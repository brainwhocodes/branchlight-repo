import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHost } from "../src/main/workspace-host";

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
			loadURL: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
			setWindowOpenHandler: vi.fn(),
			close: vi.fn(),
			isDestroyed: () => false,
		};
		setBounds = vi.fn();
		setBackgroundColor = vi.fn();
	},
}));

describe("WorkspaceHost transaction-safe close operations", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	function createHost() {
		const send = vi.fn();
		const addChildView = vi.fn();
		const removeChildView = vi.fn();
		const window = {
			isDestroyed: () => false,
			webContents: {
				isDestroyed: () => false,
				send,
			},
			contentView: {
				addChildView,
				removeChildView,
			},
		};
		const host = new WorkspaceHost(window as never, "http://127.0.0.1:9222");
		return { host, send, addChildView, removeChildView };
	}

	function createMockDocument(): WorkspaceDocumentV1 {
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
				{
					id: "tab_terminal",
					workspaceId: "ws_1",
					locationId: "loc_1",
					generation: 1,
					name: "Terminal Tab",
					paneKind: "terminal",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-term-1"],
					activePaneId: "pane-term-1",
				},
			],
			panes: [
				{ id: "pane-browser-1", tabId: "tab_browser", generation: 1, kind: "browser", entityId: "browser-1" },
				{ id: "pane-term-1", tabId: "tab_terminal", generation: 1, kind: "terminal", entityId: "term-1" },
			],
			terminals: [
				{
					id: "term-1",
					locationId: "loc_1",
					paneId: "pane-term-1",
					generation: 1,
					label: "Terminal",
					status: "ready",
				},
			],
			browsers: [
				{
					id: "browser-1",
					locationId: "loc_1",
					paneId: "pane-browser-1",
					generation: 1,
					url: "https://omp.sh",
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

	it("preserves browser view when closeBrowser is rejected by runtime", async () => {
		const { host, removeChildView } = createHost();
		const doc = createMockDocument();

		const mockClient = {
			isConnected: true,
			document: doc,
			executeCommandWithRetry: vi.fn().mockResolvedValue({
				status: "rejected",
				error: { message: "Permission denied" },
			}),
			onTerminalOutput: vi.fn(() => vi.fn()),
			subscribeTerminal: vi.fn().mockResolvedValue({ status: "ready" }),
		};

		host.setClient(mockClient as never);
		host.syncWithDocument(doc);
		host.setVisibleBrowsers(["pane-browser-1"]);

		await expect(host.closeBrowser("pane-browser-1")).rejects.toThrow("Permission denied");
		// View should NOT have been removed from window contentView
		expect(removeChildView).not.toHaveBeenCalled();
	});

	it("preserves terminal subscription when closeTerminal is rejected by runtime", async () => {
		const { host } = createHost();
		const doc = createMockDocument();
		const unsubscribe = vi.fn();

		const mockClient = {
			isConnected: true,
			document: doc,
			executeCommandWithRetry: vi.fn().mockResolvedValue({
				status: "rejected",
				error: { message: "Terminal is busy" },
			}),
			onTerminalOutput: vi.fn(() => unsubscribe),
			subscribeTerminal: vi.fn().mockResolvedValue({ status: "ready" }),
		};

		host.setClient(mockClient as never);
		host.syncWithDocument(doc);

		await expect(host.closeTerminal("pane-term-1")).rejects.toThrow("Terminal is busy");
		expect(unsubscribe).not.toHaveBeenCalled();
	});

	it("removes browser view cleanly on accepted close, and repeated close is harmless", async () => {
		const { host, removeChildView } = createHost();
		const doc = createMockDocument();

		const docAfterClose: WorkspaceDocumentV1 = {
			...doc,
			revision: 2,
			browsers: [],
			panes: doc.panes.filter(p => p.id !== "pane-browser-1"),
			tabs: doc.tabs.filter(t => t.id !== "tab_browser"),
		};

		const mockClient = {
			isConnected: true,
			document: doc,
			executeCommandWithRetry: vi.fn().mockImplementation(async () => {
				mockClient.document = docAfterClose;
				return {
					status: "accepted",
					document: docAfterClose,
				};
			}),
			onTerminalOutput: vi.fn(() => vi.fn()),
			subscribeTerminal: vi.fn().mockResolvedValue({ status: "ready" }),
		};

		host.setClient(mockClient as never);
		host.syncWithDocument(doc);
		host.setVisibleBrowsers(["pane-browser-1"]);

		await host.closeBrowser("pane-browser-1");
		expect(removeChildView).toHaveBeenCalledTimes(1);

		// Repeated close when entity is absent from document should be harmless and not throw
		await expect(host.closeBrowser("pane-browser-1")).resolves.toBeUndefined();
	});
});
