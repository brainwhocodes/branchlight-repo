/**
 * End-to-end smoke for the browser relay.
 *
 * `--fixture` owns a temporary OMP Chromium profile, a real unpacked relay
 * extension, an allocated relay endpoint, and a local fixture page. Positional
 * arguments retain the manual live-relay diagnostic:
 *
 *   bun scripts/smoke.ts --fixture
 *   bun scripts/smoke.ts [relay-url] [target-substring]
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBrowserCacheDir, removeWithRetries } from "@oh-my-pi/pi-utils";
import { installChromium, PLAYWRIGHT_CHROMIUM_VERSION } from "@oh-my-pi/pi-utils/chromium";
import { findFreeTcpPort } from "@oh-my-pi/pi-utils/net";
import type { Subprocess } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import * as coreBundle from "playwright-core/lib/coreBundle";

class BunWebSocketTransport {
	readonly wsEndpoint: string;
	readonly headers: Array<{ name: string; value: string }> = [];
	onmessage?: (message: unknown) => void;
	onclose?: (reason?: string) => void;
	private readonly _ws: WebSocket;

	constructor(url: string) {
		this.wsEndpoint = url;
		this._ws = new WebSocket(url);
		this._ws.addEventListener("message", event => {
			try {
				const data =
					typeof event.data === "string"
						? JSON.parse(event.data)
						: JSON.parse(new TextDecoder().decode(event.data as ArrayBuffer));
				this.onmessage?.(data);
			} catch {}
		});
		this._ws.addEventListener("close", event => {
			this.onclose?.(event.reason);
		});
	}

	send(message: object): void {
		if (this._ws.readyState === WebSocket.OPEN) {
			this._ws.send(JSON.stringify(message));
		}
	}

	close(): void {
		if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
			this._ws.close();
		}
	}

	async closeAndWait(): Promise<void> {
		if (this._ws.readyState === WebSocket.CLOSED) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this._ws.addEventListener("close", () => resolve(), { once: true });
		this.close();
		await promise;
	}

	static async connect(_progress: unknown, url: string, _options = {}): Promise<BunWebSocketTransport> {
		const transport = new BunWebSocketTransport(url);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onOpen = (): void => {
			cleanup();
			resolve();
		};
		const onError = (e: Event): void => {
			cleanup();
			reject(new Error(`WebSocket error: ${"message" in e ? String(e.message) : "connection failed"}`));
		};
		const cleanup = (): void => {
			transport._ws.removeEventListener("open", onOpen);
			transport._ws.removeEventListener("error", onError);
		};
		transport._ws.addEventListener("open", onOpen);
		transport._ws.addEventListener("error", onError);
		await promise;
		return transport;
	}
}

coreBundle.server.WebSocketTransport.connect = BunWebSocketTransport.connect;

import backgroundJs from "../../coding-agent/src/tools/browser/relay/extension-assets/background.js.txt" with {
	type: "text",
};
import manifestJson from "../../coding-agent/src/tools/browser/relay/extension-assets/manifest.json.txt" with {
	type: "text",
};
import optionsHtml from "../../coding-agent/src/tools/browser/relay/extension-assets/options.html.txt" with {
	type: "text",
};
import optionsJs from "../../coding-agent/src/tools/browser/relay/extension-assets/options.js.txt" with {
	type: "text",
};
import { type RelayServer, startRelayServer } from "../../coding-agent/src/tools/browser/relay/server";

const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";
const DEFAULT_MATCHER = "Relay Smoke Page";
const STARTUP_TIMEOUT_MS = 20_000;
const FIXTURE_HTML = `<!doctype html>
<html>
<head><title>Relay Smoke Page</title></head>
<body>
	<h1 id="hero">Relay fixture ready</h1>
	<button id="fixture-action" type="button">Connect</button>
	<output id="fixture-output">Waiting</output>
	<script>
		document.querySelector("#fixture-action").addEventListener("click", () => {
			document.querySelector("#fixture-output").textContent = "Connected";
		});
	</script>
</body>
</html>`;

function step(name: string): void {
	console.log(`\n== ${name}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function defaultContext(browser: Browser): BrowserContext {
	const context = browser.contexts()[0];
	if (!context) throw new Error("relay CDP connection has no default browser context");
	return context;
}

async function targetIdForPage(context: BrowserContext, page: Page): Promise<string> {
	const session = await context.newCDPSession(page);
	try {
		const result = (await session.send("Target.getTargetInfo")) as {
			targetInfo?: { targetId?: unknown };
		};
		const targetId = result.targetInfo?.targetId;
		if (typeof targetId !== "string" || targetId.length === 0) {
			throw new Error("Target.getTargetInfo did not return a target id");
		}
		return targetId;
	} finally {
		await session.detach();
	}
}

async function findPageByTargetId(browser: Browser, targetId: string): Promise<Page> {
	const context = defaultContext(browser);
	for (const page of context.pages()) {
		if ((await targetIdForPage(context, page)) === targetId) return page;
	}
	throw new Error(`worker could not adopt exact target ${JSON.stringify(targetId)}`);
}

async function findMatchingPage(browser: Browser, matcher: string): Promise<Page> {
	const context = defaultContext(browser);
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const pages = context.pages();
		for (const page of pages) {
			const title = await page.title().catch(() => "");
			if (page.url().includes(matcher) || title.includes(matcher)) {
				console.log(
					"pages:",
					pages.map(candidate => candidate.url()),
				);
				return page;
			}
		}
		await Bun.sleep(100);
	}
	console.log(
		"pages:",
		context.pages().map(page => page.url()),
	);
	throw new Error(`no page matching ${JSON.stringify(matcher)}`);
}

async function exerciseRelay(relayUrl: string, matcher: string, navigationUrl?: string): Promise<void> {
	step("supervisor: connect over CDP");
	const supervisor = await chromium.connectOverCDP(relayUrl, { timeout: STARTUP_TIMEOUT_MS });
	console.log("version:", supervisor.version());

	step("supervisor: discover exact target");
	const picked = await findMatchingPage(supervisor, matcher);
	const targetId = await targetIdForPage(defaultContext(supervisor), picked);
	console.log("picked target:", targetId, "endpoint:", relayUrl);

	step("worker: second connection and exact adoption");
	const worker = await chromium.connectOverCDP(relayUrl, { timeout: STARTUP_TIMEOUT_MS });
	const page = await findPageByTargetId(worker, targetId);

	step("worker: evaluate existing tab");
	console.log("title:", await page.title());
	const hero = await page.locator("#hero").textContent();
	console.log("hero:", hero ?? "(no hero)");
	if (navigationUrl)
		assert(hero === "Relay fixture ready", `unexpected fixture evaluation result ${JSON.stringify(hero)}`);

	step("worker: extra CDP session");
	const session = await defaultContext(worker).newCDPSession(page);
	try {
		const frameTree = (await session.send("Page.getFrameTree")) as {
			frameTree: { frame: { url: string } };
		};
		console.log("frame url:", frameTree.frameTree.frame.url);
	} finally {
		await session.detach();
	}

	step("worker: navigate existing tab");
	const destination = navigationUrl ?? "https://example.com/?relay-smoke";
	await page.goto(destination, { waitUntil: "load", timeout: STARTUP_TIMEOUT_MS });
	assert(page.url() === destination, `navigation landed on ${page.url()} instead of ${destination}`);
	console.log("navigated:", page.url(), "/", await page.title());

	step("worker: screenshot");
	const shot = await page.screenshot({ type: "png" });
	assert(shot.byteLength > 0, "relay screenshot was empty");
	console.log("screenshot bytes:", shot.byteLength);

	step("supervisor: create and close tab");
	const fresh = await defaultContext(supervisor).newPage();
	await fresh.goto("about:blank");
	assert(fresh.url() === "about:blank", `new page has unexpected URL ${fresh.url()}`);
	console.log("new page url:", fresh.url());
	await fresh.close();
	assert(fresh.isClosed(), "relay-created page did not close");
	assert(!page.isClosed(), "closing the relay-created page closed the adopted shared page");
	console.log("closed");

	// There is intentionally no Browser.close(): live mode attaches to a shared
	// user browser. Exiting this short-lived process drops both CDP sockets.
}

async function waitForRelay(relayUrl: string, browserProcess: Subprocess): Promise<void> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (browserProcess.exitCode !== null) {
			throw new Error(`fixture Chromium exited during startup with code ${browserProcess.exitCode}`);
		}
		try {
			const response = await fetch(`${relayUrl}/json/version`);
			if (response.ok) return;
		} catch {
			// Extension service worker has not connected yet.
		}
		await Bun.sleep(100);
	}
	throw new Error(`relay extension did not connect to ${relayUrl} within ${STARTUP_TIMEOUT_MS}ms`);
}

async function writeFixtureExtension(extensionDir: string, relayPort: number): Promise<void> {
	const configuredBackground = backgroundJs.replace("var DEFAULT_PORT = 9224;", `var DEFAULT_PORT = ${relayPort};`);
	if (configuredBackground === backgroundJs) {
		throw new Error("relay background asset no longer exposes its default port marker");
	}
	await Promise.all([
		Bun.write(path.join(extensionDir, "background.js"), configuredBackground),
		Bun.write(path.join(extensionDir, "manifest.json"), manifestJson),
		Bun.write(path.join(extensionDir, "options.html"), optionsHtml),
		Bun.write(path.join(extensionDir, "options.js"), optionsJs),
	]);
}

async function resolveChromiumExecutable(): Promise<string> {
	const configured = process.env.OMP_BROWSER_EXECUTABLE_PATH;
	if (configured) return configured;
	const installation = await installChromium({
		cacheDir: getBrowserCacheDir(),
		version: PLAYWRIGHT_CHROMIUM_VERSION,
	});
	return installation.executablePath;
}

async function stopBrowser(browserProcess: Subprocess | undefined): Promise<void> {
	if (!browserProcess || browserProcess.exitCode !== null) return;
	browserProcess.kill("SIGTERM");
	await Promise.race([browserProcess.exited, Bun.sleep(5_000)]);
	if (browserProcess.exitCode === null) {
		browserProcess.kill("SIGKILL");
		await browserProcess.exited;
	}
}

async function runFixture(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-relay-smoke-"));
	const profileDir = path.join(root, "profile");
	const extensionDir = path.join(root, "extension");
	let relay: RelayServer | undefined;
	let fixtureServer: Bun.Server<undefined> | undefined;
	let browserProcess: Subprocess | undefined;
	try {
		const relayPort = await findFreeTcpPort();
		await writeFixtureExtension(extensionDir, relayPort);
		relay = startRelayServer({ port: relayPort, group: false });
		const relayUrl = `http://127.0.0.1:${relayPort}`;

		fixtureServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/" || url.pathname === "/navigated") {
					return new Response(FIXTURE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
				}
				return new Response("Not found", { status: 404 });
			},
		});
		const fixtureUrl = `http://127.0.0.1:${fixtureServer.port}/`;
		const executablePath = await resolveChromiumExecutable();

		step("fixture: launch OMP Chromium with unpacked extension");
		browserProcess = Bun.spawn(
			[
				executablePath,
				`--user-data-dir=${profileDir}`,
				"--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=0",
				`--disable-extensions-except=${extensionDir}`,
				`--load-extension=${extensionDir}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--headless=new",
				"--window-size=1280,800",
				fixtureUrl,
			],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		await waitForRelay(relayUrl, browserProcess);
		await exerciseRelay(relayUrl, "Relay Smoke Page", `${fixtureUrl}navigated`);
		console.log("\nFIXTURE SMOKE OK");
	} finally {
		try {
			relay?.stop();
		} finally {
			try {
				fixtureServer?.stop(true);
			} finally {
				try {
					await stopBrowser(browserProcess);
				} finally {
					await removeWithRetries(root);
				}
			}
		}
	}
}

if (Bun.argv[2] === "--fixture") {
	await runFixture();
} else {
	await exerciseRelay(Bun.argv[2] ?? DEFAULT_RELAY_URL, Bun.argv[3] ?? DEFAULT_MATCHER);
	console.log("\nSMOKE OK");
}

process.exit(0);
