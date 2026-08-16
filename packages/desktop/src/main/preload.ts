import { contextBridge, ipcRenderer } from "electron";
import type {
	AgentSettingValue,
	AgentSettingView,
	AuthAccountView,
	AuthEvent,
	BootstrapSnapshot,
	BranchlightApi,
	BranchlightEvent,
	BranchlightSettings,
	BrowserBounds,
	BrowserNavigationAction,
	BrowserViewState,
	CreateBrowserInput,
	CreateTerminalInput,
	ElementEditState,
	FileDiffView,
	InterruptMode,
	ModelOption,
	OAuthAccountsView,
	OpenRouterModelRouting,
	QueueMode,
	SessionSnapshot,
	SlashCommand,
	TerminalViewState,
	ThinkingLevel,
	TimelineItem,
	TimelinePage,
	WorkspaceDocumentV1,
	WorkspaceEvent,
} from "../shared/contracts";

const MAX_BYTES = 512 * 1024;

function text(value: unknown, label: string): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be text`);
	if (new TextEncoder().encode(value).byteLength > MAX_BYTES) throw new RangeError(`${label} exceeds 512 KiB`);
	return value;
}

function sessionName(value: unknown): string {
	const name = text(value, "session name").trim();
	if (name.length === 0 || Array.from(name).length > 160)
		throw new RangeError("session name must contain 1–160 characters");
	return name;
}

function sessionId(value: unknown): string {
	if (typeof value !== "string" || value.length < 8 || value.length > 100) throw new TypeError("invalid session id");
	return value;
}

function paneId(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z0-9-]{8,100}$/i.test(value)) throw new TypeError("invalid pane id");
	return value;
}

function terminalDimension(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${label} must be a number`);
	}
	const rounded = Math.round(value);
	return Math.max(2, Math.min(500, rounded));
}

function browserBounds(value: unknown): BrowserBounds {
	if (typeof value !== "object" || value === null) throw new TypeError("invalid browser bounds");
	const bounds = value as Record<string, unknown>;
	for (const key of ["x", "y", "width", "height"] as const) {
		const coordinate = bounds[key];
		if (!Number.isFinite(coordinate) || Math.abs(coordinate as number) > 32_768)
			throw new RangeError(`invalid browser ${key}`);
	}
	return {
		x: Math.round(bounds.x as number),
		y: Math.round(bounds.y as number),
		width: Math.max(0, Math.round(bounds.width as number)),
		height: Math.max(0, Math.round(bounds.height as number)),
	};
}

function browserAction(value: unknown): BrowserNavigationAction {
	if (value !== "back" && value !== "forward" && value !== "reload" && value !== "stop")
		throw new TypeError("invalid browser action");
	return value;
}
function optionalTabLayout(value: unknown): "columns" | "rows" | "grid" | undefined {
	if (value === undefined) return undefined;
	if (value !== "columns" && value !== "rows" && value !== "grid") {
		throw new TypeError("layout must be columns, rows, or grid");
	}
	return value;
}

function extensionResponse(value: unknown): unknown {
	if (typeof value !== "object" || value === null || !("id" in value))
		throw new TypeError("invalid extension response");
	const response = value as Record<string, unknown>;
	if (typeof response.id !== "string" || response.id.length === 0)
		throw new TypeError("invalid extension response id");
	if (response.value !== undefined) text(response.value, "extension response");
	return value;
}
const authProvider = (value: unknown): string => {
	if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value))
		throw new TypeError("unsupported auth provider");
	return value;
};
const credentialId = (value: unknown): number => {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("invalid credential id");
	return value as number;
};
const agentSettingValue = (value: unknown): AgentSettingValue => {
	if (
		typeof value !== "boolean" &&
		typeof value !== "string" &&
		!(typeof value === "number" && Number.isFinite(value))
	)
		throw new TypeError("invalid agent setting value");
	return value;
};
const thinkingLevel = (value: unknown): ThinkingLevel => {
	if (
		value !== "inherit" &&
		value !== "off" &&
		value !== "minimal" &&
		value !== "low" &&
		value !== "medium" &&
		value !== "high" &&
		value !== "xhigh" &&
		value !== "max"
	)
		throw new TypeError("invalid thinking level");
	return value;
};
const queueMode = (value: unknown): QueueMode => {
	if (value !== "all" && value !== "one-at-a-time") throw new TypeError("invalid queue mode");
	return value;
};
const interruptMode = (value: unknown): InterruptMode => {
	if (value !== "immediate" && value !== "wait") throw new TypeError("invalid interrupt mode");
	return value;
};
const optionalAgentId = (value: unknown): string | undefined => {
	if (value === undefined || value === null) return undefined;
	return text(value, "agent id");
};
const optionalReason = (value: unknown): string | undefined => {
	if (value === undefined || value === null) return undefined;
	return text(value, "cancel reason");
};
const optionalInstruction = (value: unknown): string | undefined => {
	if (value === undefined || value === null) return undefined;
	return text(value, "instruction");
};
const optionalCaptureMode = (value: unknown): "dom" | "screenshot" | undefined => {
	if (value === undefined || value === null) return undefined;
	if (value !== "dom" && value !== "screenshot") throw new TypeError("captureMode must be dom or screenshot");
	return value;
};
const api: BranchlightApi = {
	getAuthStatus: () => ipcRenderer.invoke("branchlight:auth-status") as Promise<AuthAccountView[]>,
	getOAuthAccounts: () => ipcRenderer.invoke("branchlight:oauth-accounts") as Promise<OAuthAccountsView>,
	setOAuthAccountLock: (provider, credential) =>
		ipcRenderer.invoke(
			"branchlight:set-oauth-account-lock",
			authProvider(provider),
			credential === undefined ? undefined : credentialId(credential),
		) as Promise<OAuthAccountsView>,
	setOAuthAccountFailover: enabled => {
		if (typeof enabled !== "boolean") throw new TypeError("account failover must be boolean");
		return ipcRenderer.invoke("branchlight:set-oauth-account-failover", enabled) as Promise<OAuthAccountsView>;
	},
	removeOAuthAccount: (provider, credential) =>
		ipcRenderer.invoke(
			"branchlight:remove-oauth-account",
			authProvider(provider),
			credentialId(credential),
		) as Promise<OAuthAccountsView>,
	loginProvider: provider =>
		ipcRenderer.invoke("branchlight:auth-login", authProvider(provider)) as Promise<AuthAccountView[]>,
	logoutProvider: provider =>
		ipcRenderer.invoke("branchlight:auth-logout", authProvider(provider)) as Promise<AuthAccountView[]>,
	respondAuthPrompt: value =>
		ipcRenderer.invoke("branchlight:auth-prompt", text(value, "auth prompt")) as Promise<void>,
	getAppSettings: () => ipcRenderer.invoke("branchlight:settings-get") as Promise<BranchlightSettings>,
	updateAppSettings: updates =>
		ipcRenderer.invoke(
			"branchlight:settings-update",
			typeof updates === "object" && updates !== null ? updates : {},
		) as Promise<BranchlightSettings>,
	resetAppSettings: () => ipcRenderer.invoke("branchlight:settings-reset") as Promise<BranchlightSettings>,
	getAgentSettings: id =>
		ipcRenderer.invoke("branchlight:agent-settings", id === undefined ? undefined : sessionId(id)) as Promise<
			AgentSettingView[]
		>,
	setAgentSetting: (id, path, value) =>
		ipcRenderer.invoke(
			"branchlight:set-agent-setting",
			id === undefined ? undefined : sessionId(id),
			text(path, "setting path"),
			agentSettingValue(value),
		) as Promise<AgentSettingView>,
	bootstrap: () => ipcRenderer.invoke("branchlight:bootstrap") as Promise<BootstrapSnapshot>,
	chooseAndCreate: kind =>
		ipcRenderer.invoke("branchlight:choose-and-create", kind) as Promise<SessionSnapshot | null>,
	openSession: id => ipcRenderer.invoke("branchlight:open", sessionId(id)) as Promise<SessionSnapshot>,
	resume: id => ipcRenderer.invoke("branchlight:resume", sessionId(id)) as Promise<SessionSnapshot>,
	loadTimelinePage: (id, before, limit) => {
		if (!Number.isSafeInteger(before) || before < 0) throw new RangeError("invalid timeline cursor");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("invalid timeline limit");
		return ipcRenderer.invoke("branchlight:timeline-page", sessionId(id), before, limit) as Promise<TimelinePage>;
	},
	loadTimelineItem: (id, itemId) =>
		ipcRenderer.invoke(
			"branchlight:timeline-item",
			sessionId(id),
			text(itemId, "timeline item id"),
		) as Promise<TimelineItem>,
	getAvailableCommands: id =>
		ipcRenderer.invoke("branchlight:available-commands", sessionId(id)) as Promise<SlashCommand[]>,
	getAvailableModels: id =>
		ipcRenderer.invoke("branchlight:available-models", sessionId(id)) as Promise<ModelOption[]>,
	getOpenRouterModelRouting: (id, modelId) =>
		ipcRenderer.invoke(
			"branchlight:openrouter-model-routing",
			sessionId(id),
			text(modelId, "model"),
		) as Promise<OpenRouterModelRouting>,
	setOpenRouterProviderEnabled: (id, modelId, providerId, enabled) => {
		if (typeof enabled !== "boolean") throw new TypeError("provider enabled state must be boolean");
		return ipcRenderer.invoke(
			"branchlight:set-openrouter-provider-enabled",
			sessionId(id),
			text(modelId, "model"),
			text(providerId, "provider"),
			enabled,
		) as Promise<OpenRouterModelRouting>;
	},
	stop: id => ipcRenderer.invoke("branchlight:stop", sessionId(id)) as Promise<SessionSnapshot>,
	rename: (id, title) =>
		ipcRenderer.invoke("branchlight:rename", sessionId(id), sessionName(title)) as Promise<SessionSnapshot>,
	prompt: (id, value) =>
		ipcRenderer.invoke("branchlight:prompt", sessionId(id), text(value, "prompt")) as Promise<void>,
	steer: (id, value) => ipcRenderer.invoke("branchlight:steer", sessionId(id), text(value, "steer")) as Promise<void>,
	queueFollowUp: (id, value) =>
		ipcRenderer.invoke("branchlight:queue", sessionId(id), text(value, "follow-up")) as Promise<void>,
	abort: id => ipcRenderer.invoke("branchlight:abort", sessionId(id)) as Promise<void>,
	setModel: (id, provider, modelId) =>
		ipcRenderer.invoke(
			"branchlight:set-model",
			sessionId(id),
			text(provider, "provider"),
			text(modelId, "model"),
		) as Promise<void>,
	setThinking: (id, level) =>
		ipcRenderer.invoke("branchlight:set-thinking", sessionId(id), thinkingLevel(level)) as Promise<void>,
	setFastMode: (id, enabled) => {
		if (typeof enabled !== "boolean") throw new TypeError("fast mode must be boolean");
		return ipcRenderer.invoke("branchlight:set-fast", sessionId(id), enabled) as Promise<void>;
	},
	setQueueMode: (id, kind, mode) => {
		if (kind !== "steering" && kind !== "follow-up") throw new TypeError("invalid queue mode kind");
		return ipcRenderer.invoke("branchlight:set-queue-mode", sessionId(id), kind, queueMode(mode)) as Promise<void>;
	},
	setInterruptMode: (id, mode) =>
		ipcRenderer.invoke("branchlight:set-interrupt-mode", sessionId(id), interruptMode(mode)) as Promise<void>,
	setAutoCompaction: (id, enabled) => {
		if (typeof enabled !== "boolean") throw new TypeError("auto-compaction must be boolean");
		return ipcRenderer.invoke("branchlight:set-auto-compaction", sessionId(id), enabled) as Promise<void>;
	},
	setAutoRetry: (id, enabled) => {
		if (typeof enabled !== "boolean") throw new TypeError("auto-retry must be boolean");
		return ipcRenderer.invoke("branchlight:set-auto-retry", sessionId(id), enabled) as Promise<void>;
	},
	extensionResponse: (id, response) =>
		ipcRenderer.invoke("branchlight:extension-response", sessionId(id), extensionResponse(response)) as Promise<void>,
	getSubagentMessages: (id, subagentId, fromByte) => {
		if (!Number.isSafeInteger(fromByte) || fromByte < 0) throw new RangeError("invalid subagent byte offset");
		return ipcRenderer.invoke(
			"branchlight:subagent-messages",
			sessionId(id),
			text(subagentId, "subagent id"),
			fromByte,
		) as Promise<unknown>;
	},
	loadFileDiff: (id, target) =>
		ipcRenderer.invoke(
			"branchlight:file-diff",
			sessionId(id),
			text(target, "file diff path"),
		) as Promise<FileDiffView>,
	openWorkspaceFile: (id, target) =>
		ipcRenderer.invoke(
			"branchlight:open-workspace-file",
			sessionId(id),
			text(target, "workspace target"),
		) as Promise<void>,
	openExternal: url => ipcRenderer.invoke("branchlight:open-external", text(url, "URL")) as Promise<void>,
	getWorkspaceDocument: () =>
		ipcRenderer.invoke("branchlight:workspace-document-get") as Promise<WorkspaceDocumentV1 | null>,
	createBrowser: options => {
		if (typeof options !== "object" || options === null) throw new TypeError("CreateBrowserInput must be an object");
		const o = options as CreateBrowserInput;
		return ipcRenderer.invoke("branchlight:browser-create", {
			id: paneId(o.id),
			url: text(o.url, "URL"),
			workspaceId: text(o.workspaceId, "workspace ID"),
			tabId: text(o.tabId, "tab ID"),
			...(o.layout !== undefined ? { layout: optionalTabLayout(o.layout) } : {}),
		}) as Promise<BrowserViewState>;
	},
	navigateBrowser: (id, url) =>
		ipcRenderer.invoke("branchlight:browser-navigate", paneId(id), text(url, "URL")) as Promise<BrowserViewState>,
	controlBrowser: (id, action) =>
		ipcRenderer.invoke("branchlight:browser-control", paneId(id), browserAction(action)) as Promise<void>,
	setBrowserBounds: (id, bounds) =>
		ipcRenderer.invoke("branchlight:browser-bounds", paneId(id), browserBounds(bounds)) as Promise<void>,
	setVisibleBrowsers: ids => {
		if (!Array.isArray(ids) || ids.length > 32) throw new RangeError("invalid visible browser list");
		return ipcRenderer.invoke("branchlight:browser-visible", ids.map(paneId)) as Promise<void>;
	},
	closeBrowser: id => ipcRenderer.invoke("branchlight:browser-close", paneId(id)) as Promise<void>,
	showPaneContextMenu: (id, canSplit) => {
		if (typeof canSplit !== "boolean") throw new TypeError("pane split availability must be boolean");
		ipcRenderer.send("branchlight:pane-context-menu", paneId(id), canSplit);
	},
	createTerminal: options => {
		if (typeof options !== "object" || options === null) throw new TypeError("CreateTerminalInput must be an object");
		const o = options as CreateTerminalInput;
		return ipcRenderer.invoke("branchlight:terminal-create", {
			id: paneId(o.id),
			tabId: text(o.tabId, "tab ID"),
			workspaceId: text(o.workspaceId, "workspace ID"),
			cols: terminalDimension(o.cols, "columns"),
			rows: terminalDimension(o.rows, "rows"),
			...(o.layout !== undefined ? { layout: optionalTabLayout(o.layout) } : {}),
		}) as Promise<TerminalViewState>;
	},
	writeTerminal: (id, data) =>
		ipcRenderer.invoke("branchlight:terminal-write", paneId(id), text(data, "terminal input")) as Promise<void>,
	resizeTerminal: (id, cols, rows) =>
		ipcRenderer.invoke(
			"branchlight:terminal-resize",
			paneId(id),
			terminalDimension(cols, "columns"),
			terminalDimension(rows, "rows"),
		) as Promise<void>,
	closeTerminal: id => ipcRenderer.invoke("branchlight:terminal-close", paneId(id)) as Promise<void>,
	updateTab: (tabId, updates) => {
		if (typeof updates !== "object" || updates === null) throw new TypeError("UpdateTabInput must be an object");
		return ipcRenderer.invoke("branchlight:tab-update", text(tabId, "tab ID"), updates) as Promise<void>;
	},
	closeTab: tabId => ipcRenderer.invoke("branchlight:tab-close", text(tabId, "tab ID")) as Promise<void>,
	closePane: paneIdValue => ipcRenderer.invoke("branchlight:pane-close", paneId(paneIdValue)) as Promise<void>,
	minimizeWindow: () => ipcRenderer.invoke("branchlight:window-minimize") as Promise<void>,
	toggleMaximizeWindow: () => ipcRenderer.invoke("branchlight:window-toggle-maximize") as Promise<boolean>,
	closeWindow: () => ipcRenderer.invoke("branchlight:window-close") as Promise<void>,
	onEvent: listener => {
		const handler = (_event: Electron.IpcRendererEvent, value: BranchlightEvent) => listener(value);
		ipcRenderer.on("branchlight:event", handler);
		return () => ipcRenderer.removeListener("branchlight:event", handler);
	},
	onAuthEvent: listener => {
		const handler = (_event: Electron.IpcRendererEvent, value: AuthEvent) => listener(value);
		ipcRenderer.on("branchlight:auth", handler);
		return () => ipcRenderer.removeListener("branchlight:auth", handler);
	},
	onWorkspaceEvent: listener => {
		const handler = (_event: Electron.IpcRendererEvent, value: WorkspaceEvent) => listener(value);
		ipcRenderer.on("branchlight:workspace", handler);
		return () => ipcRenderer.removeListener("branchlight:workspace", handler);
	},
	onWorkspaceDocument: listener => {
		const handler = (_event: Electron.IpcRendererEvent, doc: WorkspaceDocumentV1) => listener(doc);
		ipcRenderer.on("branchlight:workspace-document", handler);
		return () => ipcRenderer.removeListener("branchlight:workspace-document", handler);
	},
	startSelection: (id: string, agent?: string, captureMode?: "dom" | "screenshot") =>
		ipcRenderer.invoke(
			"branchlight:selection-start",
			paneId(id),
			optionalAgentId(agent),
			optionalCaptureMode(captureMode),
		) as Promise<ElementEditState>,
	cancelSelection: (id, reason) =>
		ipcRenderer.invoke(
			"branchlight:selection-cancel",
			paneId(id),
			optionalReason(reason),
		) as Promise<ElementEditState>,
	commitSelection: (id, instruction) =>
		ipcRenderer.invoke(
			"branchlight:selection-commit",
			paneId(id),
			optionalInstruction(instruction),
		) as Promise<ElementEditState>,
	getSelectionState: id => ipcRenderer.invoke("branchlight:selection-state", paneId(id)) as Promise<ElementEditState>,
	onSelectionStateChanged: listener => {
		const handler = (_event: Electron.IpcRendererEvent, state: ElementEditState) => listener(state);
		ipcRenderer.on("branchlight:selection-state", handler);
		return () => ipcRenderer.removeListener("branchlight:selection-state", handler);
	},
};

contextBridge.exposeInMainWorld("branchlight", api);
