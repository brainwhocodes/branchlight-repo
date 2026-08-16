/**
 * CDP façade over `chrome.debugger`.
 *
 * Playwright 1.62.1 clients (the omp browser tool: one supervisor connection
 * plus one per tab worker) connect to this bridge as if it were Chrome's browser
 * debugging endpoint. Chrome only allows a single debugger attachment per tab,
 * so the bridge owns ONE `chrome.debugger` attachment per tab (via the
 * extension) and multiplexes every downstream connection over it with minted
 * per-connection session ids.
 *
 * Emulated surface (everything else is forwarded to `chrome.debugger`):
 * - the browser target (`/json/version` handshake, `Browser.getVersion`)
 * - the `Target.*` domain, including Playwright's tab → page auto-attach
 *   hierarchy (see Playwright's CDP transport, the reference implementation for
 *   this emulation)
 *
 * Session id namespaces seen by a downstream connection:
 * - minted tab pseudo-sessions (`ST<tab>.<conn>.<n>`) — Target emulation only
 * - minted page pseudo-sessions (`SP<tab>.<conn>.<n>`) — forwarded to the
 *   tab's root debugger session
 * - real child session ids (OOPIFs, workers) — created by Chrome under the
 *   shared root session and passed through verbatim
 */
import type { ExtToRelayMessage, RelayRpcRequest, RelayToExtMessage, TabSnapshot } from "./protocol";

/** Transport-agnostic websocket surface the bridge writes to. */
export interface RelaySocket {
	send(text: string): void;
	close(): void;
}

interface CdpCommand {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

interface BrowserSessionRef {
	kind: "browser";
}

interface TabSessionRef {
	kind: "tab" | "page";
	tabId: number;
}

type SessionRef = BrowserSessionRef | TabSessionRef;

interface TargetInfo {
	targetId: string;
	type: "tab" | "page" | "browser";
	title: string;
	url: string;
	attached: boolean;
	canAccessOpener: boolean;
	browserContextId?: string;
}

class CdpConnection {
	discover = false;
	autoAttach = false;
	flatten = false;
	/** Browser-target session that owns discovery events, if any. */
	discoverSessionId: string | undefined;
	/** Browser-target session that owns auto-attach events, if any. */
	autoAttachSessionId: string | undefined;
	/** Minted pseudo-sessions owned by this connection. */
	readonly sessions = new Map<string, SessionRef>();
	/** Tabs this connection claimed as drive targets (`OMP.claimTarget` / `Target.createTarget`). */
	readonly claims = new Set<number>();

	constructor(
		readonly id: number,
		readonly socket: RelaySocket,
	) {}

	sessionsForTab(tabId: number, kind?: "tab" | "page"): string[] {
		const out: string[] = [];
		for (const [sessionId, ref] of this.sessions) {
			if (!("tabId" in ref)) continue;
			if (ref.tabId === tabId && (!kind || ref.kind === kind)) out.push(sessionId);
		}
		return out;
	}
}

class TabState {
	url: string;
	title: string;
	active: boolean;
	windowId: number;
	pinned: boolean;
	/** Chrome tab group id from the last snapshot; -1 when ungrouped. */
	groupId: number;
	/** Whether `chrome.debugger` is currently attached to this tab. */
	attached = false;
	/** Set when attach failed or the user cancelled the debugger; cleared on navigation. */
	banned = false;
	/** Whether targets for this tab were announced to discovering connections. */
	announced = false;
	attaching: Promise<boolean> | null = null;
	/** True after the relay put this tab in the omp group; `ompGroupId` holds that group. */
	grouped = false;
	/** Group RPC in flight — suppresses duplicate requests from load-time tabUpdated bursts. */
	grouping = false;
	ompGroupId: number | undefined;
	/** User pulled the tab out of the omp group — never re-group it. */
	groupOptOut = false;
	/** Real Chrome session ids (OOPIF/worker children) living under this tab's root session. */
	readonly realSessions = new Set<string>();
	/** Hex main frame id reported by Page.getFrameTree; null until first retrieved. */
	mainFrameId: string | null = null;
	/** Cached execution context payloads reported by Runtime.executionContextCreated. */
	readonly executionContexts = new Map<number, Record<string, unknown>>();
	constructor(
		readonly tabId: number,
		snap: TabSnapshot,
	) {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
	}

	update(snap: TabSnapshot): void {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
	}
}

/** URLs `chrome.debugger` cannot attach to; hidden from downstream discovery entirely. */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search):/i;

const RPC_TIMEOUT_MS = 20_000;
const CDP_ERROR_METHOD_NOT_FOUND = -32601;
const CDP_ERROR_SERVER = -32000;

function tabTargetId(tabId: number): string {
	return `TAB${tabId}`;
}

function pageTargetId(tabId: number): string {
	return `PAGE${tabId}`;
}

/** Reverse of {@link tabTargetId}/{@link pageTargetId}; null for foreign ids. */
function parseTargetId(targetId: string): { kind: "tab" | "page"; tabId: number } | null {
	const match = /^(TAB|PAGE)(\d+)$/.exec(targetId);
	if (!match) return null;
	return { kind: match[1] === "TAB" ? "tab" : "page", tabId: Number(match[2]) };
}

/**
 * Multiplexing CDP bridge between downstream Playwright 1.62.1 connections and
 * the relay extension. One instance per relay server; all state lives here so an
 * extension service-worker restart only has to re-handshake.
 */
export class RelayBridge {
	#tabs = new Map<number, TabState>();
	#conns = new Map<number, CdpConnection>();
	#connSeq = 0;
	#sessionSeq = 0;
	#rpcSeq = 0;
	#ext: RelaySocket | null = null;
	#extInfo: { userAgent: string; browserVersion: string } | null = null;
	#pendingRpc = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
	>();
	/** Real child session id → owning tab, learned from `Target.attachedToTarget` events. */
	#realSessionTabs = new Map<string, number>();
	#log: (message: string, data?: Record<string, unknown>) => void;
	/** Tab-group appearance for driven tabs; null disables grouping. */
	#group: { title: string; color: string } | null;
	/** Tabs awaiting the next group RPC; drained one batch at a time. */
	#groupQueue: TabState[] = [];
	/** True while {@link #drainGroupQueue} runs — group RPCs must never overlap. */
	#groupDraining = false;

	constructor(
		opts: {
			log?: (message: string, data?: Record<string, unknown>) => void;
			/** Group tabs the agent actively drives under one per-window Chrome tab group. */
			group?: { title: string; color: string } | null;
		} = {},
	) {
		this.#log = opts.log ?? (() => {});
		this.#group = opts.group ?? null;
	}

	/** True once the extension has completed its hello handshake. */
	get ready(): boolean {
		return this.#ext !== null && this.#extInfo !== null;
	}

	/** Payload for `GET /json/version`. */
	versionInfo(wsUrl: string): Record<string, string> {
		const ua = this.#extInfo?.userAgent ?? "";
		return {
			Browser: this.#extInfo?.browserVersion ?? "Chrome/unknown",
			"Protocol-Version": "1.3",
			"User-Agent": ua,
			"V8-Version": "",
			"WebKit-Version": "",
			webSocketDebuggerUrl: wsUrl,
		};
	}

	/** Payload for `GET /json/list` (debugging aid; per-target endpoints are not served). */
	listTargets(): Array<Record<string, string>> {
		const out: Array<Record<string, string>> = [];
		for (const tab of this.#tabs.values()) {
			if (!this.#eligible(tab)) continue;
			out.push({ id: pageTargetId(tab.tabId), type: "page", title: tab.title, url: tab.url });
		}
		return out;
	}

	// ---- extension lifecycle -------------------------------------------------

	/** A new extension socket connected; replaces any previous one. */
	extConnected(socket: RelaySocket): void {
		if (this.#ext && this.#ext !== socket) {
			this.#log("replacing extension socket");
			this.#ext.close();
		}
		this.#ext = socket;
	}

	extClosed(socket: RelaySocket): void {
		if (this.#ext !== socket) return;
		this.#ext = null;
		this.#extInfo = null;
		for (const pending of this.#pendingRpc.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("relay extension disconnected"));
		}
		this.#pendingRpc.clear();
		for (const tab of this.#tabs.values()) {
			tab.attached = false;
			tab.attaching = null;
			// The extension dissolves omp groups on disconnect (or died along
			// with them); grouping state is unknowable until the next hello.
			// Without this reset, the next hello's groupId=-1 snapshots would
			// read as the user dragging every tab out (permanent opt-out).
			tab.grouped = false;
			tab.grouping = false;
			tab.ompGroupId = undefined;
		}
		this.#groupQueue.length = 0;
	}

	extMessage(socket: RelaySocket, raw: string): void {
		if (socket !== this.#ext) return;
		let msg: ExtToRelayMessage;
		try {
			msg = JSON.parse(raw) as ExtToRelayMessage;
		} catch {
			this.#log("dropping malformed extension message");
			return;
		}
		switch (msg.t) {
			case "hello":
				this.#onHello(msg);
				return;
			case "rpcResult": {
				const pending = this.#pendingRpc.get(msg.id);
				if (!pending) return;
				this.#pendingRpc.delete(msg.id);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(msg.error ?? "extension rpc failed"));
				return;
			}
			case "cdpEvent":
				this.#onCdpEvent(msg.tabId, msg.sessionId, msg.method, msg.params);
				return;
			case "detached":
				this.#onTabDetached(msg.tabId, msg.reason);
				return;
			case "tabCreated":
				this.#onTabUpsert(msg.tab);
				return;
			case "tabUpdated":
				this.#onTabUpsert(msg.tab);
				return;
			case "tabRemoved":
				this.#onTabRemoved(msg.tabId);
				return;
			case "ping":
				socket.send(JSON.stringify({ t: "pong" } satisfies RelayToExtMessage));
				return;
		}
	}

	#onHello(msg: Extract<ExtToRelayMessage, { t: "hello" }>): void {
		this.#extInfo = { userAgent: msg.userAgent, browserVersion: msg.browserVersion };
		const seen = new Set<number>();
		const attachedNow = new Set(msg.attachedTabIds);
		for (const snap of msg.tabs) {
			seen.add(snap.tabId);
			this.#onTabUpsert(snap, { silent: true });
		}
		for (const tabId of [...this.#tabs.keys()]) {
			if (!seen.has(tabId)) this.#onTabRemoved(tabId);
		}
		for (const tab of this.#tabs.values()) {
			const wasAttached = tab.attached;
			tab.attached = attachedNow.has(tab.tabId);
			tab.attaching = null;
			// A service-worker restart can drop attachments while downstream
			// connections still hold sessions: restore them best-effort.
			if (wasAttached && !tab.attached && this.#sessionHolders(tab.tabId).length > 0) {
				void this.#ensureAttached(tab).then(ok => {
					if (!ok) this.#onTabDetached(tab.tabId, "reattach_failed");
				});
			}
		}
		this.#syncGrouping();
		this.#log("extension connected", { tabs: this.#tabs.size, version: msg.browserVersion });
	}

	// ---- downstream (Playwright/CDP) lifecycle -------------------------------

	/** Register a downstream CDP websocket; returns the connection id. */
	cdpConnected(socket: RelaySocket): number {
		const conn = new CdpConnection(++this.#connSeq, socket);
		this.#conns.set(conn.id, conn);
		this.#log("cdp client connected", { conn: conn.id });
		return conn.id;
	}

	cdpClosed(connId: number): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		this.#conns.delete(connId);
		const touched = new Set<number>();
		for (const ref of conn.sessions.values()) {
			if ("tabId" in ref) touched.add(ref.tabId);
		}
		conn.sessions.clear();
		// Tabs this client claimed leave the omp group unless another claimant
		// remains — session holders don't count: the long-lived registry
		// connection holds sessions on every tab without driving any of them.
		for (const tabId of conn.claims) {
			const tab = this.#tabs.get(tabId);
			if (tab) this.#syncTabGrouping(tab);
		}
		conn.claims.clear();
		// Drop the debugger (and its infobar) from tabs nobody drives anymore.
		for (const tabId of touched) {
			if (this.#sessionHolders(tabId).length > 0) continue;
			const tab = this.#tabs.get(tabId);
			if (tab?.attached) {
				tab.attached = false;
				void this.#rpc({ op: "detach", tabId }).catch(() => {});
			}
		}
		this.#log("cdp client closed", { conn: connId });
	}

	cdpMessage(connId: number, raw: string): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		let msg: CdpCommand;
		try {
			msg = JSON.parse(raw) as CdpCommand;
		} catch {
			return;
		}
		if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
		void this.#handleCdpCommand(conn, msg).catch(err => {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		});
	}

	// ---- command routing -------------------------------------------------------

	async #handleCdpCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		const sessionId = msg.sessionId;
		if (!sessionId) {
			await this.#handleBrowserCommand(conn, msg);
			return;
		}
		const ref = conn.sessions.get(sessionId);
		if (ref?.kind === "browser") {
			await this.#handleBrowserSessionCommand(conn, msg);
			return;
		}
		if (ref?.kind === "tab") {
			this.#handleTabSessionCommand(conn, msg, ref);
			return;
		}
		if (ref?.kind === "page") {
			await this.#forwardToTab(conn, msg, ref.tabId, undefined);
			return;
		}
		const realTab = this.#realSessionTabs.get(sessionId);
		if (realTab !== undefined) {
			await this.#forwardToTab(conn, msg, realTab, sessionId);
			return;
		}
		this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
	}

	async #forwardToTab(
		conn: CdpConnection,
		msg: CdpCommand,
		tabId: number,
		realSessionId: string | undefined,
	): Promise<void> {
		const tab = this.#tabs.get(tabId);
		// Guard rails: browser-domain commands sent to page sessions.
		if (
			msg.method === "Browser.close" ||
			msg.method === "Browser.setDownloadBehavior" ||
			msg.method === "Browser.setWindowBounds"
		) {
			this.#reply(conn, msg, {});
			return;
		}
		if (msg.method === "Browser.getWindowForTarget") {
			this.#reply(conn, msg, { windowId: tab?.windowId ?? 1 });
			return;
		}
		if (msg.method === "Browser.getWindowBounds") {
			this.#reply(conn, msg, {
				bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" },
			});
			return;
		}
		// Relay-private claim: the omp tab worker marks the page it was spawned
		// to drive. Never forwarded — real Chrome rejects the unknown method.
		if (msg.method === "OMP.claimTarget") {
			this.#claimTab(conn, tabId);
			this.#reply(conn, msg, {});
			return;
		}
		try {
			if (msg.method === "Page.createIsolatedWorld" && !tab?.mainFrameId) {
				try {
					const treeResult = (await this.#rpc({ op: "send", tabId, method: "Page.getFrameTree" })) as
						| Record<string, unknown>
						| undefined;
					if (treeResult && typeof treeResult === "object" && "frameTree" in treeResult) {
						const tree = treeResult.frameTree;
						if (tree && typeof tree === "object" && "frame" in tree) {
							const frame = tree.frame;
							if (frame && typeof frame === "object" && "id" in frame && typeof frame.id === "string" && tab) {
								tab.mainFrameId = frame.id;
							}
						}
					}
				} catch {}
			}
			let params = msg.params;
			if (
				params &&
				typeof params.frameId === "string" &&
				tab?.mainFrameId &&
				params.frameId === pageTargetId(tabId)
			) {
				params = { ...params, frameId: tab.mainFrameId };
			}
			const result = (await this.#rpc({
				op: "send",
				tabId,
				sessionId: realSessionId,
				method: msg.method,
				params,
			})) as Record<string, unknown> | undefined;
			if (msg.method === "Runtime.enable" && msg.sessionId) {
				this.#replayExecutionContexts(conn, tabId, msg.sessionId);
			}
			if (msg.method === "Page.getFrameTree" && result && typeof result === "object" && "frameTree" in result) {
				const tree = result.frameTree;
				if (tree && typeof tree === "object" && "frame" in tree) {
					const frame = tree.frame;
					if (frame && typeof frame === "object" && "id" in frame && typeof frame.id === "string" && tab) {
						tab.mainFrameId = frame.id;
						frame.id = pageTargetId(tabId);
					}
				}
			}
			if (
				msg.method === "Page.createIsolatedWorld" &&
				result &&
				typeof result === "object" &&
				"executionContextId" in result &&
				typeof result.executionContextId === "number" &&
				tab
			) {
				const worldName = typeof msg.params?.worldName === "string" ? msg.params.worldName : "";
				this.#emit(
					conn,
					"Runtime.executionContextCreated",
					{
						context: {
							id: result.executionContextId,
							origin: tab.url,
							name: worldName,
							auxData: {
								isDefault: false,
								type: "isolated",
								frameId: pageTargetId(tabId),
							},
						},
					},
					msg.sessionId,
				);
			}
			this.#reply(conn, msg, (result as Record<string, unknown> | undefined) ?? {});
		} catch (err) {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Record `conn` as a driver of the tab and reconcile grouping. Claims are
	 * explicit (worker adoption or tab creation) rather than inferred from
	 * command traffic: target discovery scans every page with the same
	 * commands a driver sends, so inference would sweep all tabs.
	 */
	#claimTab(conn: CdpConnection, tabId: number): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		if (!conn.claims.has(tabId)) {
			conn.claims.add(tabId);
			this.#log("tab claimed", { conn: conn.id, tabId });
		}
		this.#syncTabGrouping(tab);
	}

	/** True while any downstream connection claims the tab as its drive target. */
	#claimed(tabId: number): boolean {
		for (const conn of this.#conns.values()) {
			if (conn.claims.has(tabId)) return true;
		}
		return false;
	}

	/** Tab pseudo-sessions only exist to satisfy Playwright's Target hierarchy. */
	#handleTabSessionCommand(conn: CdpConnection, msg: CdpCommand, ref: TabSessionRef): void {
		switch (msg.method) {
			case "Target.setAutoAttach": {
				const tab = this.#tabs.get(ref.tabId);
				if (!tab) {
					this.#replyError(conn, msg, `Tab ${ref.tabId} is gone`);
					return;
				}
				// Emit before replying: Playwright's TargetManager counts page
				// children attached before the setAutoAttach response resolves.
				const pageSession = this.#mintSession(conn, "page", tab.tabId);
				this.#emit(
					conn,
					"Target.attachedToTarget",
					{
						sessionId: pageSession,
						targetInfo: this.#pageInfo(tab, true),
						waitingForDebugger: false,
					},
					msg.sessionId,
				);
				this.#reply(conn, msg, {});
				return;
			}
			case "Runtime.runIfWaitingForDebugger":
				this.#reply(conn, msg, {});
				return;
			case "Target.getTargetInfo": {
				const tab = this.#tabs.get(ref.tabId);
				if (!tab) {
					this.#replyError(conn, msg, `Tab ${ref.tabId} is gone`);
					return;
				}
				this.#reply(conn, msg, { targetInfo: this.#pageInfo(tab, tab.attached) });
				return;
			}
			case "Target.detachFromTarget": {
				const child = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (child) this.#releaseSession(conn, child, msg.sessionId);
				this.#reply(conn, msg, {});
				return;
			}
			default:
				this.#replyError(conn, msg, `'${msg.method}' is not supported on a tab target`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	async #handleBrowserCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		switch (msg.method) {
			case "Browser.getVersion": {
				this.#reply(conn, msg, {
					protocolVersion: "1.3",
					product: this.#extInfo?.browserVersion ?? "Chrome/unknown",
					revision: "",
					userAgent: this.#extInfo?.userAgent ?? "",
					jsVersion: "",
				});
				return;
			}
			case "Browser.setDownloadBehavior":
				this.#reply(conn, msg, {});
				return;
			case "Browser.close":
				// Never close the user's browser; acknowledge and ignore.
				this.#log("refusing Browser.close from downstream client", { conn: conn.id });
				this.#reply(conn, msg, {});
				return;
			case "Target.createBrowserContext":
				this.#replyError(conn, msg, "Browser contexts are not supported by the omp browser relay");
				return;
			default:
				if (msg.method.startsWith("Target.")) {
					await this.#handleBrowserTargetCommand(conn, msg);
					return;
				}
				this.#replyError(conn, msg, `'${msg.method}' wasn't found`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	/**
	 * Handle Target-domain commands on the browser target. This is separate
	 * from the sessionless browser command path because an attached browser
	 * target has a real downstream session id that must scope replies/events.
	 */
	async #handleBrowserSessionCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		if (!msg.method.startsWith("Target.")) {
			this.#replyError(
				conn,
				msg,
				`'${msg.method}' wasn't found on the relay browser target`,
				CDP_ERROR_METHOD_NOT_FOUND,
			);
			return;
		}
		await this.#handleBrowserTargetCommand(conn, msg);
	}

	async #handleBrowserTargetCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		switch (msg.method) {
			case "Target.getBrowserContexts":
				this.#reply(conn, msg, { browserContextIds: [] });
				return;
			case "Target.attachToBrowserTarget": {
				const sessionId = `SB${conn.id}.${++this.#sessionSeq}`;
				conn.sessions.set(sessionId, { kind: "browser" });
				this.#reply(conn, msg, { sessionId });
				return;
			}
			case "Target.setDiscoverTargets": {
				conn.discover = true;
				conn.discoverSessionId = msg.sessionId;
				for (const tab of this.#tabs.values()) {
					if (!this.#eligible(tab)) continue;
					tab.announced = true;
					this.#emit(
						conn,
						"Target.targetCreated",
						{ targetInfo: this.#tabInfo(tab, tab.attached) },
						msg.sessionId,
					);
					this.#emit(
						conn,
						"Target.targetCreated",
						{ targetInfo: this.#pageInfo(tab, tab.attached) },
						msg.sessionId,
					);
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.setAutoAttach": {
				conn.autoAttach = true;
				conn.autoAttachSessionId = msg.sessionId;
				conn.flatten = Boolean(msg.params?.flatten);
				const tabs = [...this.#tabs.values()].filter(tab => this.#eligible(tab));
				await Promise.all(tabs.map(tab => this.#ensureAttached(tab)));
				for (const tab of tabs) {
					if (!tab.attached) {
						// Attach failed (DevTools open, another debugger, …): retract
						// the target so Playwright's init never waits on it.
						this.#retractTab(tab);
						continue;
					}
					this.#emitTabAttached(conn, tab, msg.sessionId);
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.attachToTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined;
				if (!parsed || !tab) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				if (!(await this.#ensureAttached(tab))) {
					this.#replyError(conn, msg, `Cannot attach to tab ${tab.tabId} (${tab.url})`);
					return;
				}
				const sessionId = this.#mintSession(conn, parsed.kind, tab.tabId);
				const info = parsed.kind === "tab" ? this.#tabInfo(tab, true) : this.#pageInfo(tab, true);
				this.#emit(
					conn,
					"Target.attachedToTarget",
					{ sessionId, targetInfo: info, waitingForDebugger: false },
					msg.sessionId,
				);
				this.#reply(conn, msg, { sessionId });
				return;
			}
			case "Target.detachFromTarget": {
				const sessionId = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (sessionId) this.#releaseSession(conn, sessionId, msg.sessionId);
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.createTarget": {
				const url =
					typeof msg.params?.url === "string" && msg.params.url.length > 0 ? msg.params.url : "about:blank";
				const result = (await this.#rpc({ op: "createTab", url })) as { tab: TabSnapshot };
				this.#onTabUpsert(result.tab);
				// Creating a tab is an explicit act of driving it.
				this.#claimTab(conn, result.tab.tabId);
				const tab = this.#tabs.get(result.tab.tabId);
				if (tab && conn.autoAttach) {
					await this.#ensureAttached(tab);
					this.#emitTabAttached(conn, tab, msg.sessionId);
				}
				this.#reply(conn, msg, { targetId: pageTargetId(result.tab.tabId) });
				return;
			}
			case "Target.closeTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (!parsed) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				await this.#rpc({ op: "removeTab", tabId: parsed.tabId });
				this.#reply(conn, msg, { success: true });
				return;
			}
			case "Target.activateTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (parsed) await this.#rpc({ op: "activateTab", tabId: parsed.tabId });
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.getTargetInfo": {
				const raw = typeof msg.params?.targetId === "string" ? msg.params.targetId : undefined;
				const parsed = raw ? parseTargetId(raw) : null;
				const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined;
				if (parsed && tab) {
					const info =
						parsed.kind === "tab" ? this.#tabInfo(tab, tab.attached) : this.#pageInfo(tab, tab.attached);
					this.#reply(conn, msg, { targetInfo: info });
					return;
				}
				this.#reply(conn, msg, {
					targetInfo: {
						targetId: "relay-browser",
						type: "browser",
						title: "",
						url: "",
						attached: true,
						canAccessOpener: false,
					} satisfies TargetInfo,
				});
				return;
			}
			default:
				this.#replyError(conn, msg, `'${msg.method}' wasn't found`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	// ---- extension events -------------------------------------------------------

	#onCdpEvent(
		tabId: number,
		sourceSessionId: string | undefined,
		method: string,
		params?: Record<string, unknown>,
	): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		let eventParams = params;
		if (params && tab.mainFrameId) {
			const frameId = params.frameId;
			const frame = params.frame;
			const context = params.context;
			let normalized = params;
			if (frameId === tab.mainFrameId) {
				normalized = { ...normalized, frameId: pageTargetId(tabId) };
			}
			if (frame && typeof frame === "object" && "id" in frame && frame.id === tab.mainFrameId) {
				normalized = {
					...normalized,
					frame: { ...frame, id: pageTargetId(tabId) },
				};
			}
			if (context && typeof context === "object") {
				const auxData = "auxData" in context ? context.auxData : undefined;
				if (auxData && typeof auxData === "object" && "frameId" in auxData && auxData.frameId === tab.mainFrameId) {
					normalized = {
						...normalized,
						context: {
							...context,
							auxData: { ...auxData, frameId: pageTargetId(tabId) },
						},
					};
				}
			}
			eventParams = normalized;
		}
		// Track real child sessions so downstream commands can route back.
		if (method === "Target.attachedToTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.add(child);
				this.#realSessionTabs.set(child, tabId);
			}
		} else if (method === "Target.detachedFromTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.delete(child);
				this.#realSessionTabs.delete(child);
			}
		} else if (method === "Runtime.executionContextCreated") {
			const context = eventParams?.context as { id?: number } | undefined;
			if (context && typeof context.id === "number") {
				tab.executionContexts.set(context.id, eventParams as Record<string, unknown>);
			}
		} else if (method === "Runtime.executionContextDestroyed") {
			const id = params?.executionContextId;
			if (typeof id === "number") {
				tab.executionContexts.delete(id);
			}
		} else if (method === "Runtime.executionContextsCleared") {
			tab.executionContexts.clear();
		}
		if (sourceSessionId) {
			// Event from a real child session: pass through verbatim to every
			// connection that observes this tab.
			const payload = JSON.stringify({ sessionId: sourceSessionId, method, params: params });
			for (const conn of this.#conns.values()) {
				if (conn.sessionsForTab(tabId, "page").length > 0) conn.socket.send(payload);
			}
			return;
		}
		// Root-session event: fan out once per minted page session.
		for (const conn of this.#conns.values()) {
			for (const pageSession of conn.sessionsForTab(tabId, "page")) {
				conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params: eventParams }));
			}
		}
	}
	#onTabDetached(tabId: number, reason: string): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		this.#log("tab detached", { tabId, reason });
		tab.attached = false;
		tab.attaching = null;
		tab.banned = true;
		// The user dismissed the debugger infobar (or the attach was torn
		// down): release the tab's omp-group membership too.
		this.#syncTabGrouping(tab);
		this.#retractTab(tab);
	}

	#onTabRemoved(tabId: number): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		this.#retractTab(tab);
		this.#tabs.delete(tabId);
		for (const conn of this.#conns.values()) conn.claims.delete(tabId);
	}

	#onTabUpsert(snap: TabSnapshot, opts: { silent?: boolean } = {}): void {
		let tab = this.#tabs.get(snap.tabId);
		if (!tab) {
			tab = new TabState(snap.tabId, snap);
			this.#tabs.set(snap.tabId, tab);
		} else {
			if (tab.url !== snap.url) tab.banned = false;
			// The user dragging a tab out of the omp group is an opt-out; the
			// relay never fights the user over grouping.
			if (tab.grouped && tab.ompGroupId !== undefined && snap.groupId !== tab.ompGroupId) {
				tab.grouped = false;
				tab.groupOptOut = true;
			}
			tab.update(snap);
		}
		if (opts.silent) return;
		const eligible = this.#eligible(tab);
		this.#syncTabGrouping(tab);
		if (eligible && !tab.announced) {
			tab.announced = true;
			for (const conn of this.#conns.values()) {
				if (!conn.discover) continue;
				this.#emit(
					conn,
					"Target.targetCreated",
					{ targetInfo: this.#tabInfo(tab, tab.attached) },
					conn.discoverSessionId,
				);
				this.#emit(
					conn,
					"Target.targetCreated",
					{ targetInfo: this.#pageInfo(tab, tab.attached) },
					conn.discoverSessionId,
				);
			}
			for (const conn of this.#conns.values()) {
				if (!conn.autoAttach) continue;
				void this.#ensureAttached(tab).then(ok => {
					if (ok) this.#emitTabAttached(conn, tab, conn.autoAttachSessionId);
				});
			}
			return;
		}
		if (!eligible && tab.announced) {
			this.#retractTab(tab);
			return;
		}
		if (eligible && tab.announced) {
			for (const conn of this.#conns.values()) {
				if (!conn.discover) continue;
				this.#emit(
					conn,
					"Target.targetInfoChanged",
					{ targetInfo: this.#tabInfo(tab, tab.attached) },
					conn.discoverSessionId,
				);
				this.#emit(
					conn,
					"Target.targetInfoChanged",
					{ targetInfo: this.#pageInfo(tab, tab.attached) },
					conn.discoverSessionId,
				);
			}
		}
	}

	// ---- tab grouping -----------------------------------------------------------

	/** A tab belongs in the omp group when claimed by a client, controllable, unpinned, not user-opted-out, and not already in a user group. */
	#groupWorthy(tab: TabState): boolean {
		if (!this.#claimed(tab.tabId) || !this.#eligible(tab) || tab.pinned || tab.groupOptOut) return false;
		return tab.grouped || tab.groupId === -1;
	}

	/** Re-group every claimed tab (extension hello / reconnect). */
	#syncGrouping(): void {
		if (!this.#group) return;
		const worthy = [...this.#tabs.values()].filter(tab => this.#groupWorthy(tab) && !tab.grouped && !tab.grouping);
		if (worthy.length > 0) this.#requestGroup(worthy);
	}

	/** Reconcile one tab's group membership after a lifecycle event. */
	#syncTabGrouping(tab: TabState): void {
		if (!this.#group) return;
		if (this.#groupWorthy(tab)) {
			if (!tab.grouped && !tab.grouping) this.#requestGroup([tab]);
			return;
		}
		if (tab.grouped) {
			tab.grouped = false;
			tab.ompGroupId = undefined;
			void this.#rpc({ op: "ungroup", tabIds: [tab.tabId] }).catch(() => {});
		}
	}

	/**
	 * Queue tabs for grouping and drain serially. Overlapping group RPCs race
	 * the extension's non-atomic query→create→set-title sequence and mint
	 * duplicate omp groups, so at most one group RPC is ever in flight.
	 */
	#requestGroup(tabs: TabState[]): void {
		if (!this.#group) return;
		for (const tab of tabs) {
			tab.grouping = true;
			this.#groupQueue.push(tab);
		}
		if (!this.#groupDraining) void this.#drainGroupQueue();
	}

	async #drainGroupQueue(): Promise<void> {
		const group = this.#group;
		if (!group) return;
		this.#groupDraining = true;
		try {
			while (this.#groupQueue.length > 0) {
				const batch = this.#groupQueue.splice(0);
				const tabIds = batch.map(tab => tab.tabId);
				try {
					const result = await this.#rpc({ op: "group", tabIds, title: group.title, color: group.color });
					// Extension replies { grouped: { [tabId]: groupId } }; validate per entry.
					const grouped: Record<string, unknown> =
						result &&
						typeof result === "object" &&
						"grouped" in result &&
						result.grouped &&
						typeof result.grouped === "object"
							? (result.grouped as Record<string, unknown>)
							: {};
					for (const tab of batch) {
						const groupId = grouped[String(tab.tabId)];
						if (typeof groupId !== "number") continue;
						tab.grouped = true;
						tab.ompGroupId = groupId;
					}
					this.#log("grouped tabs", { tabIds, grouped });
				} catch (err) {
					this.#log("tab grouping failed", { error: err instanceof Error ? err.message : String(err) });
				} finally {
					for (const tab of batch) tab.grouping = false;
				}
			}
		} finally {
			this.#groupDraining = false;
		}
	}

	/** Tear a tab out of every downstream connection (closed, detached, or now ineligible). */
	#retractTab(tab: TabState): void {
		for (const realSession of tab.realSessions) this.#realSessionTabs.delete(realSession);
		tab.realSessions.clear();
		for (const conn of this.#conns.values()) {
			const tabSessions = conn.sessionsForTab(tab.tabId, "tab");
			const browserSessionId = conn.autoAttachSessionId;
			const pageParentSessionId = tabSessions[0] ?? browserSessionId;
			for (const pageSession of conn.sessionsForTab(tab.tabId, "page")) {
				conn.sessions.delete(pageSession);
				this.#emit(
					conn,
					"Target.detachedFromTarget",
					{ sessionId: pageSession, targetId: pageTargetId(tab.tabId) },
					pageParentSessionId,
				);
			}
			for (const tabSession of tabSessions) {
				conn.sessions.delete(tabSession);
				this.#emit(
					conn,
					"Target.detachedFromTarget",
					{ sessionId: tabSession, targetId: tabTargetId(tab.tabId) },
					browserSessionId,
				);
			}
			if (conn.discover && tab.announced) {
				this.#emit(conn, "Target.targetDestroyed", { targetId: pageTargetId(tab.tabId) }, conn.discoverSessionId);
				this.#emit(conn, "Target.targetDestroyed", { targetId: tabTargetId(tab.tabId) }, conn.discoverSessionId);
			}
		}
		tab.announced = false;
	}

	// ---- session + attach bookkeeping --------------------------------------------

	#mintSession(conn: CdpConnection, kind: "tab" | "page", tabId: number): string {
		const prefix = kind === "tab" ? "ST" : "SP";
		const sessionId = `${prefix}${tabId}.${conn.id}.${++this.#sessionSeq}`;
		conn.sessions.set(sessionId, { kind, tabId });
		return sessionId;
	}

	#replayExecutionContexts(conn: CdpConnection, tabId: number, sessionId: string): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		for (const params of tab.executionContexts.values()) {
			let replayParams = params;
			const context = params.context;
			if (tab.mainFrameId && context && typeof context === "object") {
				const auxData = "auxData" in context ? context.auxData : undefined;
				if (auxData && typeof auxData === "object" && "frameId" in auxData && auxData.frameId === tab.mainFrameId) {
					replayParams = {
						...params,
						context: {
							...context,
							auxData: { ...auxData, frameId: pageTargetId(tabId) },
						},
					};
				}
			}
			this.#emit(conn, "Runtime.executionContextCreated", replayParams, sessionId);
		}
	}

	#releaseSession(conn: CdpConnection, sessionId: string, parentSessionId: string | undefined): void {
		const ref = conn.sessions.get(sessionId);
		if (!ref) return;
		conn.sessions.delete(sessionId);
		if (ref.kind === "browser") {
			if (conn.discoverSessionId === sessionId) {
				conn.discover = false;
				conn.discoverSessionId = undefined;
			}
			if (conn.autoAttachSessionId === sessionId) {
				conn.autoAttach = false;
				conn.autoAttachSessionId = undefined;
			}
		}
		this.#emit(conn, "Target.detachedFromTarget", { sessionId }, parentSessionId);
	}

	/** Connections currently holding any session on a tab. */
	#sessionHolders(tabId: number): CdpConnection[] {
		const out: CdpConnection[] = [];
		for (const conn of this.#conns.values()) {
			if (conn.sessionsForTab(tabId).length > 0) out.push(conn);
		}
		return out;
	}

	#emitTabAttached(conn: CdpConnection, tab: TabState, parentSessionId = conn.autoAttachSessionId): void {
		if (conn.flatten) {
			if (conn.sessionsForTab(tab.tabId, "page").length > 0) return;
			const sessionId = this.#mintSession(conn, "page", tab.tabId);
			this.#emit(
				conn,
				"Target.attachedToTarget",
				{
					sessionId,
					targetInfo: this.#pageInfo(tab, true),
					waitingForDebugger: false,
				},
				parentSessionId,
			);
			return;
		}
		if (conn.sessionsForTab(tab.tabId, "tab").length > 0) return;
		const sessionId = this.#mintSession(conn, "tab", tab.tabId);
		this.#emit(
			conn,
			"Target.attachedToTarget",
			{
				sessionId,
				targetInfo: this.#tabInfo(tab, true),
				waitingForDebugger: false,
			},
			parentSessionId,
		);
	}

	async #ensureAttached(tab: TabState): Promise<boolean> {
		if (tab.attached) return true;
		if (tab.banned || !this.#ext) return false;
		if (tab.attaching) return await tab.attaching;
		const attempt = this.#rpc({ op: "attach", tabId: tab.tabId })
			.then(() => {
				tab.attached = true;
				return true;
			})
			.catch(err => {
				this.#log("attach failed", {
					tabId: tab.tabId,
					url: tab.url,
					error: err instanceof Error ? err.message : String(err),
				});
				tab.banned = true;
				return false;
			})
			.finally(() => {
				tab.attaching = null;
			});
		tab.attaching = attempt;
		return await attempt;
	}

	#eligible(tab: TabState): boolean {
		if (tab.banned) return false;
		if (!tab.url) return true;
		return !INELIGIBLE_URL.test(tab.url);
	}

	#tabInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: tabTargetId(tab.tabId),
			type: "tab",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
			browserContextId: "default",
		};
	}

	#pageInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: pageTargetId(tab.tabId),
			type: "page",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
			browserContextId: "default",
		};
	}

	// ---- plumbing ---------------------------------------------------------------

	#reply(conn: CdpConnection, msg: CdpCommand, result: Record<string, unknown>): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }));
	}

	#replyError(conn: CdpConnection, msg: CdpCommand, message: string, code = CDP_ERROR_SERVER): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code, message } }));
	}

	#emit(conn: CdpConnection, method: string, params: Record<string, unknown>, sessionId?: string): void {
		conn.socket.send(JSON.stringify({ sessionId, method, params }));
	}

	#rpc(req: RelayRpcRequest, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
		const ext = this.#ext;
		if (!ext) return Promise.reject(new Error("relay extension is not connected"));
		const id = ++this.#rpcSeq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pendingRpc.delete(id);
			reject(new Error(`extension rpc '${req.op}' timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pendingRpc.set(id, { resolve, reject, timer });
		ext.send(JSON.stringify({ t: "rpc", id, ...req } satisfies RelayToExtMessage));
		return promise;
	}
}
