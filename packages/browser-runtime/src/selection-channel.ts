import type { CDPSession, Page } from "playwright-core";
import {
	type BrowserSelectionChannelOptions,
	type CommitSelectionOptions,
	type DeclarativePatchOperation,
	type DeclarativePreviewPatch,
	type DeclarativePreviewResult,
	DeclarativePreviewValidationError,
	type ElementSelectionBounds,
	type ElementSelectionResult,
	type ElementSelectionScreenshot,
	type ElementStructuralDescription,
	type ElementStructuralNode,
	SELECTION_LIMITS,
	type SelectionHoverEvent,
	type SelectionState,
	type StartSelectionOptions,
	type UpdateSelectionOptions,
} from "./types";

const FORBIDDEN_CSS_PATTERNS = [
	/@import/i,
	/expression\s*\(/i,
	/url\s*\(\s*['"]?\s*javascript:/i,
	/url\s*\(/i,
	/-moz-binding/i,
	/behavior\s*:/i,
];

const VALID_SELECTOR_PATTERN = /^[\s\S]{1,1024}$/;
const VALID_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
const VALID_ATTR_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/;
const VALID_CSS_PROP_PATTERN = /^[a-zA-Z-][a-zA-Z0-9-]*$/;

const ALLOWED_ATTRIBUTES = new Set([
	"id",
	"class",
	"role",
	"title",
	"href",
	"src",
	"alt",
	"type",
	"name",
	"placeholder",
	"disabled",
	"readonly",
	"tabindex",
	"target",
	"rel",
	"aria-label",
	"aria-describedby",
	"aria-expanded",
	"aria-hidden",
	"aria-selected",
	"aria-checked",
	"aria-disabled",
	"aria-required",
	"aria-invalid",
	"aria-controls",
	"aria-owns",
	"aria-current",
	"aria-haspopup",
]);

function computeJsonByteSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function sanitizeTextSummary(text: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	if (encoder.encode(text).byteLength <= maxBytes) {
		return text;
	}
	let low = 0;
	let high = text.length;
	let result = "";
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const slice = text.slice(0, mid);
		if (encoder.encode(slice).byteLength <= maxBytes - 3) {
			result = slice;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return `${result}...`;
}

export function validateDeclarativePreviewPatch(value: unknown): DeclarativePreviewPatch {
	if (typeof value !== "object" || value === null) {
		throw new DeclarativePreviewValidationError("expected non-null object", "$");
	}

	const byteSize = computeJsonByteSize(value);
	if (byteSize > SELECTION_LIMITS.maxPreviewBytes) {
		throw new DeclarativePreviewValidationError(
			`preview patch payload exceeds ${SELECTION_LIMITS.maxPreviewBytes} bytes (got ${byteSize} bytes)`,
			"$",
		);
	}

	const candidate = value as Record<string, unknown>;

	if (typeof candidate.patchId !== "string" || candidate.patchId.trim().length === 0) {
		throw new DeclarativePreviewValidationError("missing or empty patchId", "$.patchId");
	}
	if (candidate.patchId.length > 128) {
		throw new DeclarativePreviewValidationError("patchId exceeds maximum length of 128 characters", "$.patchId");
	}

	if (candidate.targetSelector !== undefined) {
		if (typeof candidate.targetSelector !== "string" || candidate.targetSelector.trim().length === 0) {
			throw new DeclarativePreviewValidationError(
				"targetSelector must be a non-empty string when provided",
				"$.targetSelector",
			);
		}
		if (!VALID_SELECTOR_PATTERN.test(candidate.targetSelector)) {
			throw new DeclarativePreviewValidationError("invalid targetSelector format", "$.targetSelector");
		}
	}

	if (candidate.description !== undefined) {
		if (typeof candidate.description !== "string") {
			throw new DeclarativePreviewValidationError("description must be a string", "$.description");
		}
		if (candidate.description.length > 2048) {
			throw new DeclarativePreviewValidationError("description exceeds 2048 characters", "$.description");
		}
	}

	if (candidate.css !== undefined) {
		if (typeof candidate.css !== "string") {
			throw new DeclarativePreviewValidationError("css must be a string", "$.css");
		}
		if (candidate.css.length > 32768) {
			throw new DeclarativePreviewValidationError("css exceeds 32768 characters", "$.css");
		}
		for (const pattern of FORBIDDEN_CSS_PATTERNS) {
			if (pattern.test(candidate.css)) {
				throw new DeclarativePreviewValidationError(`forbidden pattern in CSS: ${pattern.source}`, "$.css");
			}
		}
	}

	if (!Array.isArray(candidate.operations) || candidate.operations.length === 0) {
		throw new DeclarativePreviewValidationError("operations must be a non-empty array", "$.operations");
	}
	if (candidate.operations.length > 256) {
		throw new DeclarativePreviewValidationError("operations array exceeds maximum of 256 items", "$.operations");
	}

	const validatedOps: DeclarativePatchOperation[] = [];

	for (let i = 0; i < candidate.operations.length; i++) {
		const op = candidate.operations[i];
		const path = `$.operations[${i}]`;

		if (typeof op !== "object" || op === null) {
			throw new DeclarativePreviewValidationError("operation must be a non-null object", path);
		}

		const rawOp = op as Record<string, unknown>;

		if (typeof rawOp.selector !== "string" || rawOp.selector.trim().length === 0) {
			throw new DeclarativePreviewValidationError("missing or empty selector", `${path}.selector`);
		}
		if (!VALID_SELECTOR_PATTERN.test(rawOp.selector)) {
			throw new DeclarativePreviewValidationError("invalid selector syntax", `${path}.selector`);
		}

		const selector = rawOp.selector.trim();
		const type = rawOp.type;

		switch (type) {
			case "replace_text": {
				if (typeof rawOp.text !== "string") {
					throw new DeclarativePreviewValidationError(
						"replace_text requires string property 'text'",
						`${path}.text`,
					);
				}
				validatedOps.push({
					type: "replace_text",
					selector,
					text: rawOp.text,
				});
				break;
			}
			case "set_attribute": {
				if (typeof rawOp.name !== "string" || !VALID_ATTR_NAME_PATTERN.test(rawOp.name)) {
					throw new DeclarativePreviewValidationError(
						"set_attribute requires valid attribute name",
						`${path}.name`,
					);
				}
				if (rawOp.name.toLowerCase().startsWith("on")) {
					throw new DeclarativePreviewValidationError(
						"set_attribute cannot set event handlers ('on*' attributes)",
						`${path}.name`,
					);
				}
				if (typeof rawOp.value !== "string") {
					throw new DeclarativePreviewValidationError(
						"set_attribute requires string property 'value'",
						`${path}.value`,
					);
				}
				const lowerName = rawOp.name.toLowerCase();
				if (["href", "src", "action", "formaction", "data", "srcdoc"].includes(lowerName)) {
					if (/^\s*(javascript|vbscript|data\s*:\s*text\/html):/i.test(rawOp.value)) {
						throw new DeclarativePreviewValidationError(`forbidden URL scheme in ${lowerName}`, `${path}.value`);
					}
				}
				validatedOps.push({
					type: "set_attribute",
					selector,
					name: rawOp.name,
					value: rawOp.value,
				});
				break;
			}
			case "remove_attribute": {
				if (typeof rawOp.name !== "string" || !VALID_ATTR_NAME_PATTERN.test(rawOp.name)) {
					throw new DeclarativePreviewValidationError(
						"remove_attribute requires valid attribute name",
						`${path}.name`,
					);
				}
				validatedOps.push({
					type: "remove_attribute",
					selector,
					name: rawOp.name,
				});
				break;
			}
			case "set_style": {
				if (typeof rawOp.property !== "string" || !VALID_CSS_PROP_PATTERN.test(rawOp.property)) {
					throw new DeclarativePreviewValidationError(
						"set_style requires valid CSS property name",
						`${path}.property`,
					);
				}
				if (typeof rawOp.value !== "string") {
					throw new DeclarativePreviewValidationError(
						"set_style requires string property 'value'",
						`${path}.value`,
					);
				}
				for (const pattern of FORBIDDEN_CSS_PATTERNS) {
					if (pattern.test(rawOp.value)) {
						throw new DeclarativePreviewValidationError(
							`forbidden pattern in style value: ${pattern.source}`,
							`${path}.value`,
						);
					}
				}
				validatedOps.push({
					type: "set_style",
					selector,
					property: rawOp.property,
					value: rawOp.value,
				});
				break;
			}
			case "remove_style": {
				if (typeof rawOp.property !== "string" || !VALID_CSS_PROP_PATTERN.test(rawOp.property)) {
					throw new DeclarativePreviewValidationError(
						"remove_style requires valid CSS property name",
						`${path}.property`,
					);
				}
				validatedOps.push({
					type: "remove_style",
					selector,
					property: rawOp.property,
				});
				break;
			}
			case "add_class": {
				if (typeof rawOp.className !== "string" || !VALID_IDENTIFIER_PATTERN.test(rawOp.className)) {
					throw new DeclarativePreviewValidationError(
						"add_class requires valid single className identifier",
						`${path}.className`,
					);
				}
				validatedOps.push({
					type: "add_class",
					selector,
					className: rawOp.className,
				});
				break;
			}
			case "remove_class": {
				if (typeof rawOp.className !== "string" || !VALID_IDENTIFIER_PATTERN.test(rawOp.className)) {
					throw new DeclarativePreviewValidationError(
						"remove_class requires valid single className identifier",
						`${path}.className`,
					);
				}
				validatedOps.push({
					type: "remove_class",
					selector,
					className: rawOp.className,
				});
				break;
			}
			default:
				throw new DeclarativePreviewValidationError(
					`unknown or unsupported operation type '${String(type)}'`,
					`${path}.type`,
				);
		}
	}

	return {
		patchId: candidate.patchId,
		targetSelector: candidate.targetSelector as string | undefined,
		operations: validatedOps,
		css: candidate.css as string | undefined,
		description: candidate.description as string | undefined,
	};
}

interface CDPNode {
	nodeId: number;
	backendNodeId: number;
	nodeType: number;
	nodeName: string;
	localName: string;
	nodeValue?: string;
	attributes?: string[];
	children?: CDPNode[];
}

export class BrowserSelectionChannel {
	readonly #page: Page;
	#cdpSession?: CDPSession;
	readonly #workspaceId: string;
	readonly #paneId: string;
	readonly #options: BrowserSelectionChannelOptions;
	#state: SelectionState = "idle";
	#activeHover?: SelectionHoverEvent;
	#activeBackendNodeId?: number;
	#currentPreview?: DeclarativePreviewPatch;
	#isDisposed = false;
	#inspectListener?: (event: unknown) => void;
	#activeSelector?: string;

	constructor(options: BrowserSelectionChannelOptions) {
		this.#page = options.page;
		this.#cdpSession = options.cdpSession;
		this.#workspaceId = options.workspaceId ?? "default-workspace";
		this.#paneId = options.paneId ?? "default-pane";
		this.#options = options;
	}

	get state(): SelectionState {
		return this.#state;
	}

	get workspaceId(): string {
		return this.#workspaceId;
	}

	get paneId(): string {
		return this.#paneId;
	}

	get activeHover(): SelectionHoverEvent | undefined {
		return this.#activeHover;
	}

	get activeBackendNodeId(): number | undefined {
		return this.#activeBackendNodeId;
	}

	get activePreview(): DeclarativePreviewPatch | undefined {
		return this.#currentPreview;
	}

	get activeSelector(): string | undefined {
		return this.#activeSelector;
	}

	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	async #ensureCDPSession(): Promise<CDPSession | undefined> {
		if (this.#cdpSession) return this.#cdpSession;
		try {
			const session = await this.#page.context().newCDPSession(this.#page);
			this.#cdpSession = session;
			return session;
		} catch {
			return undefined;
		}
	}

	async startSelection(options: StartSelectionOptions = {}): Promise<void> {
		if (this.#isDisposed) {
			throw new Error("BrowserSelectionChannel is disposed");
		}

		this.#state = "picking";
		const session = await this.#ensureCDPSession();

		if (session) {
			try {
				await session.send("DOM.enable");
				await session.send("Overlay.enable");

				this.#inspectListener = async (event: unknown) => {
					const payload = event as { backendNodeId?: number };
					if (typeof payload?.backendNodeId === "number") {
						this.#activeBackendNodeId = payload.backendNodeId;
						await this.#syncHoverFromBackendNode(payload.backendNodeId);
					}
				};

				(session as unknown as { on?: (evt: string, fn: (data: unknown) => void) => void }).on?.(
					"Overlay.inspectNodeRequested",
					this.#inspectListener,
				);

				await session.send("Overlay.setInspectMode", {
					mode: "searchForNode",
					highlightConfig: {
						showInfo: options.showDimensions ?? true,
						showRulers: false,
						showExtensionLines: false,
						contentColor: { r: 249, g: 115, b: 22, a: 0.2 },
						borderColor: { r: 249, g: 115, b: 22, a: 1.0 },
					},
				});
			} catch {}
		}

		if (options.initialSelector) {
			this.#activeSelector = options.initialSelector;
			await this.updateSelection({ selector: options.initialSelector });
		}
	}

	async #syncHoverFromBackendNode(backendNodeId: number): Promise<void> {
		const session = this.#cdpSession;
		if (!session) return;

		try {
			const desc = (await session.send("DOM.describeNode", {
				backendNodeId,
				depth: 1,
				pierce: true,
			})) as { node?: CDPNode };

			const box = (await session.send("DOM.getBoxModel", {
				backendNodeId,
			})) as { model?: { border: number[]; width: number; height: number } };

			const node = desc.node;
			if (!node) return;

			let selector = node.localName || "div";
			const attrMap: Record<string, string> = {};
			if (Array.isArray(node.attributes)) {
				for (let i = 0; i < node.attributes.length; i += 2) {
					attrMap[node.attributes[i].toLowerCase()] = node.attributes[i + 1] || "";
				}
			}

			if (attrMap.id) selector = `#${attrMap.id}`;

			const border = box.model?.border || [0, 0, 0, 0, 0, 0, 0, 0];
			const x = border[0] ?? 0;
			const y = border[1] ?? 0;
			const width = box.model?.width ?? (border[2] ? border[2] - border[0] : 0);
			const height = box.model?.height ?? (border[5] ? border[5] - border[1] : 0);

			const bounds: ElementSelectionBounds = {
				x,
				y,
				width,
				height,
				top: y,
				left: x,
				bottom: y + height,
				right: x + width,
			};

			const hoverEvent: SelectionHoverEvent = {
				selector,
				tagName: (node.localName || node.nodeName || "div").toLowerCase(),
				role: attrMap.role,
				name: attrMap["aria-label"] || attrMap.title,
				bounds,
			};

			this.#activeHover = hoverEvent;
			this.#activeSelector = selector;
			this.#options.onHover?.(hoverEvent);
		} catch {}
	}

	async updateSelection(options: UpdateSelectionOptions): Promise<ElementStructuralNode | undefined> {
		if (this.#isDisposed) {
			throw new Error("BrowserSelectionChannel is disposed");
		}

		const session = await this.#ensureCDPSession();
		if (!session) {
			throw new Error("CDP session is required for browser element selection");
		}

		if (options.selector) {
			this.#activeSelector = options.selector;
			const doc = (await session.send("DOM.getDocument", { depth: 0 })) as { root?: { nodeId: number } };
			if (!doc.root?.nodeId) {
				throw new Error("Failed to get DOM document from CDP session");
			}

			const queryRes = (await session.send("DOM.querySelector", {
				nodeId: doc.root.nodeId,
				selector: options.selector,
			})) as { nodeId?: number };

			if (!queryRes.nodeId) {
				throw new Error(`Element with selector '${options.selector}' not found`);
			}

			const desc = (await session.send("DOM.describeNode", {
				nodeId: queryRes.nodeId,
			})) as { node?: CDPNode };

			if (!desc.node?.backendNodeId) {
				throw new Error(`Failed to resolve backend node for selector '${options.selector}'`);
			}

			this.#activeBackendNodeId = desc.node.backendNodeId;
			await this.#syncHoverFromBackendNode(desc.node.backendNodeId);
			await session
				.send("Overlay.highlightNode", {
					backendNodeId: desc.node.backendNodeId,
					highlightConfig: {
						contentColor: { r: 249, g: 115, b: 22, a: 0.2 },
						borderColor: { r: 249, g: 115, b: 22, a: 1.0 },
					},
				})
				.catch(() => {});
		} else if (options.point) {
			const locRes = (await session.send("DOM.getNodeForLocation", {
				x: Math.round(options.point.x),
				y: Math.round(options.point.y),
			})) as { backendNodeId?: number };

			if (!locRes.backendNodeId) {
				throw new Error(`No element found at point (${options.point.x}, ${options.point.y})`);
			}

			this.#activeBackendNodeId = locRes.backendNodeId;
			await this.#syncHoverFromBackendNode(locRes.backendNodeId);
		}

		return undefined;
	}

	async commitSelection(options: CommitSelectionOptions = {}): Promise<ElementSelectionResult> {
		if (this.#isDisposed) {
			throw new Error("BrowserSelectionChannel is disposed");
		}

		const session = await this.#ensureCDPSession();
		if (!session) {
			throw new Error("CDP session is required to commit element selection");
		}

		if (!this.#activeBackendNodeId) {
			if (options.selector) {
				await this.updateSelection({ selector: options.selector });
			} else {
				throw new Error("No element currently selected to commit");
			}
		}

		if (!this.#activeBackendNodeId) {
			throw new Error("Failed to resolve element backendNodeId");
		}

		const maxDepth = Math.min(options.maxDepth ?? SELECTION_LIMITS.maxDomDepth, SELECTION_LIMITS.maxDomDepth);
		const maxNodes = Math.min(options.maxNodes ?? SELECTION_LIMITS.maxDomNodes, SELECTION_LIMITS.maxDomNodes);

		const desc = (await session.send("DOM.describeNode", {
			backendNodeId: this.#activeBackendNodeId,
			depth: maxDepth,
			pierce: true,
		})) as { node?: CDPNode };

		const box = (await session.send("DOM.getBoxModel", {
			backendNodeId: this.#activeBackendNodeId,
		})) as { model?: { border: number[]; width: number; height: number } };

		const cdpRoot = desc.node;
		if (!cdpRoot) {
			throw new Error(`Selected backend node ${this.#activeBackendNodeId} is no longer present in document`);
		}

		const border = box.model?.border || [0, 0, 0, 0, 0, 0, 0, 0];
		const x = border[0] ?? 0;
		const y = border[1] ?? 0;
		const width = box.model?.width ?? (border[2] ? border[2] - border[0] : 0);
		const height = box.model?.height ?? (border[5] ? border[5] - border[1] : 0);

		const bounds: ElementSelectionBounds = {
			x,
			y,
			width,
			height,
			top: y,
			left: x,
			bottom: y + height,
			right: x + width,
		};

		const attrMap: Record<string, string> = {};
		const classes: string[] = [];
		if (Array.isArray(cdpRoot.attributes)) {
			for (let i = 0; i < cdpRoot.attributes.length; i += 2) {
				const k = cdpRoot.attributes[i].toLowerCase();
				const v = cdpRoot.attributes[i + 1] || "";
				if (ALLOWED_ATTRIBUTES.has(k) && !k.startsWith("on") && v.length < 512) {
					attrMap[k] = v;
				}
				if (k === "class") {
					classes.push(...v.split(/\s+/).filter(Boolean));
				}
			}
		}

		const effectiveSelector = attrMap.id ? `#${attrMap.id}` : (cdpRoot.localName || "div").toLowerCase();

		const rootNode: ElementStructuralNode = {
			role: attrMap.role,
			name: attrMap["aria-label"] || attrMap.title,
			tagName: (cdpRoot.localName || cdpRoot.nodeName || "div").toLowerCase(),
			selector: effectiveSelector,
			xpath: attrMap.id ? `//*[@id="${attrMap.id}"]` : undefined,
			bounds,
			attributes: attrMap,
			classes,
			id: attrMap.id,
			text: cdpRoot.nodeValue?.trim().slice(0, 300) || undefined,
			depth: 0,
			childCount: cdpRoot.children?.length ?? 0,
			isVisible: width > 0 && height > 0,
			isInteractive: Boolean(attrMap.role === "button" || attrMap.role === "link" || attrMap.tabindex),
			hierarchy: ["body", "html"],
		};

		let domJson = JSON.stringify(rootNode);
		let domBytes = new TextEncoder().encode(domJson).byteLength;

		if (domBytes > SELECTION_LIMITS.maxDomBytes) {
			const prunedRoot = { ...rootNode, children: [] };
			domJson = JSON.stringify(prunedRoot);
			domBytes = new TextEncoder().encode(domJson).byteLength;
		}

		const totalNodes = (rootNode.children?.length ?? 0) + 1;
		const structuralDescription: ElementStructuralDescription = {
			targetSelector: effectiveSelector,
			root: rootNode,
			nodeCount: totalNodes,
			maxDepth,
			serializedBytes: domBytes,
			json: domJson,
		};

		let screenshot: ElementSelectionScreenshot | undefined;
		if (options.captureScreenshot !== false) {
			try {
				if (session) {
					await session.send("Overlay.hideHighlight").catch(() => {});
					await session.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }).catch(() => {});
				}

				const bounds = rootNode.bounds;
				const padding = options.screenshotPadding ?? SELECTION_LIMITS.screenshotPaddingPx;
				const viewport = this.#page.viewportSize() ?? { width: 1280, height: 800 };

				const clipX = Math.max(0, Math.floor(bounds.x - padding));
				const clipY = Math.max(0, Math.floor(bounds.y - padding));
				const clipW = Math.min(
					viewport.width - clipX,
					Math.min(SELECTION_LIMITS.maxScreenshotDimension, Math.ceil(bounds.width + padding * 2)),
				);
				const clipH = Math.min(
					viewport.height - clipY,
					Math.min(SELECTION_LIMITS.maxScreenshotDimension, Math.ceil(bounds.height + padding * 2)),
				);

				if (clipW > 0 && clipH > 0) {
					const buffer = await this.#page.screenshot({
						clip: { x: clipX, y: clipY, width: clipW, height: clipH },
					});

					const clippedBounds: ElementSelectionBounds = {
						x: clipX,
						y: clipY,
						width: clipW,
						height: clipH,
						top: clipY,
						left: clipX,
						bottom: clipY + clipH,
						right: clipX + clipW,
					};

					if (buffer.byteLength <= SELECTION_LIMITS.maxImageBytes) {
						screenshot = {
							dataBase64: buffer.toString("base64"),
							mimeType: "image/png",
							width: clipW,
							height: clipH,
							byteLength: buffer.byteLength,
							clippedBounds,
						};
					}
				}
			} catch {
				// optional capture
			}
		}

		const idPart = rootNode.id ? `#${rootNode.id}` : "";
		const classPart = rootNode.classes.length > 0 ? `.${rootNode.classes.join(".")}` : "";
		const rolePart = rootNode.role ? ` role="${rootNode.role}"` : "";
		const namePart = rootNode.name ? ` name="${rootNode.name}"` : "";
		const textSnippet = rootNode.text ? ` - "${rootNode.text.slice(0, 80)}"` : "";
		const summaryText = `${options.summaryPrefix ?? ""}<${rootNode.tagName}${idPart}${classPart}${rolePart}${namePart}> (${Math.round(rootNode.bounds.width)}x${Math.round(rootNode.bounds.height)} at [${Math.round(rootNode.bounds.x)}, ${Math.round(rootNode.bounds.y)}])${textSnippet}`;
		const summary = sanitizeTextSummary(summaryText, SELECTION_LIMITS.maxSummaryBytes);

		const selectionId = `sel_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
		const currentUrl = this.#page.url();
		const currentTitle = await this.#page.title().catch(() => undefined);
		const result: ElementSelectionResult = {
			selectionId,
			workspaceId: this.#workspaceId,
			paneId: this.#paneId,
			url: currentUrl,
			title: currentTitle,
			timestamp: Date.now(),
			targetSelector: effectiveSelector,
			summary,
			dom: structuralDescription,
			screenshot,
		};

		await this.cancelSelection();
		this.#state = "selected";
		this.#options.onCommit?.(result);

		return result;
	}
	async cancelSelection(): Promise<void> {
		if (this.#isDisposed) return;

		const session = this.#cdpSession;
		if (session) {
			try {
				await session.send("Overlay.hideHighlight");
				await session.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
				if (this.#inspectListener) {
					(session as unknown as { removeListener?: (evt: string, fn: unknown) => void }).removeListener?.(
						"Overlay.inspectNodeRequested",
						this.#inspectListener,
					);
					this.#inspectListener = undefined;
				}
			} catch {}
		}

		this.#state = "idle";
		this.#activeHover = undefined;
		this.#activeBackendNodeId = undefined;
		this.#activeSelector = undefined;
		this.#options.onCancel?.();
	}

	async applyPreview(patch: DeclarativePreviewPatch): Promise<DeclarativePreviewResult> {
		if (this.#isDisposed) {
			throw new Error("BrowserSelectionChannel is disposed");
		}

		const validatedPatch = validateDeclarativePreviewPatch(patch);

		const previewResult = await this.#page.evaluate(p => {
			const host = document.getElementById("__branchlight_preview_host__") || document.createElement("div");
			host.id = "__branchlight_preview_host__";
			host.style.display = "none";
			if (!host.parentNode) document.documentElement.appendChild(host);

			const mutations: Array<{
				el: Element;
				type: string;
				attrName?: string;
				prevValue?: string | null;
				prevText?: string | null;
				prevClass?: string;
			}> = [];

			let appliedCount = 0;
			const errors: string[] = [];

			const rootTarget = p.targetSelector ? document.querySelector(p.targetSelector) : null;

			for (const op of p.operations) {
				try {
					let elements = Array.from(document.querySelectorAll(op.selector)) as Element[];
					// Strictly restrict mutations to the selected root subtree if targetSelector was given
					if (rootTarget) {
						elements = elements.filter(el => rootTarget.contains(el) || el === rootTarget);
					}
					if (elements.length === 0) {
						continue;
					}

					for (const el of elements) {
						switch (op.type) {
							case "replace_text": {
								mutations.push({
									el,
									type: "text",
									prevText: el.textContent,
								});
								el.textContent = op.text;
								appliedCount++;
								break;
							}
							case "set_attribute": {
								mutations.push({
									el,
									type: "attr",
									attrName: op.name,
									prevValue: el.getAttribute(op.name),
								});
								el.setAttribute(op.name, op.value);
								appliedCount++;
								break;
							}
							case "remove_attribute": {
								mutations.push({
									el,
									type: "attr",
									attrName: op.name,
									prevValue: el.getAttribute(op.name),
								});
								el.removeAttribute(op.name);
								appliedCount++;
								break;
							}
							case "set_style": {
								const htmlEl = el as HTMLElement;
								mutations.push({
									el,
									type: "style",
									attrName: op.property,
									prevValue: htmlEl.style.getPropertyValue(op.property),
								});
								htmlEl.style.setProperty(op.property, op.value);
								appliedCount++;
								break;
							}
							case "remove_style": {
								const htmlEl = el as HTMLElement;
								mutations.push({
									el,
									type: "style",
									attrName: op.property,
									prevValue: htmlEl.style.getPropertyValue(op.property),
								});
								htmlEl.style.removeProperty(op.property);
								appliedCount++;
								break;
							}
							case "add_class": {
								mutations.push({
									el,
									type: "class_add",
									prevClass: op.className,
								});
								el.classList.add(op.className);
								appliedCount++;
								break;
							}
							case "remove_class": {
								mutations.push({
									el,
									type: "class_remove",
									prevClass: op.className,
								});
								el.classList.remove(op.className);
								appliedCount++;
								break;
							}
						}
					}
				} catch (err) {
					errors.push(`failed operation on '${op.selector}': ${String(err)}`);
				}
			}

			if (p.css) {
				const styleId = "__branchlight_preview_style__";
				let styleEl = document.getElementById(styleId);
				if (!styleEl) {
					styleEl = document.createElement("style");
					styleEl.id = styleId;
					document.head.appendChild(styleEl);
				}
				styleEl.textContent = p.css;
			}

			(host as unknown as { __mutations: typeof mutations }).__mutations = mutations;

			return {
				patchId: p.patchId,
				appliedOperationsCount: appliedCount,
				success: errors.length === 0,
				errors: errors.length > 0 ? errors : undefined,
			};
		}, validatedPatch);

		this.#state = "previewing";
		this.#currentPreview = validatedPatch;

		return previewResult;
	}

	async removePreview(): Promise<void> {
		if (this.#isDisposed) return;

		await this.#page
			.evaluate(() => {
				const host = document.getElementById("__branchlight_preview_host__") as
					| (HTMLElement & {
							__mutations?: Array<{
								el: Element;
								type: string;
								attrName?: string;
								prevValue?: string | null;
								prevText?: string | null;
								prevClass?: string;
							}>;
					  })
					| null;

				if (host?.__mutations) {
					for (let i = host.__mutations.length - 1; i >= 0; i--) {
						const mut = host.__mutations[i];
						try {
							switch (mut.type) {
								case "text":
									mut.el.textContent = mut.prevText ?? "";
									break;
								case "attr":
									if (mut.attrName) {
										if (mut.prevValue !== null && mut.prevValue !== undefined) {
											mut.el.setAttribute(mut.attrName, mut.prevValue);
										} else {
											mut.el.removeAttribute(mut.attrName);
										}
									}
									break;
								case "style":
									if (mut.attrName) {
										const htmlEl = mut.el as HTMLElement;
										if (mut.prevValue) {
											htmlEl.style.setProperty(mut.attrName, mut.prevValue);
										} else {
											htmlEl.style.removeProperty(mut.attrName);
										}
									}
									break;
								case "class_add":
									if (mut.prevClass) mut.el.classList.remove(mut.prevClass);
									break;
								case "class_remove":
									if (mut.prevClass) mut.el.classList.add(mut.prevClass);
									break;
							}
						} catch {}
					}
					delete host.__mutations;
					host.remove();
				}

				const styleEl = document.getElementById("__branchlight_preview_style__");
				if (styleEl) styleEl.remove();
			})
			.catch(() => {});

		this.#state = "idle";
		this.#currentPreview = undefined;
	}

	async dispose(): Promise<void> {
		if (this.#isDisposed) return;
		this.#isDisposed = true;
		await this.removePreview().catch(() => {});
		await this.cancelSelection().catch(() => {});
	}
}
