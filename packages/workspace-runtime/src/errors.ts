export type WorkspaceRejectionCodeV1 =
	| "invalid_command"
	| "stale_revision"
	| "duplicate_command"
	| "unauthorized"
	| "capability_revoked"
	| "capability_expired"
	| "generation_mismatch"
	| "lifecycle_blocked"
	| "not_found"
	| "conflict"
	| "invariant_violation"
	| "unsupported_command";

export class WorkspaceRuntimeError extends Error {
	readonly code: WorkspaceRejectionCodeV1;
	readonly path?: string;

	constructor(code: WorkspaceRejectionCodeV1, message: string, path?: string) {
		super(message);
		this.name = "WorkspaceRuntimeError";
		this.code = code;
		this.path = path;
	}
}

export function rejection(code: WorkspaceRejectionCodeV1, message: string, path?: string): WorkspaceRuntimeError {
	return new WorkspaceRuntimeError(code, message, path);
}
