import { describe, expect, test } from "bun:test";
import { pickCdpTarget, shouldPreserveConnectedBrowserFocus } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import {
	acquireBrowser,
	type BrowserHandle,
	normalizeConnectedCdpUrl,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

async function withTargetFixture<T>(
	targets: Array<{ id: string; type: string; url: string; title: string }>,
	fn: (cdpEndpoint: string) => Promise<T>,
): Promise<T> {
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/json/list") return Response.json(targets);
			if (pathname === "/json/version") return Response.json({ Browser: "Fixture/1" });
			return new Response("not found", { status: 404 });
		},
	});
	try {
		return await fn(`http://127.0.0.1:${server.port}`);
	} finally {
		await server.stop(true);
	}
}

describe("pickCdpTarget", () => {
	test("returns one concrete page target identity", async () => {
		await withTargetFixture(
			[
				{ id: "browser", type: "browser", url: "", title: "" },
				{ id: "google-page", type: "page", url: "https://www.google.com/", title: "Google" },
			],
			async cdpEndpoint => {
				await expect(pickCdpTarget(cdpEndpoint, { matcher: "google" })).resolves.toEqual({
					id: "google-page",
					type: "page",
					url: "https://www.google.com/",
					title: "Google",
				});
			},
		);
	});

	test("fails closed when an explicit matcher misses", async () => {
		await withTargetFixture(
			[{ id: "example", type: "page", url: "https://example.com/", title: "Example" }],
			async cdpEndpoint => {
				await expect(pickCdpTarget(cdpEndpoint, { matcher: "missing" })).rejects.toThrow(
					'No page target matched "missing". Available pages:\n- Example  https://example.com/',
				);
			},
		);
	});

	test("skips internal targets during automatic selection", async () => {
		await withTargetFixture(
			[
				{ id: "devtools", type: "page", url: "devtools://devtools/", title: "DevTools" },
				{ id: "usable", type: "page", url: "https://example.org/", title: "Example" },
			],
			async cdpEndpoint => {
				await expect(pickCdpTarget(cdpEndpoint)).resolves.toMatchObject({ id: "usable" });
			},
		);
	});

	test("preserves connected-browser focus only for automatic target selection", () => {
		expect(shouldPreserveConnectedBrowserFocus()).toBe(true);
		expect(shouldPreserveConnectedBrowserFocus("example.com")).toBe(false);
	});

	test("rejects websocket cdp_url values with an actionable diagnostic", () => {
		expect(() => normalizeConnectedCdpUrl("ws://127.0.0.1:9222/devtools/browser/id")).toThrow(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint",
		);
		expect(normalizeConnectedCdpUrl("http://127.0.0.1:9222/")).toBe("http://127.0.0.1:9222");
	});

	test.skipIf(!CHROMIUM_AVAILABLE)(
		"navigates a fresh attached tab to the requested URL",
		async () => {
			const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("cdpEndpoint" in launched)) throw new Error("Expected a CDP browser");
			let attached: BrowserHandle | undefined;
			let opened = false;
			const tabName = `attach-navigation-${process.pid}-${Math.random().toString(36).slice(2)}`;
			const requested = "data:text/html,<title>attached-navigation-target</title>";

			try {
				attached = await acquireBrowser(
					{ kind: "connected", cdpUrl: launched.cdpEndpoint },
					{ cwd: process.cwd() },
				);
				const { tab } = await acquireTab(tabName, attached, {
					url: requested,
					waitUntil: "domcontentloaded",
					timeoutMs: 10_000,
				});
				opened = true;
				expect(tab.info.url).toBe(requested);
			} finally {
				if (opened) await releaseTab(tabName, { kill: false });
				else if (attached) await releaseBrowser(attached, { kill: false });
				await releaseBrowser(launched, { kill: true });
			}
		},
		30_000,
	);

	test.skipIf(!CHROMIUM_AVAILABLE)(
		"does not retry an attached navigation failure as worker startup",
		async () => {
			let requestCount = 0;
			const server = Bun.serve({
				port: 0,
				fetch: () => {
					requestCount++;
					return new Promise<Response>(() => {});
				},
			});
			const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("cdpEndpoint" in launched)) throw new Error("Expected a CDP browser");
			let attached: BrowserHandle | undefined;
			let attempted = false;
			try {
				attached = await acquireBrowser(
					{ kind: "connected", cdpUrl: launched.cdpEndpoint },
					{ cwd: process.cwd() },
				);
				attempted = true;
				await expect(
					acquireTab(`attach-failure-${process.pid}-${Math.random().toString(36).slice(2)}`, attached, {
						url: `http://127.0.0.1:${server.port}/hang`,
						waitUntil: "domcontentloaded",
						timeoutMs: 100,
					}),
				).rejects.toThrow(/Navigation timeout/i);
				expect(requestCount).toBe(1);
			} finally {
				if (attached && !attempted) await releaseBrowser(attached, { kill: false });
				await releaseBrowser(launched, { kill: true });
				await server.stop(true);
			}
		},
		30_000,
	);
});
