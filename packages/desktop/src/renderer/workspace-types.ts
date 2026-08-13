import type { WorkspacePaneKind } from "../shared/contracts";

export type WorkspaceLayout = "columns" | "rows" | "grid";

export interface WorkspacePane {
	id: string;
	kind: WorkspacePaneKind;
	title: string;
	url?: string;
	cwd?: string;
	status?: "starting" | "ready" | "exited" | "error";
	error?: string;
}

export interface WorkspaceTab {
	kind: WorkspacePaneKind;
	id: string;
	title: string;
	panes: WorkspacePane[];
	layout: WorkspaceLayout;
	ratio: number;
	activePaneId: string;
}
