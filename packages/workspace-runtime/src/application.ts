import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { reduceWorkspace } from "./reducer";
import {
	parseWorkspaceCommandInputV1,
	parseWorkspaceCommandJsonV1,
	projectWorkspaceSnapshot,
	rejectedSchemaResult,
} from "./schema";
import type {
	WorkspaceApplicationContractV1,
	WorkspaceAuthorizationV1,
	WorkspaceCommandResultV1,
	WorkspaceReducerStateV1,
} from "./types";

const DEFAULT_AUTHORIZATION: WorkspaceAuthorizationV1 = {
	principal: { kind: "service", id: "workspace-runtime" },
	capabilities: [
		{
			capabilityId: "workspace-runtime",
			scope: "workspace",
			operations: [
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
		},
	],
};

export class WorkspaceApplication implements WorkspaceApplicationContractV1 {
	#state: WorkspaceReducerStateV1;
	readonly authorization: WorkspaceAuthorizationV1;

	constructor(state: WorkspaceReducerStateV1, authorization: WorkspaceAuthorizationV1 = DEFAULT_AUTHORIZATION) {
		this.#state = state;
		this.authorization = authorization;
	}

	get state(): WorkspaceReducerStateV1 {
		return this.#state;
	}
	get document(): WorkspaceDocumentV1 {
		return this.#state.document;
	}
	installState(state: WorkspaceReducerStateV1): void {
		this.#state = state;
	}

	apply(command: unknown, authorization?: WorkspaceAuthorizationV1): WorkspaceCommandResultV1 {
		try {
			const parsed = parseWorkspaceCommandInputV1(command);
			return this.applyCommand(parsed, authorization);
		} catch (error) {
			return rejectedSchemaResult(this.#state, error);
		}
	}

	applyCommand(command: unknown, authorization?: WorkspaceAuthorizationV1): WorkspaceCommandResultV1 {
		try {
			const parsed = parseWorkspaceCommandInputV1(command);
			const result = reduceWorkspace(this.#state, parsed, authorization ?? this.authorization);
			if (result.status === "accepted") this.#state = result.state;
			return result;
		} catch (error) {
			return rejectedSchemaResult(this.#state, error);
		}
	}

	applyJson(command: string, authorization?: WorkspaceAuthorizationV1): WorkspaceCommandResultV1 {
		try {
			const parsed = parseWorkspaceCommandJsonV1(command);
			const result = reduceWorkspace(this.#state, parsed, authorization ?? this.authorization);
			if (result.status === "accepted") this.#state = result.state;
			return result;
		} catch (error) {
			return rejectedSchemaResult(this.#state, error);
		}
	}

	projectSnapshot() {
		return projectWorkspaceSnapshot(this.#state.document);
	}
}

export function createWorkspaceApplication(
	document: WorkspaceDocumentV1,
	authorization?: WorkspaceAuthorizationV1,
): WorkspaceApplication {
	return new WorkspaceApplication(
		{ document, seenCommandIds: new Set<string>(), nextEventSequence: 1 },
		authorization,
	);
}

export function createWorkspaceApplicationFromState(
	state: WorkspaceReducerStateV1,
	authorization?: WorkspaceAuthorizationV1,
): WorkspaceApplication {
	return new WorkspaceApplication(state, authorization);
}
