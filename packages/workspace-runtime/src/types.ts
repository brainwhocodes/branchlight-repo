import type {
	WorkspaceCapabilityIdV1,
	WorkspaceCommandTypeV1,
	WorkspaceDocumentV1,
	WorkspaceEventV1,
	WorkspacePrincipalV1,
	WorkspaceProviderRequestV1,
	WorkspaceSnapshotV1,
} from "@oh-my-pi/pi-wire";
import type { WorkspaceRejectionCodeV1 } from "./errors";
export type WorkspaceOperationV1 =
	| WorkspaceCommandTypeV1
	| "terminal.subscribe"
	| "terminal.unsubscribe"
	| "terminal.input"
	| "terminal.resize";

export interface WorkspaceCapabilityGrantV1 {
	capabilityId: WorkspaceCapabilityIdV1;
	scope: "workspace" | "location" | "session" | "terminal" | "browser" | "agent";
	operations: readonly WorkspaceOperationV1[];
	workspaceId?: string;
	locationId?: string;
	entityId?: string;
	paneId?: string;
	generation?: number;
	expiresAt?: number;
	revoked?: boolean;
}

export interface WorkspaceAuthorizationV1 {
	principal: WorkspacePrincipalV1;
	capabilities: readonly WorkspaceCapabilityGrantV1[];
	now?: number;
}

export interface WorkspaceEffectIntentV1 {
	kind: "provider" | "terminal" | "browser" | "agent" | "service" | "worktree" | "remote" | "cleanup";
	intentId: string;
	commandId: string;
	workspaceId: string;
	operation: WorkspaceCommandTypeV1;
	providerRequest?: WorkspaceProviderRequestV1;
	payload: Record<string, unknown>;
}

export interface WorkspaceReducerStateV1 {
	document: WorkspaceDocumentV1;
	seenCommandIds: ReadonlySet<string>;
	nextEventSequence: number;
}
export type WorkspaceReducerState = WorkspaceReducerStateV1;

export interface WorkspaceCommandResultV1 {
	status: "accepted" | "rejected" | "duplicate";
	state: WorkspaceReducerStateV1;
	document: WorkspaceDocumentV1;
	snapshot?: WorkspaceSnapshotV1;
	events: readonly WorkspaceEventV1[];
	effects: readonly WorkspaceEffectIntentV1[];
	error?: {
		code: WorkspaceRejectionCodeV1;
		message: string;
		path?: string;
	};
}

export interface WorkspaceApplicationContractV1 {
	readonly state: WorkspaceReducerStateV1;
	apply(command: unknown, authorization?: WorkspaceAuthorizationV1): WorkspaceCommandResultV1;
	applyCommand(command: unknown, authorization?: WorkspaceAuthorizationV1): WorkspaceCommandResultV1;
	applyJson(command: string, authorization?: WorkspaceAuthorizationV1): WorkspaceCommandResultV1;
	projectSnapshot(): WorkspaceSnapshotV1;
}
