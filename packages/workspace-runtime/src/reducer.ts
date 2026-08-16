import {
	type AgentCapabilitiesV1,
	parseWorkspaceDocumentV1,
	type WorkspaceAgentProfileV1,
	type WorkspaceAgentV1,
	type WorkspaceBrowserV1,
	type WorkspaceCommandV1,
	type WorkspaceDocumentV1,
	type WorkspaceElementEditV1,
	type WorkspaceEventTypeV1,
	type WorkspaceEventV1,
	type WorkspaceLocationV1,
	type WorkspacePaneV1,
	type WorkspaceTabV1,
	type WorkspaceTerminalV1,
} from "@oh-my-pi/pi-wire";
import { MAX_WORKSPACE_EVENTS, MAX_WORKSPACE_PANES, WORKSPACE_MAX_RATIO, WORKSPACE_MIN_RATIO } from "./constants";
import { rejection, WorkspaceRuntimeError } from "./errors";
import type {
	WorkspaceAuthorizationV1,
	WorkspaceCapabilityGrantV1,
	WorkspaceCommandResultV1,
	WorkspaceEffectIntentV1,
	WorkspaceReducerStateV1,
} from "./types";

const EVENT_TYPE_BY_COMMAND: Record<WorkspaceCommandV1["type"], WorkspaceEventTypeV1> = {
	"workspace.create": "workspace.created",
	"workspace.start": "workspace.updated",
	"workspace.stop": "workspace.updated",
	"workspace.delete": "workspace.deleted",
	"profile.create": "profile.changed",
	"profile.update": "profile.changed",
	"profile.delete": "profile.changed",
	"tab.update": "pane.changed",
	"tab.close": "pane.changed",
	"terminal.open": "terminal.changed",
	"terminal.status": "terminal.changed",
	"terminal.input": "terminal.changed",
	"terminal.resize": "terminal.changed",
	"terminal.close": "terminal.changed",
	"agent.start": "session.changed",
	"agent.attach": "session.changed",
	"agent.message": "session.event",
	"agent.stop": "session.changed",
	"agent.detach": "session.changed",
	"browser.open": "browser.changed",
	"browser.navigate": "browser.changed",
	"browser.close": "browser.changed",
	"selection.set": "pane.changed",
	"preview.open": "pane.changed",
	"preview.close": "pane.changed",
	"service.declare": "service.changed",
	"service.start": "service.changed",
	"service.stop": "service.changed",
	"worktree.create": "worktree.changed",
	"worktree.remove": "worktree.changed",
	"remote.connect": "location.changed",
	"remote.disconnect": "location.changed",
	"attention.notify": "notification.changed",
	"attention.dismiss": "notification.changed",
	"cleanup.retry": "cleanup.changed",
	"cleanup.cancel": "cleanup.changed",
};

const ALL_COMMANDS = Object.keys(EVENT_TYPE_BY_COMMAND) as WorkspaceCommandV1["type"][];

function copyDocument(document: WorkspaceDocumentV1): WorkspaceDocumentV1 {
	const copied = structuredClone(document);
	return stripUndefined(copied) as WorkspaceDocumentV1;
}

function stripUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => stripUndefined(item));
	if (typeof value !== "object" || value === null) return value;
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) if (child !== undefined) result[key] = stripUndefined(child);
	return result;
}
function objectPayload(command: WorkspaceCommandV1, allowed: readonly string[]): Record<string, unknown> {
	const payload = command.payload;
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(payload)) {
		if (!allowedKeys.has(key))
			throw rejection("invalid_command", `unsupported payload field ${key}`, `$.payload.${key}`);
	}
	return payload;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
	const value = payload[key];
	if (typeof value !== "string" || value.length === 0)
		throw rejection("invalid_command", `${key} must be a non-empty string`, `$.payload.${key}`);
	return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
	if (!(key in payload)) return undefined;
	const value = payload[key];
	if (typeof value !== "string") throw rejection("invalid_command", `${key} must be a string`, `$.payload.${key}`);
	return value;
}

function requiredNumber(payload: Record<string, unknown>, key: string): number {
	const value = payload[key];
	if (typeof value !== "number" || !Number.isFinite(value))
		throw rejection("invalid_command", `${key} must be a finite number`, `$.payload.${key}`);
	return value;
}

function optionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
	if (!(key in payload)) return undefined;
	return requiredNumber(payload, key);
}

function optionalObject(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	if (!(key in payload)) return undefined;
	const value = payload[key];
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw rejection("invalid_command", `${key} must be an object`, `$.payload.${key}`);
	return value as Record<string, unknown>;
}

function requiredObject(payload: Record<string, unknown>, key: string): Record<string, unknown> {
	const result = optionalObject(payload, key);
	if (!result) throw rejection("invalid_command", `${key} must be an object`, `$.payload.${key}`);
	return result;
}

function optionalStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
	if (!(key in payload)) return undefined;
	const value = payload[key];
	if (!Array.isArray(value) || value.some(item => typeof item !== "string"))
		throw rejection("invalid_command", `${key} must be an array of strings`, `$.payload.${key}`);
	return [...value];
}
function capabilityBoolean(value: Record<string, unknown>, key: string): boolean {
	const result = value[key];
	if (typeof result !== "boolean")
		throw rejection("invalid_command", `${key} must be a boolean`, `$.payload.capabilities.${key}`);
	return result;
}

function optionalAgentCapabilities(payload: Record<string, unknown>, key: string): AgentCapabilitiesV1 | undefined {
	const value = optionalObject(payload, key);
	if (!value) return undefined;
	const prompt = requiredObject(value, "prompt");
	const session = requiredObject(value, "session");
	return {
		prompt: {
			text: capabilityBoolean(prompt, "text"),
			image: capabilityBoolean(prompt, "image"),
			resource: capabilityBoolean(prompt, "resource"),
		},
		session: {
			create: capabilityBoolean(session, "create"),
			load: capabilityBoolean(session, "load"),
			resume: capabilityBoolean(session, "resume"),
			close: capabilityBoolean(session, "close"),
		},
		cancel: capabilityBoolean(value, "cancel"),
		modes: capabilityBoolean(value, "modes"),
		config: capabilityBoolean(value, "config"),
		filesystem: capabilityBoolean(value, "filesystem"),
		terminal: capabilityBoolean(value, "terminal"),
		permissions: capabilityBoolean(value, "permissions"),
		mcp: capabilityBoolean(value, "mcp"),
	};
}
function optionalAgentProtocol(payload: Record<string, unknown>, key: string): WorkspaceAgentProfileV1["protocol"] {
	const value = optionalString(payload, key);
	if (value === undefined || value === "omp" || value === "acp" || value === "terminal" || value === "auto")
		return value;
	throw rejection("invalid_command", `${key} must be a supported agent protocol`, `$.payload.${key}`);
}

function uniqueName(base: string, names: readonly string[]): string {
	if (!names.includes(base)) return base;
	let suffix = 2;
	while (names.includes(`${base} ${suffix}`)) suffix += 1;
	return `${base} ${suffix}`;
}

function idFor(command: WorkspaceCommandV1, payload: Record<string, unknown>, key: string, fallback: string): string {
	return optionalString(payload, key) ?? `${command.commandId}:${fallback}`;
}

function locationOf(document: WorkspaceDocumentV1, locationId: string): WorkspaceLocationV1 {
	const location = document.locations.find(item => item.id === locationId);
	if (!location) throw rejection("not_found", `unknown location ${locationId}`);
	return location;
}

function checkLocationActive(location: WorkspaceLocationV1): void {
	if (location.lifecycle.status !== "active")
		throw rejection("lifecycle_blocked", `location ${location.id} is ${location.lifecycle.status}`);
}

function entityLocation(
	document: WorkspaceDocumentV1,
	id: string,
): { locationId: string; generation: number } | undefined {
	const terminal = document.terminals.find(item => item.id === id);
	if (terminal) return terminal;
	const browser = document.browsers.find(item => item.id === id);
	if (browser) return browser;
	const preview = document.previews.find(item => item.id === id);
	if (preview) return preview;
	const agent = document.agents.find(item => item.id === id);
	if (agent?.sessionId) {
		const session = document.sessions.find(item => item.id === agent.sessionId);
		if (session)
			return {
				locationId: session.locationId,
				generation: locationOf(document, session.locationId).lifecycle.generation,
			};
	}
	const service = document.services.find(item => item.id === id);
	if (service)
		return {
			locationId: service.locationId,
			generation: locationOf(document, service.locationId).lifecycle.generation,
		};
	const worktree = document.worktrees.find(item => item.id === id);
	if (worktree)
		return {
			locationId: worktree.locationId,
			generation: locationOf(document, worktree.locationId).lifecycle.generation,
		};
	return undefined;
}
function entityWorkspace(
	document: WorkspaceDocumentV1,
	entityId: string,
): { workspaceId: string; paneId?: string } | undefined {
	const pane = document.panes.find(item => item.entityId === entityId);
	if (!pane) return undefined;
	const tab = document.tabs.find(item => item.id === pane.tabId);
	return tab ? { workspaceId: tab.workspaceId, paneId: pane.id } : undefined;
}

function targetFor(
	command: WorkspaceCommandV1,
	document: WorkspaceDocumentV1,
): { workspaceId?: string; locationId?: string; entityId?: string; paneId?: string; generation?: number } {
	const p = command.payload;
	if (command.type === "agent.attach" && typeof p.terminalId === "string") {
		const terminal = document.terminals.find(item => item.id === p.terminalId);
		if (terminal) {
			return {
				workspaceId: command.workspaceId,
				...entityWorkspace(document, terminal.id),
				locationId: terminal.locationId,
				entityId: terminal.id,
				generation: terminal.generation,
			};
		}
		return { workspaceId: command.workspaceId, entityId: p.terminalId };
	}
	if (command.type === "agent.detach" && typeof p.id === "string") {
		const agent = document.agents.find(item => item.id === p.id);
		if (agent?.terminalId) {
			const terminal = document.terminals.find(item => item.id === agent.terminalId);
			if (terminal) {
				return {
					workspaceId: command.workspaceId,
					...entityWorkspace(document, terminal.id),
					locationId: terminal.locationId,
					entityId: terminal.id,
					generation: terminal.generation,
				};
			}
			return { workspaceId: command.workspaceId, entityId: agent.terminalId };
		}
	}
	const entityId = typeof p.id === "string" ? p.id : typeof p.entityId === "string" ? p.entityId : undefined;
	if (typeof p.locationId === "string") {
		return {
			workspaceId: command.workspaceId,
			locationId: p.locationId,
			entityId,
			paneId: typeof p.paneId === "string" ? p.paneId : undefined,
			generation: typeof p.generation === "number" ? p.generation : undefined,
		};
	}
	if (entityId) {
		const location = entityLocation(document, entityId);
		if (location)
			return { workspaceId: command.workspaceId, ...location, ...entityWorkspace(document, entityId), entityId };
	}
	if (command.type.startsWith("workspace."))
		return { workspaceId: command.workspaceId, entityId: command.workspaceId };
	return { workspaceId: command.workspaceId, entityId };
}

function grantMatches(
	grant: WorkspaceCapabilityGrantV1,
	command: WorkspaceCommandV1,
	target: { workspaceId?: string; locationId?: string; entityId?: string; paneId?: string; generation?: number },
): boolean {
	if (!grant.operations.includes(command.type)) return false;
	if (grant.workspaceId !== undefined && grant.workspaceId !== target.workspaceId) return false;
	if (grant.paneId !== undefined && grant.paneId !== target.paneId) return false;
	if (grant.generation !== undefined && grant.generation !== target.generation)
		throw rejection("generation_mismatch", `capability ${grant.capabilityId} generation mismatch`);
	if (grant.scope === "workspace") return true;
	if (grant.scope === "location")
		return (
			target.locationId !== undefined &&
			(grant.locationId === target.locationId || grant.entityId === target.locationId)
		);
	return target.entityId !== undefined && grant.entityId === target.entityId;
}

function authorize(
	command: WorkspaceCommandV1,
	document: WorkspaceDocumentV1,
	authorization: WorkspaceAuthorizationV1,
): void {
	const now = authorization.now ?? command.issuedAt;
	const target = targetFor(command, document);
	let expired = false;
	let revoked = false;
	for (const grant of authorization.capabilities) {
		if (!grant.operations.includes(command.type)) continue;
		if (grant.revoked) {
			revoked = true;
			continue;
		}
		if (grant.expiresAt !== undefined && grant.expiresAt <= now) {
			expired = true;
			continue;
		}
		if (grantMatches(grant, command, target)) return;
	}
	if (revoked) throw rejection("capability_revoked", "capability is revoked");
	if (expired) throw rejection("capability_expired", "capability is expired");
	throw rejection("unauthorized", `principal ${authorization.principal.id} is not authorized for ${command.type}`);
}

function assertGeneration(
	document: WorkspaceDocumentV1,
	locationId: string,
	generation: number | undefined,
): WorkspaceLocationV1 {
	const location = locationOf(document, locationId);
	if (generation !== undefined && location.lifecycle.generation !== generation)
		throw rejection("generation_mismatch", `location ${locationId} generation mismatch`);
	return location;
}

function assertUniqueId(document: WorkspaceDocumentV1, id: string): void {
	const collections: readonly { id: string }[][] = [
		document.workspaces,
		document.locations,
		document.tabs,
		document.panes,
		document.terminals,
		document.browsers,
		document.previews,
		document.agentProfiles,
		document.agents,
		document.capabilities,
		document.sessions,
		document.services,
		document.worktrees,
		document.notifications,
		document.pendingCleanup,
	];
	if (collections.some(items => items.some(item => item.id === id)))
		throw rejection("conflict", `duplicate entity id ${id}`);
}
function makeCleanupId(commandId: string, entityId: string): string {
	const cmd = commandId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-28);
	const ent = entityId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-28);
	return `cln-${cmd}-${ent}`;
}

function tabForPane(document: WorkspaceDocumentV1, paneId: string): WorkspaceTabV1 {
	const pane = document.panes.find(item => item.id === paneId);
	if (!pane) throw rejection("not_found", `unknown pane ${paneId}`);
	const tab = document.tabs.find(item => item.id === pane.tabId);
	if (!tab) throw rejection("invariant_violation", `pane ${paneId} has no tab`);
	return tab;
}

function addTerminal(
	document: WorkspaceDocumentV1,
	command: WorkspaceCommandV1,
	payload: Record<string, unknown>,
	locationId: string,
	generation: number,
): string {
	const id = idFor(command, payload, "id", "terminal");
	assertUniqueId(document, id);
	const tabId = idFor(command, payload, "tabId", "tab");
	const requestedLayout = optionalString(payload, "layout");
	if (
		requestedLayout !== undefined &&
		requestedLayout !== "columns" &&
		requestedLayout !== "rows" &&
		requestedLayout !== "grid"
	) {
		throw rejection("invalid_command", "layout must be columns, rows, or grid");
	}
	let tab = document.tabs.find(item => item.id === tabId);
	if (!tab) {
		const tabName = optionalString(payload, "tabName") ?? "Terminal";
		tab = {
			id: tabId,
			workspaceId: command.workspaceId,
			locationId,
			generation,
			name: uniqueName(
				tabName,
				document.tabs
					.filter(item => item.workspaceId === command.workspaceId && item.locationId === locationId)
					.map(item => item.name),
			),
			paneKind: "terminal",
			layout: requestedLayout === "rows" ? "rows" : "columns",
			ratio: 50,
			paneIds: [],
			activePaneId: "",
		};
		document.tabs.push(tab);
	}
	if (
		tab.workspaceId !== command.workspaceId ||
		tab.locationId !== locationId ||
		tab.generation !== generation ||
		tab.paneKind !== "terminal"
	)
		throw rejection("conflict", "tab parent or pane kind mismatch");
	const activePanesInTab = document.panes.filter(p => p.tabId === tab.id);
	if (activePanesInTab.length >= MAX_WORKSPACE_PANES)
		throw rejection("invariant_violation", `maximum ${MAX_WORKSPACE_PANES} panes exceeded`);
	const nextPaneCount = activePanesInTab.length + 1;
	if (nextPaneCount >= 3) {
		if (requestedLayout !== undefined && requestedLayout !== "grid") {
			throw rejection("invalid_command", "3 or 4 panes require grid layout");
		}
		tab.layout = "grid";
	} else if (nextPaneCount <= 2) {
		if (requestedLayout === "grid") {
			throw rejection("invalid_command", "grid layout requires at least 3 panes");
		}
		if (requestedLayout !== undefined) {
			tab.layout = requestedLayout;
		}
	}
	const paneId = idFor(command, payload, "paneId", "pane");
	assertUniqueId(document, paneId);
	const terminal: WorkspaceTerminalV1 = {
		id,
		locationId,
		profileId: optionalString(payload, "profileId"),
		paneId,
		generation,
		label: optionalString(payload, "label") ?? "Terminal",
		cwd: optionalString(payload, "cwd"),
		columns: optionalNumber(payload, "columns"),
		rows: optionalNumber(payload, "rows"),
		status: "starting",
	};
	const pane: WorkspacePaneV1 = { id: paneId, tabId, generation, kind: "terminal", entityId: id };
	document.terminals.push(terminal);
	document.panes.push(pane);
	tab.paneIds = [...activePanesInTab.map(p => p.id), paneId];
	tab.activePaneId = paneId;
	return id;
}
function addBrowser(
	document: WorkspaceDocumentV1,
	command: WorkspaceCommandV1,
	payload: Record<string, unknown>,
	locationId: string,
	generation: number,
): string {
	const id = idFor(command, payload, "id", "browser");
	assertUniqueId(document, id);
	const tabId = idFor(command, payload, "tabId", "tab");
	const requestedLayout = optionalString(payload, "layout");
	if (
		requestedLayout !== undefined &&
		requestedLayout !== "columns" &&
		requestedLayout !== "rows" &&
		requestedLayout !== "grid"
	) {
		throw rejection("invalid_command", "layout must be columns, rows, or grid");
	}
	let tab = document.tabs.find(item => item.id === tabId);
	if (!tab) {
		const tabName = optionalString(payload, "tabName") ?? "Browser";
		tab = {
			id: tabId,
			workspaceId: command.workspaceId,
			locationId,
			generation,
			name: uniqueName(
				tabName,
				document.tabs
					.filter(item => item.workspaceId === command.workspaceId && item.locationId === locationId)
					.map(item => item.name),
			),
			paneKind: "browser",
			layout: requestedLayout === "rows" ? "rows" : "columns",
			ratio: 50,
			paneIds: [],
			activePaneId: "",
		};
		document.tabs.push(tab);
	}
	if (
		tab.workspaceId !== command.workspaceId ||
		tab.locationId !== locationId ||
		tab.generation !== generation ||
		tab.paneKind !== "browser"
	)
		throw rejection("conflict", "tab parent or pane kind mismatch");
	const activePanesInTab = document.panes.filter(p => p.tabId === tab.id);
	if (activePanesInTab.length >= MAX_WORKSPACE_PANES)
		throw rejection("invariant_violation", `maximum ${MAX_WORKSPACE_PANES} panes exceeded`);
	const nextPaneCount = activePanesInTab.length + 1;
	if (nextPaneCount >= 3) {
		if (requestedLayout !== undefined && requestedLayout !== "grid") {
			throw rejection("invalid_command", "3 or 4 panes require grid layout");
		}
		tab.layout = "grid";
	} else if (nextPaneCount <= 2) {
		if (requestedLayout === "grid") {
			throw rejection("invalid_command", "grid layout requires at least 3 panes");
		}
		if (requestedLayout !== undefined) {
			tab.layout = requestedLayout;
		}
	}
	const paneId = idFor(command, payload, "paneId", "pane");
	assertUniqueId(document, paneId);
	const browser: WorkspaceBrowserV1 = {
		id,
		locationId,
		paneId,
		generation,
		url: requiredString(payload, "url"),
		title: optionalString(payload, "title"),
		status: "opening",
	};
	const pane: WorkspacePaneV1 = { id: paneId, tabId, generation, kind: "browser", entityId: id };
	document.browsers.push(browser);
	document.panes.push(pane);
	tab.paneIds = [...activePanesInTab.map(p => p.id), paneId];
	tab.activePaneId = paneId;
	return id;
}
function closeEntityPane(
	document: WorkspaceDocumentV1,
	entityId: string,
	kind: WorkspacePaneV1["kind"],
	command: WorkspaceCommandV1,
	payload: Record<string, unknown>,
): void {
	const pane = document.panes.find(item => item.entityId === entityId && item.kind === kind);
	if (!pane) return;
	const tab = tabForPane(document, pane.id);
	const cleanupId = makeCleanupId(command.commandId, entityId);
	assertUniqueId(document, cleanupId);
	document.pendingCleanup.push({
		id: cleanupId,
		kind: kind === "browser" ? "browser" : "terminal",
		entityId,
		attempts: 0,
		nextAttemptAt: command.issuedAt,
		reasonCode: "pane_closed",
	});
	const nextPaneIds = tab.paneIds.filter(id => id !== pane.id);
	if (nextPaneIds.length > 0) {
		tab.paneIds = nextPaneIds;
		tab.activePaneId = nextPaneIds.includes(tab.activePaneId) ? tab.activePaneId : nextPaneIds[0];
		if (nextPaneIds.length <= 2 && tab.layout === "grid") {
			tab.layout = "columns";
		}
		document.panes = document.panes.filter(item => item.id !== pane.id);
		return;
	}
	if (document.tabs.length > 1) {
		document.tabs = document.tabs.filter(item => item.id !== tab.id);
		document.panes = document.panes.filter(item => item.id !== pane.id);
		return;
	}
	const replacementId = `${command.commandId}:final-terminal`;
	const replacementPaneId = `${command.commandId}:final-pane`;
	assertUniqueId(document, replacementId);
	assertUniqueId(document, replacementPaneId);
	const location = locationOf(document, tab.locationId);
	const replacement: WorkspaceTerminalV1 = {
		id: replacementId,
		locationId: tab.locationId,
		generation: location.lifecycle.generation,
		paneId: replacementPaneId,
		label: "Terminal",
		status: "starting",
	};
	document.terminals = document.terminals.filter(item => item.id !== entityId).concat(replacement);
	document.panes = document.panes
		.filter(item => item.id !== pane.id)
		.concat({
			id: replacementPaneId,
			tabId: tab.id,
			generation: tab.generation,
			kind: "terminal",
			entityId: replacementId,
		});
	tab.paneKind = "terminal";
	tab.paneIds = [replacementPaneId];
	tab.activePaneId = replacementPaneId;
	void payload;
}

function eventFor(
	command: WorkspaceCommandV1,
	document: WorkspaceDocumentV1,
	sequence: number,
	occurredAt: number,
): WorkspaceEventV1 {
	return {
		version: 1,
		eventId: command.commandId,
		workspaceId: command.workspaceId,
		sequence,
		revision: document.revision,
		occurredAt,
		type: EVENT_TYPE_BY_COMMAND[command.type],
		payload: { commandId: command.commandId, commandType: command.type, ...command.payload },
	};
}

function effectFor(
	command: WorkspaceCommandV1,
	payload: Record<string, unknown>,
	kind: WorkspaceEffectIntentV1["kind"],
): WorkspaceEffectIntentV1 {
	return {
		kind,
		intentId: `${command.commandId}:effect`,
		commandId: command.commandId,
		workspaceId: command.workspaceId,
		operation: command.type,
		payload,
	};
}

function finish(
	state: WorkspaceReducerStateV1,
	command: WorkspaceCommandV1,
	document: WorkspaceDocumentV1,
	effects: readonly WorkspaceEffectIntentV1[],
): WorkspaceCommandResultV1 {
	const parsed = parseWorkspaceDocumentV1(stripUndefined(document));
	const cleanParsed = stripUndefined(parsed) as WorkspaceDocumentV1;
	const nextDocument = { ...cleanParsed, revision: state.document.revision + 1, updatedAt: command.issuedAt };
	const sequence = state.nextEventSequence;
	const event = eventFor(command, nextDocument, sequence, command.issuedAt);
	if (sequence > Number.MAX_SAFE_INTEGER - 1) throw rejection("invariant_violation", "event sequence exhausted");
	const seenCommandIds = new Set(state.seenCommandIds);
	seenCommandIds.add(command.commandId);
	const nextState: WorkspaceReducerStateV1 = {
		document: nextDocument,
		seenCommandIds,
		nextEventSequence: sequence + 1,
	};
	return { status: "accepted", state: nextState, document: nextDocument, events: [event], effects };
}

function rejectResult(state: WorkspaceReducerStateV1, error: WorkspaceRuntimeError): WorkspaceCommandResultV1 {
	return {
		status: "rejected",
		state,
		document: state.document,
		events: [],
		effects: [],
		error: { code: error.code, message: error.message, path: error.path },
	};
}

function assertTargetLifecycle(command: WorkspaceCommandV1, document: WorkspaceDocumentV1): void {
	const target = targetFor(command, document);
	if (
		!target.locationId ||
		command.type === "workspace.create" ||
		command.type === "remote.connect" ||
		command.type === "remote.disconnect"
	)
		return;
	const location = locationOf(document, target.locationId);
	if (target.generation !== undefined && target.generation !== location.lifecycle.generation)
		throw rejection("generation_mismatch", `entity generation does not match location ${location.id}`);
	checkLocationActive(location);
}
function appendElementEdit(
	document: WorkspaceDocumentV1,
	command: WorkspaceCommandV1,
	payload: Record<string, unknown>,
	agentId: string,
): void {
	const editPayload = optionalObject(payload, "elementEdit");
	if (!editPayload) return;
	const editAllowed = new Set(["id", "sessionId", "target", "operation", "value", "from", "to"]);
	for (const key of Object.keys(editPayload))
		if (!editAllowed.has(key)) throw rejection("invalid_command", `unsupported element edit field ${key}`);
	const agent = document.agents.find(item => item.id === agentId);
	if (!agent?.sessionId) throw rejection("invariant_violation", "element edit requires an agent session");
	const sessionId = requiredString(editPayload, "sessionId");
	if (sessionId !== agent.sessionId) throw rejection("conflict", "element edit session does not belong to agent");
	const session = document.sessions.find(item => item.id === sessionId);
	if (!session || session.status === "closed")
		throw rejection("not_found", "element edit session does not exist or is closed");
	const target = requiredString(editPayload, "target");
	const targetLoc = entityLocation(document, target);
	if (targetLoc && targetLoc.locationId !== session.locationId)
		throw rejection("conflict", "element edit target is outside session location");
	const operation = requiredString(editPayload, "operation");
	if (operation !== "insert" && operation !== "replace" && operation !== "delete" && operation !== "move")
		throw rejection("invalid_command", "invalid element edit operation");
	const editId = optionalString(editPayload, "id") ?? `${command.commandId}:edit`;
	assertUniqueId(document, editId);
	document.elementEdits.push({
		id: editId,
		sessionId,
		target,
		operation: operation as WorkspaceElementEditV1["operation"],
		value: optionalString(editPayload, "value"),
		from: optionalNumber(editPayload, "from"),
		to: optionalNumber(editPayload, "to"),
	});
}

export function reduceWorkspace(
	state: WorkspaceReducerStateV1,
	command: WorkspaceCommandV1,
	authorization: WorkspaceAuthorizationV1,
): WorkspaceCommandResultV1 {
	if (!ALL_COMMANDS.includes(command.type))
		return rejectResult(state, rejection("unsupported_command", `unsupported command ${command.type}`));
	if (command.workspaceId.length === 0)
		return rejectResult(state, rejection("invalid_command", "workspaceId is required"));
	if (state.seenCommandIds.has(command.commandId))
		return { status: "duplicate", state, document: state.document, events: [], effects: [] };
	if (command.expectedRevision !== state.document.revision)
		return rejectResult(
			state,
			rejection(
				"stale_revision",
				`expected revision ${command.expectedRevision}, current revision ${state.document.revision}`,
			),
		);
	try {
		authorize(command, state.document, authorization);
		const document = copyDocument(state.document);
		assertTargetLifecycle(command, document);
		const p = command.payload;
		let effects: WorkspaceEffectIntentV1[] = [];
		switch (command.type) {
			case "workspace.create": {
				objectPayload(command, ["locationId", "locationName", "address", "generation", "name"]);
				const locationId = requiredString(p, "locationId");
				const locationName = requiredString(p, "locationName");
				const address = requiredObject(p, "address");
				if (document.locations.some(item => item.id === locationId))
					throw rejection("conflict", `location ${locationId} already exists`);
				const kind = address.kind;
				if (kind !== "local" && kind !== "ssh")
					throw rejection("invalid_command", "address.kind must be local or ssh");
				const path = requiredString(address, "path");
				const location: WorkspaceLocationV1 =
					kind === "local"
						? {
								id: locationId,
								name: uniqueName(
									locationName,
									document.locations.map(item => item.name),
								),
								address: { kind, path },
								lifecycle: {
									status: "active",
									generation: optionalNumber(p, "generation") ?? 1,
									updatedAt: command.issuedAt,
								},
							}
						: {
								id: locationId,
								name: uniqueName(
									locationName,
									document.locations.map(item => item.name),
								),
								address: {
									kind,
									host: requiredString(address, "host"),
									path,
									user: optionalString(address, "user"),
									port: optionalNumber(address, "port"),
									authRef: optionalString(address, "authRef"),
								},
								lifecycle: {
									status: "active",
									generation: optionalNumber(p, "generation") ?? 1,
									updatedAt: command.issuedAt,
								},
							};
				const workspaceName = uniqueName(
					optionalString(p, "name") ?? "Workspace",
					document.workspaces.map(item => item.name),
				);
				document.locations.push(location);
				document.workspaces.push({
					id: command.workspaceId,
					name: workspaceName,
					locationId,
					generation: location.lifecycle.generation,
				});
				document.activeWorkspaceId = command.workspaceId;
				effects = [effectFor(command, p, "remote")];
				break;
			}
			case "workspace.start": {
				objectPayload(command, []);
				if (!document.workspaces.some(item => item.id === command.workspaceId))
					throw rejection("not_found", "workspace does not exist");
				document.activeWorkspaceId = command.workspaceId;
				break;
			}
			case "workspace.stop": {
				objectPayload(command, []);
				if (document.activeWorkspaceId === command.workspaceId) document.activeWorkspaceId = null;
				break;
			}
			case "workspace.delete": {
				objectPayload(command, []);
				const workspace = document.workspaces.find(item => item.id === command.workspaceId);
				if (!workspace) throw rejection("not_found", "workspace does not exist");
				document.workspaces = document.workspaces.filter(item => item.id !== workspace.id);
				if (document.activeWorkspaceId === workspace.id)
					document.activeWorkspaceId = document.workspaces[0]?.id ?? null;
				break;
			}
			case "profile.create": {
				objectPayload(command, [
					"id",
					"name",
					"config",
					"capabilityIds",
					"exec",
					"args",
					"cwd",
					"protocol",
					"capabilities",
				]);
				const id = requiredString(p, "id");
				if (document.agentProfiles.some(item => item.id === id))
					throw rejection("conflict", `profile ${id} already exists`);
				const profile: WorkspaceAgentProfileV1 = {
					id,
					name: uniqueName(
						requiredString(p, "name"),
						document.agentProfiles.map(item => item.name),
					),
					config: requiredObject(p, "config"),
					capabilityIds: optionalStringArray(p, "capabilityIds") ?? [],
					exec: optionalString(p, "exec"),
					args: optionalStringArray(p, "args"),
					cwd: optionalString(p, "cwd"),
					protocol: optionalAgentProtocol(p, "protocol"),
					capabilities: optionalAgentCapabilities(p, "capabilities"),
				};
				document.agentProfiles.push(profile);
				break;
			}
			case "profile.update": {
				objectPayload(command, [
					"id",
					"name",
					"config",
					"capabilityIds",
					"exec",
					"args",
					"cwd",
					"protocol",
					"capabilities",
				]);
				const profile = document.agentProfiles.find(item => item.id === requiredString(p, "id"));
				if (!profile) throw rejection("not_found", "profile does not exist");
				if ("name" in p) profile.name = requiredString(p, "name");
				if ("config" in p) profile.config = requiredObject(p, "config");
				if ("capabilityIds" in p) profile.capabilityIds = optionalStringArray(p, "capabilityIds") ?? [];
				if ("exec" in p) profile.exec = optionalString(p, "exec");
				if ("args" in p) profile.args = optionalStringArray(p, "args");
				if ("cwd" in p) profile.cwd = optionalString(p, "cwd");
				if ("protocol" in p) profile.protocol = optionalAgentProtocol(p, "protocol");
				if ("capabilities" in p) profile.capabilities = optionalAgentCapabilities(p, "capabilities");
				break;
			}
			case "profile.delete": {
				objectPayload(command, ["id"]);
				const id = requiredString(p, "id");
				if (!document.agentProfiles.some(item => item.id === id))
					throw rejection("not_found", "profile does not exist");
				if (document.agents.some(item => item.profileId === id)) throw rejection("conflict", "profile is in use");
				document.agentProfiles = document.agentProfiles.filter(item => item.id !== id);
				break;
			}
			case "tab.update": {
				objectPayload(command, ["id", "name", "layout", "ratio", "activePaneId"]);
				const tabId = requiredString(p, "id");
				const tab = document.tabs.find(item => item.id === tabId);
				if (!tab) throw rejection("not_found", `tab ${tabId} does not exist`);
				if (tab.workspaceId !== command.workspaceId)
					throw rejection("conflict", "tab does not belong to workspace");
				if ("name" in p) {
					const newName = requiredString(p, "name");
					tab.name = uniqueName(
						newName,
						document.tabs
							.filter(
								item =>
									item.id !== tab.id &&
									item.workspaceId === tab.workspaceId &&
									item.locationId === tab.locationId,
							)
							.map(item => item.name),
					);
				}
				if ("layout" in p) {
					const layout = requiredString(p, "layout");
					if (layout !== "columns" && layout !== "rows" && layout !== "grid")
						throw rejection("invalid_command", "layout must be columns, rows, or grid");
					if (tab.paneIds.length >= 3 && layout !== "grid") {
						throw rejection("invalid_command", "3 or 4 panes require grid layout");
					}
					if (tab.paneIds.length < 3 && layout === "grid") {
						throw rejection("invalid_command", "grid layout requires at least 3 panes");
					}
					tab.layout = layout;
				}
				if ("ratio" in p) {
					const ratio = requiredNumber(p, "ratio");
					if (ratio < WORKSPACE_MIN_RATIO || ratio > WORKSPACE_MAX_RATIO)
						throw rejection(
							"invariant_violation",
							`ratio must be between ${WORKSPACE_MIN_RATIO} and ${WORKSPACE_MAX_RATIO}`,
						);
					tab.ratio = ratio;
				}
				if ("activePaneId" in p) {
					const activePaneId = requiredString(p, "activePaneId");
					if (!tab.paneIds.includes(activePaneId))
						throw rejection("invariant_violation", `active pane ${activePaneId} is not a child of tab ${tabId}`);
					tab.activePaneId = activePaneId;
				}
				break;
			}
			case "tab.close": {
				objectPayload(command, ["id"]);
				const tabId = requiredString(p, "id");
				const tab = document.tabs.find(item => item.id === tabId);
				if (!tab) throw rejection("not_found", `tab ${tabId} does not exist`);
				if (tab.workspaceId !== command.workspaceId)
					throw rejection("conflict", "tab does not belong to workspace");
				const childPanes = document.panes.filter(item => item.tabId === tab.id);
				for (const pane of childPanes) {
					if (pane.kind === "terminal") {
						const terminal = document.terminals.find(item => item.id === pane.entityId);
						if (terminal) {
							for (const agent of document.agents) {
								if (agent.terminalId === terminal.id || (terminal.paneId && agent.paneId === terminal.paneId)) {
									agent.status = "stopped";
									delete agent.terminalId;
									delete agent.paneId;
									if (agent.sessionId) {
										const session = document.sessions.find(item => item.id === agent.sessionId);
										if (session) session.status = "closed";
									}
								}
							}
							document.terminals = document.terminals.filter(item => item.id !== terminal.id);
							const cleanupId = makeCleanupId(command.commandId, terminal.id);
							assertUniqueId(document, cleanupId);
							document.pendingCleanup.push({
								id: cleanupId,
								kind: "terminal",
								entityId: terminal.id,
								attempts: 0,
								nextAttemptAt: command.issuedAt,
								reasonCode: "tab_closed",
							});
							effects.push(effectFor(command, { id: terminal.id }, "terminal"));
						}
					} else if (pane.kind === "browser") {
						const browser = document.browsers.find(item => item.id === pane.entityId);
						if (browser) {
							document.browsers = document.browsers.filter(item => item.id !== browser.id);
							const cleanupId = makeCleanupId(command.commandId, browser.id);
							assertUniqueId(document, cleanupId);
							document.pendingCleanup.push({
								id: cleanupId,
								kind: "browser",
								entityId: browser.id,
								attempts: 0,
								nextAttemptAt: command.issuedAt,
								reasonCode: "tab_closed",
							});
							effects.push(effectFor(command, { id: browser.id }, "browser"));
						}
					} else if (pane.kind === "preview") {
						document.previews = document.previews.filter(item => item.id !== pane.entityId);
						effects.push(effectFor(command, { id: pane.entityId }, "browser"));
					}
					document.panes = document.panes.filter(item => item.id !== pane.id);
				}
				document.tabs = document.tabs.filter(item => item.id !== tab.id);
				break;
			}
			case "terminal.open": {
				objectPayload(command, [
					"id",
					"locationId",
					"generation",
					"profileId",
					"paneId",
					"tabId",
					"tabName",
					"label",
					"cwd",
					"shell",
					"args",
					"columns",
					"rows",
					"layout",
				]);
				const locationId =
					optionalString(p, "locationId") ??
					document.workspaces.find(item => item.id === command.workspaceId)?.locationId;
				if (!locationId) throw rejection("not_found", "terminal location is required");
				const location = assertGeneration(document, locationId, optionalNumber(p, "generation"));
				checkLocationActive(location);
				optionalString(p, "shell");
				optionalStringArray(p, "args");
				addTerminal(document, command, p, locationId, location.lifecycle.generation);
				effects = [effectFor(command, p, "terminal")];
				break;
			}
			case "terminal.status": {
				objectPayload(command, ["id", "status", "cwd", "error", "columns", "rows"]);
				const terminal = document.terminals.find(item => item.id === requiredString(p, "id"));
				if (!terminal) break;
				const status = requiredString(p, "status");
				if (
					status !== "starting" &&
					status !== "running" &&
					status !== "exited" &&
					status !== "failed" &&
					status !== "closed"
				) {
					throw rejection("invalid_command", "invalid terminal status");
				}
				terminal.status = status;
				if ("cwd" in p) terminal.cwd = optionalString(p, "cwd");
				if ("error" in p) terminal.error = optionalString(p, "error");
				if ("columns" in p) terminal.columns = optionalNumber(p, "columns");
				if ("rows" in p) terminal.rows = optionalNumber(p, "rows");
				break;
			}
			case "terminal.input": {
				objectPayload(command, ["id", "data"]);
				const terminal = document.terminals.find(item => item.id === requiredString(p, "id"));
				if (!terminal) throw rejection("not_found", "terminal does not exist");
				if (terminal.status === "closed" || terminal.status === "exited")
					throw rejection("lifecycle_blocked", "terminal is not accepting input");
				requiredString(p, "data");
				effects = [effectFor(command, p, "terminal")];
				break;
			}
			case "terminal.resize": {
				objectPayload(command, ["id", "columns", "rows"]);
				const terminal = document.terminals.find(item => item.id === requiredString(p, "id"));
				if (!terminal) throw rejection("not_found", "terminal does not exist");
				if (terminal.status === "closed" || terminal.status === "exited")
					throw rejection("lifecycle_blocked", "terminal is not resizable");
				requiredNumber(p, "columns");
				requiredNumber(p, "rows");
				effects = [effectFor(command, p, "terminal")];
				break;
			}
			case "terminal.close": {
				objectPayload(command, ["id"]);
				const id = requiredString(p, "id");
				const terminal = document.terminals.find(item => item.id === id);
				if (!terminal) throw rejection("not_found", "terminal does not exist");
				for (const agent of document.agents) {
					if (agent.terminalId === id || (terminal.paneId && agent.paneId === terminal.paneId)) {
						agent.status = "stopped";
						delete agent.terminalId;
						delete agent.paneId;
						if (agent.sessionId) {
							const session = document.sessions.find(item => item.id === agent.sessionId);
							if (session) session.status = "closed";
						}
					}
				}
				document.terminals = document.terminals.filter(item => item.id !== id);
				closeEntityPane(document, id, "terminal", command, p);
				effects = [effectFor(command, p, "terminal")];
				break;
			}
			case "agent.start": {
				objectPayload(command, ["id", "profileId", "sessionId"]);
				const id = idFor(command, p, "id", "agent");
				const profileId = requiredString(p, "profileId");
				if (!document.agentProfiles.some(item => item.id === profileId))
					throw rejection("not_found", "profile does not exist");
				assertUniqueId(document, id);
				const sessionId = optionalString(p, "sessionId") ?? `session-${id}`;
				if (!document.sessions.some(item => item.id === sessionId)) {
					const locationId =
						document.workspaces.find(item => item.id === command.workspaceId)?.locationId ??
						document.locations[0]?.id ??
						"loc-default";
					document.sessions.push({
						id: sessionId,
						locationId,
						actorId: id,
						kind: "agent",
						status: "active",
						capabilityIds: [],
						startedAt: command.issuedAt,
						lastSeenAt: command.issuedAt,
					});
				}
				const agent: WorkspaceAgentV1 = { id, profileId, sessionId, status: "starting" };
				document.agents.push(agent);
				effects = [effectFor(command, p, "agent")];
				break;
			}
			case "agent.attach": {
				objectPayload(command, ["id", "profileId", "sessionId", "terminalId", "paneId"]);
				const id = idFor(command, p, "id", "agent");
				const profileId = requiredString(p, "profileId");
				if (!document.agentProfiles.some(item => item.id === profileId))
					throw rejection("not_found", "profile does not exist");
				const terminalId = requiredString(p, "terminalId");
				const terminal = document.terminals.find(item => item.id === terminalId);
				if (!terminal) throw rejection("not_found", "terminal does not exist");
				if (terminal.status === "closed" || terminal.status === "exited")
					throw rejection("lifecycle_blocked", "terminal is not running");
				const sessionId = requiredString(p, "sessionId");
				const paneId = optionalString(p, "paneId");
				if (paneId) {
					const pane = document.panes.find(item => item.id === paneId);
					if (!pane) throw rejection("not_found", "pane does not exist");
					if (pane.kind !== "terminal" || pane.entityId !== terminal.id)
						throw rejection("conflict", "pane does not belong to terminal");
					if (terminal.paneId && terminal.paneId !== paneId)
						throw rejection("conflict", "pane does not match terminal pane");
				}
				const profile = document.agentProfiles.find(item => item.id === profileId)!;
				const existingAgent = document.agents.find(item => item.id === id);
				if (existingAgent) {
					if (
						existingAgent.status === "running" &&
						existingAgent.terminalId === terminalId &&
						existingAgent.sessionId === sessionId
					) {
						break;
					}
					if (existingAgent.status === "running") {
						throw rejection("conflict", `agent ${id} is already running`);
					}
					existingAgent.profileId = profileId;
					existingAgent.sessionId = sessionId;
					existingAgent.terminalId = terminalId;
					existingAgent.paneId = paneId;
					existingAgent.status = "running";
				} else {
					assertUniqueId(document, id);
				}

				const session = document.sessions.find(item => item.id === sessionId);
				if (session) {
					if (session.locationId !== terminal.locationId)
						throw rejection("conflict", "session location does not match terminal");
					if (session.kind !== "agent") throw rejection("conflict", "session is not an agent session");
					if (session.status === "closed") {
						session.status = "active";
						session.lastSeenAt = command.issuedAt;
					}
					const otherRunning = document.agents.find(
						item => item.id !== id && item.sessionId === sessionId && item.status === "running",
					);
					if (otherRunning) throw rejection("conflict", "session is already linked to another running agent");
				} else {
					document.sessions.push({
						id: sessionId,
						locationId: terminal.locationId,
						actorId: id,
						kind: "agent",
						status: "active",
						capabilityIds: [...profile.capabilityIds],
						startedAt: command.issuedAt,
						lastSeenAt: command.issuedAt,
					});
				}
				if (!existingAgent) {
					document.agents.push({ id, profileId, sessionId, terminalId, paneId, status: "running" });
				}
				effects = [effectFor(command, p, "agent")];
				break;
			}
			case "agent.detach": {
				objectPayload(command, ["id", "reason"]);
				const id = requiredString(p, "id");
				const agent = document.agents.find(item => item.id === id);
				if (!agent) {
					break;
				}
				optionalString(p, "reason");
				agent.status = "stopped";
				delete agent.terminalId;
				delete agent.paneId;
				if (agent.sessionId) {
					const session = document.sessions.find(item => item.id === agent.sessionId);
					if (session) {
						session.status = "closed";
						session.lastSeenAt = command.issuedAt;
					}
				}
				effects = [effectFor(command, p, "agent")];
				break;
			}
			case "agent.message": {
				objectPayload(command, [
					"id",
					"message",
					"elementEdit",
					"selector",
					"url",
					"domSnapshot",
					"screenshot",
					"instruction",
				]);
				const agentId = requiredString(p, "id");
				requiredString(p, "message");
				appendElementEdit(document, command, p, agentId);
				effects = [effectFor(command, p, "agent")];
				break;
			}
			case "agent.stop": {
				objectPayload(command, ["id"]);
				const agent = document.agents.find(item => item.id === requiredString(p, "id"));
				if (!agent) throw rejection("not_found", "agent does not exist");
				agent.status = "stopped";
				effects = [effectFor(command, p, "agent")];
				break;
			}
			case "browser.open": {
				objectPayload(command, [
					"id",
					"locationId",
					"generation",
					"paneId",
					"tabId",
					"tabName",
					"url",
					"title",
					"layout",
				]);
				const locationId =
					optionalString(p, "locationId") ??
					document.workspaces.find(item => item.id === command.workspaceId)?.locationId;
				if (!locationId) throw rejection("not_found", "browser location is required");
				const location = assertGeneration(document, locationId, optionalNumber(p, "generation"));
				checkLocationActive(location);
				addBrowser(document, command, p, locationId, location.lifecycle.generation);
				effects = [effectFor(command, p, "browser")];
				break;
			}
			case "browser.navigate": {
				objectPayload(command, ["id", "url"]);
				const browser = document.browsers.find(item => item.id === requiredString(p, "id"));
				if (!browser) throw rejection("not_found", "browser does not exist");
				if (browser.status === "closed" || browser.status === "failed")
					throw rejection("lifecycle_blocked", "browser is not navigable");
				browser.url = requiredString(p, "url");
				effects = [effectFor(command, p, "browser")];
				break;
			}
			case "browser.close": {
				objectPayload(command, ["id"]);
				const id = requiredString(p, "id");
				if (!document.browsers.some(item => item.id === id)) throw rejection("not_found", "browser does not exist");
				document.browsers = document.browsers.filter(item => item.id !== id);
				closeEntityPane(document, id, "browser", command, p);
				effects = [effectFor(command, p, "browser")];
				break;
			}
			case "selection.set": {
				objectPayload(command, ["id", "kind"]);
				const paneId = requiredString(p, "id");
				const kind = requiredString(p, "kind");
				const pane = document.panes.find(item => item.id === paneId);
				if (!pane) throw rejection("not_found", "pane does not exist");
				if (pane.kind !== kind) throw rejection("conflict", "selection kind does not match pane");
				tabForPane(document, paneId).activePaneId = paneId;
				break;
			}
			case "preview.open": {
				objectPayload(command, ["id", "locationId", "generation", "url"]);
				const id = idFor(command, p, "id", "preview");
				const locationId =
					optionalString(p, "locationId") ??
					document.workspaces.find(item => item.id === command.workspaceId)?.locationId;
				if (!locationId) throw rejection("not_found", "preview location is required");
				const location = assertGeneration(document, locationId, optionalNumber(p, "generation"));
				checkLocationActive(location);
				assertUniqueId(document, id);
				document.previews.push({
					id,
					locationId,
					generation: location.lifecycle.generation,
					url: requiredString(p, "url"),
					status: "opening",
				});
				effects = [effectFor(command, p, "browser")];
				break;
			}
			case "preview.close": {
				objectPayload(command, ["id"]);
				const id = requiredString(p, "id");
				if (!document.previews.some(item => item.id === id)) throw rejection("not_found", "preview does not exist");
				document.previews = document.previews.filter(item => item.id !== id);
				effects = [effectFor(command, p, "browser")];
				break;
			}
			case "service.declare": {
				objectPayload(command, ["id", "locationId", "name", "command", "port", "url"]);
				const id = idFor(command, p, "id", "service");
				const locationId = requiredString(p, "locationId");
				const location = assertGeneration(document, locationId, undefined);
				checkLocationActive(location);
				assertUniqueId(document, id);
				document.services.push({
					id,
					locationId,
					name: requiredString(p, "name"),
					command: requiredString(p, "command"),
					status: "declared",
					port: optionalNumber(p, "port"),
					url: optionalString(p, "url"),
				});
				break;
			}
			case "service.start":
			case "service.stop": {
				objectPayload(command, ["id"]);
				const service = document.services.find(item => item.id === requiredString(p, "id"));
				if (!service) throw rejection("not_found", "service does not exist");
				service.status = command.type === "service.start" ? "starting" : "stopping";
				effects = [effectFor(command, p, "service")];
				break;
			}
			case "worktree.create": {
				objectPayload(command, ["id", "locationId", "path", "branch", "commit"]);
				const id = idFor(command, p, "id", "worktree");
				const locationId = requiredString(p, "locationId");
				const location = assertGeneration(document, locationId, undefined);
				checkLocationActive(location);
				assertUniqueId(document, id);
				document.worktrees.push({
					id,
					locationId,
					path: requiredString(p, "path"),
					branch: optionalString(p, "branch"),
					commit: optionalString(p, "commit"),
					status: "creating",
				});
				effects = [effectFor(command, p, "worktree")];
				break;
			}
			case "worktree.remove": {
				objectPayload(command, ["id"]);
				const item = document.worktrees.find(worktree => worktree.id === requiredString(p, "id"));
				if (!item) throw rejection("not_found", "worktree does not exist");
				item.status = "removing";
				effects = [effectFor(command, p, "worktree")];
				break;
			}
			case "remote.connect": {
				objectPayload(command, ["locationId", "locationName", "address", "generation"]);
				const locationId = requiredString(p, "locationId");
				const locationName = requiredString(p, "locationName");
				const address = requiredObject(p, "address");
				if (document.locations.some(item => item.id === locationId))
					throw rejection("conflict", "location already exists");
				const kind = address.kind;
				if (kind !== "ssh" && kind !== "local") throw rejection("invalid_command", "invalid remote address kind");
				const addressPath = requiredString(address, "path");
				const location: WorkspaceLocationV1 =
					kind === "local"
						? {
								id: locationId,
								name: uniqueName(
									locationName,
									document.locations.map(item => item.name),
								),
								address: { kind, path: addressPath },
								lifecycle: {
									status: "active",
									generation: optionalNumber(p, "generation") ?? 1,
									updatedAt: command.issuedAt,
								},
							}
						: {
								id: locationId,
								name: uniqueName(
									locationName,
									document.locations.map(item => item.name),
								),
								address: { kind, host: requiredString(address, "host"), path: addressPath },
								lifecycle: {
									status: "active",
									generation: optionalNumber(p, "generation") ?? 1,
									updatedAt: command.issuedAt,
								},
							};
				document.locations.push(location);
				effects = [effectFor(command, p, "remote")];
				break;
			}
			case "remote.disconnect": {
				objectPayload(command, ["locationId"]);
				const location = locationOf(document, requiredString(p, "locationId"));
				const referenced =
					document.workspaces.some(item => item.locationId === location.id) ||
					document.tabs.some(item => item.locationId === location.id) ||
					document.terminals.some(item => item.locationId === location.id) ||
					document.browsers.some(item => item.locationId === location.id) ||
					document.previews.some(item => item.locationId === location.id) ||
					document.services.some(item => item.locationId === location.id) ||
					document.worktrees.some(item => item.locationId === location.id);
				location.lifecycle = {
					...location.lifecycle,
					status: referenced ? "removal_blocked" : "removing",
					generation: referenced ? location.lifecycle.generation : location.lifecycle.generation + 1,
					updatedAt: command.issuedAt,
					reasonCode: referenced ? "active_references" : undefined,
				};
				effects = [effectFor(command, p, "remote")];
				break;
			}
			case "attention.notify": {
				objectPayload(command, ["id", "severity", "title", "message"]);
				const id = idFor(command, p, "id", "notification");
				assertUniqueId(document, id);
				document.notifications.push({
					id,
					severity: requiredString(p, "severity") as "info" | "success" | "warning" | "error",
					title: requiredString(p, "title"),
					message: requiredString(p, "message"),
					createdAt: command.issuedAt,
				});
				break;
			}
			case "attention.dismiss": {
				objectPayload(command, ["id"]);
				const notification = document.notifications.find(item => item.id === requiredString(p, "id"));
				if (!notification) throw rejection("not_found", "notification does not exist");
				notification.dismissedAt = command.issuedAt;
				break;
			}
			case "cleanup.retry": {
				objectPayload(command, ["id", "nextAttemptAt"]);
				const cleanup = document.pendingCleanup.find(item => item.id === requiredString(p, "id"));
				if (!cleanup) throw rejection("not_found", "cleanup does not exist");
				cleanup.attempts += 1;
				cleanup.nextAttemptAt = optionalNumber(p, "nextAttemptAt") ?? command.issuedAt;
				effects = [effectFor(command, p, "cleanup")];
				break;
			}
			case "cleanup.cancel": {
				objectPayload(command, ["id"]);
				const id = requiredString(p, "id");
				if (!document.pendingCleanup.some(item => item.id === id))
					throw rejection("not_found", "cleanup does not exist");
				document.pendingCleanup = document.pendingCleanup.filter(item => item.id !== id);
				effects = [effectFor(command, p, "cleanup")];
				break;
			}
		}
		for (const tab of document.tabs) {
			if (tab.ratio < WORKSPACE_MIN_RATIO || tab.ratio > WORKSPACE_MAX_RATIO)
				throw rejection("invariant_violation", "ratio must be between 20 and 80");
			if (tab.paneIds.length === 0 || tab.paneIds.length > MAX_WORKSPACE_PANES)
				throw rejection("invariant_violation", "tabs must contain 1-4 panes");
		}
		if (effects.length > MAX_WORKSPACE_EVENTS) throw rejection("invariant_violation", "effect cap exceeded");
		return finish(state, command, document, effects);
	} catch (error) {
		return rejectResult(
			state,
			error instanceof WorkspaceRuntimeError
				? error
				: rejection("invalid_command", error instanceof Error ? error.message : "command rejected"),
		);
	}
}

export const applyWorkspaceCommand = reduceWorkspace;
