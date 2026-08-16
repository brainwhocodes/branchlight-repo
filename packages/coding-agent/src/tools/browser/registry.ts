import * as path from "node:path";
import { isCompiledBinary, logger, withTimeout, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { ToolAbortError, ToolError } from "../tool-errors";
import { findReusableCdp, gracefulKillTreeOnce, probeCdpEndpoint, waitForCdp } from "./attach";
import type { CmuxKind } from "./cmux/rpc";
import { CmuxSocketClient } from "./cmux/socket-client";
import { DEFAULT_VIEWPORT, launchBrowserProcess, removeUserDataDir } from "./launch";
import { ensureRelayDaemon, isLoopbackRelayUrl } from "./relay/daemon";
import type { RelayKind } from "./relay/kind";
import { ensureSharedBrowser } from "./shared-daemon";

export type CdpBrowserKind =
	| { kind: "headless"; headless: boolean }
	| { kind: "spawned"; path: string }
	| { kind: "connected"; cdpUrl: string }
	| RelayKind;

export type BrowserKind = CdpBrowserKind | CmuxKind;
export type BrowserKindTag = BrowserKind["kind"];

const OWNED_PROCESS_CLOSE_TIMEOUT_MS = 5_000;
const RELAY_EXTENSION_WAIT_MS = 35_000;

interface BrowserHandleCommon {
	key: string;
	kind: BrowserKind;
	refCount: number;
}

/** Plain endpoint and ownership record; Playwright connections live only in consumers/workers. */
export interface CdpBrowserHandle extends BrowserHandleCommon {
	kind: CdpBrowserKind;
	cdpEndpoint: string;
	pid?: number;
	ownedProcess?: Subprocess;
	/** OMP-owned temporary profile, removed only after the matching owned process is stopped. */
	userDataDir?: string;
	ownsUserDataDir?: boolean;
	/** Broker owner for shared headless Chromium; this process must never terminate it. */
	sharedDaemon?: { name: string; projectDir: string };
}

export interface CmuxBrowserHandle extends BrowserHandleCommon {
	kind: CmuxKind;
	client: CmuxSocketClient;
	surface?: string;
}

export type BrowserHandle = CdpBrowserHandle | CmuxBrowserHandle;

export interface ReleaseBrowserOptions {
	kill: boolean;
	timeoutMs?: number;
	resource?: string;
}

const browsers = new Map<string, BrowserHandle>();
const pendingOpens = new Map<string, Promise<BrowserHandle>>();

function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless:${kind.headless ? "1" : "0"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.socketPath}`;
	}
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	appArgs?: string[];
	signal?: AbortSignal;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	const key = browserKey(kind);
	for (;;) {
		const existing = browsers.get(key);
		if (existing) {
			if ("client" in existing || (await probeCdpEndpoint(existing.cdpEndpoint, opts.signal))) return existing;
			browsers.delete(key);
			await disposeBrowserHandle(existing, {
				kill: existing.ownedProcess !== undefined,
			});
			continue;
		}
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");
		const pending = pendingOpens.get(key);
		if (pending) {
			await pending.catch(() => undefined);
			continue;
		}
		const open = openBrowserHandle(kind, opts).finally(() => pendingOpens.delete(key));
		pendingOpens.set(key, open);
		const handle = await open;
		if (opts.signal?.aborted) {
			await disposeBrowserHandle(handle, { kill: kind.kind === "spawned" }).catch(error => {
				logger.debug("Failed to dispose orphan browser after abort", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			throw new ToolAbortError("Browser open aborted");
		}
		browsers.set(key, handle);
		return handle;
	}
}

export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
	const cdpEndpoint = rawCdpUrl.replace(/\/+$/, "");
	if (/^wss?:\/\//i.test(cdpEndpoint)) {
		throw new ToolError(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.",
		);
	}
	return cdpEndpoint;
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "cmux") {
		const client = new CmuxSocketClient({ socketPath: kind.socketPath, password: kind.password });
		await client.connect();
		return { key: browserKey(kind), kind, client, surface: kind.surface, refCount: 0 };
	}
	if (kind.kind === "headless") {
		if (isCompiledBinary() || workerHostEntry() !== null) return await openSharedHeadlessHandle(kind, opts);
		const launched = await launchBrowserProcess({
			headless: kind.headless,
			viewport: opts.viewport,
			signal: opts.signal,
		});
		return {
			key: browserKey(kind),
			kind,
			cdpEndpoint: launched.cdpEndpoint,
			pid: launched.subprocess.pid,
			ownedProcess: launched.subprocess,
			userDataDir: launched.userDataDir,
			ownsUserDataDir: launched.ownsUserDataDir,
			refCount: 0,
		};
	}
	if (kind.kind === "connected") {
		const cdpEndpoint = normalizeConnectedCdpUrl(kind.cdpUrl);
		await waitForCdp(cdpEndpoint, 5_000, opts.signal);
		return { key: browserKey(kind), kind, cdpEndpoint, refCount: 0 };
	}
	if (kind.kind === "relay") {
		const cdpEndpoint = normalizeConnectedCdpUrl(kind.cdpUrl);
		let autoStarted = false;
		if (isLoopbackRelayUrl(cdpEndpoint) && (isCompiledBinary() || workerHostEntry() !== null)) {
			autoStarted = await ensureRelayDaemon({ cdpUrl: cdpEndpoint, signal: opts.signal });
		}
		try {
			await waitForCdp(cdpEndpoint, RELAY_EXTENSION_WAIT_MS, opts.signal);
		} catch (error) {
			if (error instanceof ToolAbortError || (error instanceof Error && error.name === "AbortError")) throw error;
			throw new ToolError(
				autoStarted
					? `omp browser relay is serving at ${cdpEndpoint} but its extension never connected. Install it with \`omp browser-relay install\` and check the toolbar badge shows "on".`
					: `omp browser relay is not reachable at ${cdpEndpoint}. Start it with \`omp browser-relay\` (or check the endpoint), and make sure the OMP Browser Relay extension is loaded in Chrome.`,
			);
		}
		return { key: browserKey(kind), kind, cdpEndpoint, refCount: 0 };
	}

	const executablePath = kind.path;
	if (!path.isAbsolute(executablePath)) {
		throw new ToolError(
			`app.path must be absolute (got ${JSON.stringify(executablePath)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`,
		);
	}
	const reused = await findReusableCdp(executablePath, opts.signal);
	if (reused) {
		logger.debug("Reusing existing CDP endpoint for attach", {
			executablePath,
			pid: reused.pid,
			cdpEndpoint: reused.cdpEndpoint,
		});
		return {
			key: browserKey(kind),
			kind,
			cdpEndpoint: reused.cdpEndpoint,
			pid: reused.pid,
			refCount: 0,
		};
	}
	const launched = await launchBrowserProcess({
		headless: false,
		executablePath,
		args: opts.appArgs,
		signal: opts.signal,
	});
	return {
		key: browserKey(kind),
		kind,
		cdpEndpoint: launched.cdpEndpoint,
		pid: launched.subprocess.pid,
		ownedProcess: launched.subprocess,
		userDataDir: launched.userDataDir,
		ownsUserDataDir: launched.ownsUserDataDir,
		refCount: 0,
	};
}

export function holdBrowser(handle: BrowserHandle): void {
	handle.refCount++;
}

export async function releaseBrowser(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	handle.refCount = Math.max(0, handle.refCount - 1);
	if (handle.refCount !== 0) return;
	if (browsers.get(handle.key) === handle) browsers.delete(handle.key);
	await disposeBrowserHandle(handle, opts);
}

async function terminateOwnedProcess(handle: CdpBrowserHandle, timeoutMs: number): Promise<void> {
	if (!handle.ownedProcess) return;
	const pid = handle.ownedProcess.pid;
	try {
		await withTimeout(gracefulKillTreeOnce(pid), timeoutMs, `Timed out stopping owned browser process ${pid}`);
	} catch (error) {
		logger.debug("Failed to stop owned browser process", {
			pid,
			error: error instanceof Error ? error.message : String(error),
		});
		await withTimeout(
			gracefulKillTreeOnce(pid, 0),
			1_000,
			`Timed out force-stopping owned browser process ${pid}`,
		).catch(() => undefined);
	}
}

async function disposeBrowserHandle(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	if ("client" in handle) {
		handle.client.close();
		return;
	}
	if (handle.sharedDaemon || handle.kind.kind === "connected" || handle.kind.kind === "relay") return;
	const terminate = handle.kind.kind === "headless" || opts.kill;
	if (!terminate || !handle.ownedProcess) return;
	await terminateOwnedProcess(handle, opts.timeoutMs ?? OWNED_PROCESS_CLOSE_TIMEOUT_MS);
	if (handle.ownsUserDataDir && handle.userDataDir) await removeUserDataDir(handle.userDataDir);
}

function sharedEndpointFromWebSocket(wsEndpoint: string): string {
	const endpoint = new URL(wsEndpoint);
	endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
	endpoint.pathname = "";
	endpoint.search = "";
	endpoint.hash = "";
	return endpoint.toString().replace(/\/$/, "");
}

async function openSharedHeadlessHandle(
	kind: Extract<CdpBrowserKind, { kind: "headless" }>,
	opts: AcquireBrowserOptions,
): Promise<CdpBrowserHandle> {
	const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
	try {
		const shared = await ensureSharedBrowser({
			projectDir: opts.cwd,
			headless: kind.headless,
			viewport,
			signal: opts.signal,
		});
		if (!shared) {
			throw new ToolError(
				"Shared browser daemon unavailable (broker start or Chromium launch failed); check `hub ps` for omp.browser.* daemons and ~/.omp/logs for details",
			);
		}
		const cdpEndpoint = sharedEndpointFromWebSocket(shared.wsEndpoint);
		await waitForCdp(cdpEndpoint, 5_000, opts.signal);
		return {
			key: browserKey(kind),
			kind,
			cdpEndpoint,
			sharedDaemon: { name: shared.daemonName, projectDir: shared.projectDir },
			refCount: 0,
		};
	} catch (error) {
		if (error instanceof ToolAbortError || error instanceof ToolError) throw error;
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");
		throw new ToolError(`Shared browser attach failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Test-only accessor for the module-global browser records. */
export function getBrowsersMapForTest(): ReadonlyMap<string, BrowserHandle> {
	return browsers;
}
