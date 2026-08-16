/** Dependency-free Workspace V1 protocol contracts and acceptance-boundary parsers. */

export const WORKSPACE_WIRE_VERSION = 1 as const;
export const WORKSPACE_MAX_NAME_BYTES = 256;
export const WORKSPACE_MAX_ID_BYTES = 128;
export const WORKSPACE_MAX_PAYLOAD_BYTES = 1_048_576;
export const WORKSPACE_MAX_COLLECTION_ITEMS = 10_000;
export const WORKSPACE_MAX_EVENT_BATCH = 1_000;
export const WORKSPACE_MAX_PANES = 4;

export type WorkspaceIdV1 = string;
export type WorkspaceEntityIdV1 = string;
export type WorkspaceLocationIdV1 = string;
export type WorkspaceActorIdV1 = string;
export type WorkspaceCapabilityIdV1 = string;
export type WorkspaceSessionIdV1 = string;
export type WorkspaceEventSequenceV1 = number;

export type WorkspaceLocationKindV1 = "local" | "ssh";
export type WorkspaceLifecycleStatusV1 = "active" | "removing" | "removal_blocked";

export interface WorkspaceGitMetadataV1 {
	repository?: string;
	branch?: string;
	commit?: string;
	dirty: boolean;
	ahead?: number;
	behind?: number;
}

export interface WorkspaceLocationLifecycleV1 {
	status: WorkspaceLifecycleStatusV1;
	generation: number;
	updatedAt: number;
	reasonCode?: string;
}

export interface WorkspaceLocalLocationV1 {
	kind: "local";
	path: string;
}

export interface WorkspaceSshLocationV1 {
	kind: "ssh";
	host: string;
	user?: string;
	port?: number;
	path: string;
	authRef?: string;
}

export type WorkspaceLocationAddressV1 = WorkspaceLocalLocationV1 | WorkspaceSshLocationV1;
export interface WorkspaceLocationV1 {
	id: WorkspaceLocationIdV1;
	name: string;
	address: WorkspaceLocationAddressV1;
	lifecycle: WorkspaceLocationLifecycleV1;
	git?: WorkspaceGitMetadataV1;
}
export interface WorkspaceV1 {
	id: WorkspaceIdV1;
	name: string;
	locationId: WorkspaceLocationIdV1;
	generation: number;
	git?: WorkspaceGitMetadataV1;
}

export interface WorkspaceTabV1 {
	id: WorkspaceEntityIdV1;
	workspaceId: WorkspaceIdV1;
	locationId: WorkspaceLocationIdV1;
	generation: number;
	name: string;
	paneKind: "terminal" | "browser" | "agent" | "preview";
	layout: "columns" | "rows" | "grid";
	ratio: number;
	paneIds: WorkspaceEntityIdV1[];
	activePaneId: WorkspaceEntityIdV1;
}

export interface WorkspacePaneV1 {
	id: WorkspaceEntityIdV1;
	tabId: WorkspaceEntityIdV1;
	generation: number;
	kind: "terminal" | "browser" | "agent" | "preview";
	entityId: WorkspaceEntityIdV1;
	title?: string;
}

export interface WorkspaceTerminalV1 {
	id: WorkspaceEntityIdV1;
	locationId: WorkspaceLocationIdV1;
	profileId?: WorkspaceEntityIdV1;
	paneId?: WorkspaceEntityIdV1;
	generation: number;
	label: string;
	cwd?: string;
	columns?: number;
	rows?: number;
	status: "starting" | "running" | "exited" | "failed" | "closed";
	error?: string;
}
export interface WorkspaceBrowserV1 {
	id: WorkspaceEntityIdV1;
	locationId: WorkspaceLocationIdV1;
	paneId?: WorkspaceEntityIdV1;
	generation: number;
	url: string;
	title?: string;
	status: "opening" | "open" | "closed" | "failed";
}
export interface WorkspacePreviewV1 {
	id: WorkspaceEntityIdV1;
	locationId: WorkspaceLocationIdV1;
	generation: number;
	url: string;
	status: "opening" | "open" | "closed" | "failed";
}

export interface WorkspaceAgentProfileV1 {
	id: WorkspaceEntityIdV1;
	name: string;
	config: Record<string, unknown>;
	capabilityIds: WorkspaceCapabilityIdV1[];
	/** Executable identity is persisted as configuration, never a resolved path. */
	exec?: string;
	args?: string[];
	cwd?: string;
	protocol?: "omp" | "acp" | "terminal" | "auto";
	capabilities?: AgentCapabilitiesV1;
}

/** Compatibility type name for callers that used the generic profile term. */
export type WorkspaceProfileV1 = WorkspaceAgentProfileV1;

export interface WorkspaceCapabilityV1 {
	id: WorkspaceCapabilityIdV1;
	name: string;
	version: string;
	scope: "workspace" | "location" | "session" | "terminal" | "browser" | "agent";
}

/** Independently negotiated adapter capabilities. */
export interface AgentCapabilitiesV1 {
	prompt: {
		text: boolean;
		image: boolean;
		resource: boolean;
	};
	session: {
		create: boolean;
		load: boolean;
		resume: boolean;
		close: boolean;
	};
	cancel: boolean;
	modes: boolean;
	config: boolean;
	filesystem: boolean;
	terminal: boolean;
	permissions: boolean;
	mcp: boolean;
}

export type AgentProfileV1 = WorkspaceAgentProfileV1;

export interface WorkspaceAgentV1 {
	id: WorkspaceEntityIdV1;
	profileId: WorkspaceEntityIdV1;
	sessionId?: WorkspaceSessionIdV1;
	/** Durable link to the terminal hosting this agent, when attached. */
	terminalId?: WorkspaceEntityIdV1;
	/** Durable link to an existing terminal pane, when one is supplied at attach time. */
	paneId?: WorkspaceEntityIdV1;
	status: "starting" | "running" | "stopped" | "failed";
}

export interface WorkspaceSessionV1 {
	id: WorkspaceSessionIdV1;
	locationId: WorkspaceLocationIdV1;
	actorId: WorkspaceActorIdV1;
	kind: "user" | "agent" | "service";
	status: "opening" | "active" | "closing" | "closed";
	capabilityIds: WorkspaceCapabilityIdV1[];
	startedAt: number;
	lastSeenAt: number;
}

export interface WorkspaceDeliveryReceiptV1 {
	id: WorkspaceEntityIdV1;
	sessionId: WorkspaceSessionIdV1;
	eventId: WorkspaceEntityIdV1;
	status: "accepted" | "delivered" | "acknowledged" | "failed";
	updatedAt: number;
	reasonCode?: string;
}

export interface WorkspaceSessionEventV1 {
	id: WorkspaceEntityIdV1;
	sessionId: WorkspaceSessionIdV1;
	kind: "message" | "input" | "output" | "tool" | "status";
	payload: Record<string, unknown>;
	createdAt: number;
}
export type AgentSessionV1 = WorkspaceSessionV1;
export type AgentEventV1 = WorkspaceSessionEventV1;
export type AgentDeliveryReceiptV1 = WorkspaceDeliveryReceiptV1;

export interface WorkspaceServiceV1 {
	id: WorkspaceEntityIdV1;
	locationId: WorkspaceLocationIdV1;
	name: string;
	command: string;
	status: "declared" | "starting" | "running" | "stopping" | "stopped" | "failed";
	port?: number;
	url?: string;
}

export interface WorkspaceWorktreeV1 {
	id: WorkspaceEntityIdV1;
	locationId: WorkspaceLocationIdV1;
	path: string;
	branch?: string;
	commit?: string;
	status: "creating" | "ready" | "dirty" | "removing" | "removed" | "failed";
}

export interface WorkspaceElementEditV1 {
	id: WorkspaceEntityIdV1;
	sessionId: WorkspaceSessionIdV1;
	target: string;
	operation: "insert" | "replace" | "delete" | "move";
	value?: string;
	from?: number;
	to?: number;
}

export interface WorkspaceNotificationV1 {
	id: WorkspaceEntityIdV1;
	severity: "info" | "success" | "warning" | "error";
	title: string;
	message: string;
	createdAt: number;
	dismissedAt?: number;
}

export interface WorkspacePendingCleanupV1 {
	id: WorkspaceEntityIdV1;
	kind: "location" | "terminal" | "browser" | "service" | "worktree" | "session";
	entityId: WorkspaceEntityIdV1;
	attempts: number;
	nextAttemptAt: number;
	reasonCode?: string;
}

export interface WorkspaceDocumentV1 {
	version: 1;
	revision: number;
	activeWorkspaceId: WorkspaceIdV1 | null;
	workspaces: WorkspaceV1[];
	locations: WorkspaceLocationV1[];
	tabs: WorkspaceTabV1[];
	panes: WorkspacePaneV1[];
	terminals: WorkspaceTerminalV1[];
	browsers: WorkspaceBrowserV1[];
	previews: WorkspacePreviewV1[];
	agentProfiles: WorkspaceAgentProfileV1[];
	agents: WorkspaceAgentV1[];
	capabilities: WorkspaceCapabilityV1[];
	sessions: WorkspaceSessionV1[];
	sessionEvents: WorkspaceSessionEventV1[];
	deliveryReceipts: WorkspaceDeliveryReceiptV1[];
	services: WorkspaceServiceV1[];
	worktrees: WorkspaceWorktreeV1[];
	elementEdits: WorkspaceElementEditV1[];
	notifications: WorkspaceNotificationV1[];
	pendingCleanup: WorkspacePendingCleanupV1[];
	createdAt: number;
	updatedAt: number;
}

export type WorkspaceRuntimeHealthV1 = "unknown" | "starting" | "ready" | "healthy" | "unhealthy" | "lost";

export interface WorkspaceRuntimeProjectionV1 {
	locations?: Array<{
		locationId: WorkspaceLocationIdV1;
		generation: number;
		connection: "disconnected" | "connecting" | "connected" | "stale";
		health: WorkspaceRuntimeHealthV1;
		reasonCode?: string;
	}>;
	terminals?: Array<{
		terminalId: WorkspaceEntityIdV1;
		state: "starting" | "running" | "exited" | "lost";
		health: WorkspaceRuntimeHealthV1;
		earliestOutputSequence?: number;
		nextOutputSequence?: number;
	}>;
	browsers?: Array<{
		browserId: WorkspaceEntityIdV1;
		state: "opening" | "open" | "closed" | "lost";
		health: WorkspaceRuntimeHealthV1;
		documentEpoch: number;
		visible: boolean;
	}>;
	services?: Array<{
		serviceId: WorkspaceEntityIdV1;
		health: "starting" | "healthy" | "unhealthy" | "stopped" | "unknown";
	}>;
	agents?: Array<{
		agentId: WorkspaceEntityIdV1;
		activity: "idle" | "working" | "waiting_input" | "complete" | "error" | "unknown";
		health: WorkspaceRuntimeHealthV1;
	}>;
	focus?: {
		workspaceId: WorkspaceIdV1;
		tabId: WorkspaceEntityIdV1;
		paneId: WorkspaceEntityIdV1;
	};
	capabilityFreshness?: Array<{
		capabilityId: WorkspaceCapabilityIdV1;
		state: "fresh" | "stale" | "revoked" | "unknown";
		checkedAt: number;
		expiresAt?: number;
	}>;
}

/** Snapshot projects durable state with non-durable runtime health/focus overlays. */
export interface WorkspaceSnapshotV1 {
	version: 1;
	revision: number;
	activeWorkspaceId: WorkspaceIdV1 | null;
	workspaces: WorkspaceV1[];
	locations: WorkspaceLocationV1[];
	tabs: WorkspaceTabV1[];
	panes: WorkspacePaneV1[];
	terminals: WorkspaceTerminalV1[];
	browsers: WorkspaceBrowserV1[];
	previews: WorkspacePreviewV1[];
	agentProfiles: WorkspaceAgentProfileV1[];
	agents: WorkspaceAgentV1[];
	capabilities: WorkspaceCapabilityV1[];
	sessions: WorkspaceSessionV1[];
	services: WorkspaceServiceV1[];
	worktrees: WorkspaceWorktreeV1[];
	notifications: WorkspaceNotificationV1[];
	pendingCleanup: WorkspacePendingCleanupV1[];
	runtime?: WorkspaceRuntimeProjectionV1;
}

export interface WorkspacePrincipalV1 {
	kind: "user" | "agent" | "service";
	id: WorkspaceActorIdV1;
	name?: string;
}
export interface WorkspaceCapabilityIdentityV1 {
	capabilityId: WorkspaceCapabilityIdV1;
	principal: WorkspacePrincipalV1;
	scope: string;
}

export interface WorkspaceTransportAuthV1 {
	token: string;
}

export interface WorkspaceCommandMetaV1 {
	version: 1;
	commandId: WorkspaceEntityIdV1;
	workspaceId: WorkspaceIdV1;
	expectedRevision: number;
	issuedAt: number;
}

export type WorkspaceCommandTypeV1 =
	| "workspace.create"
	| "workspace.start"
	| "workspace.stop"
	| "workspace.delete"
	| "profile.create"
	| "profile.update"
	| "profile.delete"
	| "tab.update"
	| "tab.close"
	| "terminal.open"
	| "terminal.status"
	| "terminal.input"
	| "terminal.resize"
	| "terminal.close"
	| "agent.start"
	| "agent.attach"
	| "agent.message"
	| "agent.stop"
	| "agent.detach"
	| "browser.open"
	| "browser.navigate"
	| "browser.close"
	| "selection.set"
	| "preview.open"
	| "preview.close"
	| "service.declare"
	| "service.start"
	| "service.stop"
	| "worktree.create"
	| "worktree.remove"
	| "remote.connect"
	| "remote.disconnect"
	| "attention.notify"
	| "attention.dismiss"
	| "cleanup.retry"
	| "cleanup.cancel";
export interface WorkspaceCommandBodyV1 {
	type: WorkspaceCommandTypeV1;
	payload: Record<string, unknown>;
}
export type WorkspaceCommandV1 = WorkspaceCommandMetaV1 & WorkspaceCommandBodyV1;

export interface WorkspaceEventMetaV1 {
	version: 1;
	eventId: WorkspaceEntityIdV1;
	workspaceId: WorkspaceIdV1;
	sequence: WorkspaceEventSequenceV1;
	revision: number;
	occurredAt: number;
}
export type WorkspaceEventTypeV1 =
	| "workspace.created"
	| "workspace.updated"
	| "workspace.deleted"
	| "location.changed"
	| "tab.changed"
	| "pane.changed"
	| "terminal.changed"
	| "browser.changed"
	| "profile.changed"
	| "capability.changed"
	| "session.changed"
	| "session.event"
	| "delivery.receipt"
	| "service.changed"
	| "worktree.changed"
	| "element.edit"
	| "notification.changed"
	| "cleanup.changed";
export interface WorkspaceEventBodyV1 {
	type: WorkspaceEventTypeV1;
	payload: Record<string, unknown>;
}
export interface WorkspaceFutureEventV1 extends WorkspaceEventMetaV1 {
	type: "future";
	payload: unknown;
}
export type WorkspaceEventV1 = (WorkspaceEventMetaV1 & WorkspaceEventBodyV1) | WorkspaceFutureEventV1;

export interface WorkspaceProviderRequestV1 {
	version: 1;

	requestId: WorkspaceEntityIdV1;
	workspaceId: WorkspaceIdV1;
	sessionId: WorkspaceSessionIdV1;
	provider: string;
	method: "start" | "stop" | "send" | "cancel" | "status";
	payload: Record<string, unknown>;
	issuedAt: number;
}
export interface WorkspaceProviderResponseV1 {
	version: 1;
	requestId: WorkspaceEntityIdV1;
	workspaceId: WorkspaceIdV1;
	sessionId: WorkspaceSessionIdV1;
	provider: string;
	status: "accepted" | "completed" | "failed" | "cancelled";
	payload: Record<string, unknown>;
	respondedAt: number;
	reasonCode?: string;
}

export class WorkspaceWireValidationError extends Error {
	readonly path: string;
	constructor(message: string, path = "$") {
		super(`${path}: ${message}`);
		this.name = "WorkspaceWireValidationError";
		this.path = path;
	}
}

const FORBIDDEN_DURABLE_KEYS = new Set([
	"processId",
	"pid",
	"cdpTargetId",
	"targetId",
	"backendNodeId",
	"dragId",
	"menuId",
	"transientError",
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NAME_PATTERN = /^(?!\s*$)[\s\S]{1,256}$/;

function fail(message: string, path: string): never {
	throw new WorkspaceWireValidationError(message, path);
}
function required(value: Record<string, unknown>, key: string, path: string): unknown {
	if (!(key in value)) fail(`missing ${key}`, path);
	return value[key];
}
function string(value: unknown, path: string, max = WORKSPACE_MAX_PAYLOAD_BYTES): string {
	if (typeof value !== "string") fail("expected string", path);
	if (new TextEncoder().encode(value).byteLength > max) fail("string exceeds size cap", path);
	return value;
}
function id(value: unknown, path: string): string {
	const result = string(value, path, WORKSPACE_MAX_ID_BYTES);
	if (!ID_PATTERN.test(result)) fail("malformed id", path);
	return result;
}
function name(value: unknown, path: string): string {
	const result = string(value, path, WORKSPACE_MAX_NAME_BYTES);
	if (!NAME_PATTERN.test(result)) fail("invalid name", path);
	return result;
}
function integer(value: unknown, path: string, min = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
		fail("expected non-negative integer", path);
	return value;
}
function finite(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail("expected finite number", path);
	return value;
}
function bool(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail("expected boolean", path);
	return value;
}
function array(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) fail("expected array", path);
	if (value.length > WORKSPACE_MAX_COLLECTION_ITEMS) fail("collection exceeds cap", path);
	return value;
}
function record(value: unknown, path: string): Record<string, unknown> {
	return object(value, path);
}
function literal<T extends string | number>(value: unknown, expected: T, path: string): T {
	if (value !== expected) fail(`expected ${String(expected)}`, path);
	return expected;
}
function optionalString(value: Record<string, unknown>, key: string, path: string): string | undefined {
	return key in value ? string(value[key], `${path}.${key}`) : undefined;
}
function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) fail("invalid enum value", path);
	return value as T;
}
function uniqueIds(items: readonly { id: string }[], path: string): void {
	const seen = new Set<string>();
	for (const item of items) {
		if (seen.has(item.id)) fail("duplicate id", `${path}.${item.id}`);
		seen.add(item.id);
	}
}
function jsonSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function parseGit(value: unknown, path: string): WorkspaceGitMetadataV1 {
	const v = object(value, path);
	return {
		repository: optionalString(v, "repository", path),
		branch: optionalString(v, "branch", path),
		commit: optionalString(v, "commit", path),
		dirty: bool(required(v, "dirty", path), `${path}.dirty`),
		ahead: "ahead" in v ? integer(v.ahead, `${path}.ahead`) : undefined,
		behind: "behind" in v ? integer(v.behind, `${path}.behind`) : undefined,
	};
}
function parseLocation(value: unknown, path: string): WorkspaceLocationV1 {
	const v = object(value, path);
	const a = object(required(v, "address", path), `${path}.address`);
	const kind = enumValue(required(a, "kind", `${path}.address`), ["local", "ssh"], `${path}.address.kind`);
	const address: WorkspaceLocationAddressV1 =
		kind === "local"
			? { kind, path: string(required(a, "path", `${path}.address`), `${path}.address.path`) }
			: {
					kind,
					host: string(required(a, "host", `${path}.address`), `${path}.address.host`),
					user: optionalString(a, "user", `${path}.address`),
					port: "port" in a ? integer(a.port, `${path}.address.port`, 1) : undefined,
					path: string(required(a, "path", `${path}.address`), `${path}.address.path`),
					authRef: optionalString(a, "authRef", `${path}.address`),
				};
	const l = object(required(v, "lifecycle", path), `${path}.lifecycle`);
	return {
		id: id(required(v, "id", path), `${path}.id`),
		name: name(required(v, "name", path), `${path}.name`),
		address,
		lifecycle: {
			status: enumValue(
				required(l, "status", `${path}.lifecycle`),
				["active", "removing", "removal_blocked"],
				`${path}.lifecycle.status`,
			),
			generation: integer(required(l, "generation", `${path}.lifecycle.generation`), `${path}.lifecycle.generation`),
			updatedAt: finite(required(l, "updatedAt", `${path}.lifecycle.updatedAt`), `${path}.lifecycle.updatedAt`),
			reasonCode: optionalString(l, "reasonCode", `${path}.lifecycle`),
		},
		git: "git" in v ? parseGit(v.git, `${path}.git`) : undefined,
	};
}
function parseCommonEntity(value: unknown, path: string): Record<string, unknown> {
	const v = object(value, path);
	id(required(v, "id", path), `${path}.id`);
	return v;
}
function parsePayload(value: unknown, path: string): Record<string, unknown> {
	const v = record(value, path);
	if (jsonSize(v) > WORKSPACE_MAX_PAYLOAD_BYTES) fail("payload exceeds size cap", path);
	return v;
}
function parseStringArray(value: unknown, path: string): string[] {
	return parseArray(value, path, (item, itemPath) => string(item, itemPath, WORKSPACE_MAX_NAME_BYTES));
}
function uniqueAcrossCollections(collections: readonly (readonly { id: string }[])[], path: string): void {
	const seen = new Set<string>();
	for (const collection of collections) {
		for (const item of collection) {
			if (seen.has(item.id)) fail("duplicate id", path);
			seen.add(item.id);
		}
	}
}

function parseAgentCapabilities(value: unknown, path: string): AgentCapabilitiesV1 {
	const v = object(value, path);
	const prompt = object(required(v, "prompt", path), `${path}.prompt`);
	const session = object(required(v, "session", path), `${path}.session`);
	return {
		prompt: {
			text: bool(required(prompt, "text", `${path}.prompt`), `${path}.prompt.text`),
			image: bool(required(prompt, "image", `${path}.prompt`), `${path}.prompt.image`),
			resource: bool(required(prompt, "resource", `${path}.prompt`), `${path}.prompt.resource`),
		},
		session: {
			create: bool(required(session, "create", `${path}.session`), `${path}.session.create`),
			load: bool(required(session, "load", `${path}.session`), `${path}.session.load`),
			resume: bool(required(session, "resume", `${path}.session`), `${path}.session.resume`),
			close: bool(required(session, "close", `${path}.session`), `${path}.session.close`),
		},
		cancel: bool(required(v, "cancel", path), `${path}.cancel`),
		modes: bool(required(v, "modes", path), `${path}.modes`),
		config: bool(required(v, "config", path), `${path}.config`),
		filesystem: bool(required(v, "filesystem", path), `${path}.filesystem`),
		terminal: bool(required(v, "terminal", path), `${path}.terminal`),
		permissions: bool(required(v, "permissions", path), `${path}.permissions`),
		mcp: bool(required(v, "mcp", path), `${path}.mcp`),
	};
}

function parseArray<T>(value: unknown, path: string, parser: (value: unknown, path: string) => T): T[] {
	return array(value, path).map((item, index) => parser(item, `${path}[${index}]`));
}

export function parseWorkspaceDocumentV1(value: unknown): WorkspaceDocumentV1 {
	const v = object(value, "$");
	literal(required(v, "version", "$"), 1, "$.version");
	const result: WorkspaceDocumentV1 = {
		version: 1,
		revision: integer(required(v, "revision", "$"), "$.revision"),
		activeWorkspaceId:
			v.activeWorkspaceId === null ? null : id(required(v, "activeWorkspaceId", "$"), "$.activeWorkspaceId"),
		workspaces: parseArray(required(v, "workspaces", "$"), "$.workspaces", parseWorkspace),
		locations: parseArray(required(v, "locations", "$"), "$.locations", parseLocation),
		tabs: parseArray(required(v, "tabs", "$"), "$.tabs", parseTab),
		panes: parseArray(required(v, "panes", "$"), "$.panes", parsePane),
		terminals: parseArray(required(v, "terminals", "$"), "$.terminals", parseTerminal),
		browsers: parseArray(required(v, "browsers", "$"), "$.browsers", parseBrowser),
		previews: parseArray(required(v, "previews", "$"), "$.previews", parsePreview),
		agentProfiles: parseArray(required(v, "agentProfiles", "$"), "$.agentProfiles", parseAgentProfile),
		agents: parseArray(required(v, "agents", "$"), "$.agents", parseAgent),
		capabilities: parseArray(required(v, "capabilities", "$"), "$.capabilities", parseCapability),
		sessions: parseArray(required(v, "sessions", "$"), "$.sessions", parseSession),
		sessionEvents: parseArray(required(v, "sessionEvents", "$"), "$.sessionEvents", parseSessionEvent),
		deliveryReceipts: parseArray(required(v, "deliveryReceipts", "$"), "$.deliveryReceipts", parseReceipt),
		services: parseArray(required(v, "services", "$"), "$.services", parseService),
		worktrees: parseArray(required(v, "worktrees", "$"), "$.worktrees", parseWorktree),
		elementEdits: parseArray(required(v, "elementEdits", "$"), "$.elementEdits", parseElementEdit),
		notifications: parseArray(required(v, "notifications", "$"), "$.notifications", parseNotification),
		pendingCleanup: parseArray(required(v, "pendingCleanup", "$"), "$.pendingCleanup", parseCleanup),
		createdAt: finite(required(v, "createdAt", "$"), "$.createdAt"),
		updatedAt: finite(required(v, "updatedAt", "$"), "$.updatedAt"),
	};
	uniqueIds(result.workspaces, "$.workspaces");
	uniqueIds(result.locations, "$.locations");
	uniqueIds(result.tabs, "$.tabs");
	uniqueIds(result.panes, "$.panes");
	uniqueIds(result.agentProfiles, "$.agentProfiles");
	uniqueIds(result.agents, "$.agents");
	uniqueAcrossCollections(
		[
			result.workspaces,
			result.locations,
			result.tabs,
			result.panes,
			result.terminals,
			result.browsers,
			result.previews,
			result.agentProfiles,
			result.agents,
			result.capabilities,
			result.sessions,
			result.sessionEvents,
			result.deliveryReceipts,
			result.services,
			result.worktrees,
			result.elementEdits,
			result.notifications,
			result.pendingCleanup,
		],
		"$.entities",
	);
	validateLinks(result);
	if (result.activeWorkspaceId !== null && !result.workspaces.some(item => item.id === result.activeWorkspaceId))
		fail("unknown active workspace", "$.activeWorkspaceId");
	return result;
}

function parseWorkspace(value: unknown, path: string): WorkspaceV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		name: name(required(v, "name", path), `${path}.name`),
		locationId: id(required(v, "locationId", path), `${path}.locationId`),
		generation: integer(required(v, "generation", path), `${path}.generation`),
		git: "git" in v ? parseGit(v.git, `${path}.git`) : undefined,
	};
}
function parseAgentProfile(value: unknown, path: string): WorkspaceAgentProfileV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		name: name(required(v, "name", path), `${path}.name`),
		config: parsePayload(required(v, "config", path), `${path}.config`),
		capabilityIds: parseArray(required(v, "capabilityIds", path), `${path}.capabilityIds`, id),
		exec: optionalString(v, "exec", path),
		args: "args" in v ? parseStringArray(v.args, `${path}.args`) : undefined,
		cwd: optionalString(v, "cwd", path),
		protocol:
			"protocol" in v
				? enumValue(v.protocol, ["omp", "acp", "terminal", "auto"] as const, `${path}.protocol`)
				: undefined,
		capabilities: "capabilities" in v ? parseAgentCapabilities(v.capabilities, `${path}.capabilities`) : undefined,
	};
}
function parseAgent(value: unknown, path: string): WorkspaceAgentV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		profileId: id(required(v, "profileId", path), `${path}.profileId`),
		sessionId: "sessionId" in v ? id(v.sessionId, `${path}.sessionId`) : undefined,
		terminalId: "terminalId" in v ? id(v.terminalId, `${path}.terminalId`) : undefined,
		paneId: "paneId" in v ? id(v.paneId, `${path}.paneId`) : undefined,
		status: enumValue(required(v, "status", path), ["starting", "running", "stopped", "failed"], `${path}.status`),
	};
}

function parseTab(value: unknown, path: string): WorkspaceTabV1 {
	const v = parseCommonEntity(value, path);
	const paneIds = parseArray(required(v, "paneIds", path), `${path}.paneIds`, id);
	if (paneIds.length === 0 || paneIds.length > WORKSPACE_MAX_PANES) fail("invalid pane count", `${path}.paneIds`);
	const paneKind = enumValue(
		required(v, "paneKind", path),
		["terminal", "browser", "agent", "preview"],
		`${path}.paneKind`,
	);
	const ratio = finite(required(v, "ratio", path), `${path}.ratio`);
	if (ratio < 20 || ratio > 80) fail("ratio must be between 20 and 80", `${path}.ratio`);
	return {
		id: id(v.id, `${path}.id`),
		workspaceId: id(required(v, "workspaceId", path), `${path}.workspaceId`),
		locationId: id(required(v, "locationId", path), `${path}.locationId`),
		generation: integer(required(v, "generation", path), `${path}.generation`),
		name: name(required(v, "name", path), `${path}.name`),
		paneKind,
		layout: enumValue(required(v, "layout", path), ["columns", "rows", "grid"], `${path}.layout`),
		ratio,
		paneIds,
		activePaneId: id(required(v, "activePaneId", path), `${path}.activePaneId`),
	};
}
function parsePane(value: unknown, path: string): WorkspacePaneV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		tabId: id(required(v, "tabId", path), `${path}.tabId`),
		generation: integer(required(v, "generation", path), `${path}.generation`),
		kind: enumValue(required(v, "kind", path), ["terminal", "browser", "agent", "preview"], `${path}.kind`),
		entityId: id(required(v, "entityId", path), `${path}.entityId`),
		title: optionalString(v, "title", path),
	};
}
function parseTerminal(value: unknown, path: string): WorkspaceTerminalV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		locationId: id(required(v, "locationId", path), `${path}.locationId`),
		profileId: "profileId" in v ? id(v.profileId, `${path}.profileId`) : undefined,
		paneId: "paneId" in v ? id(v.paneId, `${path}.paneId`) : undefined,
		generation: integer(required(v, "generation", path), `${path}.generation`),
		label: name(required(v, "label", path), `${path}.label`),
		cwd: optionalString(v, "cwd", path),
		columns: "columns" in v ? integer(v.columns, `${path}.columns`, 1) : undefined,
		rows: "rows" in v ? integer(v.rows, `${path}.rows`, 1) : undefined,
		status: enumValue(
			required(v, "status", path),
			["starting", "running", "exited", "failed", "closed"],
			`${path}.status`,
		),
		error: optionalString(v, "error", path),
	};
}
function parseBrowser(value: unknown, path: string): WorkspaceBrowserV1 {
	const v = parseCommonEntity(value, path);
	if ("bounds" in v) fail("browser bounds are transient and not durable", `${path}.bounds`);
	return {
		id: id(v.id, `${path}.id`),
		locationId: id(required(v, "locationId", path), `${path}.locationId`),
		paneId: "paneId" in v ? id(v.paneId, `${path}.paneId`) : undefined,
		generation: integer(required(v, "generation", path), `${path}.generation`),
		url: string(required(v, "url", path), `${path}.url`),
		title: optionalString(v, "title", path),
		status: enumValue(required(v, "status", path), ["opening", "open", "closed", "failed"], `${path}.status`),
	};
}
function parsePreview(value: unknown, path: string): WorkspacePreviewV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		locationId: id(required(v, "locationId", path), `${path}.locationId`),
		generation: integer(required(v, "generation", path), `${path}.generation`),
		url: string(required(v, "url", path), `${path}.url`),
		status: enumValue(required(v, "status", path), ["opening", "open", "closed", "failed"], `${path}.status`),
	};
}
function parseCapability(value: unknown, path: string): WorkspaceCapabilityV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		name: name(required(v, "name", path), `${path}.name`),
		version: string(required(v, "version", path), `${path}.version`),
		scope: enumValue(
			required(v, "scope", path),
			["workspace", "location", "session", "terminal", "browser", "agent"],
			`${path}.scope`,
		),
	};
}
function parseSession(value: unknown, path: string): WorkspaceSessionV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		locationId: id(required(v, "locationId", path), `${path}.locationId`),
		actorId: id(required(v, "actorId", path), `${path}.actorId`),
		kind: enumValue(required(v, "kind", path), ["user", "agent", "service"], `${path}.kind`),
		status: enumValue(required(v, "status", path), ["opening", "active", "closing", "closed"], `${path}.status`),
		capabilityIds: parseArray(required(v, "capabilityIds", path), `${path}.capabilityIds`, id),
		startedAt: finite(required(v, "startedAt", path), `${path}.startedAt`),
		lastSeenAt: finite(required(v, "lastSeenAt", path), `${path}.lastSeenAt`),
	};
}
function parseSessionEvent(value: unknown, path: string): WorkspaceSessionEventV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		sessionId: id(required(v, "sessionId", path), `${path}.sessionId`),
		kind: enumValue(required(v, "kind", path), ["message", "input", "output", "tool", "status"], `${path}.kind`),
		payload: parsePayload(required(v, "payload", path), `${path}.payload`),
		createdAt: finite(required(v, "createdAt", path), `${path}.createdAt`),
	};
}
function parseReceipt(value: unknown, path: string): WorkspaceDeliveryReceiptV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		sessionId: id(required(v, "sessionId", path), `${path}.sessionId`),
		eventId: id(required(v, "eventId", path), `${path}.eventId`),
		status: enumValue(
			required(v, "status", path),
			["accepted", "delivered", "acknowledged", "failed"],
			`${path}.status`,
		),
		updatedAt: finite(required(v, "updatedAt", path), `${path}.updatedAt`),
		reasonCode: optionalString(v, "reasonCode", path),
	};
}
function parseService(value: unknown, path: string): WorkspaceServiceV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		locationId: id(required(v, "locationId", path), `${path}.locationId`),
		name: name(required(v, "name", path), `${path}.name`),
		command: string(required(v, "command", path), `${path}.command`),
		status: enumValue(
			required(v, "status", path),
			["declared", "starting", "running", "stopping", "stopped", "failed"],
			`${path}.status`,
		),
		port: "port" in v ? integer(v.port, `${path}.port`, 1) : undefined,
		url: optionalString(v, "url", path),
	};
}
function parseWorktree(value: unknown, path: string): WorkspaceWorktreeV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		locationId: id(required(v, "locationId", path), `${path}.locationId`),
		path: string(required(v, "path", path), `${path}.path`),
		branch: optionalString(v, "branch", path),
		commit: optionalString(v, "commit", path),
		status: enumValue(
			required(v, "status", path),
			["creating", "ready", "dirty", "removing", "removed", "failed"],
			`${path}.status`,
		),
	};
}
function parseElementEdit(value: unknown, path: string): WorkspaceElementEditV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		sessionId: id(required(v, "sessionId", path), `${path}.sessionId`),
		target: string(required(v, "target", path), `${path}.target`, WORKSPACE_MAX_ID_BYTES),
		operation: enumValue(
			required(v, "operation", path),
			["insert", "replace", "delete", "move"],
			`${path}.operation`,
		),
		value: optionalString(v, "value", path),
		from: "from" in v ? integer(v.from, `${path}.from`) : undefined,
		to: "to" in v ? integer(v.to, `${path}.to`) : undefined,
	};
}
function parseNotification(value: unknown, path: string): WorkspaceNotificationV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		severity: enumValue(required(v, "severity", path), ["info", "success", "warning", "error"], `${path}.severity`),
		title: name(required(v, "title", path), `${path}.title`),
		message: string(required(v, "message", path), `${path}.message`),
		createdAt: finite(required(v, "createdAt", path), `${path}.createdAt`),
		dismissedAt: "dismissedAt" in v ? finite(v.dismissedAt, `${path}.dismissedAt`) : undefined,
	};
}
function parseCleanup(value: unknown, path: string): WorkspacePendingCleanupV1 {
	const v = parseCommonEntity(value, path);
	return {
		id: id(v.id, `${path}.id`),
		kind: enumValue(
			required(v, "kind", path),
			["location", "terminal", "browser", "service", "worktree", "session"],
			`${path}.kind`,
		),
		entityId: id(required(v, "entityId", path), `${path}.entityId`),
		attempts: integer(required(v, "attempts", path), `${path}.attempts`),
		nextAttemptAt: finite(required(v, "nextAttemptAt", path), `${path}.nextAttemptAt`),
		reasonCode: optionalString(v, "reasonCode", path),
	};
}
function validateLinks(document: WorkspaceDocumentV1): void {
	const locations = new Set(document.locations.map(item => item.id));
	const locationGeneration = new Map(document.locations.map(item => [item.id, item.lifecycle.generation]));
	const workspaces = new Set(document.workspaces.map(item => item.id));
	const tabs = new Set(document.tabs.map(item => item.id));
	const panes = new Set(document.panes.map(item => item.id));
	const profiles = new Set(document.agentProfiles.map(item => item.id));
	const sessions = new Set(document.sessions.map(item => item.id));
	const capabilities = new Set(document.capabilities.map(item => item.id));
	const terminalIds = new Set(document.terminals.map(item => item.id));
	const browserIds = new Set(document.browsers.map(item => item.id));
	const agentIds = new Set(document.agents.map(item => item.id));
	const previewIds = new Set(document.previews.map(item => item.id));
	if (new Set(document.workspaces.map(item => item.name)).size !== document.workspaces.length)
		fail("duplicate workspace name", "$.workspaces");
	if (new Set(document.locations.map(item => item.name)).size !== document.locations.length)
		fail("duplicate location name", "$.locations");
	for (const workspace of document.workspaces) {
		if (!locations.has(workspace.locationId)) fail("unknown location parent", "$.workspaces");
		if (locationGeneration.get(workspace.locationId) !== workspace.generation)
			fail("workspace generation mismatch", "$.workspaces");
	}
	for (const tab of document.tabs) {
		if (!workspaces.has(tab.workspaceId)) fail("unknown workspace parent", "$.tabs");
		const workspace = document.workspaces.find(w => w.id === tab.workspaceId);
		if (!workspace || workspace.locationId !== tab.locationId) fail("tab workspace/location mismatch", "$.tabs");
		if (!locations.has(tab.locationId)) fail("unknown location parent", "$.tabs");
		if (locationGeneration.get(tab.locationId) !== tab.generation) fail("tab generation mismatch", "$.tabs");
		if (
			new Set(
				document.tabs
					.filter(item => item.workspaceId === tab.workspaceId && item.locationId === tab.locationId)
					.map(item => item.name),
			).size !==
			document.tabs.filter(item => item.workspaceId === tab.workspaceId && item.locationId === tab.locationId).length
		)
			fail("duplicate tab name", "$.tabs");
		if (tab.paneIds.length > WORKSPACE_MAX_PANES) fail("too many panes in tab", "$.tabs");
		if (document.panes.filter(item => item.tabId === tab.id).length > WORKSPACE_MAX_PANES)
			fail("too many panes in tab", "$.panes");
		for (const paneId of tab.paneIds) if (!panes.has(paneId)) fail("unknown pane parent", "$.tabs");
		if (!tab.paneIds.includes(tab.activePaneId)) fail("active pane is not a child", "$.tabs");
		for (const pane of document.panes.filter(item => tab.paneIds.includes(item.id))) {
			if (pane.kind !== tab.paneKind) fail("tab pane kinds must be homogeneous", "$.tabs");
		}
	}
	for (const pane of document.panes) {
		if (!tabs.has(pane.tabId)) fail("unknown tab parent", "$.panes");
		const tab = document.tabs.find(item => item.id === pane.tabId);
		if (!tab || pane.generation !== tab.generation) fail("pane generation mismatch", "$.panes");
		const matches = [
			terminalIds.has(pane.entityId),
			browserIds.has(pane.entityId),
			agentIds.has(pane.entityId),
			previewIds.has(pane.entityId),
		].filter(Boolean).length;
		if (matches !== 1) fail("pane must resolve to exactly one entity", "$.panes");
		const kindMatches =
			pane.kind === "terminal"
				? terminalIds.has(pane.entityId)
				: pane.kind === "browser"
					? browserIds.has(pane.entityId)
					: pane.kind === "agent"
						? agentIds.has(pane.entityId)
						: previewIds.has(pane.entityId);
		if (!kindMatches) fail("pane entity kind mismatch", "$.panes");
	}
	for (const terminal of document.terminals) {
		if (!locations.has(terminal.locationId)) fail("unknown location parent", "$.terminals");
		if (terminal.profileId && !profiles.has(terminal.profileId)) fail("unknown profile parent", "$.terminals");
		if (locationGeneration.get(terminal.locationId) !== terminal.generation)
			fail("terminal generation mismatch", "$.terminals");
	}
	for (const browser of document.browsers) {
		if (!locations.has(browser.locationId)) fail("unknown location parent", "$.browsers");
		if (locationGeneration.get(browser.locationId) !== browser.generation)
			fail("browser generation mismatch", "$.browsers");
	}
	for (const preview of document.previews)
		if (!locations.has(preview.locationId) || locationGeneration.get(preview.locationId) !== preview.generation)
			fail("preview location/generation mismatch", "$.previews");
	for (const agent of document.agents) {
		if (!profiles.has(agent.profileId)) fail("unknown profile parent", "$.agents");
		if (agent.sessionId && !sessions.has(agent.sessionId)) fail("unknown session parent", "$.agents");
		if (agent.terminalId) {
			const terminal = document.terminals.find(item => item.id === agent.terminalId);
			if (!terminal) fail("unknown terminal parent", "$.agents");
			if (agent.paneId) {
				const pane = document.panes.find(item => item.id === agent.paneId);
				if (!pane) fail("unknown pane parent", "$.agents");
				if (pane.kind !== "terminal" || pane.entityId !== terminal.id)
					fail("agent pane must resolve to its terminal", "$.agents");
			}
			if (agent.sessionId) {
				const session = document.sessions.find(item => item.id === agent.sessionId);
				if (session && session.locationId !== terminal.locationId)
					fail("agent session location mismatch", "$.agents");
			}
		} else if (agent.paneId) {
			fail("agent pane requires terminal parent", "$.agents");
		}
	}
	for (const profile of document.agentProfiles)
		for (const capabilityId of profile.capabilityIds)
			if (!capabilities.has(capabilityId)) fail("unknown capability parent", "$.agentProfiles");
	for (const session of document.sessions) {
		if (!locations.has(session.locationId)) fail("unknown location parent", "$.sessions");
		if (session.capabilityIds.some(capabilityId => !capabilities.has(capabilityId)))
			fail("unknown capability parent", "$.sessions");
	}
}

function parseRuntimeProjection(value: unknown, path: string): WorkspaceRuntimeProjectionV1 {
	const v = object(value, path);
	const locations =
		"locations" in v
			? parseArray(v.locations, `${path}.locations`, (item, itemPath) => {
					const entry = object(item, itemPath);
					return {
						locationId: id(required(entry, "locationId", itemPath), `${itemPath}.locationId`),
						generation: integer(required(entry, "generation", itemPath), `${itemPath}.generation`),
						connection: enumValue(
							required(entry, "connection", itemPath),
							["disconnected", "connecting", "connected", "stale"],
							`${itemPath}.connection`,
						),
						health: enumValue(
							required(entry, "health", itemPath),
							["unknown", "starting", "ready", "healthy", "unhealthy", "lost"],
							`${itemPath}.health`,
						),
						reasonCode: optionalString(entry, "reasonCode", itemPath),
					};
				})
			: undefined;
	const terminals =
		"terminals" in v
			? parseArray(v.terminals, `${path}.terminals`, (item, itemPath) => {
					const entry = object(item, itemPath);
					return {
						terminalId: id(required(entry, "terminalId", itemPath), `${itemPath}.terminalId`),
						state: enumValue(
							required(entry, "state", itemPath),
							["starting", "running", "exited", "lost"],
							`${itemPath}.state`,
						),
						health: enumValue(
							required(entry, "health", itemPath),
							["unknown", "starting", "ready", "healthy", "unhealthy", "lost"],
							`${itemPath}.health`,
						),
						earliestOutputSequence:
							"earliestOutputSequence" in entry
								? integer(entry.earliestOutputSequence, `${itemPath}.earliestOutputSequence`)
								: undefined,
						nextOutputSequence:
							"nextOutputSequence" in entry
								? integer(entry.nextOutputSequence, `${itemPath}.nextOutputSequence`)
								: undefined,
					};
				})
			: undefined;
	const browsers =
		"browsers" in v
			? parseArray(v.browsers, `${path}.browsers`, (item, itemPath) => {
					const entry = object(item, itemPath);
					return {
						browserId: id(required(entry, "browserId", itemPath), `${itemPath}.browserId`),
						state: enumValue(
							required(entry, "state", itemPath),
							["opening", "open", "closed", "lost"],
							`${itemPath}.state`,
						),
						health: enumValue(
							required(entry, "health", itemPath),
							["unknown", "starting", "ready", "healthy", "unhealthy", "lost"],
							`${itemPath}.health`,
						),
						documentEpoch: integer(required(entry, "documentEpoch", itemPath), `${itemPath}.documentEpoch`),
						visible: bool(required(entry, "visible", itemPath), `${itemPath}.visible`),
					};
				})
			: undefined;
	const services =
		"services" in v
			? parseArray(v.services, `${path}.services`, (item, itemPath) => {
					const entry = object(item, itemPath);
					return {
						serviceId: id(required(entry, "serviceId", itemPath), `${itemPath}.serviceId`),
						health: enumValue(
							required(entry, "health", itemPath),
							["starting", "healthy", "unhealthy", "stopped", "unknown"],
							`${itemPath}.health`,
						),
					};
				})
			: undefined;
	const agents =
		"agents" in v
			? parseArray(v.agents, `${path}.agents`, (item, itemPath) => {
					const entry = object(item, itemPath);
					return {
						agentId: id(required(entry, "agentId", itemPath), `${itemPath}.agentId`),
						activity: enumValue(
							required(entry, "activity", itemPath),
							["idle", "working", "waiting_input", "complete", "error", "unknown"],
							`${itemPath}.activity`,
						),
						health: enumValue(
							required(entry, "health", itemPath),
							["unknown", "starting", "ready", "healthy", "unhealthy", "lost"],
							`${itemPath}.health`,
						),
					};
				})
			: undefined;
	const focus =
		"focus" in v
			? (() => {
					const entry = object(v.focus, `${path}.focus`);
					return {
						workspaceId: id(required(entry, "workspaceId", `${path}.focus`), `${path}.focus.workspaceId`),
						tabId: id(required(entry, "tabId", `${path}.focus`), `${path}.focus.tabId`),
						paneId: id(required(entry, "paneId", `${path}.focus`), `${path}.focus.paneId`),
					};
				})()
			: undefined;
	const capabilityFreshness =
		"capabilityFreshness" in v
			? parseArray(v.capabilityFreshness, `${path}.capabilityFreshness`, (item, itemPath) => {
					const entry = object(item, itemPath);
					return {
						capabilityId: id(required(entry, "capabilityId", itemPath), `${itemPath}.capabilityId`),
						state: enumValue(
							required(entry, "state", itemPath),
							["fresh", "stale", "revoked", "unknown"],
							`${itemPath}.state`,
						),
						checkedAt: finite(required(entry, "checkedAt", itemPath), `${itemPath}.checkedAt`),
						expiresAt: "expiresAt" in entry ? finite(entry.expiresAt, `${itemPath}.expiresAt`) : undefined,
					};
				})
			: undefined;
	return { locations, terminals, browsers, services, agents, focus, capabilityFreshness };
}

export function parseWorkspaceSnapshotV1(value: unknown): WorkspaceSnapshotV1 {
	const v = object(value, "$");
	literal(required(v, "version", "$"), 1, "$.version");
	const snapshot: WorkspaceSnapshotV1 = {
		version: 1,
		revision: integer(required(v, "revision", "$"), "$.revision"),
		activeWorkspaceId:
			v.activeWorkspaceId === null ? null : id(required(v, "activeWorkspaceId", "$"), "$.activeWorkspaceId"),
		workspaces: parseArray(required(v, "workspaces", "$"), "$.workspaces", parseWorkspace),
		locations: parseArray(required(v, "locations", "$"), "$.locations", parseLocation),
		tabs: parseArray(required(v, "tabs", "$"), "$.tabs", parseTab),
		panes: parseArray(required(v, "panes", "$"), "$.panes", parsePane),
		terminals: parseArray(required(v, "terminals", "$"), "$.terminals", parseTerminal),
		browsers: parseArray(required(v, "browsers", "$"), "$.browsers", parseBrowser),
		previews: parseArray(required(v, "previews", "$"), "$.previews", parsePreview),
		agentProfiles: parseArray(required(v, "agentProfiles", "$"), "$.agentProfiles", parseAgentProfile),
		agents: parseArray(required(v, "agents", "$"), "$.agents", parseAgent),
		capabilities: parseArray(required(v, "capabilities", "$"), "$.capabilities", parseCapability),
		sessions: parseArray(required(v, "sessions", "$"), "$.sessions", parseSession),
		services: parseArray(required(v, "services", "$"), "$.services", parseService),
		worktrees: parseArray(required(v, "worktrees", "$"), "$.worktrees", parseWorktree),
		notifications: parseArray(required(v, "notifications", "$"), "$.notifications", parseNotification),
		pendingCleanup: parseArray(required(v, "pendingCleanup", "$"), "$.pendingCleanup", parseCleanup),
		runtime: "runtime" in v ? parseRuntimeProjection(v.runtime, "$.runtime") : undefined,
	};
	uniqueAcrossCollections(
		[
			snapshot.workspaces,
			snapshot.locations,
			snapshot.tabs,
			snapshot.panes,
			snapshot.terminals,
			snapshot.browsers,
			snapshot.previews,
			snapshot.agentProfiles,
			snapshot.agents,
			snapshot.capabilities,
			snapshot.sessions,
			snapshot.services,
			snapshot.worktrees,
			snapshot.notifications,
			snapshot.pendingCleanup,
		],
		"$.entities",
	);
	if (snapshot.activeWorkspaceId !== null && !snapshot.workspaces.some(item => item.id === snapshot.activeWorkspaceId))
		fail("unknown active workspace", "$.activeWorkspaceId");
	validateLinks({
		...snapshot,
		createdAt: 0,
		updatedAt: 0,
		sessionEvents: [],
		deliveryReceipts: [],
		elementEdits: [],
	});
	return snapshot;
}

export function projectWorkspaceSnapshotV1(document: WorkspaceDocumentV1): WorkspaceSnapshotV1 {
	const parsed = parseWorkspaceDocumentV1(document);
	return {
		version: 1,
		revision: parsed.revision,
		activeWorkspaceId: parsed.activeWorkspaceId,
		workspaces: parsed.workspaces,
		locations: parsed.locations,
		tabs: parsed.tabs,
		panes: parsed.panes,
		terminals: parsed.terminals,
		browsers: parsed.browsers,
		previews: parsed.previews,
		agentProfiles: parsed.agentProfiles,
		agents: parsed.agents,
		capabilities: parsed.capabilities,
		sessions: parsed.sessions,
		services: parsed.services,
		worktrees: parsed.worktrees,
		notifications: parsed.notifications,
		pendingCleanup: parsed.pendingCleanup,
	};
}

export function parseWorkspaceCommandV1(value: unknown): WorkspaceCommandV1 {
	const v = object(value, "$");
	for (const key of ["principal", "source", "clientId", "actorId", "auth"])
		if (key in v) fail(`claimed identity or auth field ${key} is not accepted`, `$.${key}`);
	literal(required(v, "version", "$"), 1, "$.version");
	const type = enumValue(
		required(v, "type", "$"),
		[
			"workspace.create",
			"workspace.start",
			"workspace.stop",
			"workspace.delete",
			"profile.create",
			"profile.update",
			"profile.delete",
			"tab.update",
			"tab.close",
			"terminal.open",
			"terminal.status",
			"terminal.input",
			"terminal.resize",
			"terminal.close",
			"agent.start",
			"agent.attach",
			"agent.message",
			"agent.stop",
			"agent.detach",
			"browser.open",
			"browser.navigate",
			"browser.close",
			"selection.set",
			"preview.open",
			"preview.close",
			"service.declare",
			"service.start",
			"service.stop",
			"worktree.create",
			"worktree.remove",
			"remote.connect",
			"remote.disconnect",
			"attention.notify",
			"attention.dismiss",
			"cleanup.retry",
			"cleanup.cancel",
		],
		"$.type",
	);
	const result: WorkspaceCommandV1 = {
		version: 1,
		commandId: id(required(v, "commandId", "$"), "$.commandId"),
		workspaceId: id(required(v, "workspaceId", "$"), "$.workspaceId"),
		expectedRevision: integer(required(v, "expectedRevision", "$"), "$.expectedRevision"),
		issuedAt: finite(required(v, "issuedAt", "$"), "$.issuedAt"),
		type,
		payload: parsePayload(required(v, "payload", "$"), "$.payload"),
	};
	return result;
}

export function parseWorkspaceEventV1(value: unknown): WorkspaceEventV1 {
	const v = object(value, "$");
	literal(required(v, "version", "$"), 1, "$.version");
	const base = {
		version: 1 as const,
		eventId: id(required(v, "eventId", "$"), "$.eventId"),
		workspaceId: id(required(v, "workspaceId", "$"), "$.workspaceId"),
		sequence: integer(required(v, "sequence", "$"), "$.sequence"),
		revision: integer(required(v, "revision", "$"), "$.revision"),
		occurredAt: finite(required(v, "occurredAt", "$"), "$.occurredAt"),
	};
	const type = required(v, "type", "$");
	if (type === "future") return { ...base, type, payload: required(v, "payload", "$.payload") };
	return {
		...base,
		type: enumValue(
			type,
			[
				"workspace.created",
				"workspace.updated",
				"workspace.deleted",
				"location.changed",
				"tab.changed",
				"pane.changed",
				"terminal.changed",
				"browser.changed",
				"profile.changed",
				"capability.changed",
				"session.changed",
				"session.event",
				"delivery.receipt",
				"service.changed",
				"worktree.changed",
				"element.edit",
				"notification.changed",
				"cleanup.changed",
			],
			"$.type",
		),
		payload: parsePayload(required(v, "payload", "$"), "$.payload"),
	};
}

export function parseWorkspaceProviderRequestV1(value: unknown): WorkspaceProviderRequestV1 {
	const v = object(value, "$");
	literal(required(v, "version", "$"), 1, "$.version");
	return {
		version: 1,
		requestId: id(required(v, "requestId", "$"), "$.requestId"),
		workspaceId: id(required(v, "workspaceId", "$"), "$.workspaceId"),
		sessionId: id(required(v, "sessionId", "$"), "$.sessionId"),
		provider: string(required(v, "provider", "$"), "$.provider", WORKSPACE_MAX_NAME_BYTES),
		method: enumValue(required(v, "method", "$"), ["start", "stop", "send", "cancel", "status"], "$.method"),
		payload: parsePayload(required(v, "payload", "$"), "$.payload"),
		issuedAt: finite(required(v, "issuedAt", "$"), "$.issuedAt"),
	};
}

export function parseWorkspaceProviderResponseV1(value: unknown): WorkspaceProviderResponseV1 {
	const v = object(value, "$");
	literal(required(v, "version", "$"), 1, "$.version");
	return {
		version: 1,
		requestId: id(required(v, "requestId", "$"), "$.requestId"),
		workspaceId: id(required(v, "workspaceId", "$"), "$.workspaceId"),
		sessionId: id(required(v, "sessionId", "$"), "$.sessionId"),
		provider: string(required(v, "provider", "$"), "$.provider", WORKSPACE_MAX_NAME_BYTES),
		status: enumValue(required(v, "status", "$"), ["accepted", "completed", "failed", "cancelled"], "$.status"),
		payload: parsePayload(required(v, "payload", "$"), "$.payload"),
		respondedAt: finite(required(v, "respondedAt", "$"), "$.respondedAt"),
		reasonCode: optionalString(v, "reasonCode", "$"),
	};
}
function assertNoForbidden(value: unknown, path: string, seen: Set<object>): void {
	if (typeof value !== "object" || value === null) return;
	if (seen.has(value)) fail("cyclic value is not JSON", path);
	seen.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			assertNoForbidden(value[index], `${path}[${index}]`, seen);
		}
	} else {
		for (const [key, child] of Object.entries(value)) {
			if (FORBIDDEN_DURABLE_KEYS.has(key)) fail(`forbidden durable key ${key}`, `${path}.${key}`);
			assertNoForbidden(child, `${path}.${key}`, seen);
		}
	}
	seen.delete(value);
}
function object(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("expected object", path);
	assertNoForbidden(value, path, new Set<object>());
	return value as Record<string, unknown>;
}
export function encodeWorkspaceDocumentV1(value: unknown): string {
	return JSON.stringify(parseWorkspaceDocumentV1(value));
}
export function encodeWorkspaceSnapshotV1(value: unknown): string {
	return JSON.stringify(parseWorkspaceSnapshotV1(value));
}
export function encodeWorkspaceCommandV1(value: unknown): string {
	return JSON.stringify(parseWorkspaceCommandV1(value));
}
export function encodeWorkspaceEventV1(value: unknown): string {
	return JSON.stringify(parseWorkspaceEventV1(value));
}
export function encodeWorkspaceProviderRequestV1(value: unknown): string {
	return JSON.stringify(parseWorkspaceProviderRequestV1(value));
}
export function encodeWorkspaceProviderResponseV1(value: unknown): string {
	return JSON.stringify(parseWorkspaceProviderResponseV1(value));
}
function decode(value: string, parser: (value: unknown) => unknown): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		fail("invalid JSON", "$");
	}
	return parser(parsed);
}
export function decodeWorkspaceDocumentV1(value: string): WorkspaceDocumentV1 {
	return decode(value, parseWorkspaceDocumentV1) as WorkspaceDocumentV1;
}
export function decodeWorkspaceCommandV1(value: string): WorkspaceCommandV1 {
	return decode(value, parseWorkspaceCommandV1) as WorkspaceCommandV1;
}
export function decodeWorkspaceSnapshotV1(value: string): WorkspaceSnapshotV1 {
	return decode(value, parseWorkspaceSnapshotV1) as WorkspaceSnapshotV1;
}
export function decodeWorkspaceEventV1(value: string): WorkspaceEventV1 {
	return decode(value, parseWorkspaceEventV1) as WorkspaceEventV1;
}
export function decodeWorkspaceProviderRequestV1(value: string): WorkspaceProviderRequestV1 {
	return decode(value, parseWorkspaceProviderRequestV1) as WorkspaceProviderRequestV1;
}
export function decodeWorkspaceProviderResponseV1(value: string): WorkspaceProviderResponseV1 {
	return decode(value, parseWorkspaceProviderResponseV1) as WorkspaceProviderResponseV1;
}
