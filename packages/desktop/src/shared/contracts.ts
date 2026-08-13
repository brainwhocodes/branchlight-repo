export type SessionKind = "work" | "code";
export type ProcessState = "stopped" | "starting" | "ready" | "running" | "stopping" | "error";
export type ThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type QueueMode = "all" | "one-at-a-time";
export type InterruptMode = "immediate" | "wait";
export type SlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
export type ModelInputModality = "text" | "image";

export interface SlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: SlashCommandSource;
}

export interface ModelOption {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	input: ModelInputModality[];
	contextWindow?: number;
}

export interface OpenRouterProviderOption {
	id: string;
	name: string;
	enabled: boolean;
}

export interface OpenRouterModelRouting {
	modelId: string;
	providers: OpenRouterProviderOption[];
}

export type AgentSettingValue = boolean | string | number;
export type AgentSettingTab = "appearance" | "model" | "interaction" | "context" | "tools" | "tasks";

export interface AgentSettingOption {
	value: AgentSettingValue;
	label: string;
	description?: string;
}

export interface AgentSettingView {
	path: string;
	tab: AgentSettingTab;
	group?: string;
	label: string;
	description: string;
	control: "toggle" | "select";
	value: AgentSettingValue;
	options?: AgentSettingOption[];
	apply: "immediate" | "next-session";
}

export interface SessionRuntimeConfig {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	fastMode?: boolean;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	interruptMode?: InterruptMode;
	autoCompactionEnabled?: boolean;
	autoRetryEnabled?: boolean;
}

export interface SessionRecordV1 {
	id: string;
	kind: SessionKind;
	cwd: string;
	ompSessionId: string;
	sessionFile: string;
	title: string | null;
	createdAt: string;
	lastOpenedAt: string;
}

export interface SessionRegistryV1 {
	version: 1;
	sessions: SessionRecordV1[];
	activeByKind: Record<SessionKind, string | null>;
}
export interface TimelineImage {
	data: string;
	mimeType: string;
}

export type FileChangeOperation = "write" | "edit";

export interface TimelineFileChange {
	path: string;
	operation: FileChangeOperation;
}

export type FileDiffStatus = "modified" | "added" | "deleted" | "renamed" | "clean" | "binary" | "unavailable";

export interface FileDiffView {
	path: string;
	diff: string;
	status: FileDiffStatus;
	additions: number;
	deletions: number;
	truncated: boolean;
	message?: string;
}

export interface TimelineItem {
	id: string;
	kind: "user" | "assistant" | "thinking" | "tool" | "notice" | "todo" | "marker" | "raw";
	text: string;
	textLoaded?: boolean;
	detail?: string;
	toolName?: string;
	toolCallId?: string;
	status?: "running" | "complete" | "error";
	args?: unknown;
	result?: unknown;
	images?: TimelineImage[];
	files?: TimelineFileChange[];
	isError?: boolean;
	timestamp?: string;
}

export interface TimelinePage {
	items: TimelineItem[];
	start: number;
	total: number;
}

export interface SubagentView {
	id: string;
	agent: string;
	status: string;
	task?: string;
	assignment?: string;
	parentToolCallId?: string;
	progress?: {
		currentTool?: string;
		lastIntent?: string;
		tokens?: number;
		contextTokens?: number;
		contextWindow?: number;
		cost?: number;
		durationMs?: number;
		recentOutput?: string[];
		resolvedModel?: string;
		requests?: number;
	};
}

export interface SessionSnapshot extends SessionRuntimeConfig {
	record: SessionRecordV1;
	state: ProcessState;
	timeline: TimelineItem[];
	timelineStart?: number;
	timelineTotal?: number;
	subagents: SubagentView[];
	commands?: SlashCommand[];
	contextTokens?: number;
	contextWindow?: number;
	tokensPerSecond?: number | null;
	queuedMessageCount?: number;
	todoPhases?: Array<{ title?: string; items: Array<{ text: string; completed: boolean }> }>;
	warning?: string;
}

export interface AuthAccountView {
	provider: string;
	name: string;
	available: boolean;
	signedIn: boolean;
	email?: string;
	accountId?: string;
	orgName?: string;
}

export type AuthEvent =
	| { type: "progress"; provider: string; message: string }
	| { type: "auth-url"; provider: string; message: string; url?: string }
	| { type: "prompt"; provider: string; message: string; placeholder?: string; sensitive: true }
	| { type: "complete"; provider: string; message: string }
	| { type: "error"; provider: string; message: string };

export type WorkspacePaneKind = "browser" | "terminal";
export type BrowserNavigationAction = "back" | "forward" | "reload" | "stop";

export interface BrowserBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface BrowserViewState {
	id: string;
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	loading: boolean;
	error?: string;
}

export interface TerminalViewState {
	id: string;
	cwd: string;
}

export type WorkspaceEvent =
	| { type: "browser-state"; paneId: string; state: BrowserViewState }
	| { type: "browser-focus"; paneId: string }
	| { type: "browser-new-window"; paneId: string; url: string }
	| { type: "terminal-data"; paneId: string; data: string }
	| { type: "terminal-exit"; paneId: string; exitCode: number }
	| { type: "terminal-error"; paneId: string; message: string };

export interface BootstrapSnapshot {
	registry: SessionRegistryV1;
	warning?: string;
}

export interface BranchlightEvent {
	sessionId: string;
	type: "session" | "timeline" | "subagents" | "extension" | "commands" | "config" | "warning";
	state?: ProcessState;
	record?: SessionRecordV1;
	item?: TimelineItem;
	subagents?: SubagentView[];
	commands?: SlashCommand[];
	config?: SessionRuntimeConfig;
	extension?: ExtensionView;
	message?: string;
}

export interface ExtensionView {
	id: string;
	method:
		| "select"
		| "confirm"
		| "input"
		| "editor"
		| "cancel"
		| "notify"
		| "setStatus"
		| "setWidget"
		| "setTitle"
		| "set_editor_text"
		| "open_url";
	targetId?: string;
	title?: string;
	message?: string;
	options?: string[];
	sensitive?: boolean;
	placeholder?: string;
	prefill?: string;
	text?: string;
	url?: string;
	instructions?: string;
	notifyType?: "info" | "warning" | "error";
	statusKey?: string;
	statusText?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: "aboveEditor" | "belowEditor";
}

export interface BranchlightApi {
	getAuthStatus(): Promise<AuthAccountView[]>;
	loginProvider(provider: string): Promise<AuthAccountView[]>;
	logoutProvider(provider: string): Promise<AuthAccountView[]>;
	respondAuthPrompt(value: string): Promise<void>;
	getAgentSettings(id?: string): Promise<AgentSettingView[]>;
	setAgentSetting(id: string | undefined, path: string, value: AgentSettingValue): Promise<AgentSettingView>;
	bootstrap(): Promise<BootstrapSnapshot>;
	chooseAndCreate(kind: SessionKind): Promise<SessionSnapshot | null>;
	openSession(id: string): Promise<SessionSnapshot>;
	resume(id: string): Promise<SessionSnapshot>;
	loadTimelinePage(id: string, before: number, limit: number): Promise<TimelinePage>;
	loadTimelineItem(id: string, itemId: string): Promise<TimelineItem>;
	getAvailableCommands(id: string): Promise<SlashCommand[]>;
	getAvailableModels(id: string): Promise<ModelOption[]>;
	getOpenRouterModelRouting(id: string, modelId: string): Promise<OpenRouterModelRouting>;
	setOpenRouterProviderEnabled(
		id: string,
		modelId: string,
		providerId: string,
		enabled: boolean,
	): Promise<OpenRouterModelRouting>;
	stop(id: string): Promise<SessionSnapshot>;
	rename(id: string, title: string): Promise<SessionSnapshot>;
	prompt(id: string, text: string): Promise<void>;
	steer(id: string, text: string): Promise<void>;
	queueFollowUp(id: string, text: string): Promise<void>;
	abort(id: string): Promise<void>;
	setModel(id: string, provider: string, modelId: string): Promise<void>;
	setThinking(id: string, level: ThinkingLevel): Promise<void>;
	setFastMode(id: string, enabled: boolean): Promise<void>;
	setQueueMode(id: string, kind: "steering" | "follow-up", mode: QueueMode): Promise<void>;
	setInterruptMode(id: string, mode: InterruptMode): Promise<void>;
	setAutoCompaction(id: string, enabled: boolean): Promise<void>;
	setAutoRetry(id: string, enabled: boolean): Promise<void>;
	extensionResponse(id: string, response: unknown): Promise<void>;
	getSubagentMessages(id: string, subagentId: string, fromByte: number): Promise<unknown>;
	loadFileDiff(id: string, target: string): Promise<FileDiffView>;
	openWorkspaceFile(id: string, target: string): Promise<void>;
	openExternal(url: string): Promise<void>;
	createBrowser(id: string, url: string): Promise<BrowserViewState>;
	nameBrowser(id: string, name: string): Promise<void>;
	navigateBrowser(id: string, url: string): Promise<BrowserViewState>;
	controlBrowser(id: string, action: BrowserNavigationAction): Promise<void>;
	setBrowserBounds(id: string, bounds: BrowserBounds): Promise<void>;
	setVisibleBrowsers(ids: string[]): Promise<void>;
	closeBrowser(id: string): Promise<void>;
	createTerminal(id: string, cols: number, rows: number): Promise<TerminalViewState>;
	writeTerminal(id: string, data: string): Promise<void>;
	resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
	closeTerminal(id: string): Promise<void>;
	minimizeWindow(): Promise<void>;
	toggleMaximizeWindow(): Promise<boolean>;
	closeWindow(): Promise<void>;
	onEvent(listener: (event: BranchlightEvent) => void): () => void;
	onAuthEvent(listener: (event: AuthEvent) => void): () => void;
	onWorkspaceEvent(listener: (event: WorkspaceEvent) => void): () => void;
}

declare global {
	interface Window {
		branchlight: BranchlightApi;
	}
}
