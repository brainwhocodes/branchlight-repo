import type { WorkspacePaneKind } from "../shared/contracts";

export type WorkspaceLayout = "columns" | "rows" | "grid";

export type ElementEditPhase = "idle" | "picking" | "selected" | "sending" | "working" | "ready" | "error" | "preview";

export type SelectionCaptureMode = "dom" | "screenshot";

export interface ElementSelectionState {
	phase: ElementEditPhase;
	selectionId?: string;
	workspaceId?: string;
	paneId?: string;
	agentId?: string;
	agentName?: string;
	captureMode: SelectionCaptureMode;
	url?: string;
	selector?: string;
	tagName?: string;
	elementLabel?: string;
	domSummary?: string;
	screenshotDataUrl?: string;
	previewPatch?: string;
	workingMessage?: string;
	error?: string;
	updatedAt?: number;
}

export type AgentProcessStatus = "idle" | "ready" | "running" | "working" | "stopped" | "error";

export interface WorkspaceAgent {
	id: string;
	name: string;
	agent: string;
	status: AgentProcessStatus | string;
	swatch: string;
	workspaceId?: string;
	sessionId?: string;
	deliverable: boolean;
	task?: string;
	assignment?: string;
	lastIntent?: string;
	currentTool?: string;
	terminalId?: string;
	paneId?: string;
	profileId?: string;
}

export interface WorkspacePane {
	id: string;
	kind: WorkspacePaneKind;
	title: string;
	url?: string;
	cwd?: string;
	status?: "starting" | "ready" | "exited" | "error";
	error?: string;
	workspaceId?: string;
	tabId?: string;
	selectionState?: ElementSelectionState;
	agentId?: string;
	agent?: WorkspaceAgent;
}

export interface WorkspaceTab {
	kind: WorkspacePaneKind;
	id: string;
	title: string;
	panes: WorkspacePane[];
	layout: WorkspaceLayout;
	ratio: number;
	activePaneId: string;
	workspaceId?: string;
}

const SWATCH_PALETTE: readonly string[] = [
	"oklch(0.65 0.18 25)",
	"oklch(0.68 0.16 48)",
	"oklch(0.72 0.15 85)",
	"oklch(0.66 0.17 145)",
	"oklch(0.64 0.14 185)",
	"oklch(0.62 0.16 240)",
	"oklch(0.63 0.18 290)",
	"oklch(0.65 0.19 330)",
];

export function getAgentSwatch(idOrName: string): string {
	let hash = 0;
	for (let i = 0; i < idOrName.length; i++) {
		hash = (hash * 31 + idOrName.charCodeAt(i)) >>> 0;
	}
	return SWATCH_PALETTE[hash % SWATCH_PALETTE.length];
}
