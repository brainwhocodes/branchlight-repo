import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Browser, BrowserContext, CDPSession, Locator, Page } from "playwright-core";
import {
	BrowserSelectionChannel,
	DeclarativePreviewValidationError,
	PlaywrightBrowserService,
	SELECTION_LIMITS,
	validateDeclarativePreviewPatch,
} from "../src";

function createMockPage(targetId: string, initialUrl = "https://omp.sh", initialTitle = "Branchlight"): Page {
	let currentUrl = initialUrl;
	const currentTitle = initialTitle;
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

	const mockCdpSession: Partial<CDPSession> = {
		send: (async (method: string, _params?: Record<string, unknown>) => {
			if (method === "Target.getTargetInfo") {
				return {
					targetInfo: {
						targetId,
						type: "page",
						title: currentTitle,
						url: currentUrl,
						attached: true,
						canAccessOpener: false,
					},
				};
			}
			if (method === "DOM.getDocument") {
				return { root: { nodeId: 1 } };
			}
			if (method === "DOM.querySelector") {
				return { nodeId: 2 };
			}
			if (method === "DOM.getNodeForLocation") {
				return { backendNodeId: 100 };
			}
			if (method === "DOM.describeNode") {
				return {
					node: {
						nodeId: 2,
						backendNodeId: 100,
						nodeType: 1,
						nodeName: "DIV",
						localName: "div",
						attributes: ["id", "hero", "class", "hero-banner", "role", "banner", "aria-label", "Hero Section"],
						nodeValue: "Welcome to Branchlight",
						children: [],
					},
				};
			}
			if (method === "DOM.getBoxModel") {
				return {
					model: {
						border: [10, 20, 310, 20, 310, 170, 10, 170],
						width: 300,
						height: 150,
					},
				};
			}
			return {};
		}) as unknown as CDPSession["send"],
		detach: async () => {},
	};

	const mockActiveTarget = {
		selector: "#hero",
		tagName: "div",
		role: "banner",
		name: "Hero Section",
		bounds: { x: 10, y: 20, width: 300, height: 150, top: 20, left: 10, bottom: 170, right: 310 },
	};

	const mockPage: Partial<Page> = {
		url: () => currentUrl,
		title: async () => currentTitle,
		goto: async (url: string) => {
			currentUrl = url;
			for (const handler of listeners.get("framenavigated") ?? []) {
				handler(mockPage.mainFrame?.());
			}
			return null;
		},
		mainFrame: () => mockPage as unknown as Page["mainFrame"] extends () => infer R ? R : never,
		on: ((event: string, handler: (...args: unknown[]) => void) => {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event)!.push(handler);
			return mockPage as Page;
		}) as unknown as Page["on"],
		removeListener: ((event: string, handler: (...args: unknown[]) => void) => {
			const list = listeners.get(event);
			if (list) {
				const idx = list.indexOf(handler);
				if (idx >= 0) list.splice(idx, 1);
			}
			return mockPage as Page;
		}) as unknown as Page["removeListener"],
		close: async () => {
			for (const handler of listeners.get("close") ?? []) {
				handler();
			}
		},
		locator: (_selector: string) =>
			({
				ariaSnapshot: async () => "snapshot-ok",
				click: async () => {},
				fill: async () => {},
				count: async () => 0,
				nth: () => ({
					boundingBox: async () => null,
					textContent: async () => null,
					evaluate: async () => "div",
				}),
			}) as unknown as Locator,
		viewportSize: () => ({ width: 1280, height: 800 }),
		evaluate: async (fn: unknown, arg?: unknown) => {
			if (typeof fn === "function") {
				const fnStr = fn.toString();
				if (
					(fnStr.includes("__branchlight_selection_overlay_host__") ||
						fnStr.includes("__branchlight_active_target__")) &&
					fnStr.includes("return")
				) {
					return mockActiveTarget;
				}
				if (fnStr.includes("extractNode") || fnStr.includes("depthLimit")) {
					return {
						targetSelector: "#hero",
						root: {
							role: "banner",
							name: "Hero Section",
							tagName: "div",
							selector: "#hero",
							xpath: '//*[@id="hero"]',
							bounds: { x: 10, y: 20, width: 300, height: 150, top: 20, left: 10, bottom: 170, right: 310 },
							attributes: { id: "hero", class: "hero-banner" },
							classes: ["hero-banner"],
							id: "hero",
							text: "Welcome to Branchlight",
							depth: 0,
							childCount: 0,
							isVisible: true,
							isInteractive: false,
							hierarchy: ["body", "html"],
						},
						nodeCount: 1,
						maxDepth: 12,
					};
				}
				if (fnStr.includes("appliedOperationsCount") || fnStr.includes("mutations")) {
					return {
						patchId: (arg as { patchId?: string })?.patchId ?? "preview-123",
						appliedOperationsCount: 1,
						success: true,
					};
				}
				return undefined;
			}
			return "evaluated";
		},
		screenshot: async () => Buffer.from("fake-png-data"),
	};

	const pageInstance = {
		...mockPage,
		_mockCdpSession: mockCdpSession,
		context: () =>
			({
				newCDPSession: async () => mockCdpSession as CDPSession,
			}) as unknown as BrowserContext,
	} as unknown as Page;

	return pageInstance;
}

describe("PlaywrightBrowserService exact target adoption", () => {
	let service: PlaywrightBrowserService;
	let page1: Page;
	let page2: Page;
	let mockContext: BrowserContext;
	let mockBrowser: Browser;

	beforeEach(() => {
		service = new PlaywrightBrowserService();
		page1 = createMockPage("target-123", "https://omp.sh/doc1", "Doc 1");
		page2 = createMockPage("target-456", "https://omp.sh/doc2", "Doc 2");

		let isConnected = true;
		mockBrowser = {
			isConnected: () => isConnected,
			close: async () => {
				isConnected = false;
			},
		} as unknown as Browser;

		mockContext = {
			pages: () => [page1, page2],
			browser: () => mockBrowser,
			close: async () => {},
			newCDPSession: async (p: Page) => (p as unknown as { _mockCdpSession: CDPSession })._mockCdpSession,
		} as unknown as BrowserContext;

		service.registerBrowserContext("mock-cdp", mockBrowser, mockContext, true);
	});

	afterEach(async () => {
		await service.close();
	});

	it("adopts exact targets by DevTools targetId and prevents cross-pane confusion on duplicate URLs", async () => {
		const adopted1 = await service.adoptTarget({
			target: {
				workspaceId: "ws-1",
				paneId: "pane-1",
				documentEpoch: 1,
				targetId: "target-123",
				url: "https://omp.sh/doc1",
			},
			cdpUrl: "mock-cdp",
		});

		expect(adopted1).toBe(page1);
		expect(service.adoptedCount).toBe(1);

		const duplicateUrlPage = createMockPage("target-789", "https://omp.sh/doc1", "Doc 1 Copy");
		mockContext.pages = () => [page1, page2, duplicateUrlPage];

		const adopted2 = await service.adoptTarget({
			target: {
				workspaceId: "ws-1",
				paneId: "pane-2",
				documentEpoch: 1,
				targetId: "target-789",
				url: "https://omp.sh/doc1",
			},
			cdpUrl: "mock-cdp",
		});

		expect(adopted2).toBe(duplicateUrlPage);
		expect(service.adoptedCount).toBe(2);
	});

	it("fails closed with not_found on unknown targetId without falling back to other pages", async () => {
		await expect(
			service.adoptTarget({
				target: {
					workspaceId: "ws-1",
					paneId: "pane-1",
					documentEpoch: 1,
					targetId: "non-existent-target",
					url: "https://omp.sh/doc1",
				},
				cdpUrl: "mock-cdp",
			}),
		).rejects.toThrow("not_found");
	});

	it("fails closed with stale_target on documentEpoch or workspace mismatch", async () => {
		await service.adoptTarget({
			target: {
				workspaceId: "ws-1",
				paneId: "pane-1",
				documentEpoch: 1,
				targetId: "target-123",
				url: "https://omp.sh",
			},
			cdpUrl: "mock-cdp",
		});

		// Stale document epoch
		await expect(
			service.adoptTarget({
				target: {
					workspaceId: "ws-1",
					paneId: "pane-1",
					documentEpoch: 2,
					targetId: "target-123",
					url: "https://omp.sh",
				},
				cdpUrl: "mock-cdp",
			}),
		).rejects.toThrow("stale_target");
	});

	it("releases target without terminating shared browser connection", async () => {
		await service.adoptTarget({
			target: {
				workspaceId: "ws-1",
				paneId: "pane-1",
				documentEpoch: 1,
				targetId: "target-123",
				url: "https://omp.sh",
			},
			cdpUrl: "mock-cdp",
			isShared: true,
		});

		expect(service.adoptedCount).toBe(1);
		await service.releaseTarget("pane-1");
		expect(service.adoptedCount).toBe(0);
		expect(mockBrowser.isConnected()).toBe(true);
	});
});

describe("Declarative Preview Validation", () => {
	it("validates well-formed declarative preview patch with all operation types", () => {
		const patch = {
			patchId: "patch-all-ops",
			targetSelector: "#container",
			description: "Comprehensive test patch",
			css: ".custom-class { display: block; }",
			operations: [
				{
					type: "replace_text",
					selector: "#title",
					text: "Updated Header",
				},
				{
					type: "set_attribute",
					selector: "#img",
					name: "alt",
					value: "Logo",
				},
				{
					type: "remove_attribute",
					selector: "#img",
					name: "title",
				},
				{
					type: "set_style",
					selector: "#box",
					property: "margin-top",
					value: "16px",
				},
				{
					type: "remove_style",
					selector: "#box",
					property: "padding",
				},
				{
					type: "add_class",
					selector: "#box",
					className: "highlighted",
				},
				{
					type: "remove_class",
					selector: "#box",
					className: "dimmed",
				},
			],
		};

		const validated = validateDeclarativePreviewPatch(patch);
		expect(validated.patchId).toBe("patch-all-ops");
		expect(validated.operations).toHaveLength(7);
		expect(validated.operations[0].type).toBe("replace_text");
		expect(validated.operations[6].type).toBe("remove_class");
	});

	it("rejects unsupported HTML and value mutation operation types", () => {
		const htmlPatch = {
			patchId: "patch-html",
			operations: [
				{
					type: "replace_html",
					selector: "#content",
					html: "<div>Injected</div>",
				},
			],
		};
		expect(() => validateDeclarativePreviewPatch(htmlPatch)).toThrow(DeclarativePreviewValidationError);

		const valuePatch = {
			patchId: "patch-val",
			operations: [
				{
					type: "set_value",
					selector: "#input",
					value: "Injected Value",
				},
			],
		};
		expect(() => validateDeclarativePreviewPatch(valuePatch)).toThrow(DeclarativePreviewValidationError);
	});

	it("rejects patch exceeding maxPreviewBytes limit (64 KiB)", () => {
		const largeString = "a".repeat(SELECTION_LIMITS.maxPreviewBytes + 100);
		const patch = {
			patchId: "patch-large",
			operations: [
				{
					type: "replace_text",
					selector: "#text",
					text: largeString,
				},
			],
		};

		expect(() => validateDeclarativePreviewPatch(patch)).toThrow(DeclarativePreviewValidationError);
	});

	it("rejects dangerous script tags and inline event handlers in HTML operations", () => {
		const scriptPatch = {
			patchId: "patch-xss",
			operations: [
				{
					type: "replace_html",
					selector: "#content",
					html: '<div>Hello<script>alert("xss")</script></div>',
				},
			],
		};
		expect(() => validateDeclarativePreviewPatch(scriptPatch)).toThrow(DeclarativePreviewValidationError);

		const eventHandlerPatch = {
			patchId: "patch-event",
			operations: [
				{
					type: "insert_html",
					selector: "#content",
					position: "beforeend",
					html: '<img src="x" onerror="alert(1)">',
				},
			],
		};
		expect(() => validateDeclarativePreviewPatch(eventHandlerPatch)).toThrow(DeclarativePreviewValidationError);
	});

	it("rejects dangerous on* event handler attributes and javascript: URLs", () => {
		const onAttrPatch = {
			patchId: "patch-on-click",
			operations: [
				{
					type: "set_attribute",
					selector: "button",
					name: "onclick",
					value: "doBadThings()",
				},
			],
		};
		expect(() => validateDeclarativePreviewPatch(onAttrPatch)).toThrow(DeclarativePreviewValidationError);

		const jsHrefPatch = {
			patchId: "patch-js-href",
			operations: [
				{
					type: "set_attribute",
					selector: "a",
					name: "href",
					value: "javascript:alert(1)",
				},
			],
		};
		expect(() => validateDeclarativePreviewPatch(jsHrefPatch)).toThrow(DeclarativePreviewValidationError);
	});

	it("rejects forbidden patterns in CSS like @import and expression()", () => {
		const importCssPatch = {
			patchId: "patch-css-import",
			css: "@import url('https://evil.com/evil.css');",
			operations: [
				{
					type: "add_class",
					selector: "div",
					className: "test",
				},
			],
		};
		expect(() => validateDeclarativePreviewPatch(importCssPatch)).toThrow(DeclarativePreviewValidationError);

		const expressionCssPatch = {
			patchId: "patch-css-expression",
			css: "div { width: expression(alert(1)); }",
			operations: [
				{
					type: "add_class",
					selector: "div",
					className: "test",
				},
			],
		};
		expect(() => validateDeclarativePreviewPatch(expressionCssPatch)).toThrow(DeclarativePreviewValidationError);
	});

	it("exports correct SELECTION_LIMITS constants matching specification", () => {
		expect(SELECTION_LIMITS.maxImageBytes).toBe(150 * 1024);
		expect(SELECTION_LIMITS.maxDomBytes).toBe(32 * 1024);
		expect(SELECTION_LIMITS.maxPreviewBytes).toBe(64 * 1024);
		expect(SELECTION_LIMITS.maxSummaryBytes).toBe(8 * 1024);
		expect(SELECTION_LIMITS.maxTotalRequestBytes).toBe(256 * 1024);
		expect(SELECTION_LIMITS.maxLiveRequests).toBe(128);
		expect(SELECTION_LIMITS.maxRuntimeStorageBytes).toBe(64 * 1024 * 1024);
		expect(SELECTION_LIMITS.maxLifetimeMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(SELECTION_LIMITS.maxDomDepth).toBe(12);
		expect(SELECTION_LIMITS.maxDomNodes).toBe(256);
		expect(SELECTION_LIMITS.screenshotPaddingPx).toBe(12);
		expect(SELECTION_LIMITS.maxScreenshotDimension).toBe(1024);
	});
});

describe("BrowserSelectionChannel lifecycle and operations", () => {
	it("initializes channel and supports startSelection, commitSelection, cancelSelection", async () => {
		const page = createMockPage("target-sel-1");
		let committedResult: unknown = null;
		let cancelled = false;

		const channel = new BrowserSelectionChannel({
			page,
			workspaceId: "ws-test",
			paneId: "pane-test",
			onCommit: res => {
				committedResult = res;
			},
			onCancel: () => {
				cancelled = true;
			},
		});

		expect(channel.state).toBe("idle");
		expect(channel.workspaceId).toBe("ws-test");
		expect(channel.paneId).toBe("pane-test");

		await channel.startSelection({ initialSelector: "#hero" });
		expect(channel.state).toBe("picking");

		await channel.updateSelection({ point: { x: 50, y: 50 } });
		expect(channel.activeHover?.selector).toBe("#hero");

		const result = await channel.commitSelection({
			selector: "#hero",
			summaryPrefix: "[Hero Element] ",
		});

		expect(result.selectionId).toBeDefined();
		expect(result.workspaceId).toBe("ws-test");
		expect(result.paneId).toBe("pane-test");
		expect(result.summary).toContain("[Hero Element]");
		expect(result.dom).toBeDefined();
		expect(result.screenshot).toBeDefined();
		expect(result.screenshot?.clippedBounds).toBeDefined();
		expect(channel.state).toBe("selected");
		expect(committedResult).toBe(result);

		await channel.cancelSelection();
		expect(channel.state).toBe("idle");
		expect(cancelled).toBe(true);

		await channel.dispose();
		expect(channel.isDisposed).toBe(true);
		await expect(channel.startSelection()).rejects.toThrow("disposed");
	});

	it("applies and removes declarative preview safely", async () => {
		const page = createMockPage("target-preview-1");
		const channel = new BrowserSelectionChannel({
			page,
			workspaceId: "ws-preview",
			paneId: "pane-preview",
		});

		const patch = {
			patchId: "preview-123",
			operations: [
				{
					type: "replace_text" as const,
					selector: "h1",
					text: "New Title",
				},
			],
			css: "h1 { color: red; }",
		};

		const previewRes = await channel.applyPreview(patch);
		expect(previewRes.patchId).toBe("preview-123");
		expect(channel.state).toBe("previewing");
		expect(channel.activePreview?.patchId).toBe("preview-123");

		await channel.removePreview();
		expect(channel.state).toBe("idle");
		expect(channel.activePreview).toBeUndefined();
	});
});
