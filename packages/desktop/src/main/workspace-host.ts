import type { WebContentsView } from "electron";
import * as electron from "electron";

const { Menu } = electron;

import * as prompt from "@oh-my-pi/pi-utils/prompt";
import type { WorkspaceClient } from "@oh-my-pi/pi-workspace-runtime";
import {
	type ElementScreenshot,
	ElementSelectionCoordinator,
	SELECTION_LIMITS,
	type SelectionAuthScope,
	type StartSelectionOptions,
} from "@oh-my-pi/pi-workspace-runtime/selection";
import type { TerminalOutputFrame } from "@oh-my-pi/pi-workspace-runtime/terminal-protocol";
import type {
	BrowserBounds,
	BrowserNavigationAction,
	BrowserViewState,
	CreateBrowserInput,
	CreateTerminalInput,
	ElementEditState,
	PaneContextMenuAction,
	TerminalViewState,
	UpdateTabInput,
	WorkspaceDocumentV1,
	WorkspaceEvent,
} from "../shared/contracts";
import type { AppSettingsStore } from "./app-settings";
import { defaultWorkspacePath } from "./backend-path";
import elementSelectionPromptTemplate from "./prompts/element-selection.md" with { type: "text" };

export const BROWSER_BG_DARK = "#1c1b1a";
export const BROWSER_BG_LIGHT = "#f6f2eb";
const MAX_WORKSPACE_PANES = 4;

function escapeCssIdentifier(ident: string): string {
	return ident.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function uniqueCommandId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

const DEFAULT_BROWSER_URL = "https://omp.sh";
interface PendingNavigation {
	url: string;
	issuedAt: number;
}

interface BrowserEntry {
	view: WebContentsView;
	state: BrowserViewState;
	attached: boolean;
	bounds: BrowserBounds;
	cssBounds?: BrowserBounds;
	documentEpoch: number;
	authoritativeUrl: string;
	pendingNavigation?: PendingNavigation;
	debuggerAttachedBySelection?: boolean;
}
export type CreateBrowserOptions = CreateBrowserInput;
export type CreateTerminalOptions = CreateTerminalInput;
function paneId(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z0-9-]{8,100}$/i.test(value)) throw new TypeError("Invalid pane id");
	return value;
}

function dimension(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${label} must be a number`);
	}
	const rounded = Math.round(value);
	return Math.max(2, Math.min(500, rounded));
}

function browserUrl(value: unknown, searchEngineTemplate?: string, defaultUrl?: string): URL {
	if (typeof value !== "string") throw new TypeError("Address must be text");
	const address = value.trim();
	if (address.length === 0) return new URL(defaultUrl ?? DEFAULT_BROWSER_URL);
	let candidate = address;
	if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
		const searchTemplate = searchEngineTemplate || "https://www.google.com/search?q=%s";
		const encoded = encodeURIComponent(candidate);
		candidate =
			/\s/.test(candidate) || !candidate.includes(".")
				? searchTemplate.includes("%s")
					? searchTemplate.replace("%s", encoded)
					: `${searchTemplate}${encoded}`
				: `https://${candidate}`;
	}
	const url = new URL(candidate);
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Only HTTP and HTTPS addresses can open here");
	return url;
}

function browserBounds(value: unknown): BrowserBounds {
	if (typeof value !== "object" || value === null) throw new TypeError("Invalid browser bounds");
	const source = value as Record<string, unknown>;
	const numbers = [source.x, source.y, source.width, source.height];
	if (!numbers.every(item => typeof item === "number" && Number.isFinite(item)))
		throw new TypeError("Browser bounds must be finite numbers");
	return {
		x: Math.max(0, Math.round(source.x as number)),
		y: Math.max(0, Math.round(source.y as number)),
		width: Math.max(0, Math.round(source.width as number)),
		height: Math.max(0, Math.round(source.height as number)),
	};
}

export class WorkspaceHost {
	#window: Electron.BaseWindow & { webContents?: Electron.WebContents };
	#visibleBrowsers = new Set<string>();
	#browsers = new Map<string, BrowserEntry>();
	#terminalSubscriptions = new Map<string, () => void>();
	#terminalIds = new Map<string, string>();
	#terminalStates = new Map<string, string>();
	#terminalOffsets = new Map<string, number>();
	#selectionCoordinator: ElementSelectionCoordinator;
	#activeSelectionPaneId?: string;
	#boundScopes = new Map<string, SelectionAuthScope>();
	#client?: WorkspaceClient;
	#settingsStore?: AppSettingsStore;
	constructor(
		window: Electron.BaseWindow & { webContents?: Electron.WebContents },
		settingsStoreOrCdpUrl?: AppSettingsStore | string,
		cdpUrl = "http://127.0.0.1:9222",
	) {
		this.#window = window;
		if (typeof settingsStoreOrCdpUrl !== "string") {
			this.#settingsStore = settingsStoreOrCdpUrl;
		}
		// Retained for constructor compatibility with older callers.
		void cdpUrl;
		this.#selectionCoordinator = new ElementSelectionCoordinator();
		if ("nativeTheme" in electron && electron.nativeTheme && typeof electron.nativeTheme.on === "function") {
			electron.nativeTheme.on("updated", () => this.updateTheme());
		}
	}

	resolveTheme(): "dark" | "light" {
		const setting = this.#settingsStore?.settings.theme;
		if (setting === "light") return "light";
		if (setting === "dark") return "dark";
		if (
			"nativeTheme" in electron &&
			electron.nativeTheme &&
			typeof electron.nativeTheme.shouldUseDarkColors === "boolean"
		) {
			return electron.nativeTheme.shouldUseDarkColors ? "dark" : "light";
		}
		return "dark";
	}

	getBrowserBackgroundColor(): string {
		return this.resolveTheme() === "dark" ? BROWSER_BG_DARK : BROWSER_BG_LIGHT;
	}

	updateTheme(): void {
		const bg = this.getBrowserBackgroundColor();
		for (const entry of this.#browsers.values()) {
			entry.view.setBackgroundColor(bg);
		}
	}
	#getBrowserUrl(value: unknown): URL {
		const settings = this.#settingsStore?.settings;
		return browserUrl(value, settings?.browser?.searchEngine, settings?.browser?.defaultUrl);
	}

	setClient(client: WorkspaceClient): void {
		this.#client = client;
	}

	async replaceClient(newClient: WorkspaceClient): Promise<void> {
		for (const unsubscribe of this.#terminalSubscriptions.values()) {
			try {
				unsubscribe();
			} catch {}
		}
		this.#terminalSubscriptions.clear();
		this.#client = newClient;

		if (newClient.document) {
			this.syncWithDocument(newClient.document);
		}

		const doc = newClient.document;
		if (doc) {
			for (const terminal of doc.terminals) {
				if (!terminal.paneId) continue;
				if (terminal.status === "running" || terminal.status === "starting") {
					const paneId = terminal.paneId;
					this.#terminalIds.set(paneId, terminal.id);
					void this.#subscribeTerminal(paneId, terminal.id).catch(() => {});
				}
			}
		}
	}

	syncWithDocument(document: WorkspaceDocumentV1): void {
		this.#syncBrowserDocument(document);
		this.#selectionCoordinator.syncWithDocument(document);
		const activeTerminalIds = new Set<string>();
		for (const terminal of document.terminals) {
			if (!terminal.paneId) continue;
			activeTerminalIds.add(terminal.paneId);
			this.#terminalIds.set(terminal.paneId, terminal.id);
			const previousStatus = this.#terminalStates.get(terminal.paneId);
			if (previousStatus !== terminal.status) {
				if (terminal.status === "failed") {
					this.#send({
						type: "terminal-error",
						paneId: terminal.paneId,
						message: terminal.error ?? "Terminal failed",
					});
				} else if (terminal.status === "exited") {
					this.#send({ type: "terminal-exit", paneId: terminal.paneId, exitCode: -1 });
				}
				this.#terminalStates.set(terminal.paneId, terminal.status);
			}
		}
		for (const paneId of this.#terminalIds.keys()) {
			if (activeTerminalIds.has(paneId)) continue;
			this.#unsubscribeTerminal(paneId);
			this.#terminalIds.delete(paneId);
			this.#terminalStates.delete(paneId);
			this.#terminalOffsets.delete(paneId);
		}
	}

	async #subscribeTerminal(paneId: string, terminalId: string): Promise<void> {
		const client = this.#client;
		if (!client) throw new Error("WorkspaceClient is not configured");
		if (!this.#terminalSubscriptions.has(paneId)) {
			const removeOutputListener = client.onTerminalOutput(terminalId, (frame: TerminalOutputFrame) => {
				const nextOffset = frame.offset + Buffer.byteLength(frame.data, "utf8");
				const currentOffset = this.#terminalOffsets.get(paneId) ?? 0;
				if (frame.offset < currentOffset) return;
				this.#terminalOffsets.set(paneId, Math.max(currentOffset, nextOffset));
				this.#send({ type: "terminal-data", paneId, data: frame.data });
			});
			this.#terminalSubscriptions.set(paneId, removeOutputListener);
		}
		try {
			const snapshot = await client.subscribeTerminal(terminalId, this.#terminalOffsets.get(paneId) ?? 0);
			if (snapshot.status === "failed") {
				this.#send({ type: "terminal-error", paneId, message: "Terminal failed" });
			}
		} catch (error) {
			this.#unsubscribeTerminal(paneId);
			this.#send({
				type: "terminal-error",
				paneId,
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	#unsubscribeTerminal(paneId: string): void {
		const removeOutputListener = this.#terminalSubscriptions.get(paneId);
		if (removeOutputListener) removeOutputListener();
		this.#terminalSubscriptions.delete(paneId);
	}

	#terminalEntityId(paneId: string): string {
		const terminalId =
			this.#terminalIds.get(paneId) ?? this.#client?.document?.terminals.find(item => item.paneId === paneId)?.id;
		if (!terminalId) throw new Error(`Terminal pane '${paneId}' is unavailable`);
		this.#terminalIds.set(paneId, terminalId);
		return terminalId;
	}
	async createBrowser(options: CreateBrowserInput): Promise<BrowserViewState> {
		if (typeof options !== "object" || options === null) {
			throw new TypeError("CreateBrowserInput must be an object");
		}
		if (
			options.layout !== undefined &&
			options.layout !== "columns" &&
			options.layout !== "rows" &&
			options.layout !== "grid"
		) {
			throw new TypeError("layout must be columns, rows, or grid");
		}
		const id = paneId(options.id);
		const existing = this.#browsers.get(id);
		if (existing) return { ...existing.state };
		const requestedUrl = this.#getBrowserUrl(options.url).toString();

		if (!this.#client?.isConnected || !this.#client.document) {
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		}

		const doc = this.#client.document;
		const durableBrowser = doc.browsers.find(b => b.paneId === id || b.id === id);
		const url = durableBrowser?.url ?? requestedUrl;
		const workspace =
			doc.workspaces.find(w => w.id === options.workspaceId) ??
			doc.workspaces.find(w => w.id === doc.activeWorkspaceId) ??
			doc.workspaces[0];
		if (!workspace) {
			throw new Error(`No active workspace found in authority document`);
		}

		const location = doc.locations.find(l => l.id === workspace.locationId) ?? doc.locations[0];
		if (!location) {
			throw new Error(`Location '${workspace.locationId}' for workspace '${workspace.id}' not found`);
		}

		const targetTabId = options.tabId;

		if (!doc.browsers.some(b => (b.id === id || b.paneId === id) && b.status !== "closed" && b.status !== "failed")) {
			const res = await this.#client.executeCommandWithRetry(currentDoc => ({
				version: 1 as const,
				commandId: uniqueCommandId("cmd-browser-open"),
				workspaceId: workspace.id,
				expectedRevision: currentDoc.revision,
				issuedAt: Date.now(),
				type: "browser.open" as const,
				payload: {
					id: `browser-${id}`,
					paneId: id,
					tabId: targetTabId,
					locationId: location.id,
					url,
					title: "New browser",
					...(options.layout ? { layout: options.layout } : {}),
				},
			}));
			if (res.status !== "accepted" && res.status !== "duplicate") {
				throw new Error(
					`Failed to open browser in runtime: command status '${res.status}' - ${res.error?.message ?? "rejected"}`,
				);
			}
			this.syncWithDocument(res.document);
		}

		return this.#ensureBrowserView(id, url, durableBrowser?.title ?? "New browser");
	}
	#ensureBrowserView(id: string, url: string, title: string): BrowserViewState {
		const existing = this.#browsers.get(id);
		if (existing) {
			if (existing.state.title !== title) {
				existing.state = { ...existing.state, title };
				this.#emitBrowserState(id);
			}
			if (existing.pendingNavigation) {
				if (url === existing.pendingNavigation.url) {
					existing.authoritativeUrl = url;
					existing.pendingNavigation = undefined;
				} else if (url === existing.authoritativeUrl) {
					// In-flight navigation is still pending and incoming doc reflects prior state; ignore stale URL.
					return { ...existing.state };
				} else {
					// Genuinely newer third-party external navigation from another client.
					existing.authoritativeUrl = url;
					existing.pendingNavigation = undefined;
					if (existing.state.url !== url) {
						existing.state = { ...existing.state, url, loading: true, error: undefined };
						this.#emitBrowserState(id);
						void existing.view.webContents
							.loadURL(url)
							.catch((error: unknown) => this.#setBrowserError(id, error));
					}
				}
			} else {
				existing.authoritativeUrl = url;
				if (existing.state.url !== url) {
					existing.state = { ...existing.state, url, loading: true, error: undefined };
					this.#emitBrowserState(id);
					void existing.view.webContents.loadURL(url).catch((error: unknown) => this.#setBrowserError(id, error));
				}
			}
			return { ...existing.state };
		}
		const view = new electron.WebContentsView({
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webSecurity: true,
			},
		});
		view.setBackgroundColor(this.getBrowserBackgroundColor());
		const entry: BrowserEntry = {
			view,
			attached: false,
			bounds: { x: 0, y: 0, width: 0, height: 0 },
			state: { id, url, title, canGoBack: false, canGoForward: false, loading: true },
			documentEpoch: 1,
			authoritativeUrl: url,
		};
		this.#browsers.set(id, entry);
		this.#bindBrowser(id, entry);
		if (this.#visibleBrowsers.has(id)) this.#attach(entry);
		void view.webContents.loadURL(url).catch((error: unknown) => this.#setBrowserError(id, error));
		return { ...entry.state };
	}

	#syncBrowserDocument(document: WorkspaceDocumentV1): void {
		const durableIds = new Set<string>();
		for (const browser of document.browsers) {
			if (browser.status === "closed") continue;
			const id = browser.paneId ?? browser.id;
			durableIds.add(id);
			this.#ensureBrowserView(id, browser.url, browser.title ?? "Browser");
		}
		for (const id of this.#browsers.keys()) {
			if (!durableIds.has(id)) this.destroyBrowserView(id);
		}
	}

	async navigateBrowser(rawId: unknown, rawUrl: unknown): Promise<BrowserViewState> {
		const id = paneId(rawId);
		const url = this.#getBrowserUrl(rawUrl).toString();
		const entry = this.#requireBrowser(id);
		entry.pendingNavigation = { url, issuedAt: Date.now() };

		const client = this.#client;
		if (!client?.isConnected || !client.document)
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		const browser = client.document.browsers.find(item => item.paneId === id || item.id === id);
		const pane = browser ? client.document.panes.find(item => item.entityId === browser.id) : undefined;
		const tab = pane ? client.document.tabs.find(item => item.id === pane.tabId) : undefined;
		if (!browser || !tab) throw new Error(`Browser pane '${id}' is unavailable`);
		const result = await client.executeCommandWithRetry(currentDocument => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-browser-nav"),
			workspaceId: tab.workspaceId,
			expectedRevision: currentDocument.revision,
			issuedAt: Date.now(),
			type: "browser.navigate" as const,
			payload: { id: browser.id, url },
		}));
		if (result.status === "rejected") {
			if (entry.pendingNavigation?.url === url) {
				entry.pendingNavigation = undefined;
			}
			const rollbackUrl = entry.authoritativeUrl;
			entry.state = { ...entry.state, url: rollbackUrl };
			this.#setBrowserError(id, new Error(`Failed to navigate browser: ${result.error?.message ?? "rejected"}`));
			void entry.view.webContents.loadURL(rollbackUrl).catch((error: unknown) => this.#setBrowserError(id, error));
			throw new Error(`Failed to navigate browser: ${result.error?.message ?? result.status}`);
		}
		if (result.status === "accepted" || result.status === "duplicate") {
			if (entry.pendingNavigation?.url === url) {
				entry.pendingNavigation = undefined;
			}
			entry.authoritativeUrl = url;
			this.syncWithDocument(result.document);
			if (entry.state.url !== url) {
				entry.state = { ...entry.state, url, loading: true, error: undefined };
				this.#emitBrowserState(id);
				void entry.view.webContents.loadURL(url).catch((error: unknown) => this.#setBrowserError(id, error));
			}
		}
		return { ...entry.state };
	}

	controlBrowser(rawId: unknown, rawAction: unknown): void {
		const id = paneId(rawId);
		const entry = this.#browsers.get(id);
		if (!entry) return;
		if (rawAction !== "back" && rawAction !== "forward" && rawAction !== "reload" && rawAction !== "stop")
			throw new TypeError("Invalid browser action");
		const action: BrowserNavigationAction = rawAction;
		const history = entry.view.webContents.navigationHistory;
		if (action === "back" && history.canGoBack()) history.goBack();
		else if (action === "forward" && history.canGoForward()) history.goForward();
		else if (action === "reload") entry.view.webContents.reload();
		else if (action === "stop") entry.view.webContents.stop();
	}

	setBrowserBounds(rawId: unknown, rawBounds: unknown): void {
		const entry = this.#requireBrowser(paneId(rawId));
		const raw = browserBounds(rawBounds);
		entry.cssBounds = raw;
		entry.bounds = this.#toDipBounds(raw);
		if (entry.attached && entry.bounds.width > 0 && entry.bounds.height > 0) entry.view.setBounds(entry.bounds);
	}

	#toDipBounds(cssBounds: BrowserBounds): BrowserBounds {
		const zoomFactor =
			typeof this.#window.webContents?.getZoomFactor === "function" ? this.#window.webContents.getZoomFactor() : 1;
		const factor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
		return {
			x: Math.round(cssBounds.x * factor),
			y: Math.round(cssBounds.y * factor),
			width: Math.max(0, Math.round(cssBounds.width * factor)),
			height: Math.max(0, Math.round(cssBounds.height * factor)),
		};
	}

	updateZoomBounds(): void {
		for (const entry of this.#browsers.values()) {
			if (entry.cssBounds) {
				entry.bounds = this.#toDipBounds(entry.cssBounds);
				if (entry.attached && entry.bounds.width > 0 && entry.bounds.height > 0) {
					entry.view.setBounds(entry.bounds);
				}
			}
		}
	}

	setVisibleBrowsers(value: unknown): void {
		if (!Array.isArray(value) || value.length > 32) throw new TypeError("Invalid visible browser list");
		const ids = value.map(paneId);
		this.#visibleBrowsers = new Set(ids);
		for (const [id, entry] of this.#browsers) {
			if (this.#visibleBrowsers.has(id)) this.#attach(entry);
			else this.#detach(entry);
		}
	}

	async closeBrowser(rawId: unknown): Promise<void> {
		const id = paneId(rawId);
		if (this.#activeSelectionPaneId === id) {
			await this.#endSelection(id, "Browser closed");
		}

		if (!this.#client?.isConnected || !this.#client.document) {
			this.destroyBrowserView(id);
			return;
		}

		const doc = this.#client.document;
		const browser = doc.browsers.find(b => b.paneId === id || b.id === id);
		if (!browser || browser.status === "closed") {
			this.destroyBrowserView(id);
			return;
		}

		const pane = doc.panes.find(item => item.entityId === browser.id);
		const tab = pane ? doc.tabs.find(item => item.id === pane.tabId) : undefined;
		const workspaceId =
			tab?.workspaceId ??
			doc.workspaces.find(w => w.locationId === browser.locationId)?.id ??
			doc.activeWorkspaceId ??
			"workspace-default";

		const res = await this.#client.executeCommandWithRetry(currentDoc => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-browser-close"),
			workspaceId,
			expectedRevision: currentDoc.revision,
			issuedAt: Date.now(),
			type: "browser.close" as const,
			payload: { id: browser.id },
		}));

		if (res.status === "rejected") {
			throw new Error(`Failed to close browser in runtime: ${res.error?.message ?? "rejected"}`);
		}

		this.syncWithDocument(res.document);
		if (this.#browsers.has(id)) {
			this.destroyBrowserView(id);
		}
	}

	destroyBrowserView(id: string): void {
		const entry = this.#browsers.get(id);
		if (!entry) return;

		void this.#endSelection(id, "Browser view destroyed");

		this.#browsers.delete(id);
		this.#visibleBrowsers.delete(id);
		this.#detach(entry);
		if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close?.();
	}
	async updateTab(rawTabId: unknown, rawUpdates: unknown): Promise<void> {
		const tabId = typeof rawTabId === "string" ? rawTabId.trim() : "";
		if (!tabId) throw new TypeError("Invalid tab id");
		const updates = typeof rawUpdates === "object" && rawUpdates !== null ? (rawUpdates as UpdateTabInput) : {};
		if (!this.#client?.isConnected || !this.#client.document) {
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		}
		const payload: Record<string, unknown> = { id: tabId };
		if (typeof updates.name === "string" && updates.name.trim().length > 0) payload.name = updates.name.trim();
		if (updates.layout === "columns" || updates.layout === "rows" || updates.layout === "grid")
			payload.layout = updates.layout;
		if (typeof updates.ratio === "number" && Number.isFinite(updates.ratio)) payload.ratio = updates.ratio;
		if (typeof updates.activePaneId === "string" && updates.activePaneId.trim().length > 0)
			payload.activePaneId = updates.activePaneId.trim();

		const res = await this.#client.executeCommandWithRetry(currentDoc => {
			const tab = currentDoc.tabs.find(t => t.id === tabId);
			if (!tab) throw new Error(`Tab '${tabId}' not found`);
			return {
				version: 1 as const,
				commandId: uniqueCommandId("cmd-tab-update"),
				workspaceId: tab.workspaceId,
				expectedRevision: currentDoc.revision,
				issuedAt: Date.now(),
				type: "tab.update" as const,
				payload,
			};
		});
		if (res.status === "accepted" || res.status === "duplicate") {
			this.syncWithDocument(res.document);
		}
	}

	async closeTab(rawTabId: unknown): Promise<void> {
		const tabId = typeof rawTabId === "string" ? rawTabId.trim() : "";
		if (!tabId) throw new TypeError("Invalid tab id");
		if (!this.#client?.isConnected || !this.#client.document) return;
		const doc = this.#client.document;
		const tab = doc.tabs.find(t => t.id === tabId);
		if (!tab) {
			for (const id of this.#browsers.keys()) {
				const pane = doc.panes.find(p => p.id === id);
				if (pane && pane.tabId === tabId) this.destroyBrowserView(id);
			}
			return;
		}

		const res = await this.#client.executeCommandWithRetry(currentDoc => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-tab-close"),
			workspaceId: tab.workspaceId,
			expectedRevision: currentDoc.revision,
			issuedAt: Date.now(),
			type: "tab.close" as const,
			payload: { id: tabId },
		}));

		if (res.status === "rejected") {
			throw new Error(`Failed to close tab in runtime: ${res.error?.message ?? "rejected"}`);
		}

		this.syncWithDocument(res.document);
	}

	async closePane(rawPaneId: unknown): Promise<void> {
		const id = paneId(rawPaneId);
		const doc = this.#client?.document;
		const paneRecord = doc?.panes.find(p => p.id === id);
		if (paneRecord?.kind === "browser" || this.#browsers.has(id)) {
			await this.closeBrowser(id);
		} else {
			await this.closeTerminal(id);
		}
	}

	async createTerminal(options: CreateTerminalInput): Promise<TerminalViewState> {
		if (typeof options !== "object" || options === null) {
			throw new TypeError("CreateTerminalInput must be an object");
		}
		if (
			options.layout !== undefined &&
			options.layout !== "columns" &&
			options.layout !== "rows" &&
			options.layout !== "grid"
		) {
			throw new TypeError("layout must be columns, rows, or grid");
		}
		const id = paneId(options.id);
		const columns = dimension(options.cols, "Terminal columns");
		const rows = dimension(options.rows, "Terminal rows");
		const client = this.#client;
		if (!client?.isConnected || !client.document) {
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		}
		const document = client.document;
		const workspace =
			document.workspaces.find(item => item.id === options.workspaceId) ??
			document.workspaces.find(item => item.id === document.activeWorkspaceId) ??
			document.workspaces[0];
		if (!workspace) throw new Error("No active workspace found in authority document");
		const location = document.locations.find(item => item.id === workspace.locationId);
		if (!location) throw new Error(`Location '${workspace.locationId}' does not exist`);
		let terminal = document.terminals.find(item => item.paneId === id);
		if (!terminal || terminal.status === "closed") {
			const result = await client.executeCommandWithRetry(currentDocument => ({
				version: 1 as const,
				commandId: uniqueCommandId("cmd-terminal-open"),
				workspaceId: workspace.id,
				expectedRevision: currentDocument.revision,
				issuedAt: Date.now(),
				type: "terminal.open" as const,
				payload: {
					id: terminal?.id ?? `term-${id}`,
					paneId: id,
					tabId: options.tabId,
					locationId: location.id,
					label: "Terminal",
					columns,
					rows,
					cwd: this.#settingsStore?.settings.workspace.defaultPath ?? defaultWorkspacePath(),
					...(options.layout ? { layout: options.layout } : {}),
					...(this.#settingsStore?.settings.terminal.shell
						? { shell: this.#settingsStore.settings.terminal.shell }
						: {}),
				},
			}));
			if (result.status !== "accepted" && result.status !== "duplicate") {
				throw new Error(
					`Failed to open terminal in runtime: command status '${result.status}' - ${result.error?.message ?? "rejected"}`,
				);
			}
			this.syncWithDocument(result.document);
			terminal = result.document.terminals.find(item => item.paneId === id);
		}
		if (!terminal) throw new Error(`Terminal pane '${id}' was not created`);
		this.#terminalIds.set(id, terminal.id);
		await this.#subscribeTerminal(id, terminal.id);
		return { id, cwd: terminal.cwd ?? defaultWorkspacePath() };
	}

	async writeTerminal(rawId: unknown, rawData: unknown): Promise<void> {
		const id = paneId(rawId);
		if (typeof rawData !== "string" || Buffer.byteLength(rawData, "utf8") > 512 * 1024)
			throw new TypeError("Invalid terminal input");
		const terminalId = this.#terminalEntityId(id);
		if (!this.#client) throw new Error("WorkspaceClient is not configured");
		await this.#client.sendTerminalInput(terminalId, rawData);
	}

	async resizeTerminal(rawId: unknown, rawCols: unknown, rawRows: unknown): Promise<void> {
		const id = paneId(rawId);
		const terminalId = this.#terminalEntityId(id);
		if (!this.#client) throw new Error("WorkspaceClient is not configured");
		await this.#client.resizeTerminal(
			terminalId,
			dimension(rawCols, "Terminal columns"),
			dimension(rawRows, "Terminal rows"),
		);
	}

	async closeTerminal(rawId: unknown): Promise<void> {
		const id = paneId(rawId);
		const client = this.#client;
		if (!client?.isConnected || !client.document) {
			this.#unsubscribeTerminal(id);
			this.#terminalIds.delete(id);
			this.#terminalStates.delete(id);
			this.#terminalOffsets.delete(id);
			return;
		}

		const terminalId = this.#terminalIds.get(id) ?? client.document.terminals.find(item => item.paneId === id)?.id;
		if (!terminalId) {
			this.#unsubscribeTerminal(id);
			this.#terminalIds.delete(id);
			this.#terminalStates.delete(id);
			this.#terminalOffsets.delete(id);
			return;
		}

		const terminal = client.document.terminals.find(item => item.id === terminalId);
		if (!terminal || terminal.status === "closed") {
			this.#unsubscribeTerminal(id);
			this.#terminalIds.delete(id);
			this.#terminalStates.delete(id);
			this.#terminalOffsets.delete(id);
			return;
		}

		const pane = client.document.panes.find(item => item.entityId === terminalId);
		const tab = pane ? client.document.tabs.find(item => item.id === pane.tabId) : undefined;
		const workspaceId =
			tab?.workspaceId ??
			(terminal.locationId
				? client.document.workspaces.find(w => w.locationId === terminal.locationId)?.id
				: undefined) ??
			client.document.activeWorkspaceId ??
			"workspace-default";

		const result = await client.executeCommandWithRetry(currentDocument => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-terminal-close"),
			workspaceId,
			expectedRevision: currentDocument.revision,
			issuedAt: Date.now(),
			type: "terminal.close" as const,
			payload: { id: terminal.id },
		}));

		if (result.status === "rejected") {
			throw new Error(`Failed to close terminal in runtime: ${result.error?.message ?? "rejected"}`);
		}

		this.syncWithDocument(result.document);
		if (this.#terminalIds.has(id)) {
			this.#unsubscribeTerminal(id);
			this.#terminalIds.delete(id);
			this.#terminalStates.delete(id);
			this.#terminalOffsets.delete(id);
		}
	}
	showPaneContextMenu(rawId: unknown, rawCanSplit: unknown): void {
		const id = paneId(rawId);
		if (typeof rawCanSplit !== "boolean") throw new TypeError("Pane split availability must be boolean");
		const select = (action: PaneContextMenuAction): void => {
			this.#send({ type: "pane-context-action", paneId: id, action });
		};
		const menu = Menu.buildFromTemplate([
			{ label: "Split Right", enabled: rawCanSplit, click: () => select("split-columns") },
			{ label: "Split Down", enabled: rawCanSplit, click: () => select("split-rows") },
			{ type: "separator" },
			{ label: "Close Pane", click: () => select("close") },
		]);
		menu.popup({ window: this.#window });
	}
	async #endSelection(paneId: string, reason?: string): Promise<void> {
		const entry = this.#browsers.get(paneId);
		if (entry && !entry.view.webContents.isDestroyed()) {
			try {
				if (entry.view.webContents.debugger.isAttached()) {
					await entry.view.webContents.debugger.sendCommand("Overlay.hideHighlight").catch(() => {});
					await entry.view.webContents.debugger
						.sendCommand("Overlay.setInspectMode", {
							mode: "none",
							highlightConfig: {},
						})
						.catch(() => {});
					if (entry.debuggerAttachedBySelection) {
						entry.view.webContents.debugger.detach();
						entry.debuggerAttachedBySelection = false;
					}
				}
			} catch {}
		}

		const scope = this.#boundScopes.get(paneId);
		if (scope) {
			this.#selectionCoordinator.cancelSelection(scope, undefined, reason);
			this.#boundScopes.delete(paneId);
			const activeId = this.#selectionCoordinator.activeSelectionId;
			if (activeId) this.#boundScopes.delete(activeId);
		}
		if (this.#activeSelectionPaneId === paneId) {
			this.#activeSelectionPaneId = undefined;
		}
		this.#emitSelectionState({ phase: "idle", paneId, updatedAt: Date.now() });
	}

	async startSelection(scope: SelectionAuthScope, options: StartSelectionOptions = {}): Promise<ElementEditState> {
		const id = paneId(scope.paneId);
		if (this.#activeSelectionPaneId && this.#activeSelectionPaneId !== id) {
			await this.#endSelection(this.#activeSelectionPaneId, "Switching selection to another pane");
		}
		const entry = this.#requireBrowser(id);
		this.#activeSelectionPaneId = id;
		this.#boundScopes.set(id, scope);

		const state = this.#selectionCoordinator.startSelection(scope, {
			...options,
			url: entry.state.url,
		});
		if (state.selectionId) {
			this.#boundScopes.set(state.selectionId, scope);
		}

		const { webContents } = entry.view;
		if (!webContents.isDestroyed()) {
			try {
				if (!webContents.debugger.isAttached()) {
					webContents.debugger.attach("1.3");
					entry.debuggerAttachedBySelection = true;
				}
				await webContents.debugger.sendCommand("DOM.enable");
				await webContents.debugger.sendCommand("Overlay.enable");
				await webContents.debugger.sendCommand("Overlay.setInspectMode", {
					mode: "searchForNode",
					highlightConfig: {
						showInfo: true,
						showRulers: false,
						showExtensionLines: false,
						contentColor: { r: 249, g: 115, b: 22, a: 0.2 },
						borderColor: { r: 249, g: 115, b: 22, a: 1.0 },
					},
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const errState = this.#selectionCoordinator.reportError(
					scope,
					state.selectionId ?? "",
					"inspect_setup_failed",
					message,
				);
				this.#emitSelectionState(errState);
				return errState;
			}
		}
		this.#emitSelectionState(state);
		return state;
	}

	async #handleInspectNodeRequested(
		_id: string,
		entry: BrowserEntry,
		scope: SelectionAuthScope,
		activeId: string,
		backendNodeId: number,
	): Promise<void> {
		const { webContents } = entry.view;
		if (webContents.isDestroyed()) return;
		try {
			const desc = (await webContents.debugger.sendCommand("DOM.describeNode", {
				backendNodeId,
				depth: 1,
				pierce: true,
			})) as { node?: { localName?: string; attributes?: string[] } };

			const box = (await webContents.debugger.sendCommand("DOM.getBoxModel", {
				backendNodeId,
			})) as { model?: { border: number[]; width: number; height: number } };

			const node = desc?.node;
			if (!node) return;

			const attrMap: Record<string, string> = {};
			if (Array.isArray(node.attributes)) {
				for (let i = 0; i < node.attributes.length; i += 2) {
					attrMap[node.attributes[i].toLowerCase()] = node.attributes[i + 1] || "";
				}
			}

			const tag = (node.localName || "div").toLowerCase();
			let selector: string;
			if (attrMap.id?.trim()) {
				selector = `#${escapeCssIdentifier(attrMap.id.trim())}`;
			} else if (attrMap["data-testid"]?.trim()) {
				selector = `[data-testid="${attrMap["data-testid"].trim()}"]`;
			} else if (attrMap["data-test"]?.trim()) {
				selector = `[data-test="${attrMap["data-test"].trim()}"]`;
			} else if (attrMap.class?.trim()) {
				const classes = attrMap.class.trim().split(/\s+/).map(escapeCssIdentifier).join(".");
				selector = `${tag}.${classes}`;
			} else if (attrMap["aria-label"]?.trim()) {
				selector = `${tag}[aria-label="${attrMap["aria-label"].trim()}"]`;
			} else if (attrMap.name?.trim()) {
				selector = `${tag}[name="${attrMap.name.trim()}"]`;
			} else {
				selector = tag;
			}

			let html: string | undefined;
			try {
				const htmlRes = (await webContents.debugger.sendCommand("DOM.getOuterHTML", {
					backendNodeId,
				})) as { outerHTML?: string };
				if (htmlRes?.outerHTML) {
					html = htmlRes.outerHTML.slice(0, SELECTION_LIMITS.maxDomBytes);
				}
			} catch {}

			const border = box?.model?.border || [0, 0, 0, 0, 0, 0, 0, 0];
			const x = border[0] ?? 0;
			const y = border[1] ?? 0;
			const width = box?.model?.width ?? (border[2] ? border[2] - border[0] : 0);
			const height = box?.model?.height ?? (border[5] ? border[5] - border[1] : 0);

			const updated = this.#selectionCoordinator.updateSelection(scope, activeId, {
				backendNodeId,
				selector,
				domSnapshot: {
					selector,
					tagName: tag,
					role: attrMap.role,
					name: attrMap["aria-label"] || attrMap.title,
					html,
					attributes: attrMap,
					bounds: { x, y, width, height, top: y, left: x, bottom: y + height, right: x + width },
					hierarchy: ["body", "html"],
				},
				url: entry.state.url,
			});
			this.#emitSelectionState(updated);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const errState = this.#selectionCoordinator.reportError(scope, activeId, "inspect_node_failed", message);
			this.#emitSelectionState(errState);
		}
	}

	async cancelSelection(rawPaneId: unknown, rawReason?: unknown): Promise<ElementEditState> {
		const id = paneId(rawPaneId);
		const reason = typeof rawReason === "string" ? rawReason : undefined;
		await this.#endSelection(id, reason);
		return { phase: "idle", paneId: id, updatedAt: Date.now() };
	}

	async #deliverSelection(
		scope: SelectionAuthScope,
		selectionState: ElementEditState,
		instruction?: string,
	): Promise<void> {
		const client = this.#client;
		if (!client?.isConnected || !client.document) {
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		}
		const doc = client.document;
		const agent = doc.agents.find(a => a.id === scope.agentId);
		if (!agent) {
			throw new Error(`Target agent '${scope.agentId}' not found in authoritative workspace`);
		}
		if (agent.sessionId !== scope.sessionId) {
			throw new Error(`Target agent '${scope.agentId}' session mismatch`);
		}

		const promptData = {
			url: selectionState.url,
			selector: selectionState.selector,
			tagName: selectionState.selectedElement?.tagName || selectionState.domSnapshot?.tagName,
			captureMode: selectionState.captureMode,
			summary: selectionState.selectedElement?.summary || selectionState.domSnapshot?.summary,
			text: selectionState.selectedElement?.text || selectionState.domSnapshot?.text,
			screenshotAttached: Boolean(selectionState.screenshot),
			screenshotWidth: selectionState.screenshot?.width,
			screenshotHeight: selectionState.screenshot?.height,
			domHtml: selectionState.selectedElement?.html || selectionState.domSnapshot?.html,
			instruction: instruction?.trim() || undefined,
		};

		const promptText = prompt.render(elementSelectionPromptTemplate, promptData);

		const result = await client.executeCommandWithRetry(currentDocument => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-selection-deliver"),
			workspaceId: scope.workspaceId,
			expectedRevision: currentDocument.revision,
			issuedAt: Date.now(),
			type: "agent.message" as const,
			payload: {
				id: agent.id,
				message: promptText,
				selector: selectionState.selector,
				url: selectionState.url,
				...(selectionState.selectedElement || selectionState.domSnapshot
					? { domSnapshot: selectionState.selectedElement || selectionState.domSnapshot }
					: {}),
				...(selectionState.screenshot ? { screenshot: selectionState.screenshot } : {}),
			},
		}));

		if (result.status === "rejected") {
			throw new Error(result.error?.message ?? "Delivery rejected by workspace runtime");
		}
	}

	async commitSelection(rawPaneId: unknown, rawInstruction?: unknown): Promise<ElementEditState> {
		const id = paneId(rawPaneId);
		const entry = this.#requireBrowser(id);
		const scope = this.#boundScopes.get(id);
		if (!scope) {
			throw new Error("No active selection scope for pane");
		}
		const activeId = this.#selectionCoordinator.activeSelectionId;
		if (!activeId) return this.#selectionCoordinator.getState(scope);

		const currentState = this.#selectionCoordinator.getState(scope);
		const { webContents } = entry.view;
		if (!webContents.isDestroyed()) {
			try {
				if (
					webContents.debugger &&
					typeof webContents.debugger.isAttached === "function" &&
					webContents.debugger.isAttached()
				) {
					await webContents.debugger.sendCommand("Overlay.hideHighlight").catch(() => {});
					await webContents.debugger
						.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: {} })
						.catch(() => {});
				}

				if (currentState.captureMode === "screenshot" && typeof webContents.capturePage === "function") {
					const nativeImage = await webContents.capturePage();
					const size =
						typeof nativeImage.getSize === "function"
							? nativeImage.getSize()
							: { width: entry.bounds.width, height: entry.bounds.height };
					let buffer = nativeImage.toJPEG(80);
					if (buffer.byteLength > SELECTION_LIMITS.maxImageBytes) {
						buffer = nativeImage.toJPEG(60);
					}
					const base64 = buffer.toString("base64");
					const screenshot: ElementScreenshot = {
						dataUrl: `data:image/jpeg;base64,${base64}`,
						base64,
						mimeType: "image/jpeg",
						width: size.width,
						height: size.height,
						byteLength: buffer.byteLength,
					};

					this.#selectionCoordinator.updateSelection(scope, activeId, {
						screenshot,
						url: entry.state.url,
					});
				}
			} catch {}
		}

		const committedState = this.#selectionCoordinator.commitSelection(scope, activeId);

		const instruction = typeof rawInstruction === "string" ? rawInstruction.trim() : undefined;

		try {
			await this.#deliverSelection(scope, committedState, instruction);
			await this.#endSelection(id, "Delivered");
			return { phase: "idle", paneId: id, updatedAt: Date.now() };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const errState = this.#selectionCoordinator.reportError(scope, activeId, "delivery_failed", message);
			this.#emitSelectionState(errState);
			return errState;
		}
	}

	getSelectionState(rawPaneId: unknown): ElementEditState {
		const id = paneId(rawPaneId);
		const scope = this.#boundScopes.get(id);
		if (scope) {
			return this.#selectionCoordinator.getState(scope);
		}
		return { phase: "idle", updatedAt: Date.now() };
	}

	getBrowserDocumentEpoch(rawPaneId: unknown): number {
		const id = paneId(rawPaneId);
		const entry = this.#browsers.get(id);
		if (!entry) {
			throw new Error(`Browser pane '${id}' not found`);
		}
		return entry.documentEpoch;
	}
	#emitSelectionState(state: ElementEditState): void {
		if (!this.#window.isDestroyed() && this.#window.webContents && !this.#window.webContents.isDestroyed()) {
			this.#window.webContents.send("branchlight:selection-state", state);
			if (state.paneId) {
				this.#send({ type: "selection-state", paneId: state.paneId, state });
			}
		}
	}

	async stop(): Promise<void> {
		for (const paneId of this.#terminalSubscriptions.keys()) this.#unsubscribeTerminal(paneId);
		this.#terminalIds.clear();
		this.#terminalStates.clear();
		this.#terminalOffsets.clear();
		for (const id of [...this.#browsers.keys()]) this.destroyBrowserView(id);
	}

	async #persistBrowserNavigation(id: string, url: string): Promise<void> {
		const entry = this.#browsers.get(id);
		if (!entry) return;
		entry.pendingNavigation = { url, issuedAt: Date.now() };

		const client = this.#client;
		if (!client?.isConnected || !client.document) return;
		const browser = client.document.browsers.find(item => item.paneId === id || item.id === id);
		if (!browser || browser.url === url) return;
		const pane = client.document.panes.find(item => item.entityId === browser.id);
		const tab = pane ? client.document.tabs.find(item => item.id === pane.tabId) : undefined;
		if (!tab) return;
		const result = await client.executeCommandWithRetry(currentDocument => ({
			version: 1 as const,
			commandId: uniqueCommandId(`cmd-browser-navigate-view-${id}`),
			workspaceId: tab.workspaceId,
			expectedRevision: currentDocument.revision,
			issuedAt: Date.now(),
			type: "browser.navigate" as const,
			payload: { id: browser.id, url },
		}));
		if (result.status === "rejected") {
			if (entry.pendingNavigation?.url === url) {
				entry.pendingNavigation = undefined;
			}
			const rollbackUrl = entry.authoritativeUrl;
			entry.state = { ...entry.state, url: rollbackUrl };
			this.#setBrowserError(id, new Error(`Failed to persist navigation: ${result.error?.message ?? "rejected"}`));
			void entry.view.webContents.loadURL(rollbackUrl).catch((error: unknown) => this.#setBrowserError(id, error));
			return;
		}
		if (result.status === "accepted" || result.status === "duplicate") {
			if (entry.pendingNavigation?.url === url) {
				entry.pendingNavigation = undefined;
			}
			entry.authoritativeUrl = url;
			this.syncWithDocument(result.document);
		}
	}
	#bindBrowser(id: string, entry: BrowserEntry): void {
		const { webContents } = entry.view;
		webContents.on("did-start-loading", () => {
			entry.state = { ...entry.state, loading: true, error: undefined };
			this.#emitBrowserState(id);
		});
		webContents.on("did-stop-loading", () => {
			entry.state = { ...entry.state, loading: false };
			this.#refreshBrowserState(id);
		});
		webContents.on("did-finish-load", () => {
			const title = webContents.getTitle().trim().slice(0, 160);
			if (title) {
				entry.state = { ...entry.state, title };
				this.#emitBrowserState(id);
			}
		});
		webContents.on("did-navigate", (_event: unknown, url: string) => {
			entry.documentEpoch++;
			void this.#endSelection(id, "Page navigated");
			entry.state = { ...entry.state, url };
			this.#refreshBrowserState(id);
			void this.#persistBrowserNavigation(id, url).catch(() => {});
		});
		webContents.on("did-navigate-in-page", (_event: unknown, url: string, isMainFrame: boolean) => {
			if (isMainFrame !== false) {
				entry.documentEpoch++;
				void this.#endSelection(id, "In-page navigation");
			}
			entry.state = { ...entry.state, url };
			this.#refreshBrowserState(id);
			if (isMainFrame !== false) void this.#persistBrowserNavigation(id, url).catch(() => {});
		});
		if (webContents.debugger && typeof webContents.debugger.on === "function") {
			webContents.debugger.on("message", async (_event: unknown, method: string, params: unknown) => {
				if (method === "Overlay.inspectNodeRequested") {
					if (this.#activeSelectionPaneId !== id) return;
					const scope = this.#boundScopes.get(id);
					if (!scope) return;
					const activeId = this.#selectionCoordinator.activeSelectionId;
					if (!activeId) return;

					const payload = params as { backendNodeId?: number };
					if (typeof payload?.backendNodeId === "number") {
						await this.#handleInspectNodeRequested(id, entry, scope, activeId, payload.backendNodeId);
					}
				}
			});
		}
		webContents.on("page-title-updated", (_event: unknown, title: string) => {
			const pageTitle = title.trim().slice(0, 160) || "Browser";
			entry.state = { ...entry.state, title: pageTitle };
			this.#emitBrowserState(id);
		});
		webContents.on(
			"did-fail-load",
			(_event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
				if (!isMainFrame || errorCode === -3) return;
				entry.state = {
					...entry.state,
					url: validatedURL || entry.state.url,
					loading: false,
					error: errorDescription || `Navigation failed (${errorCode})`,
				};
				this.#emitBrowserState(id);
			},
		);
		webContents.on("focus", () => this.#send({ type: "browser-focus", paneId: id }));
		webContents.on("context-menu", () => {
			this.showPaneContextMenu(id, this.#visibleBrowsers.size < MAX_WORKSPACE_PANES);
		});
		webContents.on("render-process-gone", (_event: unknown, details: { reason?: string }) => {
			entry.state = {
				...entry.state,
				loading: false,
				error: `Browser process stopped: ${details?.reason ?? "unknown"}`,
			};
			this.#emitBrowserState(id);
		});
		webContents.on("will-navigate", (event: { preventDefault: () => void }, url: string) => {
			try {
				this.#getBrowserUrl(url);
			} catch {
				event.preventDefault();
			}
		});
		webContents.on("will-redirect", (event: { preventDefault: () => void }, url: string) => {
			try {
				this.#getBrowserUrl(url);
			} catch {
				event.preventDefault();
			}
		});
		if (typeof webContents.setWindowOpenHandler === "function") {
			webContents.setWindowOpenHandler(details => {
				try {
					const targetUrl = this.#getBrowserUrl(details.url).toString();
					this.#send({ type: "browser-new-window", paneId: id, url: targetUrl });
				} catch {}
				return { action: "deny" };
			});
		}
	}

	#refreshBrowserState(id: string): void {
		const entry = this.#browsers.get(id);
		if (!entry || entry.view.webContents.isDestroyed()) return;
		const history = entry.view.webContents.navigationHistory;
		entry.state = {
			...entry.state,
			url: entry.view.webContents.getURL() || entry.state.url,
			canGoBack: history.canGoBack(),
			canGoForward: history.canGoForward(),
		};
		this.#emitBrowserState(id);
	}

	#setBrowserError(id: string, error: unknown): void {
		const entry = this.#browsers.get(id);
		if (!entry) return;
		entry.state = { ...entry.state, loading: false, error: error instanceof Error ? error.message : String(error) };
		this.#emitBrowserState(id);
	}

	#emitBrowserState(id: string): void {
		const state = this.#browsers.get(id)?.state;
		if (state) this.#send({ type: "browser-state", paneId: id, state: { ...state } });
	}

	#send(event: WorkspaceEvent): void {
		if (!this.#window.isDestroyed() && this.#window.webContents && !this.#window.webContents.isDestroyed())
			this.#window.webContents.send("branchlight:workspace", event);
	}

	#requireBrowser(id: string): BrowserEntry {
		const entry = this.#browsers.get(id);
		if (!entry) throw new Error("Browser pane is unavailable");
		return entry;
	}

	#attach(entry: BrowserEntry): void {
		if (!entry.attached) {
			this.#window.contentView.addChildView(entry.view);
			entry.attached = true;
		}
		if (entry.cssBounds) {
			entry.bounds = this.#toDipBounds(entry.cssBounds);
		}
		if (entry.bounds.width > 0 && entry.bounds.height > 0) entry.view.setBounds(entry.bounds);
	}
	#detach(entry: BrowserEntry): void {
		if (!entry.attached) return;
		this.#window.contentView.removeChildView(entry.view);
		entry.attached = false;
	}
}
