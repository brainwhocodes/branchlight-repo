import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { WorkspaceClient } from "@oh-my-pi/pi-workspace-runtime/client";
import { ToolError, throwIfAborted } from "../tool-errors";

const ATTACH_TARGET_SKIP_PATTERN =
	/request[\s_-]?handler|devtools|background[\s_-]?(?:page|host)|service[\s_-]?worker|localhost:5173|127\.0\.0\.1:5173|Mars\s+Kommander|Branchlight|^app:\/\/|^file:\/\/.*index\.html/i;
const CDP_PROBE_TIMEOUT_MS = 2_000;

export interface CdpVersionInfo {
	Browser?: string;
	"Protocol-Version"?: string;
	webSocketDebuggerUrl?: string;
	[key: string]: unknown;
}

export interface CdpTargetInfo {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

function cdpUrl(cdpEndpoint: string, suffix: string): string {
	return `${cdpEndpoint.replace(/\/+$/, "")}${suffix}`;
}

/** Poll `/json/version` until it returns a valid CDP version document. */
export async function waitForCdp(
	cdpEndpoint: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<CdpVersionInfo> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	const probeUrl = cdpUrl(cdpEndpoint, "/json/version");
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		const probeTimeout = AbortSignal.timeout(Math.min(CDP_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
		const probeSignal = signal ? AbortSignal.any([signal, probeTimeout]) : probeTimeout;
		try {
			const res = await fetch(probeUrl, { signal: probeSignal });
			if (!res.ok) {
				lastErr = new Error(`HTTP ${res.status}`);
				await res.body?.cancel();
			} else {
				const value = (await res.json()) as unknown;
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					lastErr = new Error("invalid JSON version document");
				} else {
					return value as CdpVersionInfo;
				}
			}
		} catch (err) {
			if (signal?.aborted) throwIfAborted(signal);
			lastErr = err;
		}
		await Bun.sleep(150);
	}
	throw new ToolError(
		`Timed out waiting for CDP endpoint ${cdpEndpoint}${lastErr instanceof Error ? `: ${lastErr.message}` : ""}`,
	);
}

/** One-shot liveness check for a plain HTTP CDP endpoint. */
export async function probeCdpEndpoint(cdpEndpoint: string, signal?: AbortSignal): Promise<boolean> {
	try {
		await waitForCdp(cdpEndpoint, 1_500, signal);
		return true;
	} catch {
		if (signal?.aborted) throwIfAborted(signal);
		return false;
	}
}

function findArgValue(args: string[], name: string): string | null {
	const prefix = `${name}=`;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.startsWith(prefix)) return arg.slice(prefix.length) || null;
		if (arg === name) return args[i + 1] ?? null;
	}
	return null;
}

async function cdpEndpointFromArgs(args: string[]): Promise<string | null> {
	const rawPort = findArgValue(args, "--remote-debugging-port");
	if (rawPort) {
		const port = Number.parseInt(rawPort, 10);
		if (Number.isFinite(port) && port > 0) return `http://127.0.0.1:${port}`;
	}
	const userDataDir = findArgValue(args, "--user-data-dir");
	if (!userDataDir || !path.isAbsolute(userDataDir)) return null;
	try {
		const text = await Bun.file(path.join(userDataDir, "DevToolsActivePort")).text();
		const port = Number.parseInt(text.split(/\r?\n/, 1)[0] ?? "", 10);
		return Number.isFinite(port) && port > 0 ? `http://127.0.0.1:${port}` : null;
	} catch {
		return null;
	}
}

/** Reuse a running instance only when its advertised CDP endpoint is live. */
export async function findReusableCdp(
	exe: string,
	signal?: AbortSignal,
): Promise<{ cdpEndpoint: string; pid: number } | null> {
	const candidates = Process.fromPath(exe).filter(process => process.status() === ProcessStatus.Running);
	for (const process of candidates) {
		let args: string[];
		try {
			args = process.args();
		} catch {
			continue;
		}
		const cdpEndpoint = await cdpEndpointFromArgs(args);
		if (cdpEndpoint && (await probeCdpEndpoint(cdpEndpoint, signal))) {
			return { cdpEndpoint, pid: process.pid };
		}
	}
	return null;
}

export function shouldPreserveConnectedBrowserFocus(target?: string): boolean {
	return !target;
}

/** Read page target descriptors without loading a browser automation runtime in the supervisor. */
export async function listCdpTargets(
	cdpEndpoint: string,
	timeoutMs = CDP_PROBE_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<CdpTargetInfo[]> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	let response: Response;
	try {
		response = await fetch(cdpUrl(cdpEndpoint, "/json/list"), { signal: requestSignal });
	} catch (error) {
		if (signal?.aborted) throwIfAborted(signal);
		throw new ToolError(`Failed to list CDP targets at ${cdpEndpoint}: ${(error as Error).message}`);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new ToolError(`Failed to list CDP targets at ${cdpEndpoint}: HTTP ${response.status}`);
	}
	const raw = (await response.json()) as unknown;
	if (!Array.isArray(raw)) throw new ToolError(`CDP target list at ${cdpEndpoint} was not an array`);
	return raw.flatMap(value => {
		if (!value || typeof value !== "object") return [];
		const item = value as Record<string, unknown>;
		if (
			typeof item.id !== "string" ||
			typeof item.type !== "string" ||
			typeof item.url !== "string" ||
			typeof item.title !== "string"
		) {
			return [];
		}
		return [
			{
				id: item.id,
				type: item.type,
				url: item.url,
				title: item.title,
				...(typeof item.webSocketDebuggerUrl === "string"
					? { webSocketDebuggerUrl: item.webSocketDebuggerUrl }
					: {}),
			},
		];
	});
}
async function targetIsVisible(target: CdpTargetInfo, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	if (!target.webSocketDebuggerUrl) return false;
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let settled = false;
	const finish = (visible: boolean): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		socket.close();
		resolve(visible);
	};
	const onAbort = (): void => finish(false);
	const timer = setTimeout(() => finish(false), timeoutMs);
	signal?.addEventListener("abort", onAbort, { once: true });
	socket.addEventListener("open", () => {
		socket.send(
			JSON.stringify({
				id: 1,
				method: "Runtime.evaluate",
				params: { expression: "document.visibilityState === 'visible'", returnByValue: true },
			}),
		);
	});
	socket.addEventListener("message", event => {
		if (typeof event.data !== "string") return;
		try {
			const message = JSON.parse(event.data) as {
				id?: number;
				result?: { result?: { value?: unknown } };
			};
			if (message.id === 1) finish(message.result?.result?.value === true);
		} catch {
			finish(false);
		}
	});
	socket.addEventListener("error", () => finish(false));
	socket.addEventListener("close", () => finish(false));
	const visible = await promise;
	if (signal?.aborted) throwIfAborted(signal);
	return visible;
}

/**
 * Select one concrete page descriptor, whose target id is then adopted exactly
 * by the tab worker. A matcher miss fails closed and never substitutes another page.
 */
export async function pickCdpTarget(
	cdpEndpoint: string,
	options: { matcher?: string; preferVisible?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CdpTargetInfo> {
	const allTargets = (await listCdpTargets(cdpEndpoint, options.timeoutMs, options.signal)).filter(
		target => target.type === "page" || target.type === "webview",
	);
	if (!allTargets.length) throw new ToolError("No page targets available on the attached browser");

	const usable = allTargets.filter(
		target => !ATTACH_TARGET_SKIP_PATTERN.test(target.url) && !ATTACH_TARGET_SKIP_PATTERN.test(target.title),
	);

	if (options.matcher) {
		const needle = options.matcher.toLowerCase();
		const hit = (usable.length ? usable : allTargets).find(
			target => target.url.toLowerCase().includes(needle) || target.title.toLowerCase().includes(needle),
		);
		if (hit) return hit;
		const summary = (usable.length ? usable : allTargets)
			.map(target => `- ${target.title || "(untitled)"}  ${target.url}`)
			.join("\n");
		throw new ToolError(`No page target matched ${JSON.stringify(options.matcher)}. Available pages:\n${summary}`);
	}

	if (options.preferVisible && usable.length > 1) {
		const visibility = await Promise.all(
			usable.map(target =>
				targetIsVisible(target, Math.min(options.timeoutMs ?? CDP_PROBE_TIMEOUT_MS, 1_000), options.signal),
			),
		);
		const foregroundIndex = visibility.indexOf(true);
		if (foregroundIndex >= 0) return usable[foregroundIndex]!;
	}

	if (usable.length > 0) return usable[0]!;

	if (process.env.BRANCHLIGHT_TERMINAL === "1" && process.env.PI_RUNTIME_DIR && process.env.PI_RUNTIME_TOKEN) {
		try {
			const client = new WorkspaceClient({
				runtimeRoot: process.env.PI_RUNTIME_DIR,
				token: process.env.PI_RUNTIME_TOKEN,
			});
			await client.connect();
			const doc = client.document ?? (await client.getDocument());
			const workspaceId =
				process.env.BRANCHLIGHT_WORKSPACE_ID ??
				doc.activeWorkspaceId ??
				doc.workspaces[0]?.id ??
				"workspace-default";
			const locationId =
				doc.workspaces.find(w => w.id === workspaceId)?.locationId ?? doc.locations[0]?.id ?? "loc-1";
			const tabId = `tab-${crypto.randomUUID()}`;
			const paneId = `browser-${crypto.randomUUID()}`;
			const res = await client.executeCommandWithRetry(currentDoc => ({
				version: 1 as const,
				commandId: `cmd-open-${crypto.randomUUID().slice(0, 8)}`,
				workspaceId,
				expectedRevision: currentDoc.revision,
				issuedAt: Date.now(),
				type: "browser.open" as const,
				payload: {
					id: paneId,
					paneId,
					tabId,
					tabName: "Browser",
					locationId,
					url: "https://omp.sh",
					title: "New browser",
				},
			}));
			await client.close().catch(() => {});
			if (res.status === "accepted" || res.status === "duplicate") {
				await new Promise(r => setTimeout(r, 400));
				const updatedTargets = (await listCdpTargets(cdpEndpoint, options.timeoutMs, options.signal)).filter(
					target => target.type === "page" || target.type === "webview",
				);
				const newUsable = updatedTargets.filter(
					target => !ATTACH_TARGET_SKIP_PATTERN.test(target.url) && !ATTACH_TARGET_SKIP_PATTERN.test(target.title),
				);
				if (newUsable.length > 0) return newUsable[newUsable.length - 1]!;
			}
		} catch {}
	}

	return allTargets[0]!;
}

/** Close exactly one CDP target. This is used only for orphan cleanup on an OMP-owned browser. */
export async function closeCdpTarget(
	cdpEndpoint: string,
	targetId: string,
	timeoutMs = CDP_PROBE_TIMEOUT_MS,
): Promise<void> {
	const response = await fetch(cdpUrl(cdpEndpoint, `/json/close/${encodeURIComponent(targetId)}`), {
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new ToolError(`Failed to close CDP target ${JSON.stringify(targetId)}: HTTP ${response.status}`);
	}
	await response.body?.cancel();
}

/** SIGTERM the OMP-owned process tree, then forcefully terminate survivors. */
export async function gracefulKillTreeOnce(pid: number, gracePeriodMs = 2_000): Promise<void> {
	const process = Process.fromPid(pid);
	if (!process) return;
	await process.terminate({ gracefulMs: gracePeriodMs, timeoutMs: 500 });
}
