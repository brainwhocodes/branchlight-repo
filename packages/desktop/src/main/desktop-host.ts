import { randomUUID } from "node:crypto";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { type BrowserWindow, dialog, shell } from "electron";
import type {
	AuthAccountView,
	AuthEvent,
	BootstrapSnapshot,
	BranchlightEvent,
	ExtensionView,
	InterruptMode,
	ModelOption,
	ProcessState,
	QueueMode,
	SessionRecordV1,
	SessionSnapshot,
	SlashCommand,
	SubagentView,
	ThinkingLevel,
	TimelineItem,
	TimelinePage,
} from "../shared/contracts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../shared/rpc-wire";
import {
	assertBoundedText,
	assertSessionKind,
	assertSessionName,
	resolveWorkspaceTarget,
	safeExternalUrl,
} from "./guards";
import type { RpcClient } from "./rpc-client";
import { RpcProcess } from "./rpc-process";
import { SessionRegistry } from "./session-registry";
import { TranscriptStore } from "./transcript-store";

type RuntimeSession = {
	record: SessionRecordV1;
	process: RpcProcess;
	timeline: TranscriptStore;
	state: ProcessState;
	subagents: SubagentView[];
	commands: SlashCommand[];
	models?: ModelOption[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	fastMode?: boolean;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	interruptMode?: InterruptMode;
	autoCompactionEnabled?: boolean;
	contextTokens?: number;
	contextWindow?: number;
	tokensPerSecond?: number | null;
	queuedMessageCount?: number;
	todoPhases?: SessionSnapshot["todoPhases"];
	outstandingExtensions: Map<string, RpcExtensionUIRequest["method"]>;
};

type TimerHandle = NodeJS.Timeout;

interface StateData {
	sessionId: string;
	sessionFile?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	fastModeEnabled: boolean;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	interruptMode: InterruptMode;
	autoCompactionEnabled: boolean;
	contextUsage?: { tokens: number; contextWindow: number };
	tokensPerSecond: number | null;
	queuedMessageCount: number;
	todoPhases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
}
async function loadHistory(client: RpcClient): Promise<unknown[]> {
	const paged = await client.request({ type: "get_messages_page", limit: 256 });
	if (!paged.success) {
		const legacy = await client.request({ type: "get_messages" });
		if (!legacy.success || legacy.command !== "get_messages") throw new Error(legacy.error ?? "History load failed");
		const data = legacy.data as { messages?: unknown[] };
		return Array.isArray(data.messages) ? data.messages : [];
	}
	const messages: unknown[] = [];
	let response: typeof paged | undefined = paged;
	let pageCount = 0;
	while (response?.success && response.command === "get_messages_page") {
		const data = response.data as { messages?: unknown[]; nextCursor?: string };
		if (!Array.isArray(data.messages)) throw new Error("History page was invalid");
		messages.push(...data.messages);
		if (!data.nextCursor) return messages;
		if (++pageCount > 10_000) throw new Error("History pagination exceeded its safety bound");
		response = await client.request({ type: "get_messages_page", cursor: data.nextCursor, limit: 256 });
	}
	throw new Error(response?.error ?? "History page load failed");
}

export class DesktopHost {
	#registry: SessionRegistry;
	#window: BrowserWindow | undefined;
	#runtimes = new Map<string, RuntimeSession>();
	#eventQueues = new Map<string, BranchlightEvent[]>();
	#eventTimers = new Map<string, TimerHandle>();
	#warning: string | undefined;
	#authProcess: RpcProcess | undefined;
	#authClient: Promise<RpcClient> | undefined;
	#authClientUsers = 0;
	#authLogin: Promise<AuthAccountView[]> | undefined;
	#authPrompt:
		| {
				id: string;
				process: RpcProcess;
		  }
		| undefined;

	constructor(userDataPath: string) {
		this.#registry = new SessionRegistry(userDataPath);
	}

	async load(): Promise<void> {
		await this.#registry.load();
		this.#warning = this.#registry.warning;
	}
	setWindow(window: BrowserWindow): void {
		this.#window = window;
	}

	bootstrap(): BootstrapSnapshot {
		return { registry: this.#registry.value, warning: this.#warning };
	}
	async getAuthStatus(): Promise<AuthAccountView[]> {
		return this.#authAccounts();
	}

	async loginProvider(providerInput: unknown): Promise<AuthAccountView[]> {
		const provider = assertAuthProvider(providerInput);
		if (this.#authLogin) return this.#authLogin;
		const operation = this.#runAuthLogin(provider);
		this.#authLogin = operation;
		try {
			return await operation;
		} finally {
			if (this.#authLogin === operation) this.#authLogin = undefined;
		}
	}

	async logoutProvider(providerInput: unknown): Promise<AuthAccountView[]> {
		const provider = assertAuthProvider(providerInput);
		const response = await this.#withAuthClient(client => client.request({ type: "logout", providerId: provider }));
		if (!response.success) throw new Error(response.error ?? "Sign-out failed");
		this.#emitAuth({ type: "complete", provider, message: "Signed out of ChatGPT" });
		return this.#authAccounts();
	}

	respondAuthPrompt(valueInput: unknown): void {
		const value = assertBoundedText(valueInput, "auth prompt");
		const pending = this.#authPrompt;
		if (!pending) throw new Error("No authentication prompt is pending");
		this.#authPrompt = undefined;
		pending.process.client?.sendExtensionResponse({ type: "extension_ui_response", id: pending.id, value });
	}

	async chooseAndCreate(kindInput: unknown): Promise<SessionSnapshot | null> {
		const kind = assertSessionKind(kindInput);
		if (!this.#window) throw new Error("Main window is not ready");
		const result = await dialog.showOpenDialog(this.#window, { properties: ["openDirectory", "createDirectory"] });
		if (result.canceled || result.filePaths.length === 0) return null;
		const cwd = result.filePaths[0];
		const record: SessionRecordV1 = {
			id: randomUUID(),
			kind,
			cwd,
			ompSessionId: "",
			sessionFile: "",
			title: null,
			createdAt: new Date().toISOString(),
			lastOpenedAt: new Date().toISOString(),
		};
		const runtime = this.#createRuntime(record);
		try {
			await this.#startRuntime(runtime, false);
			await this.#registry.create(runtime.record);
			return this.#snapshot(runtime);
		} catch (error) {
			this.#runtimes.delete(record.id);
			throw error;
		}
	}

	async openSession(id: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		await this.#registry.setActive(record.kind, record.id);
		const runtime = this.#runtimes.get(record.id);
		if (runtime) return this.#snapshot(runtime);
		return { record, state: "stopped", timeline: [], subagents: [] };
	}

	async resume(id: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		const existing = this.#runtimes.get(record.id);
		if (existing && existing.state !== "stopped" && existing.state !== "error") return this.#snapshot(existing);
		const runtime = existing ?? this.#createRuntime(record);
		await this.#startRuntime(runtime, true);
		const lastOpenedAt = new Date().toISOString();
		await this.#registry.update(record.id, { lastOpenedAt });
		await this.#registry.setActive(record.kind, record.id);
		runtime.record = { ...runtime.record, lastOpenedAt };
		const snapshot = this.#snapshot(runtime);
		return snapshot;
	}

	async loadTimelinePage(idInput: unknown, beforeInput: unknown, limitInput: unknown): Promise<TimelinePage> {
		const record = this.#record(idInput);
		const runtime = this.#runtimes.get(record.id);
		if (!runtime) throw new Error("Session is not loaded");
		const before = assertTimelineOffset(beforeInput, "timeline cursor");
		const limit = Math.min(assertTimelineOffset(limitInput, "timeline limit"), 200);
		const end = Math.min(before, runtime.timeline.size);
		const start = Math.max(0, end - limit);
		return {
			items: runtime.timeline.page(start, end - start).map(dehydrateTimelineItem),
			start,
			total: runtime.timeline.size,
		};
	}

	async loadTimelineItem(idInput: unknown, itemIdInput: unknown): Promise<TimelineItem> {
		const record = this.#record(idInput);
		const runtime = this.#runtimes.get(record.id);
		if (!runtime) throw new Error("Session is not loaded");
		if (typeof itemIdInput !== "string" || itemIdInput.length === 0) throw new TypeError("invalid timeline item id");
		const item = runtime.timeline.find(itemIdInput);
		if (!item) throw new Error("Timeline item not found");
		return { ...item, textLoaded: true };
	}
	async getAvailableCommands(idInput: unknown): Promise<SlashCommand[]> {
		const runtime = await this.#requireRunning(idInput);
		if (runtime.commands.length > 0) return [...runtime.commands];
		const response = await runtime.process.client?.request({ type: "get_available_commands" });
		if (!response?.success) throw new Error(response?.error ?? "Slash commands are unavailable");
		const data = isRecord(response.data) ? response.data : undefined;
		runtime.commands = normalizeSlashCommands(data?.commands);
		return [...runtime.commands];
	}

	async getAvailableModels(idInput: unknown): Promise<ModelOption[]> {
		const runtime = await this.#requireRunning(idInput);
		if (runtime.models) return [...runtime.models];
		const response = await runtime.process.client?.request({ type: "get_available_models" });
		if (!response?.success) throw new Error(response?.error ?? "Models are unavailable");
		const data = isRecord(response.data) ? response.data : undefined;
		const models = Array.isArray(data?.models)
			? data.models.map(toModelOption).filter((model): model is ModelOption => model !== undefined)
			: [];
		runtime.models = models;
		return [...models];
	}

	async stop(id: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		const runtime = this.#runtimes.get(record.id);
		if (!runtime) return { record, state: "stopped", timeline: [], subagents: [] };
		await runtime.process.stop();
		runtime.state = "stopped";
		this.#emitUrgent({ sessionId: record.id, type: "session", state: "stopped" });
		return this.#snapshot(runtime);
	}

	async rename(id: unknown, titleInput: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		const title = assertSessionName(titleInput);
		const runtime = this.#runtimes.get(record.id);
		if (runtime?.process.client) {
			const response = await runtime.process.client.request({ type: "set_session_name", name: title });
			if (!response.success) throw new Error(response.error);
		}
		await this.#registry.update(record.id, { title });
		if (runtime) runtime.record = { ...runtime.record, title };
		return runtime
			? this.#snapshot(runtime)
			: { record: { ...record, title }, state: "stopped", timeline: [], subagents: [] };
	}

	async prompt(id: unknown, textInput: unknown): Promise<void> {
		const text = assertBoundedText(textInput, "prompt");
		const runtime = await this.#requireRunning(id);
		await runtime.process.client?.prompt(text);
	}

	async steer(id: unknown, textInput: unknown): Promise<void> {
		const runtime = await this.#requireRunning(id);
		const response = await runtime.process.client?.request({
			type: "steer",
			message: assertBoundedText(textInput, "steer"),
		});
		if (response && !response.success) throw new Error(response.error);
	}

	async queueFollowUp(id: unknown, textInput: unknown): Promise<void> {
		const runtime = await this.#requireRunning(id);
		const response = await runtime.process.client?.request({
			type: "follow_up",
			message: assertBoundedText(textInput, "follow-up"),
		});
		if (response && !response.success) throw new Error(response.error);
	}

	async abort(id: unknown): Promise<void> {
		const runtime = await this.#requireRunning(id);
		const response = await runtime.process.client?.request({ type: "abort" });
		if (response && !response.success) throw new Error(response.error);
	}

	async setModel(id: unknown, providerInput: unknown, modelInput: unknown): Promise<void> {
		const runtime = await this.#requireRunning(id);
		const provider = assertBoundedText(providerInput, "provider").trim();
		const modelId = assertBoundedText(modelInput, "model").trim();
		if (!provider || !modelId) throw new TypeError("invalid model");
		const response = await runtime.process.client?.request({
			type: "set_model",
			provider,
			modelId,
		});
		if (response && !response.success) throw new Error(response.error);
		const selected = toModelOption(response?.data);
		runtime.model = selected ? `${selected.provider}/${selected.id}` : `${provider}/${modelId}`;
	}

	async setThinking(id: unknown, levelInput: unknown): Promise<void> {
		const runtime = await this.#requireRunning(id);
		const level = assertThinkingLevel(levelInput);
		const response = await runtime.process.client?.request({
			type: "set_thinking_level",
			level,
		});
		if (response && !response.success) throw new Error(response.error);
		runtime.thinkingLevel = level;
	}

	async setFastMode(id: unknown, enabled: unknown): Promise<void> {
		const runtime = await this.#requireRunning(id);
		if (typeof enabled !== "boolean") throw new TypeError("invalid fast mode value");
		const response = await runtime.process.client?.request({ type: "set_fast_mode", enabled });
		if (response && !response.success) throw new Error(response.error);
		const data = isRecord(response?.data) ? response.data : undefined;
		runtime.fastMode = typeof data?.enabled === "boolean" ? data.enabled : enabled;
	}

	async setQueueMode(id: unknown, kindInput: unknown, modeInput: unknown): Promise<void> {
		const runtime = await this.#requireRunning(id);
		if (kindInput !== "steering" && kindInput !== "follow-up") throw new TypeError("invalid queue mode kind");
		const mode = assertQueueMode(modeInput);
		const response = await runtime.process.client?.request({
			type: kindInput === "steering" ? "set_steering_mode" : "set_follow_up_mode",
			mode,
		});
		if (response && !response.success) throw new Error(response.error);
		if (kindInput === "steering") runtime.steeringMode = mode;
		else runtime.followUpMode = mode;
	}

	async setInterruptMode(id: unknown, modeInput: unknown): Promise<void> {
		const runtime = await this.#requireRunning(id);
		const mode = assertInterruptMode(modeInput);
		const response = await runtime.process.client?.request({ type: "set_interrupt_mode", mode });
		if (response && !response.success) throw new Error(response.error);
		runtime.interruptMode = mode;
	}

	async setAutoCompaction(id: unknown, enabled: unknown): Promise<void> {
		const runtime = await this.#requireRunning(id);
		if (typeof enabled !== "boolean") throw new TypeError("invalid auto-compaction value");
		const response = await runtime.process.client?.request({ type: "set_auto_compaction", enabled });
		if (response && !response.success) throw new Error(response.error);
		runtime.autoCompactionEnabled = enabled;
	}

	async extensionResponse(idInput: unknown, responseInput: unknown): Promise<void> {
		const runtime = await this.#requireRunning(idInput);
		if (typeof responseInput !== "object" || responseInput === null || !("id" in responseInput))
			throw new TypeError("invalid extension response");
		const response = responseInput as Record<string, unknown>;
		if (typeof response.id !== "string") throw new TypeError("invalid extension response id");
		const expected = runtime.outstandingExtensions.get(response.id);
		if (!expected) throw new Error("stale extension response");
		if (response.method !== undefined && response.method !== expected)
			throw new Error("extension response method mismatch");
		if (response.value !== undefined) assertBoundedText(response.value, "extension response");
		if (response.confirmed !== undefined && typeof response.confirmed !== "boolean")
			throw new TypeError("invalid extension confirmation");
		if (response.cancelled !== undefined && response.cancelled !== true)
			throw new TypeError("invalid extension cancellation");
		runtime.outstandingExtensions.delete(response.id);
		runtime.process.client?.sendExtensionResponse({
			...response,
			type: "extension_ui_response",
		} as RpcExtensionUIResponse);
	}

	async getSubagentMessages(idInput: unknown, subagentIdInput: unknown, fromByteInput: unknown): Promise<unknown> {
		const runtime = await this.#requireRunning(idInput);
		if (
			typeof subagentIdInput !== "string" ||
			typeof fromByteInput !== "number" ||
			!Number.isSafeInteger(fromByteInput) ||
			fromByteInput < 0
		)
			throw new TypeError("invalid subagent transcript request");
		const response = await runtime.process.client?.request({
			type: "get_subagent_messages",
			subagentId: subagentIdInput,
			fromByte: fromByteInput,
		});
		if (!response?.success) throw new Error(response?.error ?? "subagent transcript unavailable");
		return response.data;
	}

	async openWorkspaceFile(idInput: unknown, targetInput: unknown): Promise<void> {
		const record = this.#record(idInput);
		if (typeof targetInput !== "string") throw new TypeError("target must be text");
		const resolved = await resolveWorkspaceTarget(record.cwd, targetInput);
		if (resolved.revealOnly) await shell.showItemInFolder(resolved.target);
		else {
			const error = await shell.openPath(resolved.target);
			if (error) throw new Error(error);
		}
	}

	async openExternal(urlInput: unknown): Promise<void> {
		const url = safeExternalUrl(urlInput);
		await shell.openExternal(url.toString());
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.#runtimes.values()].map(runtime => runtime.process.stop().catch(() => {})));
	}
	async close(): Promise<void> {
		this.#authPrompt = undefined;
		const authProcess = this.#authProcess;
		this.#authProcess = undefined;
		this.#authClient = undefined;
		await authProcess?.stop().catch(() => {});
	}

	#createRuntime(record: SessionRecordV1): RuntimeSession {
		const runtime = {} as RuntimeSession;
		runtime.record = record;
		runtime.timeline = new TranscriptStore();
		runtime.state = "stopped";
		runtime.subagents = [];
		runtime.commands = [];
		runtime.outstandingExtensions = new Map();
		runtime.process = new RpcProcess({
			cwd: record.cwd,
			sessionFile: record.sessionFile || undefined,
			onEvent: event => this.#onEvent(runtime, event),
			onExtension: request => this.#onExtension(runtime, request),
			onState: (state, error) => {
				runtime.state = state;
				this.#emitUrgent({ sessionId: runtime.record.id, type: "session", state, message: error });
			},
		});
		this.#runtimes.set(record.id, runtime);
		return runtime;
	}

	async #startRuntime(runtime: RuntimeSession, resumed: boolean): Promise<void> {
		if (runtime.state === "starting" || runtime.state === "ready" || runtime.state === "running") return;
		if (resumed && !runtime.record.sessionFile) throw new Error("No resumable OMP session file exists");
		const client = await runtime.process.start();
		const state = await client.request({ type: "get_state" });
		if (!state.success || state.command !== "get_state")
			throw new Error(
				state.success ? "OMP state response was invalid" : (state.error ?? "OMP state request failed"),
			);
		const data = state.data as StateData;
		runtime.record = {
			...runtime.record,
			ompSessionId: data.sessionId,
			sessionFile: data.sessionFile ?? runtime.record.sessionFile,
			lastOpenedAt: new Date().toISOString(),
		};
		runtime.model = data.model ? `${data.model.provider}/${data.model.id}` : undefined;
		runtime.thinkingLevel = data.thinkingLevel;
		runtime.fastMode = data.fastModeEnabled;
		runtime.steeringMode = data.steeringMode ?? "all";
		runtime.followUpMode = data.followUpMode ?? "all";
		runtime.interruptMode = data.interruptMode ?? "immediate";
		runtime.autoCompactionEnabled = data.autoCompactionEnabled ?? true;
		runtime.contextTokens = data.contextUsage?.tokens;
		runtime.contextWindow = data.contextUsage?.contextWindow;
		runtime.tokensPerSecond = data.tokensPerSecond;
		runtime.queuedMessageCount = data.queuedMessageCount;
		runtime.todoPhases = data.todoPhases.map(phase => ({
			title: phase.name,
			items: phase.tasks.map(task => ({ text: task.content, completed: task.status === "completed" })),
		}));
		const messages = await loadHistory(client);
		runtime.timeline.load(messages);
		const subagents = await client.request({ type: "get_subagents" });
		if (subagents.success && subagents.command === "get_subagents") {
			const data = subagents.data as { subagents: unknown[] };
			runtime.subagents = data.subagents.map(toSubagentView);
		}
		const commands = await client.request({ type: "set_subagent_subscription", level: "progress" });
		if (!commands.success) throw new Error(commands.error ?? "Subagent subscription failed");
		await this.#registry.update(runtime.record.id, runtime.record);
		this.#emitUrgent({ sessionId: runtime.record.id, type: "session", state: runtime.state });
		this.#emitUrgent({ sessionId: runtime.record.id, type: "timeline" });
	}

	async #requireRunning(idInput: unknown): Promise<RuntimeSession> {
		const record = this.#record(idInput);
		let runtime = this.#runtimes.get(record.id);
		if (!runtime || runtime.state === "stopped" || runtime.state === "error") {
			runtime = runtime ?? this.#createRuntime(record);
			await this.#startRuntime(runtime, Boolean(record.sessionFile));
		}
		if (!runtime.process.client) throw new Error("OMP is not ready");
		return runtime;
	}

	#record(idInput: unknown): SessionRecordV1 {
		if (typeof idInput !== "string") throw new TypeError("invalid session id");
		const record = this.#registry.value.sessions.find(candidate => candidate.id === idInput);
		if (!record) throw new Error("Session not found");
		return record;
	}

	#snapshot(runtime: RuntimeSession): SessionSnapshot {
		const timelineTotal = runtime.timeline.size;
		const timelineStart = Math.max(0, timelineTotal - 200);
		return {
			record: runtime.record,
			state: runtime.state,
			timeline: runtime.timeline.page(timelineStart, timelineTotal - timelineStart).map(dehydrateTimelineItem),
			timelineStart,
			timelineTotal,
			subagents: runtime.subagents,
			commands: [...runtime.commands],
			model: runtime.model,
			thinkingLevel: runtime.thinkingLevel,
			fastMode: runtime.fastMode,
			steeringMode: runtime.steeringMode,
			followUpMode: runtime.followUpMode,
			interruptMode: runtime.interruptMode,
			autoCompactionEnabled: runtime.autoCompactionEnabled,
			contextTokens: runtime.contextTokens,
			contextWindow: runtime.contextWindow,
			tokensPerSecond: runtime.tokensPerSecond,
			queuedMessageCount: runtime.queuedMessageCount,
			todoPhases: runtime.todoPhases,
		};
	}

	async #authAccounts(): Promise<AuthAccountView[]> {
		const fallback: AuthAccountView = {
			provider: "openai-codex",
			name: "ChatGPT Plus/Pro (Codex Subscription)",
			signedIn: false,
		};
		try {
			const response = await this.#withAuthClient(client => client.request({ type: "get_login_providers" }));
			if (!response.success) return [fallback];
			const data = response.data as {
				providers?: Array<{ id?: string; name?: string; authenticated?: boolean }>;
			};
			const provider = data.providers?.find(candidate => candidate.id === "openai-codex");
			return [
				{
					provider: "openai-codex",
					name: provider?.name ?? fallback.name,
					signedIn: provider?.authenticated === true,
				},
			];
		} catch {
			return [fallback];
		}
	}

	async #runAuthLogin(provider: "openai-codex"): Promise<AuthAccountView[]> {
		try {
			const response = await this.#withAuthClient(client => client.request({ type: "login", providerId: provider }));
			if (!response.success) throw new Error(response.error ?? "ChatGPT sign-in failed");
			this.#emitAuth({ type: "complete", provider, message: "ChatGPT sign-in complete." });
			return this.#authAccounts();
		} catch (error) {
			this.#authPrompt = undefined;
			const message = error instanceof Error ? error.message : String(error);
			this.#emitAuth({ type: "error", provider, message });
			throw error;
		}
	}

	async #withAuthClient<T>(operation: (client: RpcClient) => Promise<T>): Promise<T> {
		this.#authClientUsers++;
		try {
			let clientPromise = this.#authClient;
			if (!clientPromise) {
				const authProcess = new RpcProcess({
					cwd: process.cwd(),
					onEvent: () => {},
					onExtension: request => this.#onAuthExtension(request),
					onState: () => {},
				});
				this.#authProcess = authProcess;
				clientPromise = authProcess.start();
				this.#authClient = clientPromise;
			}
			return await operation(await clientPromise);
		} finally {
			this.#authClientUsers--;
			if (this.#authClientUsers === 0) {
				const authProcess = this.#authProcess;
				this.#authProcess = undefined;
				this.#authClient = undefined;
				await authProcess?.stop().catch(() => {});
			}
		}
	}

	#onAuthExtension(request: RpcExtensionUIRequest): void {
		if (request.method === "open_url" && request.url) {
			this.#emitAuth({
				type: "auth-url",
				provider: "openai-codex",
				message: "Opening ChatGPT sign-in in your browser.",
				url: request.launchUrl ?? request.url,
			});
			void this.openExternal(request.launchUrl ?? request.url).catch(error =>
				this.#emitAuth({
					type: "error",
					provider: "openai-codex",
					message: error instanceof Error ? error.message : String(error),
				}),
			);
			return;
		}
		if (request.method !== "input" || !this.#authProcess) return;
		this.#authPrompt = { id: request.id, process: this.#authProcess };
		this.#emitAuth({
			type: "prompt",
			provider: "openai-codex",
			message: request.title ?? "Enter the authorization code",
			sensitive: true,
		});
	}

	#emitAuth(event: AuthEvent): void {
		this.#window?.webContents.send("branchlight:auth", event);
	}

	#onEvent(runtime: RuntimeSession, event: unknown): void {
		const frame = event as Record<string, unknown>;
		if (frame.type === "subagent_lifecycle" || frame.type === "subagent_progress") {
			this.#updateSubagents(runtime, frame);
			this.#queueEvent({ sessionId: runtime.record.id, type: "subagents", subagents: runtime.subagents });
			return;
		}
		if (frame.type === "available_commands_update") {
			runtime.commands = normalizeSlashCommands(frame.commands);
			this.#emitUrgent({
				sessionId: runtime.record.id,
				type: "commands",
				commands: [...runtime.commands],
			});
			return;
		}
		if (frame.type === "config_update") {
			const model = toModelOption(frame.model);
			if (model) runtime.model = `${model.provider}/${model.id}`;
			if (isThinkingLevel(frame.thinkingLevel)) runtime.thinkingLevel = frame.thinkingLevel;
			this.#emitUrgent({
				sessionId: runtime.record.id,
				type: "config",
				config: {
					model: runtime.model,
					thinkingLevel: runtime.thinkingLevel,
					fastMode: runtime.fastMode,
					steeringMode: runtime.steeringMode,
					followUpMode: runtime.followUpMode,
					interruptMode: runtime.interruptMode,
					autoCompactionEnabled: runtime.autoCompactionEnabled,
				},
			});
			return;
		}
		if (frame.type === "session_info_update" && typeof frame.title === "string") {
			let title: string;
			try {
				title = assertSessionName(frame.title);
			} catch {
				return;
			}
			runtime.record = { ...runtime.record, title };
			void this.#registry.update(runtime.record.id, { title }).catch(error => {
				this.#emitUrgent({
					sessionId: runtime.record.id,
					type: "warning",
					message: error instanceof Error ? error.message : String(error),
				});
			});
			this.#emitUrgent({ sessionId: runtime.record.id, type: "session", record: runtime.record });
			return;
		}
		const items = runtime.timeline.applyChanges(event);
		for (const item of items) this.#queueEvent({ sessionId: runtime.record.id, type: "timeline", item });
		if (frame.type === "notice" || frame.type === "command_output" || frame.type === "agent_end")
			this.#flush(runtime.record.id);
	}

	#updateSubagents(runtime: RuntimeSession, frame: Record<string, unknown>): void {
		const payload =
			typeof frame.payload === "object" && frame.payload !== null
				? (frame.payload as Record<string, unknown>)
				: undefined;
		if (!payload) return;
		const id =
			typeof payload.id === "string" ? payload.id : typeof payload.agent === "string" ? payload.agent : undefined;
		if (!id) return;
		const current = runtime.subagents.find(agent => agent.id === id);
		const progress =
			typeof payload.progress === "object" && payload.progress !== null
				? (payload.progress as Record<string, unknown>)
				: undefined;
		const value: SubagentView = {
			id,
			agent: typeof payload.agent === "string" ? payload.agent : (current?.agent ?? "subagent"),
			status: typeof payload.status === "string" ? payload.status : (current?.status ?? "running"),
			task: typeof payload.task === "string" ? payload.task : current?.task,
			assignment: typeof payload.assignment === "string" ? payload.assignment : current?.assignment,
			parentToolCallId:
				typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : current?.parentToolCallId,
			progress: progress
				? {
						currentTool: typeof progress.currentTool === "string" ? progress.currentTool : undefined,
						lastIntent: typeof progress.lastIntent === "string" ? progress.lastIntent : undefined,
						tokens: typeof progress.tokens === "number" ? progress.tokens : undefined,
						contextTokens: typeof progress.contextTokens === "number" ? progress.contextTokens : undefined,
						contextWindow: typeof progress.contextWindow === "number" ? progress.contextWindow : undefined,
						cost: typeof progress.cost === "number" ? progress.cost : undefined,
						durationMs: typeof progress.durationMs === "number" ? progress.durationMs : undefined,
						recentOutput: Array.isArray(progress.recentOutput)
							? progress.recentOutput.filter((value): value is string => typeof value === "string")
							: undefined,
						resolvedModel: typeof progress.resolvedModel === "string" ? progress.resolvedModel : undefined,
						requests: typeof progress.requests === "number" ? progress.requests : undefined,
					}
				: current?.progress,
		};
		if (current) runtime.subagents = runtime.subagents.map(agent => (agent.id === id ? value : agent));
		else runtime.subagents = [...runtime.subagents, value];
	}

	#onExtension(runtime: RuntimeSession, request: RpcExtensionUIRequest): void {
		if (request.method === "cancel") {
			if (request.targetId) runtime.outstandingExtensions.delete(request.targetId);
			this.#emitUrgent({
				sessionId: runtime.record.id,
				type: "extension",
				extension: { id: request.id, method: "cancel", targetId: request.targetId },
			});
			return;
		}
		if (expectsExtensionResponse(request.method)) runtime.outstandingExtensions.set(request.id, request.method);
		const extension: ExtensionView = {
			id: request.id,
			method: request.method,
			targetId: request.targetId,
			title: request.title,
			message: request.message,
			options: request.options,
			placeholder: request.placeholder,
			sensitive: request.sensitive,
			prefill: request.prefill,
			text: request.text,
			url: request.url,
			instructions: request.instructions,
			notifyType: request.notifyType,
			statusKey: request.statusKey,
			statusText: request.statusText,
			widgetKey: request.widgetKey,
			widgetLines: request.widgetLines,
			widgetPlacement: request.widgetPlacement,
		};
		this.#emitUrgent({ sessionId: runtime.record.id, type: "extension", extension });
	}

	#queueEvent(event: BranchlightEvent): void {
		const queue = this.#eventQueues.get(event.sessionId) ?? [];
		queue.push(event);
		this.#eventQueues.set(event.sessionId, queue);
		if (!this.#eventTimers.has(event.sessionId))
			this.#eventTimers.set(
				event.sessionId,
				setTimeout(() => this.#flush(event.sessionId), 16),
			);
	}

	#emitUrgent(event: BranchlightEvent): void {
		this.#queueEvent(event);
		this.#flush(event.sessionId);
	}

	#flush(sessionId: string): void {
		const timer = this.#eventTimers.get(sessionId);
		if (timer) clearTimeout(timer);

		this.#eventTimers.delete(sessionId);
		const queue = this.#eventQueues.get(sessionId);
		if (!queue || queue.length === 0) return;
		this.#eventQueues.delete(sessionId);
		for (const event of queue) this.#window?.webContents.send("branchlight:event", event);
	}
}
function expectsExtensionResponse(method: RpcExtensionUIRequest["method"]): boolean {
	return (
		method === "select" || method === "confirm" || method === "input" || method === "editor" || method === "open_url"
	);
}
function assertTimelineOffset(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
		throw new RangeError(`${label} must be a non-negative integer`);
	}
	return value as number;
}
function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "inherit" ||
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function assertThinkingLevel(value: unknown): ThinkingLevel {
	if (!isThinkingLevel(value)) throw new TypeError("invalid thinking level");
	return value;
}

function assertQueueMode(value: unknown): QueueMode {
	if (value !== "all" && value !== "one-at-a-time") throw new TypeError("invalid queue mode");
	return value;
}

function assertInterruptMode(value: unknown): InterruptMode {
	if (value !== "immediate" && value !== "wait") throw new TypeError("invalid interrupt mode");
	return value;
}

function normalizeSlashCommands(value: unknown): SlashCommand[] {
	if (!Array.isArray(value)) return [];
	const commands: SlashCommand[] = [];
	const seen = new Set<string>();
	for (const item of value.slice(0, 5_000)) {
		if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0 || item.name.length > 160)
			continue;
		if (!isSlashCommandSource(item.source) || seen.has(item.name)) continue;
		seen.add(item.name);
		const aliases = Array.isArray(item.aliases)
			? item.aliases
					.filter((alias): alias is string => typeof alias === "string" && alias.length <= 160)
					.slice(0, 32)
			: undefined;
		const input =
			isRecord(item.input) && typeof item.input.hint === "string"
				? { hint: item.input.hint.slice(0, 256) }
				: undefined;
		const subcommands = Array.isArray(item.subcommands)
			? item.subcommands
					.slice(0, 100)
					.map(subcommand => {
						if (!isRecord(subcommand) || typeof subcommand.name !== "string") return undefined;
						return {
							name: subcommand.name.slice(0, 160),
							description:
								typeof subcommand.description === "string" ? subcommand.description.slice(0, 1_024) : undefined,
							usage: typeof subcommand.usage === "string" ? subcommand.usage.slice(0, 512) : undefined,
						};
					})
					.filter((subcommand): subcommand is NonNullable<typeof subcommand> => subcommand !== undefined)
			: undefined;
		commands.push({
			name: item.name,
			aliases,
			description: typeof item.description === "string" ? item.description.slice(0, 4_096) : undefined,
			input,
			subcommands,
			source: item.source,
		});
	}
	return commands;
}

function isSlashCommandSource(value: unknown): value is SlashCommand["source"] {
	return (
		value === "builtin" ||
		value === "skill" ||
		value === "extension" ||
		value === "custom" ||
		value === "mcp_prompt" ||
		value === "file"
	);
}

function toModelOption(value: unknown): ModelOption | undefined {
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
	if (value.provider.length === 0 || value.provider.length > 160 || value.id.length === 0 || value.id.length > 512)
		return undefined;
	return {
		provider: value.provider,
		id: value.id,
		name: typeof value.name === "string" && value.name.length <= 512 ? value.name : value.id,
		reasoning: value.reasoning === true,
		contextWindow:
			typeof value.contextWindow === "number" && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0
				? value.contextWindow
				: undefined,
	};
}

function dehydrateTimelineItem(item: TimelineItem): TimelineItem {
	if (item.kind !== "thinking" || item.text.length <= 64 * 1024) return { ...item };
	return { ...item, text: "Reasoning available. Open to load the full record.", textLoaded: false };
}

function toSubagentView(value: unknown): SubagentView {
	const candidate = value as Record<string, unknown>;
	const progress =
		typeof candidate.progress === "object" && candidate.progress !== null
			? (candidate.progress as Record<string, unknown>)
			: undefined;
	return {
		id: String(candidate.id ?? randomUUID()),
		agent: String(candidate.agent ?? "subagent"),
		status: String(candidate.status ?? "pending"),
		task: typeof candidate.task === "string" ? candidate.task : undefined,
		assignment: typeof candidate.assignment === "string" ? candidate.assignment : undefined,
		parentToolCallId: typeof candidate.parentToolCallId === "string" ? candidate.parentToolCallId : undefined,
		progress: progress
			? {
					currentTool: typeof progress.currentTool === "string" ? progress.currentTool : undefined,
					lastIntent: typeof progress.lastIntent === "string" ? progress.lastIntent : undefined,
					tokens: typeof progress.tokens === "number" ? progress.tokens : undefined,
					contextTokens: typeof progress.contextTokens === "number" ? progress.contextTokens : undefined,
					contextWindow: typeof progress.contextWindow === "number" ? progress.contextWindow : undefined,
					cost: typeof progress.cost === "number" ? progress.cost : undefined,
					durationMs: typeof progress.durationMs === "number" ? progress.durationMs : undefined,
					recentOutput: Array.isArray(progress.recentOutput)
						? progress.recentOutput.filter((item): item is string => typeof item === "string")
						: undefined,
					resolvedModel: typeof progress.resolvedModel === "string" ? progress.resolvedModel : undefined,
					requests: typeof progress.requests === "number" ? progress.requests : undefined,
				}
			: undefined,
	};
}
function assertAuthProvider(value: unknown): "openai-codex" {
	if (value !== "openai-codex") throw new TypeError("Unsupported OAuth provider");
	return value;
}
