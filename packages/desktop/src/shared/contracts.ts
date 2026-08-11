export type SessionKind = "work" | "code";
export type ProcessState = "stopped" | "starting" | "ready" | "running" | "stopping" | "error";
export type ThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type QueueMode = "all" | "one-at-a-time";
export type InterruptMode = "immediate" | "wait";
export type SlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

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
	contextWindow?: number;
}

export interface SessionRuntimeConfig {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	fastMode?: boolean;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	interruptMode?: InterruptMode;
	autoCompactionEnabled?: boolean;
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
	provider: "openai-codex";
	name: string;
	signedIn: boolean;
	email?: string;
	accountId?: string;
	orgName?: string;
}

export type AuthEvent =
	| { type: "progress"; provider: "openai-codex"; message: string }
	| { type: "auth-url"; provider: "openai-codex"; message: string; url?: string }
	| { type: "prompt"; provider: "openai-codex"; message: string; placeholder?: string; sensitive: true }
	| { type: "complete"; provider: "openai-codex"; message: string }
	| { type: "error"; provider: "openai-codex"; message: string };

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
	loginProvider(provider: "openai-codex"): Promise<AuthAccountView[]>;
	logoutProvider(provider: "openai-codex"): Promise<AuthAccountView[]>;
	respondAuthPrompt(value: string): Promise<void>;
	bootstrap(): Promise<BootstrapSnapshot>;
	chooseAndCreate(kind: SessionKind): Promise<SessionSnapshot | null>;
	openSession(id: string): Promise<SessionSnapshot>;
	resume(id: string): Promise<SessionSnapshot>;
	loadTimelinePage(id: string, before: number, limit: number): Promise<TimelinePage>;
	loadTimelineItem(id: string, itemId: string): Promise<TimelineItem>;
	getAvailableCommands(id: string): Promise<SlashCommand[]>;
	getAvailableModels(id: string): Promise<ModelOption[]>;
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
	extensionResponse(id: string, response: unknown): Promise<void>;
	getSubagentMessages(id: string, subagentId: string, fromByte: number): Promise<unknown>;
	openWorkspaceFile(id: string, target: string): Promise<void>;
	openExternal(url: string): Promise<void>;
	minimizeWindow(): Promise<void>;
	toggleMaximizeWindow(): Promise<boolean>;
	closeWindow(): Promise<void>;
	onEvent(listener: (event: BranchlightEvent) => void): () => void;
	onAuthEvent(listener: (event: AuthEvent) => void): () => void;
}

declare global {
	interface Window {
		branchlight: BranchlightApi;
	}
}
