import {
	parseWorkspaceCommandV1,
	projectWorkspaceSnapshotV1,
	type WorkspaceCommandV1,
	type WorkspaceDocumentV1,
	type WorkspaceSnapshotV1,
} from "@oh-my-pi/pi-wire";
import { WorkspaceRuntimeError } from "./errors";
import type { WorkspaceCommandResultV1, WorkspaceReducerStateV1 } from "./types";

export function createInitialWorkspaceDocumentV1(now = 0): WorkspaceDocumentV1 {
	return {
		version: 1,
		revision: 0,
		activeWorkspaceId: null,
		workspaces: [],
		locations: [],
		tabs: [],
		panes: [],
		terminals: [],
		browsers: [],
		previews: [],
		agentProfiles: [],
		agents: [],
		capabilities: [],
		sessions: [],
		sessionEvents: [],
		deliveryReceipts: [],
		services: [],
		worktrees: [],
		elementEdits: [],
		notifications: [],
		pendingCleanup: [],
		createdAt: now,
		updatedAt: now,
	};
}

export const createEmptyWorkspaceDocumentV1 = createInitialWorkspaceDocumentV1;

export function createInitialWorkspaceReducerStateV1(now = 0): WorkspaceReducerStateV1 {
	return { document: createInitialWorkspaceDocumentV1(now), seenCommandIds: new Set<string>(), nextEventSequence: 1 };
}

export function parseWorkspaceCommandInputV1(value: unknown): WorkspaceCommandV1 {
	return parseWorkspaceCommandV1(value);
}

export function parseWorkspaceCommandJsonV1(value: string): WorkspaceCommandV1 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		throw new WorkspaceRuntimeError("invalid_command", "command is not valid JSON", "$");
	}
	return parseWorkspaceCommandV1(parsed);
}

function stripUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => stripUndefined(item));
	if (typeof value !== "object" || value === null) return value;
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) if (child !== undefined) result[key] = stripUndefined(child);
	return result;
}

export function projectWorkspaceSnapshot(document: WorkspaceDocumentV1): WorkspaceSnapshotV1 {
	return projectWorkspaceSnapshotV1(stripUndefined(document) as WorkspaceDocumentV1);
}

export function rejectedSchemaResult(state: WorkspaceReducerStateV1, error: unknown): WorkspaceCommandResultV1 {
	const runtimeError =
		error instanceof WorkspaceRuntimeError
			? error
			: new WorkspaceRuntimeError("invalid_command", error instanceof Error ? error.message : "invalid command");
	return {
		status: "rejected",
		state,
		document: state.document,
		events: [],
		effects: [],
		error: { code: runtimeError.code, message: runtimeError.message, path: runtimeError.path },
	};
}
