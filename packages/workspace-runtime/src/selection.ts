import { validateDeclarativePreviewPatch } from "@oh-my-pi/pi-browser-runtime/selection-channel";
import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { rejection } from "./errors";

export * from "./selection-types";

import type {
	CommitSelectionPayload,
	DeclarativePreviewPatch,
	ElementDomNode,
	ElementDomSnapshot,
	ElementEditPhase,
	ElementEditResultV1,
	ElementEditState,
	ElementScreenshot,
	ElementSelectionLimits,
	ElementSelectionV1,
	SelectionAuthContext,
	SelectionAuthScope,
	StartSelectionOptions,
	UpdateSelectionOptions,
} from "./selection-types";

export const SELECTION_LIMITS: ElementSelectionLimits = Object.freeze({
	maxImageBytes: 150 * 1024, // 153600 (150 KiB)
	maxDomBytes: 32 * 1024, // 32768 (32 KiB)
	maxPreviewBytes: 64 * 1024, // 65536 (64 KiB)
	maxSummaryBytes: 8 * 1024, // 8192 (8 KiB)
	maxRequestStorageBytes: 256 * 1024, // 262144 (256 KiB)
	maxTotalRequestBytes: 256 * 1024, // 262144 (256 KiB)
	maxLiveRequests: 128,
	maxStorageBytes: 64 * 1024 * 1024, // 67108864 (64 MiB)
	maxTotalStorageBytes: 64 * 1024 * 1024, // 67108864 (64 MiB)
	maxLifetimeMs: 7 * 24 * 60 * 60 * 1000, // 604800000 (7 days)
	maxDepth: 12,
	maxDomRecords: 256,
	screenshotPaddingPx: 12,
	maxScreenshotDimension: 1024,
});

function calculateUtf8Bytes(value: string | undefined): number {
	if (!value) return 0;
	return Buffer.byteLength(value, "utf8");
}

function calculateDomSnapshotBytes(snapshot: ElementDomSnapshot | undefined): number {
	if (!snapshot) return 0;
	try {
		return calculateUtf8Bytes(JSON.stringify(snapshot));
	} catch {
		return (
			calculateUtf8Bytes(snapshot.selector) +
			calculateUtf8Bytes(snapshot.html) +
			calculateUtf8Bytes(snapshot.text) +
			calculateUtf8Bytes(snapshot.summary)
		);
	}
}

function calculateScreenshotBytes(screenshot: ElementScreenshot | undefined): number {
	if (!screenshot) return 0;
	if (typeof screenshot.byteLength === "number" && screenshot.byteLength > 0) {
		return screenshot.byteLength;
	}
	if (screenshot.base64) {
		return Math.ceil((screenshot.base64.length * 3) / 4);
	}
	if (screenshot.dataUrl) {
		const commaIndex = screenshot.dataUrl.indexOf(",");
		const base64Data = commaIndex >= 0 ? screenshot.dataUrl.slice(commaIndex + 1) : screenshot.dataUrl;
		return Math.ceil((base64Data.length * 3) / 4);
	}
	return 0;
}

function calculatePreviewPatchBytes(patch: DeclarativePreviewPatch | undefined): number {
	if (!patch) return 0;
	try {
		return calculateUtf8Bytes(JSON.stringify(patch));
	} catch {
		return 0;
	}
}

function calculateSelectionBytes(selection: {
	selector?: string;
	domSnapshot?: ElementDomSnapshot;
	screenshot?: ElementScreenshot;
	previewPatch?: DeclarativePreviewPatch;
	url?: string;
}): number {
	let total = 64; // base object metadata overhead
	if (selection.selector) total += calculateUtf8Bytes(selection.selector);
	if (selection.url) total += calculateUtf8Bytes(selection.url);
	if (selection.domSnapshot) total += calculateDomSnapshotBytes(selection.domSnapshot);
	if (selection.screenshot) total += calculateScreenshotBytes(selection.screenshot);
	if (selection.previewPatch) total += calculatePreviewPatchBytes(selection.previewPatch);
	return total;
}

function inspectDomDepthAndRecords(
	nodes: ElementDomNode[] | undefined,
	currentDepth = 1,
): { maxDepth: number; totalRecords: number } {
	if (!nodes || nodes.length === 0) return { maxDepth: currentDepth - 1, totalRecords: 0 };
	let totalRecords = nodes.length;
	let maxDepth = currentDepth;

	for (const node of nodes) {
		if (node.children && node.children.length > 0) {
			const childStats = inspectDomDepthAndRecords(node.children, currentDepth + 1);
			totalRecords += childStats.totalRecords;
			if (childStats.maxDepth > maxDepth) {
				maxDepth = childStats.maxDepth;
			}
		}
	}

	return { maxDepth, totalRecords };
}

function validateDomDepthAndRecords(snapshot: ElementDomSnapshot, maxDepth: number, maxRecords: number): void {
	if (snapshot.nodes && snapshot.nodes.length > 0) {
		const stats = inspectDomDepthAndRecords(snapshot.nodes, 1);
		if (stats.maxDepth > maxDepth) {
			throw rejection(
				"invariant_violation",
				`DOM tree depth ${stats.maxDepth} exceeds maximum allowed depth of ${maxDepth}`,
			);
		}
		if (stats.totalRecords > maxRecords) {
			throw rejection(
				"invariant_violation",
				`DOM records count ${stats.totalRecords} exceeds maximum allowed records of ${maxRecords}`,
			);
		}
	} else if (snapshot.hierarchy && snapshot.hierarchy.length > maxDepth) {
		throw rejection(
			"invariant_violation",
			`DOM hierarchy depth ${snapshot.hierarchy.length} exceeds maximum allowed depth of ${maxDepth}`,
		);
	}
}

export interface ElementSelectionCoordinatorOptions {
	limits?: ElementSelectionLimits;
	idGenerator?: (prefix: string) => string;
	now?: () => number;
	onStateChange?: (state: ElementEditState) => void;
	onSelectionCreated?: (selection: ElementSelectionV1) => void;
	onSelectionCommitted?: (selection: ElementSelectionV1) => void;
	onSelectionExpired?: (selectionId: string) => void;
}

export class ElementSelectionCoordinator {
	readonly #selections = new Map<string, ElementSelectionV1>();
	readonly #locationGenerations = new Map<string, number>();
	readonly #limits: ElementSelectionLimits;
	readonly #idGenerator: (prefix: string) => string;
	readonly #now: () => number;
	readonly #onStateChange?: (state: ElementEditState) => void;
	readonly #onSelectionCreated?: (selection: ElementSelectionV1) => void;
	readonly #onSelectionCommitted?: (selection: ElementSelectionV1) => void;
	readonly #onSelectionExpired?: (selectionId: string) => void;

	#activeSelectionId?: string;
	#activeState: ElementEditState = {
		phase: "idle",
		updatedAt: Date.now(),
	};
	#totalStorageBytes = 0;

	constructor(options: ElementSelectionCoordinatorOptions = {}) {
		this.#limits = options.limits ?? SELECTION_LIMITS;
		this.#idGenerator = options.idGenerator ?? ((p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`);
		this.#now = options.now ?? (() => Date.now());
		this.#onStateChange = options.onStateChange;
		this.#onSelectionCreated = options.onSelectionCreated;
		this.#onSelectionCommitted = options.onSelectionCommitted;
		this.#onSelectionExpired = options.onSelectionExpired;
		this.#activeState.updatedAt = this.#now();
	}

	get activeSelectionId(): string | undefined {
		return this.#activeSelectionId;
	}

	get totalStorageBytes(): number {
		return this.#totalStorageBytes;
	}

	get liveSelectionCount(): number {
		return this.#selections.size;
	}

	get limits(): ElementSelectionLimits {
		return this.#limits;
	}

	#authorize(scope: SelectionAuthScope, selection: ElementSelectionV1): void {
		if (
			!scope ||
			typeof scope.principalId !== "string" ||
			scope.principalId.trim().length === 0 ||
			typeof scope.workspaceId !== "string" ||
			scope.workspaceId.trim().length === 0 ||
			typeof scope.tabId !== "string" ||
			scope.tabId.trim().length === 0 ||
			typeof scope.paneId !== "string" ||
			scope.paneId.trim().length === 0 ||
			typeof scope.locationId !== "string" ||
			scope.locationId.trim().length === 0 ||
			typeof scope.agentId !== "string" ||
			scope.agentId.trim().length === 0 ||
			typeof scope.sessionId !== "string" ||
			scope.sessionId.trim().length === 0 ||
			typeof scope.documentEpoch !== "number" ||
			typeof scope.locationGeneration !== "number"
		) {
			throw rejection("not_found", "Selection not found");
		}

		if (selection.principalId !== scope.principalId) {
			throw rejection("not_found", "Selection not found");
		}
		if (selection.workspaceId !== scope.workspaceId) {
			throw rejection("not_found", "Selection not found");
		}
		if (selection.tabId !== scope.tabId) {
			throw rejection("not_found", "Selection not found");
		}
		if (selection.paneId !== scope.paneId) {
			throw rejection("not_found", "Selection not found");
		}
		if (selection.locationId !== scope.locationId) {
			throw rejection("not_found", "Selection not found");
		}
		if (selection.agentId !== scope.agentId) {
			throw rejection("not_found", "Selection not found");
		}
		if (selection.sessionId !== scope.sessionId) {
			throw rejection("not_found", "Selection not found");
		}
		if (selection.documentEpoch !== scope.documentEpoch) {
			throw rejection("not_found", "Selection not found");
		}
		if (selection.locationGeneration !== scope.locationGeneration) {
			throw rejection("not_found", "Selection not found");
		}
		if (scope.frameId && selection.frameId && scope.frameId !== selection.frameId) {
			throw rejection("not_found", "Selection not found");
		}
		if (scope.backendNodeId && selection.backendNodeId && scope.backendNodeId !== selection.backendNodeId) {
			throw rejection("not_found", "Selection not found");
		}
	}
	#buildStateFromSelection(selection: ElementSelectionV1, phase?: ElementEditPhase): ElementEditState {
		return {
			phase: phase ?? this.#activeState.phase,
			selectionId: selection.id,
			workspaceId: selection.workspaceId,
			paneId: selection.paneId,
			locationId: selection.locationId,
			locationGeneration: selection.locationGeneration,
			browserSessionId: selection.browserSessionId,
			agentId: selection.agentId,
			captureMode: selection.captureMode,
			url: selection.url,
			selector: selection.selector,
			selectedElement: selection.domSnapshot,
			domSnapshot: selection.domSnapshot,
			screenshot: selection.screenshot,
			previewPatch: selection.previewPatch,
			preview: selection.previewPatch,
			updatedAt: selection.updatedAt,
		};
	}

	getState(scope: SelectionAuthScope, selectionId?: string): ElementEditState {
		const targetId = selectionId ?? this.#activeSelectionId;
		if (!targetId) {
			return {
				phase: "idle",
				updatedAt: this.#now(),
			};
		}
		const selection = this.#selections.get(targetId);
		if (!selection) {
			return {
				phase: "idle",
				updatedAt: this.#now(),
			};
		}
		this.#authorize(scope, selection);
		return this.#buildStateFromSelection(selection, this.#activeState?.phase ?? "selected");
	}

	getSelection(scope: SelectionAuthScope, selectionId: string): ElementEditState {
		const selection = this.#selections.get(selectionId);
		if (!selection) {
			throw rejection("not_found", "Selection not found");
		}
		this.#authorize(scope, selection);
		return this.#buildStateFromSelection(selection, "selected");
	}

	listSelections(scope: SelectionAuthScope): readonly ElementEditState[] {
		this.pruneExpiredSelections();
		const results: ElementEditState[] = [];
		for (const item of this.#selections.values()) {
			try {
				this.#authorize(scope, item);
				results.push(this.#buildStateFromSelection(item, "selected"));
			} catch {
				// Fail closed: omit unauthorized selections from list
			}
		}
		return results;
	}

	updateLocationGeneration(locationId: string, generation: number): void {
		this.#locationGenerations.set(locationId, generation);
	}

	getLocationGeneration(locationId: string): number | undefined {
		return this.#locationGenerations.get(locationId);
	}

	syncWithDocument(document: WorkspaceDocumentV1): void {
		for (const loc of document.locations) {
			this.#locationGenerations.set(loc.id, loc.lifecycle.generation);
		}
	}

	assertLocationGeneration(locationId: string | undefined, expectedGeneration: number | undefined): void {
		if (!locationId || expectedGeneration === undefined) {
			throw rejection("not_found", "Location generation is required and cannot be empty");
		}
		const trackedGeneration = this.#locationGenerations.get(locationId);
		if (trackedGeneration === undefined || trackedGeneration !== expectedGeneration) {
			throw rejection(
				"generation_mismatch",
				`Location ${locationId} generation mismatch (expected ${expectedGeneration}, active ${trackedGeneration})`,
			);
		}
	}

	checkAuthorization(context: SelectionAuthContext): boolean {
		return (
			typeof context.agentWorkspaceId === "string" &&
			context.agentWorkspaceId.length > 0 &&
			context.agentWorkspaceId === context.selectionWorkspaceId &&
			context.selectionWorkspaceId === context.paneWorkspaceId
		);
	}

	assertAuthorization(context: SelectionAuthContext): void {
		if (!this.checkAuthorization(context)) {
			throw rejection("not_found", "Selection not found");
		}
	}

	isAgentDeliverable(agent: { id: string; workspaceId: string; status?: string }, paneWorkspaceId: string): boolean {
		if (!agent.id || !agent.workspaceId || !paneWorkspaceId) return false;
		if (agent.workspaceId !== paneWorkspaceId) return false;
		if (agent.status === "stopped" || agent.status === "failed") return false;
		return true;
	}

	startSelection(scope: SelectionAuthScope, options: StartSelectionOptions = {}): ElementEditState {
		if (
			!scope?.principalId ||
			!scope.workspaceId ||
			!scope.tabId ||
			!scope.paneId ||
			!scope.locationId ||
			!scope.agentId ||
			!scope.sessionId ||
			typeof scope.documentEpoch !== "number" ||
			typeof scope.locationGeneration !== "number"
		) {
			throw rejection("invalid_command", "Valid SelectionAuthScope is required to start element selection");
		}

		this.pruneExpiredSelections();

		if (this.#selections.size >= this.#limits.maxLiveRequests) {
			throw rejection(
				"invariant_violation",
				`Maximum live selection requests (${this.#limits.maxLiveRequests}) exceeded`,
			);
		}

		this.assertLocationGeneration(scope.locationId, scope.locationGeneration);

		const now = this.#now();
		const selectionId = options.selectionId ?? this.#idGenerator("sel");

		if (this.#selections.has(selectionId)) {
			throw rejection("conflict", `Selection with id ${selectionId} already exists`);
		}

		const baseBytes = calculateSelectionBytes({ url: options.url });
		if (this.#totalStorageBytes + baseBytes > this.#limits.maxStorageBytes) {
			throw rejection(
				"invariant_violation",
				`Workspace selection storage cap of ${this.#limits.maxStorageBytes} bytes exceeded`,
			);
		}

		const selection: ElementSelectionV1 = {
			id: selectionId,
			principalId: scope.principalId,
			workspaceId: scope.workspaceId,
			tabId: scope.tabId,
			paneId: scope.paneId,
			documentEpoch: scope.documentEpoch,
			locationGeneration: scope.locationGeneration,
			locationId: scope.locationId,
			agentId: scope.agentId,
			sessionId: scope.sessionId,
			frameId: scope.frameId,
			backendNodeId: scope.backendNodeId,
			captureMode: options.captureMode ?? "dom",
			url: options.url,
			createdAt: now,
			updatedAt: now,
			expiresAt: now + this.#limits.maxLifetimeMs,
			byteSize: baseBytes,
		};
		this.#selections.set(selectionId, selection);
		this.#totalStorageBytes += baseBytes;
		this.#activeSelectionId = selectionId;

		this.#activeState = {
			phase: "picking",
			selectionId,
			workspaceId: scope.workspaceId,
			paneId: scope.paneId,
			locationId: scope.locationId,
			locationGeneration: scope.locationGeneration,
			agentId: scope.agentId,
			captureMode: options.captureMode ?? "dom",
			url: options.url,
			updatedAt: now,
		};
		this.#notifyCreated(selection);
		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	updateSelection(scope: SelectionAuthScope, selectionId: string, update: UpdateSelectionOptions): ElementEditState {
		const selection = this.#selections.get(selectionId);
		if (!selection) {
			throw rejection("not_found", "Selection not found");
		}
		this.#authorize(scope, selection);

		if (selection.locationId) {
			this.assertLocationGeneration(selection.locationId, selection.locationGeneration);
		}

		if (update.frameId !== undefined) {
			if (selection.frameId !== undefined && selection.frameId !== update.frameId) {
				throw rejection(
					"invariant_violation",
					`Cannot rebind selection frameId from ${selection.frameId} to ${update.frameId}`,
				);
			}
			selection.frameId = update.frameId;
		}

		if (update.backendNodeId !== undefined) {
			if (selection.backendNodeId !== undefined && selection.backendNodeId !== update.backendNodeId) {
				throw rejection(
					"invariant_violation",
					`Cannot rebind selection backendNodeId from ${selection.backendNodeId} to ${update.backendNodeId}`,
				);
			}
			selection.backendNodeId = update.backendNodeId;
		}

		if (update.screenshot) {
			const imageBytes = calculateScreenshotBytes(update.screenshot);
			if (imageBytes > this.#limits.maxImageBytes) {
				throw rejection(
					"invariant_violation",
					`Screenshot image size (${imageBytes} bytes) exceeds limit of ${this.#limits.maxImageBytes} bytes`,
				);
			}
		}

		if (update.domSnapshot) {
			const domBytes = calculateDomSnapshotBytes(update.domSnapshot);
			if (domBytes > this.#limits.maxDomBytes) {
				throw rejection(
					"invariant_violation",
					`DOM snapshot size (${domBytes} bytes) exceeds limit of ${this.#limits.maxDomBytes} bytes`,
				);
			}

			if (update.domSnapshot.summary) {
				const summaryBytes = calculateUtf8Bytes(update.domSnapshot.summary);
				if (summaryBytes > this.#limits.maxSummaryBytes) {
					throw rejection(
						"invariant_violation",
						`DOM summary size (${summaryBytes} bytes) exceeds limit of ${this.#limits.maxSummaryBytes} bytes`,
					);
				}
			}

			validateDomDepthAndRecords(update.domSnapshot, this.#limits.maxDepth, this.#limits.maxDomRecords);
		}

		if (update.previewPatch) {
			const previewBytes = calculatePreviewPatchBytes(update.previewPatch);
			if (previewBytes > this.#limits.maxPreviewBytes) {
				throw rejection(
					"invariant_violation",
					`Preview patch size (${previewBytes} bytes) exceeds limit of ${this.#limits.maxPreviewBytes} bytes`,
				);
			}
		}

		const mergedSelector = update.selector ?? selection.selector;
		const mergedDomSnapshot = update.domSnapshot ?? selection.domSnapshot;
		const mergedScreenshot = update.screenshot ?? selection.screenshot;
		const mergedPreviewPatch = update.previewPatch ?? selection.previewPatch;
		const mergedUrl = update.url ?? selection.url;
		const mergedCaptureMode = update.captureMode ?? selection.captureMode;

		const updatedBytes = calculateSelectionBytes({
			selector: mergedSelector,
			domSnapshot: mergedDomSnapshot,
			screenshot: mergedScreenshot,
			previewPatch: mergedPreviewPatch,
			url: mergedUrl,
		});

		if (updatedBytes > this.#limits.maxRequestStorageBytes) {
			throw rejection(
				"invariant_violation",
				`Selection request size (${updatedBytes} bytes) exceeds per-request cap of ${this.#limits.maxRequestStorageBytes} bytes`,
			);
		}

		const deltaBytes = updatedBytes - selection.byteSize;
		if (this.#totalStorageBytes + deltaBytes > this.#limits.maxStorageBytes) {
			throw rejection(
				"invariant_violation",
				`Workspace selection runtime storage cap of ${this.#limits.maxStorageBytes} bytes exceeded`,
			);
		}

		const now = this.#now();
		selection.selector = mergedSelector;
		selection.domSnapshot = mergedDomSnapshot;
		selection.screenshot = mergedScreenshot;
		selection.previewPatch = mergedPreviewPatch;
		selection.url = mergedUrl;
		selection.captureMode = mergedCaptureMode;
		selection.updatedAt = now;
		selection.byteSize = updatedBytes;
		this.#totalStorageBytes += deltaBytes;

		const nextPhase: ElementEditPhase =
			mergedSelector || mergedDomSnapshot || mergedScreenshot
				? "selected"
				: this.#activeState.phase === "idle"
					? "picking"
					: this.#activeState.phase;

		this.#activeSelectionId = selectionId;
		this.#activeState = {
			phase: nextPhase,
			selectionId,
			workspaceId: selection.workspaceId,
			paneId: selection.paneId,
			locationId: selection.locationId,
			locationGeneration: selection.locationGeneration,
			browserSessionId: selection.browserSessionId,
			agentId: selection.agentId,
			captureMode: selection.captureMode,
			url: selection.url,
			selector: selection.selector,
			selectedElement: selection.domSnapshot,
			domSnapshot: selection.domSnapshot,
			screenshot: selection.screenshot,
			previewPatch: selection.previewPatch,
			preview: selection.previewPatch,
			updatedAt: now,
		};

		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	commitSelection(scope: SelectionAuthScope, selectionId: string, payload?: CommitSelectionPayload): ElementEditState {
		const selection = this.#selections.get(selectionId);
		if (!selection) {
			throw rejection("not_found", "Selection not found");
		}
		this.#authorize(scope, selection);

		if (selection.locationId) {
			this.assertLocationGeneration(selection.locationId, selection.locationGeneration);
		}

		if (payload) {
			if (payload.frameId !== undefined) {
				if (selection.frameId !== undefined && selection.frameId !== payload.frameId) {
					throw rejection("invariant_violation", "Cannot rebind selection frameId on commit");
				}
				selection.frameId = payload.frameId;
			}
			if (payload.backendNodeId !== undefined) {
				if (selection.backendNodeId !== undefined && selection.backendNodeId !== payload.backendNodeId) {
					throw rejection("invariant_violation", "Cannot rebind selection backendNodeId on commit");
				}
				selection.backendNodeId = payload.backendNodeId;
			}
			this.updateSelection(scope, selectionId, {
				frameId: selection.frameId,
				backendNodeId: selection.backendNodeId,
				selector: payload.selector ?? payload.target,
				domSnapshot: payload.domSnapshot,
				screenshot: payload.screenshot,
			});
		}

		const now = this.#now();
		selection.updatedAt = now;

		this.#activeSelectionId = selectionId;
		this.#activeState = {
			...this.#activeState,
			phase: "selected",
			selectionId,
			agentId: selection.agentId,
			updatedAt: now,
		};
		this.#notifyCommitted(selection);
		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	sendToAgent(
		scope: SelectionAuthScope,
		selectionId: string,
		agent: { id: string; workspaceId: string; status?: string },
		instruction?: string,
	): ElementEditState {
		const selection = this.#selections.get(selectionId);
		if (!selection) {
			throw rejection("not_found", "Selection not found");
		}
		this.#authorize(scope, selection);

		if (selection.locationId) {
			this.assertLocationGeneration(selection.locationId, selection.locationGeneration);
		}

		this.assertAuthorization({
			agentWorkspaceId: agent.workspaceId,
			selectionWorkspaceId: selection.workspaceId,
			paneWorkspaceId: selection.paneId ? selection.workspaceId : scope.workspaceId,
		});
		if (agent.id !== selection.agentId) {
			throw rejection(
				"invariant_violation",
				`Selection is already bound to recipient agent ${selection.agentId}; cannot reassign to ${agent.id}`,
			);
		}

		if (agent.status === "stopped" || agent.status === "failed") {
			throw rejection(
				"lifecycle_blocked",
				`Agent ${agent.id} is in status ${agent.status} and cannot accept element edits`,
			);
		}

		const now = this.#now();
		selection.updatedAt = now;
		this.#activeState = {
			phase: "working",
			selectionId,
			workspaceId: selection.workspaceId,
			paneId: selection.paneId,
			locationId: selection.locationId,
			locationGeneration: selection.locationGeneration,
			browserSessionId: selection.browserSessionId,
			agentId: agent.id,
			captureMode: selection.captureMode,
			url: selection.url,
			selector: selection.selector,
			selectedElement: selection.domSnapshot,
			domSnapshot: selection.domSnapshot,
			screenshot: selection.screenshot,
			previewPatch: selection.previewPatch,
			preview: selection.previewPatch,
			workingMessage: instruction ?? "Agent is processing element edit...",
			updatedAt: now,
		};

		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	reportWorking(scope: SelectionAuthScope, selectionId: string, message?: string): ElementEditState {
		const selection = this.#selections.get(selectionId);
		if (!selection) {
			throw rejection("not_found", "Selection not found");
		}
		this.#authorize(scope, selection);

		const now = this.#now();
		this.#activeSelectionId = selectionId;
		this.#activeState = {
			...this.#activeState,
			phase: "working",
			selectionId,
			workingMessage: message ?? "Agent is processing element edit...",
			updatedAt: now,
		};

		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	reportReady(scope: SelectionAuthScope, selectionId: string, result: ElementEditResultV1): ElementEditState {
		const selection = this.#selections.get(selectionId);
		if (!selection) {
			throw rejection("not_found", "Selection not found");
		}
		this.#authorize(scope, selection);

		if (selection.locationId) {
			this.assertLocationGeneration(selection.locationId, selection.locationGeneration);
		}

		if (result.selectionId !== selection.id || result.workspaceId !== selection.workspaceId) {
			throw rejection("invariant_violation", "Result selectionId or workspaceId does not match selection");
		}

		if (result.previewPatch) {
			const previewBytes = calculatePreviewPatchBytes(result.previewPatch);
			if (previewBytes > this.#limits.maxPreviewBytes) {
				throw rejection(
					"invariant_violation",
					`Result preview patch size (${previewBytes} bytes) exceeds limit of ${this.#limits.maxPreviewBytes} bytes`,
				);
			}
		}

		const now = this.#now();
		this.#activeSelectionId = selectionId;
		this.#activeState = {
			phase: "ready",
			selectionId,
			workspaceId: selection.workspaceId,
			paneId: selection.paneId,
			locationId: selection.locationId,
			locationGeneration: selection.locationGeneration,
			browserSessionId: selection.browserSessionId,
			agentId: result.agentId ?? selection.agentId,
			captureMode: selection.captureMode,
			url: selection.url,
			selector: selection.selector,
			selectedElement: selection.domSnapshot,
			domSnapshot: selection.domSnapshot,
			screenshot: selection.screenshot,
			previewPatch: result.previewPatch ?? selection.previewPatch,
			preview: result.previewPatch ?? selection.previewPatch,
			result,
			updatedAt: now,
		};

		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	reportError(scope: SelectionAuthScope, selectionId: string, code: string, message: string): ElementEditState {
		const selection = this.#selections.get(selectionId);
		if (!selection) {
			throw rejection("not_found", "Selection not found");
		}
		this.#authorize(scope, selection);

		const now = this.#now();
		this.#activeSelectionId = selectionId;
		this.#activeState = {
			phase: "error",
			selectionId,
			workspaceId: selection.workspaceId,
			paneId: selection.paneId,
			locationId: selection.locationId,
			locationGeneration: selection.locationGeneration,
			browserSessionId: selection.browserSessionId,
			agentId: selection.agentId,
			captureMode: selection.captureMode,
			url: selection.url,
			selector: selection.selector,
			domSnapshot: selection.domSnapshot,
			selectedElement: selection.domSnapshot,
			screenshot: selection.screenshot,
			error: {
				code,
				message,
			},
			updatedAt: now,
		};

		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	applyPreview(scope: SelectionAuthScope, selectionId: string, patch: DeclarativePreviewPatch): ElementEditState {
		const selection = this.#selections.get(selectionId);
		if (!selection) {
			throw rejection("not_found", "Selection not found");
		}
		this.#authorize(scope, selection);

		if (selection.locationId) {
			this.assertLocationGeneration(selection.locationId, selection.locationGeneration);
		}

		let validatedPatch: DeclarativePreviewPatch;
		try {
			validatedPatch = validateDeclarativePreviewPatch(patch);
		} catch (err) {
			throw rejection("invariant_violation", err instanceof Error ? err.message : String(err));
		}

		const patchBytes = calculatePreviewPatchBytes(validatedPatch);
		if (patchBytes > this.#limits.maxPreviewBytes) {
			throw rejection(
				"invariant_violation",
				`Preview patch size (${patchBytes} bytes) exceeds limit of ${this.#limits.maxPreviewBytes} bytes`,
			);
		}

		selection.previewPatch = validatedPatch;
		const now = this.#now();
		selection.updatedAt = now;

		this.#activeSelectionId = selectionId;
		this.#activeState = {
			...this.#activeState,
			phase: "preview",
			selectionId,
			previewPatch: validatedPatch,
			preview: validatedPatch,
			updatedAt: now,
		};

		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	removePreview(scope: SelectionAuthScope, selectionId: string): ElementEditState {
		const selection = this.#selections.get(selectionId);
		if (!selection) {
			throw rejection("not_found", "Selection not found");
		}
		this.#authorize(scope, selection);

		if (selection.locationId) {
			this.assertLocationGeneration(selection.locationId, selection.locationGeneration);
		}

		selection.previewPatch = undefined;
		const now = this.#now();
		selection.updatedAt = now;

		const revertedPhase: ElementEditPhase = this.#activeState.result ? "ready" : "selected";

		this.#activeSelectionId = selectionId;
		this.#activeState = {
			...this.#activeState,
			phase: revertedPhase,
			selectionId,
			previewPatch: undefined,
			preview: undefined,
			updatedAt: now,
		};

		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	cancelSelection(scope: SelectionAuthScope, selectionId?: string, reason?: string): ElementEditState {
		const targetId = selectionId ?? this.#activeSelectionId;
		if (!targetId) {
			this.#activeSelectionId = undefined;
			this.#activeState = {
				phase: "idle",
				updatedAt: this.#now(),
			};
			this.#notifyStateChange();
			return { ...this.#activeState };
		}

		const selection = this.#selections.get(targetId);
		if (selection) {
			this.#authorize(scope, selection);
		}

		const now = this.#now();
		this.#activeSelectionId = undefined;
		this.#activeState = {
			phase: "idle",
			selectionId: targetId,
			workspaceId: selection?.workspaceId ?? scope.workspaceId,
			paneId: selection?.paneId ?? scope.paneId,
			locationId: selection?.locationId ?? scope.locationId,
			locationGeneration: selection?.locationGeneration ?? scope.locationGeneration,
			agentId: selection?.agentId ?? scope.agentId,
			workingMessage: reason ? `Selection cancelled: ${reason}` : "Selection cancelled",
			updatedAt: now,
		};

		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	reset(): ElementEditState {
		this.#activeSelectionId = undefined;
		this.#activeState = {
			phase: "idle",
			updatedAt: this.#now(),
		};
		this.#notifyStateChange();
		return { ...this.#activeState };
	}

	pruneExpiredSelections(): number {
		const now = this.#now();
		let prunedCount = 0;
		for (const [id, sel] of this.#selections.entries()) {
			if (now >= sel.expiresAt) {
				this.#selections.delete(id);
				this.#totalStorageBytes -= sel.byteSize;
				prunedCount++;
				this.#onSelectionExpired?.(id);
				if (this.#activeSelectionId === id) {
					this.#activeSelectionId = undefined;
					this.#activeState = {
						phase: "idle",
						updatedAt: now,
					};
					this.#notifyStateChange();
				}
			}
		}
		if (this.#totalStorageBytes < 0) {
			this.#totalStorageBytes = 0;
		}
		return prunedCount;
	}

	#notifyCreated(selection: ElementSelectionV1): void {
		try {
			this.#onSelectionCreated?.(selection);
		} catch {}
	}

	#notifyCommitted(selection: ElementSelectionV1): void {
		try {
			this.#onSelectionCommitted?.(selection);
		} catch {}
	}

	#notifyStateChange(): void {
		try {
			this.#onStateChange?.({ ...this.#activeState });
		} catch {}
	}
}
