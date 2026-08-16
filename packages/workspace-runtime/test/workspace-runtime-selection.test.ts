import { describe, expect, it } from "bun:test";
import {
	type ElementEditResultV1,
	ElementSelectionCoordinator,
	SELECTION_LIMITS,
	type SelectionAuthScope,
} from "../src";

describe("ElementSelectionCoordinator", () => {
	const validScope: SelectionAuthScope = {
		principalId: "user-1",
		workspaceId: "ws-1",
		tabId: "tab-1",
		paneId: "pane-1",
		documentEpoch: 1,
		locationGeneration: 1,
		locationId: "loc-1",
		agentId: "agent-1",
		sessionId: "sess-1",
	};

	it("exports SELECTION_LIMITS with accurate capacity constants", () => {
		expect(SELECTION_LIMITS.maxImageBytes).toBe(153600); // 150 KiB
		expect(SELECTION_LIMITS.maxDomBytes).toBe(32768); // 32 KiB
		expect(SELECTION_LIMITS.maxPreviewBytes).toBe(65536); // 64 KiB
		expect(SELECTION_LIMITS.maxSummaryBytes).toBe(8192); // 8 KiB
		expect(SELECTION_LIMITS.maxRequestStorageBytes).toBe(262144); // 256 KiB
		expect(SELECTION_LIMITS.maxTotalRequestBytes).toBe(262144);
		expect(SELECTION_LIMITS.maxLiveRequests).toBe(128);
		expect(SELECTION_LIMITS.maxStorageBytes).toBe(67108864); // 64 MiB
		expect(SELECTION_LIMITS.maxTotalStorageBytes).toBe(67108864);
		expect(SELECTION_LIMITS.maxLifetimeMs).toBe(604800000); // 7 days
		expect(SELECTION_LIMITS.maxDepth).toBe(12);
		expect(SELECTION_LIMITS.maxDomRecords).toBe(256);
		expect(SELECTION_LIMITS.screenshotPaddingPx).toBe(12);
		expect(SELECTION_LIMITS.maxScreenshotDimension).toBe(1024);
	});

	it("manages the entire selection lifecycle transitions with required scope", () => {
		const currentTime = 1000000;
		const coordinator = new ElementSelectionCoordinator({
			now: () => currentTime,
			idGenerator: p => `${p ?? "sel"}-1`,
		});
		coordinator.updateLocationGeneration("loc-1", 1);

		// 1. Initial idle phase
		expect(coordinator.getState(validScope).phase).toBe("idle");
		expect(coordinator.liveSelectionCount).toBe(0);

		// 2. Start selection -> picking phase
		const pickingState = coordinator.startSelection(validScope, {
			url: "https://example.com",
		});
		expect(pickingState.phase).toBe("picking");
		expect(pickingState.selectionId).toBe("sel-1");
		expect(pickingState.workspaceId).toBe("ws-1");
		expect(pickingState.paneId).toBe("pane-1");
		expect(coordinator.liveSelectionCount).toBe(1);

		// 3. Update with element details -> selected phase
		const selectedState = coordinator.updateSelection(validScope, "sel-1", {
			selector: "button.submit-btn",
			domSnapshot: {
				selector: "button.submit-btn",
				tagName: "button",
				text: "Submit Order",
				role: "button",
				summary: "Primary action button",
			},
			screenshot: {
				base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				mimeType: "image/png",
				width: 120,
				height: 40,
				byteLength: 68,
			},
		});
		expect(selectedState.phase).toBe("selected");
		expect(selectedState.selector).toBe("button.submit-btn");
		expect(selectedState.selectedElement?.text).toBe("Submit Order");
		expect(selectedState.screenshot).toBeDefined();

		// 4. Send to agent -> working phase
		const workingState = coordinator.sendToAgent(
			validScope,
			"sel-1",
			{ id: "agent-1", workspaceId: "ws-1", status: "ready" },
			"Make the button green",
		);
		expect(workingState.phase).toBe("working");
		expect(workingState.agentId).toBe("agent-1");
		expect(workingState.workingMessage).toBe("Make the button green");

		// 5. Agent reports ready result -> ready phase
		const editResult: ElementEditResultV1 = {
			id: "edit-1",
			selectionId: "sel-1",
			workspaceId: "ws-1",
			paneId: "pane-1",
			agentId: "agent-1",
			target: "button.submit-btn",
			operation: "replace",
			value: "Confirm Order",
			applied: true,
			createdAt: currentTime + 500,
		};
		const readyState = coordinator.reportReady(validScope, "sel-1", editResult);
		expect(readyState.phase).toBe("ready");
		expect(readyState.result?.value).toBe("Confirm Order");

		// 6. Apply declarative preview -> preview phase
		const previewState = coordinator.applyPreview(validScope, "sel-1", {
			patchId: "patch-1",
			operations: [
				{
					type: "replace_text",
					selector: "button.submit-btn",
					text: "Confirm Order",
				},
				{
					type: "set_style",
					selector: "button.submit-btn",
					property: "background-color",
					value: "#10b981",
				},
			],
		});
		expect(previewState.phase).toBe("preview");
		expect(previewState.previewPatch?.operations).toHaveLength(2);

		// 7. Remove preview -> reverts to ready
		const revertedState = coordinator.removePreview(validScope, "sel-1");
		expect(revertedState.phase).toBe("ready");
		expect(revertedState.previewPatch).toBeUndefined();

		// 8. Cancel -> idle
		const idleState = coordinator.cancelSelection(validScope, "sel-1", "user cancelled");
		expect(idleState.phase).toBe("idle");
	});

	it("fails closed on mismatched principal, workspace, pane, or generation", () => {
		const coordinator = new ElementSelectionCoordinator({
			idGenerator: () => "sel-auth",
		});
		coordinator.updateLocationGeneration("loc-1", 1);

		coordinator.startSelection(validScope, {});

		// 1. Mismatched principal fails closed with not_found
		expect(() => coordinator.getSelection({ ...validScope, principalId: "wrong-user" }, "sel-auth")).toThrow(
			"Selection not found",
		);

		// 2. Mismatched workspace fails closed with not_found
		expect(() => coordinator.getSelection({ ...validScope, workspaceId: "wrong-ws" }, "sel-auth")).toThrow(
			"Selection not found",
		);

		// 3. Mismatched pane fails closed with not_found
		expect(() => coordinator.getSelection({ ...validScope, paneId: "wrong-pane" }, "sel-auth")).toThrow(
			"Selection not found",
		);

		// 4. Mismatched documentEpoch fails closed with not_found
		expect(() => coordinator.getSelection({ ...validScope, documentEpoch: 2 }, "sel-auth")).toThrow(
			"Selection not found",
		);

		// 5. Mismatched locationGeneration fails closed with not_found
		expect(() => coordinator.getSelection({ ...validScope, locationGeneration: 2 }, "sel-auth")).toThrow(
			"Selection not found",
		);

		// 6. Mismatched agentId fails closed with not_found
		expect(() => coordinator.getSelection({ ...validScope, agentId: "wrong-agent" }, "sel-auth")).toThrow(
			"Selection not found",
		);

		// 7. Mismatched sessionId fails closed with not_found
		expect(() => coordinator.getSelection({ ...validScope, sessionId: "wrong-session" }, "sel-auth")).toThrow(
			"Selection not found",
		);

		// 8. Untracked location generation fails closed
		expect(() => {
			const c2 = new ElementSelectionCoordinator();
			c2.startSelection({ ...validScope, locationId: "unregistered-loc" }, {});
		}).toThrow("generation mismatch");
	});

	it("enforces SELECTION_LIMITS on payload sizes", () => {
		const coordinator = new ElementSelectionCoordinator({
			idGenerator: () => "sel-limits",
		});
		coordinator.updateLocationGeneration("loc-1", 1);
		coordinator.startSelection(validScope, {});

		// 1. Oversized image (> 150 KiB) rejected
		expect(() =>
			coordinator.updateSelection(validScope, "sel-limits", {
				screenshot: {
					byteLength: 153601,
				},
			}),
		).toThrow();

		// 2. Oversized DOM description (> 32 KiB) rejected
		expect(() =>
			coordinator.updateSelection(validScope, "sel-limits", {
				domSnapshot: {
					selector: "div",
					html: "x".repeat(33000),
				},
			}),
		).toThrow();

		// 3. Oversized summary (> 8 KiB) rejected
		expect(() =>
			coordinator.updateSelection(validScope, "sel-limits", {
				domSnapshot: {
					selector: "div",
					summary: "s".repeat(8200),
				},
			}),
		).toThrow();

		// 4. Oversized preview patch (> 64 KiB) rejected
		expect(() =>
			coordinator.applyPreview(validScope, "sel-limits", {
				patchId: "patch-huge",
				operations: [
					{
						type: "replace_text",
						selector: "div",
						text: "p".repeat(66000),
					},
				],
			}),
		).toThrow();

		// 5. DOM tree depth (> 12) rejected
		type TestNode = { selector: string; tagName: string; depth: number; children: TestNode[] };
		let deepNode: TestNode = { selector: "span", tagName: "span", depth: 13, children: [] };
		for (let i = 12; i >= 1; i--) {
			deepNode = { selector: `div-${i}`, tagName: "div", depth: i, children: [deepNode] };
		}
		expect(() =>
			coordinator.updateSelection(validScope, "sel-limits", {
				domSnapshot: {
					selector: "div-1",
					nodes: [deepNode],
				},
			}),
		).toThrow();
	});

	it("prunes expired requests after 7 days", () => {
		let mockTime = 1000;
		const coordinator = new ElementSelectionCoordinator({
			now: () => mockTime,
			idGenerator: () => "sel-old",
		});
		coordinator.updateLocationGeneration("loc-1", 1);

		coordinator.startSelection(validScope, {});
		expect(coordinator.liveSelectionCount).toBe(1);

		// Advance time beyond 7 days (604800000 ms)
		mockTime += 604800000 + 1000;

		const pruned = coordinator.pruneExpiredSelections();
		expect(pruned).toBe(1);
		expect(coordinator.liveSelectionCount).toBe(0);
	});
});
