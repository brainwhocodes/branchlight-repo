import { contextBridge, ipcRenderer } from "electron";
import type {
	AuthAccountView,
	AuthEvent,
	BootstrapSnapshot,
	BranchlightApi,
	BranchlightEvent,
	InterruptMode,
	ModelOption,
	QueueMode,
	SessionSnapshot,
	SlashCommand,
	ThinkingLevel,
	TimelineItem,
	TimelinePage,
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

function extensionResponse(value: unknown): unknown {
	if (typeof value !== "object" || value === null || !("id" in value))
		throw new TypeError("invalid extension response");
	const response = value as Record<string, unknown>;
	if (typeof response.id !== "string" || response.id.length === 0)
		throw new TypeError("invalid extension response id");
	if (response.value !== undefined) text(response.value, "extension response");
	return value;
}
const authProvider = (value: unknown): "openai-codex" => {
	if (value !== "openai-codex") throw new TypeError("unsupported auth provider");
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

const api: BranchlightApi = {
	getAuthStatus: () => ipcRenderer.invoke("branchlight:auth-status") as Promise<AuthAccountView[]>,
	loginProvider: provider =>
		ipcRenderer.invoke("branchlight:auth-login", authProvider(provider)) as Promise<AuthAccountView[]>,
	logoutProvider: provider =>
		ipcRenderer.invoke("branchlight:auth-logout", authProvider(provider)) as Promise<AuthAccountView[]>,
	respondAuthPrompt: value =>
		ipcRenderer.invoke("branchlight:auth-prompt", text(value, "auth prompt")) as Promise<void>,
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
	openWorkspaceFile: (id, target) =>
		ipcRenderer.invoke(
			"branchlight:open-workspace-file",
			sessionId(id),
			text(target, "workspace target"),
		) as Promise<void>,
	openExternal: url => ipcRenderer.invoke("branchlight:open-external", text(url, "URL")) as Promise<void>,
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
};

contextBridge.exposeInMainWorld("branchlight", api);
