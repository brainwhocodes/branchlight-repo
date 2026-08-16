import type { CDPSession, Page } from "playwright-core";

export interface BrowserTargetIdentity {
	workspaceId: string;
	paneId: string;
	documentEpoch: number;
	targetId: string;
	url: string;
	title?: string;
	visible?: boolean;
	health?: "unknown" | "starting" | "ready" | "healthy" | "unhealthy" | "lost";
}

export interface BrowserElementQueryInfo {
	selector: string;
	tagName: string;
	text?: string;
	attributes?: Record<string, string>;
	boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface BrowserActionOptions {
	timeoutMs?: number;
}

export interface AdoptTargetOptions {
	target: BrowserTargetIdentity;
	cdpUrl: string;
	isShared?: boolean;
	timeoutMs?: number;
}

export const SELECTION_LIMITS = {
	maxImageBytes: 150 * 1024,
	maxDomBytes: 32 * 1024,
	maxPreviewBytes: 64 * 1024,
	maxSummaryBytes: 8 * 1024,
	maxTotalRequestBytes: 256 * 1024,
	maxLiveRequests: 128,
	maxRuntimeStorageBytes: 64 * 1024 * 1024,
	maxLifetimeMs: 7 * 24 * 60 * 60 * 1000,
	maxDomDepth: 12,
	maxDomNodes: 256,
	screenshotPaddingPx: 12,
	maxScreenshotDimension: 1024,
} as const;

export interface ElementSelectionPoint {
	x: number;
	y: number;
}

export interface ElementSelectionBounds {
	x: number;
	y: number;
	width: number;
	height: number;
	top: number;
	left: number;
	bottom: number;
	right: number;
}

export interface ElementStructuralNode {
	role?: string;
	name?: string;
	tagName: string;
	selector: string;
	xpath?: string;
	bounds: ElementSelectionBounds;
	attributes: Record<string, string>;
	classes: string[];
	id?: string;
	text?: string;
	depth: number;
	childCount: number;
	isVisible: boolean;
	isInteractive: boolean;
	hierarchy: string[];
	children?: ElementStructuralNode[];
}

export interface ElementStructuralDescription {
	targetSelector: string;
	root: ElementStructuralNode;
	nodeCount: number;
	maxDepth: number;
	serializedBytes: number;
	json: string;
}

export interface ElementSelectionScreenshot {
	dataBase64: string;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	width: number;
	height: number;
	byteLength: number;
	clippedBounds: ElementSelectionBounds;
}

export interface ElementSelectionResult {
	selectionId: string;
	workspaceId: string;
	paneId: string;
	url: string;
	title?: string;
	timestamp: number;
	targetSelector: string;
	summary: string;
	dom: ElementStructuralDescription;
	screenshot?: ElementSelectionScreenshot;
}

export interface StartSelectionOptions {
	workspaceId?: string;
	paneId?: string;
	initialSelector?: string;
	highlightColor?: string;
	showDimensions?: boolean;
	captureScreenshot?: boolean;
}

export interface UpdateSelectionOptions {
	point?: ElementSelectionPoint;
	selector?: string;
	scrollToTarget?: boolean;
}

export interface CommitSelectionOptions {
	selector?: string;
	point?: ElementSelectionPoint;
	captureScreenshot?: boolean;
	screenshotPadding?: number;
	maxDepth?: number;
	maxNodes?: number;
	summaryPrefix?: string;
}

export type SelectionState = "idle" | "picking" | "selected" | "previewing";

export interface SelectionHoverEvent {
	selector: string;
	tagName: string;
	bounds: ElementSelectionBounds;
	role?: string;
	name?: string;
}

export interface BrowserSelectionChannelOptions {
	page: Page;
	cdpSession?: CDPSession;
	workspaceId?: string;
	paneId?: string;
	onHover?: (event: SelectionHoverEvent) => void;
	onCommit?: (result: ElementSelectionResult) => void;
	onCancel?: () => void;
}

export type DeclarativePatchOpType =
	| "replace_text"
	| "set_attribute"
	| "remove_attribute"
	| "set_style"
	| "remove_style"
	| "add_class"
	| "remove_class";
export interface BaseDeclarativePatchOp {
	type: DeclarativePatchOpType;
	selector: string;
}

export interface ReplaceTextPatchOp extends BaseDeclarativePatchOp {
	type: "replace_text";
	text: string;
}

export interface SetAttributePatchOp extends BaseDeclarativePatchOp {
	type: "set_attribute";
	name: string;
	value: string;
}

export interface RemoveAttributePatchOp extends BaseDeclarativePatchOp {
	type: "remove_attribute";
	name: string;
}

export interface SetStylePatchOp extends BaseDeclarativePatchOp {
	type: "set_style";
	property: string;
	value: string;
}

export interface RemoveStylePatchOp extends BaseDeclarativePatchOp {
	type: "remove_style";
	property: string;
}

export interface AddClassPatchOp extends BaseDeclarativePatchOp {
	type: "add_class";
	className: string;
}

export interface RemoveClassPatchOp extends BaseDeclarativePatchOp {
	type: "remove_class";
	className: string;
}

export type DeclarativePatchOperation =
	| ReplaceTextPatchOp
	| SetAttributePatchOp
	| RemoveAttributePatchOp
	| SetStylePatchOp
	| RemoveStylePatchOp
	| AddClassPatchOp
	| RemoveClassPatchOp;
export interface DeclarativePreviewPatch {
	patchId: string;
	targetSelector?: string;
	operations: DeclarativePatchOperation[];
	css?: string;
	description?: string;
}

export interface DeclarativePreviewResult {
	patchId: string;
	appliedOperationsCount: number;
	revertedOperationsCount?: number;
	success: boolean;
	errors?: string[];
}

export class DeclarativePreviewValidationError extends Error {
	readonly path: string;
	constructor(message: string, path = "$") {
		super(`Declarative preview validation error at ${path}: ${message}`);
		this.name = "DeclarativePreviewValidationError";
		this.path = path;
	}
}
