import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHost } from "../src/main/workspace-host";

const mockLoadURL = vi.fn().mockResolvedValue(undefined);
const mockEventHandlers: Record<string, Function[]> = {};

vi.mock("electron", () => ({
	app: { isPackaged: false, getPath: vi.fn(() => "/tmp/userData") },
	Menu: {
		buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
	},
	WebContentsView: class {
		webContents = {
			navigationHistory: {
				canGoBack: () => false,
				canGoForward: () => false,
			},
			loadURL: mockLoadURL,
			on: (event: string, handler: Function) => {
				mockEventHandlers[event] = mockEventHandlers[event] || [];
				mockEventHandlers[event].push(handler);
			},
			setWindowOpenHandler: vi.fn(),
			getTitle: () => "Test Page",
			getURL: vi.fn(() => "https://omp.sh"),
			close: vi.fn(),
			isDestroyed: () => false,
		};
		setBounds = vi.fn();
		setBackgroundColor = vi.fn();
	},
}));

describe("WorkspaceHost pending-navigation state machine", () => {
	afterEach(() => {
		mockLoadURL.mockClear();
		for (const key of Object.keys(mockEventHandlers)) {
			delete mockEventHandlers[key];
		}
		vi.clearAllMocks();
	});

	function createHost() {
		const send = vi.fn();
		const window = {
			isDestroyed: () => false,
			webContents: {
				isDestroyed: () => false,
				send,
			},
			contentView: {
				addChildView: vi.fn(),
				removeChildView: vi.fn(),
			},
		};
		const host = new WorkspaceHost(window as never, "http://127.0.0.1:9222");
		return { host, send };
	}

	function createMockDocument(browserUrl = "https://omp.sh"): WorkspaceDocumentV1 {
		return {
			version: 1,
			revision: 1,
			workspaces: [{ id: "ws_1", label: "Main", locationId: "loc_1" }],
			locations: [{ id: "loc_1", kind: "local", path: "/test", lifecycle: { generation: 1 } }],
			tabs: [
				{
					id: "tab_browser",
					workspaceId: "ws_1",
					locationId: "loc_1",
					generation: 1,
					name: "Browser Tab",
					paneKind: "browser",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-browser-1"],
					activePaneId: "pane-browser-1",
				},
			],
			panes: [{ id: "pane-browser-1", tabId: "tab_browser", generation: 1, kind: "browser", entityId: "browser-1" }],
			terminals: [],
			browsers: [
				{
					id: "browser-1",
					locationId: "loc_1",
					paneId: "pane-browser-1",
					generation: 1,
					url: browserUrl,
					status: "ready",
				},
			],
			previews: [],
			agents: [],
			sessions: [],
			agentProfiles: [],
			pendingCleanup: [],
		};
	}

	it("ignores stale incoming document URL when local in-flight navigation is pending", async () => {
		const { host } = createHost();
		const doc = createMockDocument("https://omp.sh");

		const mockClient = {
			isConnected: true,
			document: doc,
			executeCommandWithRetry: vi.fn().mockImplementation(async () => {
				const { promise } = Promise.withResolvers<unknown>();
				return promise;
			}),
		};
		host.setClient(mockClient as never);
		host.syncWithDocument(doc);
		expect(mockLoadURL).toHaveBeenCalledTimes(1);
		expect(mockLoadURL).toHaveBeenLastCalledWith("https://omp.sh");

		// Simulate page navigated in-page to new URL
		const didNavigateHandlers = mockEventHandlers["did-navigate"] || [];
		expect(didNavigateHandlers.length).toBeGreaterThan(0);
		didNavigateHandlers[0]({}, "https://omp.sh/docs");

		// An unrelated stale document arrives still having the old URL https://omp.sh
		const staleDoc = createMockDocument("https://omp.sh");
		staleDoc.revision = 2;
		host.syncWithDocument(staleDoc);

		// loadURL should NOT have been called with the old https://omp.sh again
		expect(mockLoadURL).toHaveBeenCalledTimes(1);
	});

	it("rolls back to authoritativeUrl and emits error when navigation persistence is rejected", async () => {
		const { host, send } = createHost();
		const doc = createMockDocument("https://omp.sh");

		const mockClient = {
			isConnected: true,
			document: doc,
			executeCommandWithRetry: vi.fn().mockResolvedValue({
				status: "rejected",
				error: { message: "Navigation rejected by policy" },
			}),
		};

		host.setClient(mockClient as never);
		host.syncWithDocument(doc);
		expect(mockLoadURL).toHaveBeenCalledTimes(1);
		// Trigger did-navigate
		const didNavigateHandlers = mockEventHandlers["did-navigate"] || [];
		didNavigateHandlers[0]({}, "https://disallowed.com");

		await vi.waitFor(() => {
			expect(mockLoadURL).toHaveBeenCalledTimes(2);
		});
		expect(mockLoadURL).toHaveBeenLastCalledWith("https://omp.sh");

		// Should have emitted error state
		const errorEvents = send.mock.calls.map(c => c[1]).filter(e => e?.type === "browser-state" && e.state?.error);
		expect(errorEvents.length).toBeGreaterThan(0);
		expect(errorEvents[0].state.error).toContain("Navigation rejected by policy");
	});
});
