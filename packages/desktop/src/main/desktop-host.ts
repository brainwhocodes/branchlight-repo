import { randomUUID } from "node:crypto";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { WorkspaceDocumentV1, WorkspacePrincipalV1 } from "@oh-my-pi/pi-wire";
import type { SelectionAuthScope } from "@oh-my-pi/pi-workspace-runtime/selection";
import { type BrowserWindow, dialog, shell } from "electron";
import type {
	AgentSettingOption,
	AgentSettingValue,
	AgentSettingView,
	AuthAccountView,
	AuthEvent,
	BootstrapSnapshot,
	BranchlightEvent,
	ExtensionView,
	FileDiffView,
	InterruptMode,
	ModelOption,
	OAuthAccountSummaryView,
	OAuthAccountsView,
	OAuthProviderAccountsView,
	OpenRouterModelRouting,
	ProcessState,
	QueueMode,
	RuntimeReportView,
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
import { RuntimeSupervisor } from "./runtime-supervisor";
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
	autoRetryEnabled?: boolean;
	contextTokens?: number;
	contextWindow?: number;
	tokensPerSecond?: number | null;
	queuedMessageCount?: number;
	todoPhases?: SessionSnapshot["todoPhases"];
	outstandingExtensions: Map<string, RpcExtensionUIRequest["method"]>;
	fileDiffCache: Map<string, { expiresAt: number; request: Promise<FileDiffView> }>;
};

type TimerHandle = NodeJS.Timeout;
const FILE_DIFF_CACHE_TTL_MS = 1_000;

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
	autoRetryEnabled: boolean;
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

function isWindowUsable(window?: BrowserWindow): boolean {
	if (!window) return false;
	if (typeof window.isDestroyed === "function" && window.isDestroyed()) return false;
	if (window.webContents && typeof window.webContents.isDestroyed === "function" && window.webContents.isDestroyed())
		return false;
	return Boolean(window.webContents?.send);
}

export class DesktopHost {
	#registry: SessionRegistry;
	#window: BrowserWindow | undefined;
	#runtimes = new Map<string, RuntimeSession>();
	#supervisor: RuntimeSupervisor;
	#eventQueues = new Map<string, BranchlightEvent[]>();
	#eventTimers = new Map<string, TimerHandle>();
	#warning: string | undefined;
	#authProcess: RpcProcess | undefined;
	#authClient: Promise<RpcClient> | undefined;
	#authClientUsers = 0;
	#authLogin: Promise<AuthAccountView[]> | undefined;
	#activeAuthProvider: { id: string; name: string } | undefined;
	#authPrompt:
		| {
				id: string;
				process: RpcProcess;
		  }
		| undefined;
	#document: WorkspaceDocumentV1 | undefined;
	#principal: WorkspacePrincipalV1 | undefined;

	constructor(userDataPath: string) {
		this.#registry = new SessionRegistry(userDataPath);
		this.#supervisor = new RuntimeSupervisor({
			maxResident: 3,
			idleTimeoutMs: 300_000,
			sampleIntervalMs: 5_000,
			onReport: report => this.#onRuntimeReport(report),
		});
	}

	setWorkspaceAuthority(principal: WorkspacePrincipalV1, document: WorkspaceDocumentV1): void {
		this.#principal = principal;
		this.#document = document;
	}

	get principal(): WorkspacePrincipalV1 | undefined {
		return this.#principal;
	}

	getDocument(): WorkspaceDocumentV1 | undefined {
		return this.#document;
	}

	syncWithDocument(doc: WorkspaceDocumentV1): void {
		this.#document = doc;
	}

	async load(): Promise<void> {
		await this.#registry.load();
		this.#warning = this.#registry.warning;
		for (const record of this.#registry.value.sessions) this.#createRuntime(record);
	}

	setWindow(window: BrowserWindow | undefined): void {
		this.#window = window;
	}

	bootstrap(): BootstrapSnapshot {
		return { registry: this.#registry.value, warning: this.#warning };
	}
	async getAuthStatus(): Promise<AuthAccountView[]> {
		return this.#authAccounts();
	}

	async getOAuthAccounts(): Promise<OAuthAccountsView> {
		return this.#oauthAccounts();
	}

	async setOAuthAccountLock(providerInput: unknown, credentialInput: unknown): Promise<OAuthAccountsView> {
		const providerId = assertAuthProvider(providerInput);
		const credentialId = credentialInput === undefined ? undefined : assertCredentialId(credentialInput);
		const response = await this.#withAuthClient(client =>
			client.request({
				type: "set_oauth_account_lock",
				providerId,
				...(credentialId === undefined ? {} : { credentialId }),
			}),
		);
		if (!response.success) throw new Error(response.error ?? "OAuth account lock update failed");
		return normalizeOAuthAccounts(response.data);
	}

	async setOAuthAccountFailover(enabledInput: unknown): Promise<OAuthAccountsView> {
		if (typeof enabledInput !== "boolean") throw new TypeError("account failover must be boolean");
		const response = await this.#withAuthClient(client =>
			client.request({ type: "set_oauth_account_failover", enabled: enabledInput }),
		);
		if (!response.success) throw new Error(response.error ?? "OAuth account failover update failed");
		return normalizeOAuthAccounts(response.data);
	}

	async removeOAuthAccount(providerInput: unknown, credentialInput: unknown): Promise<OAuthAccountsView> {
		const providerId = assertAuthProvider(providerInput);
		const credentialId = assertCredentialId(credentialInput);
		const response = await this.#withAuthClient(client =>
			client.request({ type: "remove_oauth_account", providerId, credentialId }),
		);
		if (!response.success) throw new Error(response.error ?? "OAuth account removal failed");
		return normalizeOAuthAccounts(response.data);
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
		const account = (await this.#authAccounts()).find(candidate => candidate.provider === provider);
		if (!account) throw new Error(`Unsupported OAuth provider: ${provider}`);
		const response = await this.#withAuthClient(client => client.request({ type: "logout", providerId: provider }));
		if (!response.success) throw new Error(response.error ?? "Sign-out failed");
		this.#emitAuth({ type: "complete", provider, message: `Signed out of ${account.name}.` });
		return this.#authAccounts();
	}

	respondAuthPrompt(valueInput: unknown): void {
		const value = assertBoundedText(valueInput, "auth prompt");
		const pending = this.#authPrompt;
		if (!pending) throw new Error("No authentication prompt is pending");
		this.#authPrompt = undefined;
		pending.process.client?.sendExtensionResponse({ type: "extension_ui_response", id: pending.id, value });
	}

	async getAgentSettings(idInput?: unknown): Promise<AgentSettingView[]> {
		const response = await this.#withSettingsClient(idInput, client => client.request({ type: "get_settings" }));
		if (!response.success) throw new Error(response.error ?? "Agent settings are unavailable");
		const data = isRecord(response.data) ? response.data : undefined;
		return normalizeAgentSettings(data?.settings);
	}

	async setAgentSetting(idInput: unknown, pathInput: unknown, valueInput: unknown): Promise<AgentSettingView> {
		const path = assertBoundedText(pathInput, "setting path").trim();
		if (!path || path.length > 160) throw new TypeError("invalid setting path");
		const value = assertAgentSettingValue(valueInput);
		const response = await this.#withSettingsClient(idInput, client =>
			client.request({ type: "set_setting", path, value }),
		);
		if (!response.success) throw new Error(response.error ?? "Agent setting update failed");
		const data = isRecord(response.data) ? response.data : undefined;
		const setting = normalizeAgentSetting(data?.setting);
		if (!setting) throw new Error("Agent setting response was invalid");
		return setting;
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
			return await this.#supervisor.run(record.id, async () => {
				await this.#registry.create(runtime.record);
				return this.#snapshot(runtime);
			});
		} catch (error) {
			await this.#supervisor.unregister(record.id);
			this.#runtimes.delete(record.id);
			throw error;
		}
	}
	async openSession(id: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		return this.#supervisor.run(record.id, async () => {
			this.#supervisor.touch(record.id);
			await this.#registry.setActive(record.kind, record.id);
			return this.#snapshot(this.#requiredRuntime(record.id));
		});
	}
	async resume(id: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		if (!record.sessionFile) throw new Error("No resumable OMP session file exists");
		return this.#supervisor.run(record.id, async () => {
			const runtime = this.#requiredRuntime(record.id);
			const lastOpenedAt = new Date().toISOString();
			await this.#registry.update(record.id, { lastOpenedAt });
			await this.#registry.setActive(record.kind, record.id);
			runtime.record = { ...runtime.record, lastOpenedAt };
			this.#supervisor.touch(record.id);
			return this.#snapshot(runtime);
		});
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
		return this.#runWithRuntime(idInput, async (runtime, client) => {
			if (runtime.commands.length > 0) return [...runtime.commands];
			const response = await client.request({ type: "get_available_commands" });
			if (!response.success) throw new Error(response.error ?? "Slash commands are unavailable");
			const data = isRecord(response.data) ? response.data : undefined;
			runtime.commands = normalizeSlashCommands(data?.commands);
			return [...runtime.commands];
		});
	}

	async getAvailableModels(idInput: unknown): Promise<ModelOption[]> {
		return this.#runWithRuntime(idInput, async (runtime, client) => {
			if (runtime.models) return [...runtime.models];
			const response = await client.request({ type: "get_available_models" });
			if (!response.success) throw new Error(response.error ?? "Models are unavailable");
			const data = isRecord(response.data) ? response.data : undefined;
			const models = Array.isArray(data?.models)
				? data.models.map(toModelOption).filter((model): model is ModelOption => model !== undefined)
				: [];
			runtime.models = models;
			return [...models];
		});
	}
	async getOpenRouterModelRouting(idInput: unknown, modelInput: unknown): Promise<OpenRouterModelRouting> {
		const modelId = assertBoundedText(modelInput, "model").trim();
		if (!modelId) throw new TypeError("invalid model");
		return this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({
				type: "get_openrouter_model_routing",
				modelId,
			});
			if (!response.success) throw new Error(response.error ?? "OpenRouter routes are unavailable");
			return normalizeOpenRouterModelRouting(response.data);
		});
	}

	async setOpenRouterProviderEnabled(
		idInput: unknown,
		modelInput: unknown,
		providerInput: unknown,
		enabledInput: unknown,
	): Promise<OpenRouterModelRouting> {
		const modelId = assertBoundedText(modelInput, "model").trim();
		const providerId = assertBoundedText(providerInput, "provider").trim();
		if (!modelId || !providerId || typeof enabledInput !== "boolean") {
			throw new TypeError("invalid OpenRouter routing preference");
		}
		return this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({
				type: "set_openrouter_provider_enabled",
				modelId,
				providerId,
				enabled: enabledInput,
			});
			if (!response.success) throw new Error(response.error ?? "OpenRouter route could not be updated");
			return normalizeOpenRouterModelRouting(response.data);
		});
	}

	async stop(id: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		await this.#supervisor.stop(record.id);
		return this.#snapshot(this.#requiredRuntime(record.id));
	}

	async rename(id: unknown, titleInput: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		const title = assertSessionName(titleInput);
		const runtime = this.#requiredRuntime(record.id);
		if (runtime.state === "ready" || runtime.state === "running") {
			await this.#supervisor.run(record.id, async () => {
				const client = runtime.process.client;
				if (!client) throw new Error("OMP is not ready");
				const response = await client.request({ type: "set_session_name", name: title });
				if (!response.success) throw new Error(response.error);
			});
		}
		await this.#registry.update(record.id, { title });
		runtime.record = { ...runtime.record, title };
		return this.#snapshot(runtime);
	}

	async prompt(id: unknown, textInput: unknown): Promise<void> {
		const text = assertBoundedText(textInput, "prompt");
		await this.#runWithRuntime(id, async (_runtime, client) => client.prompt(text));
	}
	resolveSelectionScope(paneId: string, targetAgentId?: string, documentEpoch?: number): SelectionAuthScope {
		if (!paneId || paneId.trim().length === 0) {
			throw new Error("Pane ID is required for selection scope");
		}

		if (!targetAgentId || targetAgentId.trim().length === 0) {
			throw new Error("Explicit target agent ID is required for selection authorization");
		}

		const doc = this.#document;
		const principal = this.#principal;

		if (!doc || !principal) {
			throw new Error("No authenticated workspace authority found for selection");
		}

		// 1. Exact agent
		const agent = doc.agents.find(a => a.id === targetAgentId);
		if (!agent) {
			throw new Error(`Target agent '${targetAgentId}' not found in authenticated workspace authority`);
		}
		// 2. Active session
		if (!agent.sessionId) {
			throw new Error(`Target agent '${targetAgentId}' has no active session`);
		}
		const session = doc.sessions.find(s => s.id === agent.sessionId);
		if (!session) {
			throw new Error(`Session '${agent.sessionId}' for agent '${targetAgentId}' not found in authority document`);
		}

		// 3. Session location
		const location = doc.locations.find(l => l.id === session.locationId);
		if (!location) {
			throw new Error(
				`Location '${session.locationId}' for session '${session.id}' not found in authority document`,
			);
		}

		// 4. Requested pane
		const pane = doc.panes.find(p => p.id === paneId);
		if (!pane) {
			throw new Error(`Pane '${paneId}' not found in authority document`);
		}
		if (pane.kind !== "browser") {
			throw new Error(`Pane '${paneId}' is a ${pane.kind} pane, not a browser pane`);
		}

		// 5. Owning tab
		const tab = doc.tabs.find(t => t.id === pane.tabId);
		if (!tab) {
			throw new Error(`Tab '${pane.tabId}' for pane '${paneId}' not found in authority document`);
		}

		// 6. Owning workspace from the tab
		const workspace = doc.workspaces.find(w => w.id === tab.workspaceId);
		if (!workspace) {
			throw new Error(`Workspace '${tab.workspaceId}' for tab '${tab.id}' not found in authority document`);
		}

		// 7. Same location and generation verification
		if (tab.locationId !== location.id) {
			throw new Error(`Pane location '${tab.locationId}' does not match agent location '${location.id}'`);
		}
		if (tab.generation !== location.lifecycle.generation) {
			throw new Error(
				`Tab generation ${tab.generation} does not match active location generation ${location.lifecycle.generation}`,
			);
		}
		// 8. Exact open browser entity verification
		const browser = doc.browsers.find(
			b =>
				b.id === pane.entityId &&
				b.paneId === pane.id &&
				b.locationId === location.id &&
				b.generation === location.lifecycle.generation &&
				(b.status === "opening" || b.status === "open"),
		);
		if (!browser) {
			throw new Error(`Open browser entity '${pane.entityId}' for pane '${paneId}' not found in authority document`);
		}

		if (typeof documentEpoch !== "number" || !Number.isSafeInteger(documentEpoch) || documentEpoch <= 0) {
			throw new Error("Valid positive documentEpoch is required for selection scope");
		}

		return {
			principalId: principal.id,
			workspaceId: workspace.id,
			tabId: tab.id,
			paneId: pane.id,
			documentEpoch,
			locationGeneration: location.lifecycle.generation,
			locationId: location.id,
			agentId: agent.id,
			sessionId: session.id,
		};
	}
	async steer(id: unknown, textInput: unknown): Promise<void> {
		const message = assertBoundedText(textInput, "steer");
		await this.#runWithRuntime(id, async (_runtime, client) => {
			const response = await client.request({ type: "steer", message });
			if (!response.success) throw new Error(response.error);
		});
	}

	async queueFollowUp(id: unknown, textInput: unknown): Promise<void> {
		const message = assertBoundedText(textInput, "follow-up");
		await this.#runWithRuntime(id, async (_runtime, client) => {
			const response = await client.request({ type: "follow_up", message });
			if (!response.success) throw new Error(response.error);
		});
	}

	async abort(id: unknown): Promise<void> {
		await this.#runWithRuntime(id, async (_runtime, client) => {
			const response = await client.request({ type: "abort" });
			if (!response.success) throw new Error(response.error);
		});
	}

	async setModel(id: unknown, providerInput: unknown, modelIdInput: unknown): Promise<void> {
		const provider = assertBoundedText(providerInput, "model provider");
		const modelId = assertBoundedText(modelIdInput, "model id");
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({
				type: "set_model",
				provider,
				modelId,
			});
			if (!response.success) throw new Error(response.error);
			runtime.model = `${provider}/${modelId}`;
		});
	}

	async setThinking(id: unknown, levelInput: unknown): Promise<void> {
		return this.setThinkingLevel(id, levelInput);
	}

	async setThinkingLevel(id: unknown, levelInput: unknown): Promise<void> {
		const level = assertThinkingLevel(levelInput);
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({
				type: "set_thinking_level",
				level,
			});
			if (!response.success) throw new Error(response.error);
			runtime.thinkingLevel = level;
		});
	}
	async setFastMode(id: unknown, enabled: unknown): Promise<void> {
		if (typeof enabled !== "boolean") throw new TypeError("invalid fast mode value");
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({ type: "set_fast_mode", enabled });
			if (!response.success) throw new Error(response.error);
			const data = isRecord(response.data) ? response.data : undefined;
			runtime.fastMode = typeof data?.enabled === "boolean" ? data.enabled : enabled;
		});
	}

	async setQueueMode(id: unknown, kindInput: unknown, modeInput: unknown): Promise<void> {
		if (kindInput !== "steering" && kindInput !== "follow-up") throw new TypeError("invalid queue mode kind");
		const mode = assertQueueMode(modeInput);
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({
				type: kindInput === "steering" ? "set_steering_mode" : "set_follow_up_mode",
				mode,
			});
			if (!response.success) throw new Error(response.error);
			if (kindInput === "steering") runtime.steeringMode = mode;
			else runtime.followUpMode = mode;
		});
	}

	async setInterruptMode(id: unknown, modeInput: unknown): Promise<void> {
		const mode = assertInterruptMode(modeInput);
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({ type: "set_interrupt_mode", mode });
			if (!response.success) throw new Error(response.error);
			runtime.interruptMode = mode;
		});
	}

	async setAutoCompaction(id: unknown, enabled: unknown): Promise<void> {
		if (typeof enabled !== "boolean") throw new TypeError("invalid auto-compaction value");
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({ type: "set_auto_compaction", enabled });
			if (!response.success) throw new Error(response.error);
			runtime.autoCompactionEnabled = enabled;
		});
	}

	async setAutoRetry(id: unknown, enabled: unknown): Promise<void> {
		if (typeof enabled !== "boolean") throw new TypeError("invalid auto-retry value");
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({ type: "set_auto_retry", enabled });
			if (!response.success) throw new Error(response.error);
			runtime.autoRetryEnabled = enabled;
		});
	}

	async extensionResponse(idInput: unknown, responseInput: unknown): Promise<void> {
		if (typeof responseInput !== "object" || responseInput === null || !("id" in responseInput))
			throw new TypeError("invalid extension response");
		const response = responseInput as Record<string, unknown>;
		if (typeof response.id !== "string") throw new TypeError("invalid extension response id");
		if (response.value !== undefined) assertBoundedText(response.value, "extension response");
		if (response.confirmed !== undefined && typeof response.confirmed !== "boolean")
			throw new TypeError("invalid extension confirmation");
		if (response.cancelled !== undefined && response.cancelled !== true)
			throw new TypeError("invalid extension cancellation");
		await this.#runWithRuntime(idInput, (runtime, client) => {
			const expected = runtime.outstandingExtensions.get(response.id as string);
			if (!expected) throw new Error("stale extension response");
			if (response.method !== undefined && response.method !== expected)
				throw new Error("extension response method mismatch");
			runtime.outstandingExtensions.delete(response.id as string);
			client.sendExtensionResponse({
				...response,
				type: "extension_ui_response",
			} as RpcExtensionUIResponse);
		});
	}

	async getSubagentMessages(idInput: unknown, subagentIdInput: unknown, fromByteInput: unknown): Promise<unknown> {
		if (
			typeof subagentIdInput !== "string" ||
			typeof fromByteInput !== "number" ||
			!Number.isSafeInteger(fromByteInput) ||
			fromByteInput < 0
		)
			throw new TypeError("invalid subagent transcript request");
		return this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({
				type: "get_subagent_messages",
				subagentId: subagentIdInput,
				fromByte: fromByteInput,
			});
			if (!response.success) throw new Error(response.error ?? "subagent transcript unavailable");
			return response.data;
		});
	}
	async loadFileDiff(idInput: unknown, targetInput: unknown): Promise<FileDiffView> {
		const target = assertBoundedText(targetInput, "file diff path").trim();
		if (!target || target.length > 4_096) throw new TypeError("invalid file diff path");
		return this.#runWithRuntime(idInput, async (runtime, client) => {
			const key = fileDiffCacheKey(target);
			const cached = runtime.fileDiffCache.get(key);
			if (cached && cached.expiresAt > Date.now()) return cached.request;

			const request = client.request({ type: "get_file_diff", path: target }).then(response => {
				if (!response.success) throw new Error(response.error ?? "File diff is unavailable");
				return normalizeFileDiff(response.data);
			});
			const entry = { expiresAt: Date.now() + FILE_DIFF_CACHE_TTL_MS, request };
			runtime.fileDiffCache.set(key, entry);
			try {
				return await request;
			} catch (error) {
				if (runtime.fileDiffCache.get(key) === entry) runtime.fileDiffCache.delete(key);
				throw error;
			}
		});
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
		await this.#supervisor.close();
	}
	async close(): Promise<void> {
		this.#authPrompt = undefined;
		const authProcess = this.#authProcess;
		this.#authProcess = undefined;
		this.#authClient = undefined;
		await Promise.all([this.#supervisor.close(), authProcess?.stop().catch(() => {})]);
	}

	#createRuntime(record: SessionRecordV1): RuntimeSession {
		const runtime = {} as RuntimeSession;
		runtime.record = record;
		runtime.timeline = new TranscriptStore();
		runtime.state = "stopped";
		runtime.subagents = [];
		runtime.commands = [];
		runtime.outstandingExtensions = new Map();
		runtime.fileDiffCache = new Map();
		runtime.process = new RpcProcess({
			cwd: record.cwd,
			onEvent: event => this.#onEvent(runtime, event),
			onExtension: request => this.#onExtension(runtime, request),
			onState: (state, error) => {
				runtime.state = state;
				if (this.#runtimes.get(runtime.record.id) !== runtime) return;
				this.#supervisor.updateState(runtime.record.id, state);
				if (error) {
					this.#emitUrgent({
						sessionId: runtime.record.id,
						type: "session",
						state,
						runtime: this.#supervisor.report(runtime.record.id),
						message: error,
					});
				}
			},
		});
		this.#runtimes.set(record.id, runtime);
		this.#supervisor.register({
			id: record.id,
			start: async () => {
				try {
					await this.#startRuntime(runtime);
				} catch (error) {
					if (runtime.process.state !== "stopping" && runtime.process.state !== "stopped") {
						await runtime.process.stop().catch(() => {});
					}
					throw error;
				}
			},
			stop: async () => {
				await runtime.process.stop();
				runtime.outstandingExtensions.clear();
			},
			sample: () => runtime.process.sample(),
		});
		return runtime;
	}

	async #startRuntime(runtime: RuntimeSession): Promise<void> {
		const client = await runtime.process.start(runtime.record.sessionFile || undefined);
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
		runtime.autoRetryEnabled = data.autoRetryEnabled ?? true;
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
		this.#emitUrgent({ sessionId: runtime.record.id, type: "timeline" });
	}

	async #runWithRuntime<T>(
		idInput: unknown,
		operation: (runtime: RuntimeSession, client: RpcClient) => T | Promise<T>,
	): Promise<T> {
		const record = this.#record(idInput);
		const runtime = this.#requiredRuntime(record.id);
		return this.#supervisor.run(record.id, () => {
			const client = runtime.process.client;
			if (!client) throw new Error("OMP is not ready");
			return operation(runtime, client);
		});
	}

	#requiredRuntime(id: string): RuntimeSession {
		const runtime = this.#runtimes.get(id);
		if (!runtime) throw new Error(`Runtime ${id} is not registered`);
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
			autoRetryEnabled: runtime.autoRetryEnabled,
			contextTokens: runtime.contextTokens,
			contextWindow: runtime.contextWindow,
			tokensPerSecond: runtime.tokensPerSecond,
			queuedMessageCount: runtime.queuedMessageCount,
			todoPhases: runtime.todoPhases,
			runtime: this.#supervisor.report(runtime.record.id),
		};
	}

	async #oauthAccounts(): Promise<OAuthAccountsView> {
		const response = await this.#withAuthClient(client => client.request({ type: "get_oauth_accounts" }));
		if (!response.success) throw new Error(response.error ?? "OAuth accounts are unavailable");
		return normalizeOAuthAccounts(response.data);
	}
	async #authAccounts(): Promise<AuthAccountView[]> {
		const fallback: AuthAccountView = {
			provider: "openai-codex",
			name: "ChatGPT Plus/Pro (Codex Subscription)",
			available: true,
			signedIn: false,
		};
		try {
			const response = await this.#withAuthClient(client => client.request({ type: "get_login_providers" }));
			if (!response.success) return [fallback];
			const data = isRecord(response.data) ? response.data : undefined;
			return normalizeAuthAccounts(data?.providers);
		} catch {
			return [fallback];
		}
	}

	async #runAuthLogin(provider: string): Promise<AuthAccountView[]> {
		let providerName = provider;
		try {
			const account = (await this.#authAccounts()).find(candidate => candidate.provider === provider);
			if (!account) throw new Error(`Unsupported OAuth provider: ${provider}`);
			if (!account.available) throw new Error(`${account.name} sign-in is unavailable on this system`);
			providerName = account.name;
			this.#activeAuthProvider = { id: provider, name: providerName };
			const response = await this.#withAuthClient(client => client.request({ type: "login", providerId: provider }));
			if (!response.success) throw new Error(response.error ?? `${providerName} sign-in failed`);
			this.#emitAuth({ type: "complete", provider, message: `${providerName} sign-in complete.` });
			return this.#authAccounts();
		} catch (error) {
			this.#authPrompt = undefined;
			const message = error instanceof Error ? error.message : String(error);
			this.#emitAuth({ type: "error", provider, message });
			throw error;
		} finally {
			if (this.#activeAuthProvider?.id === provider) this.#activeAuthProvider = undefined;
		}
	}

	async #withSettingsClient<T>(idInput: unknown, operation: (client: RpcClient) => Promise<T>): Promise<T> {
		if (idInput !== undefined) {
			const record = this.#record(idInput);
			const runtime = this.#requiredRuntime(record.id);
			if (runtime.state === "ready" || runtime.state === "running") {
				return this.#supervisor.run(record.id, () => {
					const client = runtime.process.client;
					if (!client) throw new Error("OMP is not ready");
					return operation(client);
				});
			}
		}
		return this.#withAuthClient(operation);
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
		const provider = this.#activeAuthProvider ?? {
			id: "openai-codex",
			name: "ChatGPT Plus/Pro (Codex Subscription)",
		};
		if (request.method === "notify" && request.message) {
			this.#emitAuth({ type: "progress", provider: provider.id, message: request.message });
			return;
		}
		if (request.method === "open_url" && request.url) {
			this.#emitAuth({
				type: "auth-url",
				provider: provider.id,
				message: `Opening ${provider.name} sign-in in your browser.`,
				url: request.launchUrl ?? request.url,
			});
			void this.openExternal(request.launchUrl ?? request.url).catch(error =>
				this.#emitAuth({
					type: "error",
					provider: provider.id,
					message: error instanceof Error ? error.message : String(error),
				}),
			);
			return;
		}
		if (request.method !== "input" || !this.#authProcess) return;
		this.#authPrompt = { id: request.id, process: this.#authProcess };
		this.#emitAuth({
			type: "prompt",
			provider: provider.id,
			message: request.title ?? `Finish signing in to ${provider.name}`,
			placeholder: request.placeholder,
			sensitive: true,
		});
	}

	#emitAuth(event: AuthEvent): void {
		if (isWindowUsable(this.#window)) {
			this.#window?.webContents.send("branchlight:auth", event);
		}
	}

	#onRuntimeReport(report: RuntimeReportView): void {
		if (!this.#runtimes.has(report.id)) return;
		this.#emitUrgent({
			sessionId: report.id,
			type: "session",
			state: report.processState,
			runtime: report,
		});
	}

	#onEvent(runtime: RuntimeSession, event: unknown): void {
		this.#supervisor.touch(runtime.record.id);
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
					autoRetryEnabled: runtime.autoRetryEnabled,
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
		if (items.some(item => item.status === "complete" && item.isError !== true && item.files?.length)) {
			runtime.fileDiffCache.clear();
		}
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
		this.#supervisor.touch(runtime.record.id);
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
		if (isWindowUsable(this.#window)) {
			for (const event of queue) this.#window?.webContents.send("branchlight:event", event);
		}
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
		input: Array.isArray(value.input)
			? [
					...new Set(
						value.input.filter(
							(input): input is ModelOption["input"][number] => input === "text" || input === "image",
						),
					),
				]
			: ["text"],
		contextWindow:
			typeof value.contextWindow === "number" && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0
				? value.contextWindow
				: undefined,
	};
}
function normalizeOpenRouterModelRouting(value: unknown): OpenRouterModelRouting {
	if (
		!isRecord(value) ||
		typeof value.modelId !== "string" ||
		value.modelId.length === 0 ||
		value.modelId.length > 512 ||
		!Array.isArray(value.providers) ||
		value.providers.length > 512
	) {
		throw new Error("OpenRouter routing response was invalid");
	}
	const providers: OpenRouterModelRouting["providers"] = [];
	const seen = new Set<string>();
	for (const item of value.providers) {
		if (
			!isRecord(item) ||
			typeof item.id !== "string" ||
			item.id.length === 0 ||
			item.id.length > 128 ||
			typeof item.name !== "string" ||
			item.name.length === 0 ||
			item.name.length > 256 ||
			typeof item.enabled !== "boolean" ||
			seen.has(item.id)
		) {
			throw new Error("OpenRouter routing response was invalid");
		}
		seen.add(item.id);
		providers.push({ id: item.id, name: item.name, enabled: item.enabled });
	}
	if (providers.length === 0) throw new Error("OpenRouter routing response did not include providers");
	return { modelId: value.modelId, providers };
}

function dehydrateTimelineItem(item: TimelineItem): TimelineItem {
	if (item.kind !== "thinking" || item.text.length <= 64 * 1024) return { ...item };
	return { ...item, text: "Reasoning available. Open to load the full record.", textLoaded: false };
}

function normalizeFileDiff(value: unknown): FileDiffView {
	if (
		!isRecord(value) ||
		typeof value.path !== "string" ||
		typeof value.diff !== "string" ||
		!isFileDiffStatus(value.status) ||
		typeof value.additions !== "number" ||
		!Number.isSafeInteger(value.additions) ||
		value.additions < 0 ||
		typeof value.deletions !== "number" ||
		!Number.isSafeInteger(value.deletions) ||
		value.deletions < 0 ||
		typeof value.truncated !== "boolean"
	)
		throw new Error("File diff response was invalid");
	return {
		path: value.path,
		diff: value.diff,
		status: value.status,
		additions: value.additions,
		deletions: value.deletions,
		truncated: value.truncated,
		message: typeof value.message === "string" ? value.message : undefined,
	};
}

function isFileDiffStatus(value: unknown): value is FileDiffView["status"] {
	return (
		value === "modified" ||
		value === "added" ||
		value === "deleted" ||
		value === "renamed" ||
		value === "clean" ||
		value === "binary" ||
		value === "unavailable"
	);
}

function fileDiffCacheKey(target: string): string {
	const normalized = target.replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
function normalizeAuthAccounts(value: unknown): AuthAccountView[] {
	if (!Array.isArray(value)) return [];
	const accounts: AuthAccountView[] = [];
	const seen = new Set<string>();
	for (const candidate of value.slice(0, 1_000)) {
		if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.name !== "string") continue;
		if (
			candidate.id.length === 0 ||
			candidate.id.length > 160 ||
			candidate.name.length === 0 ||
			candidate.name.length > 512 ||
			seen.has(candidate.id)
		)
			continue;
		seen.add(candidate.id);
		accounts.push({
			provider: candidate.id,
			name: candidate.name,
			available: candidate.available === true,
			signedIn: candidate.authenticated === true,
		});
	}
	return accounts.sort(
		(left, right) =>
			Number(right.signedIn) - Number(left.signedIn) ||
			Number(right.available) - Number(left.available) ||
			left.name.localeCompare(right.name),
	);
}

function normalizeOAuthAccounts(value: unknown): OAuthAccountsView {
	const data = isRecord(value) ? value : undefined;
	const providers: OAuthProviderAccountsView[] = [];
	const seenProviders = new Set<string>();
	if (!Array.isArray(data?.providers)) return { providers };
	for (const candidate of data.providers.slice(0, 1_000)) {
		if (
			!isRecord(candidate) ||
			typeof candidate.id !== "string" ||
			!/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(candidate.id) ||
			typeof candidate.name !== "string" ||
			candidate.name.length === 0 ||
			candidate.name.length > 512 ||
			seenProviders.has(candidate.id)
		)
			continue;
		seenProviders.add(candidate.id);
		const accounts: OAuthAccountSummaryView[] = [];
		const seenCredentials = new Set<number>();
		if (Array.isArray(candidate.accounts)) {
			for (const account of candidate.accounts.slice(0, 1_000)) {
				if (
					!isRecord(account) ||
					!Number.isSafeInteger(account.credentialId) ||
					(account.credentialId as number) < 0 ||
					seenCredentials.has(account.credentialId as number)
				)
					continue;
				const optionalText = (key: string): string | undefined => {
					const value = account[key];
					return typeof value === "string" && value.length <= 512 ? value : undefined;
				};
				const credentialId = account.credentialId as number;
				seenCredentials.add(credentialId);
				accounts.push({
					credentialId,
					email: optionalText("email"),
					accountId: optionalText("accountId"),
					orgId: optionalText("orgId"),
					orgName: optionalText("orgName"),
					projectId: optionalText("projectId"),
					active: account.active === true,
					locked: account.locked === true,
					lockable: account.lockable === true,
				});
			}
		}
		const lockedCredentialId =
			Number.isSafeInteger(candidate.lockedCredentialId) && (candidate.lockedCredentialId as number) >= 0
				? (candidate.lockedCredentialId as number)
				: undefined;
		providers.push({
			id: candidate.id,
			name: candidate.name,
			available: candidate.available === true,
			failover: candidate.failover === true,
			lockedCredentialId,
			accounts,
		});
	}
	return { providers };
}
function normalizeAgentSettings(value: unknown): AgentSettingView[] {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, 1_000)
		.map(normalizeAgentSetting)
		.filter((setting): setting is AgentSettingView => setting !== undefined);
}

function normalizeAgentSetting(value: unknown): AgentSettingView | undefined {
	if (
		!isRecord(value) ||
		typeof value.path !== "string" ||
		value.path.length === 0 ||
		value.path.length > 160 ||
		!isAgentSettingTab(value.tab) ||
		typeof value.label !== "string" ||
		value.label.length === 0 ||
		value.label.length > 512 ||
		typeof value.description !== "string" ||
		value.description.length > 8_192 ||
		(value.control !== "toggle" && value.control !== "select") ||
		(value.apply !== "immediate" && value.apply !== "next-session") ||
		!isAgentSettingValue(value.value)
	)
		return undefined;
	if (value.control === "toggle" && typeof value.value !== "boolean") return undefined;
	const options = Array.isArray(value.options)
		? value.options
				.slice(0, 1_000)
				.map(normalizeAgentSettingOption)
				.filter((option): option is AgentSettingOption => option !== undefined)
		: undefined;
	if (value.control === "select" && (!options || options.length === 0)) return undefined;
	return {
		path: value.path,
		tab: value.tab,
		group: typeof value.group === "string" && value.group.length <= 160 ? value.group : undefined,
		label: value.label,
		description: value.description,
		control: value.control,
		value: value.value,
		options,
		apply: value.apply,
	};
}

function normalizeAgentSettingOption(value: unknown): AgentSettingOption | undefined {
	if (
		!isRecord(value) ||
		!isAgentSettingValue(value.value) ||
		typeof value.label !== "string" ||
		value.label.length === 0 ||
		value.label.length > 512
	)
		return undefined;
	return {
		value: value.value,
		label: value.label,
		description:
			typeof value.description === "string" && value.description.length <= 4_096 ? value.description : undefined,
	};
}

function isAgentSettingTab(value: unknown): value is AgentSettingView["tab"] {
	return (
		value === "appearance" ||
		value === "model" ||
		value === "interaction" ||
		value === "context" ||
		value === "tools" ||
		value === "tasks"
	);
}

function isAgentSettingValue(value: unknown): value is AgentSettingValue {
	return (
		typeof value === "boolean" ||
		(typeof value === "string" && value.length <= 2_048) ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function assertAgentSettingValue(value: unknown): AgentSettingValue {
	if (!isAgentSettingValue(value)) throw new TypeError("invalid agent setting value");
	return value;
}

function assertAuthProvider(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value))
		throw new TypeError("Unsupported OAuth provider");
	return value;
}

function assertCredentialId(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("invalid OAuth credential id");
	return value as number;
}
