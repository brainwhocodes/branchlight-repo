import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_BG_DARK, BROWSER_BG_LIGHT, WorkspaceHost } from "../src/main/workspace-host";

const mockSetBounds = vi.fn();
const mockSetBackgroundColor = vi.fn();

vi.mock("electron", () => ({
	app: { isPackaged: false, getPath: vi.fn(() => "/tmp/userData") },
	nativeTheme: {
		shouldUseDarkColors: true,
		on: vi.fn(),
	},
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
		setBounds = mockSetBounds;
		setBackgroundColor = mockSetBackgroundColor;
	},
}));

describe("WorkspaceHost position-aware browser bounds", () => {
	afterEach(() => {
		mockSetBounds.mockClear();
		vi.clearAllMocks();
	});

	function createHost(zoomFactor = 1) {
		const send = vi.fn();
		const addChildView = vi.fn();
		const removeChildView = vi.fn();
		const window = {
			isDestroyed: () => false,
			webContents: {
				isDestroyed: () => false,
				send,
				getZoomFactor: () => zoomFactor,
			},
			contentView: {
				addChildView,
				removeChildView,
			},
		};
		const host = new WorkspaceHost(window as never, "http://127.0.0.1:9222");
		return { host, send, addChildView, removeChildView, window };
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
			],
			panes: [{ id: "pane-browser-1", tabId: "tab_browser", generation: 1, kind: "browser", entityId: "browser-1" }],
			terminals: [],
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

	it("converts CSS pixels to DIPs with window zoom factor when applying bounds", () => {
		const { host } = createHost(1.25);
		const doc = createMockDocument();
		host.syncWithDocument(doc);
		host.setVisibleBrowsers(["pane-browser-1"]);

		host.setBrowserBounds("pane-browser-1", { x: 100, y: 50, width: 800, height: 600 });

		expect(mockSetBounds).toHaveBeenCalledWith({
			x: 125, // 100 * 1.25
			y: 63, // 50 * 1.25 rounded
			width: 1000, // 800 * 1.25
			height: 750, // 600 * 1.25
		});
	});

	it("re-applies cached bounds immediately upon view reattachment", () => {
		const { host } = createHost(1);
		const doc = createMockDocument();
		host.syncWithDocument(doc);
		host.setVisibleBrowsers(["pane-browser-1"]);

		host.setBrowserBounds("pane-browser-1", { x: 10, y: 20, width: 500, height: 400 });
		expect(mockSetBounds).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 500, height: 400 });

		// Detach by hiding
		host.setVisibleBrowsers([]);
		// Reattach by making visible again
		host.setVisibleBrowsers(["pane-browser-1"]);
		expect(mockSetBounds).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 500, height: 400 });
	});

	it("sets background color matching theme and recolors views on theme update", () => {
		mockSetBackgroundColor.mockClear();
		const store = {
			settings: {
				theme: "dark" as const,
				confirmCloseTab: true,
				terminal: { shell: "" },
				browser: {},
				workspace: { defaultPath: "/tmp" },
			},
		};
		const send = vi.fn();
		const window = {
			isDestroyed: () => false,
			webContents: { isDestroyed: () => false, send, getZoomFactor: () => 1 },
			contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
		};
		const host = new WorkspaceHost(window as never, store as never);
		const doc = createMockDocument();
		host.syncWithDocument(doc);

		expect(mockSetBackgroundColor).toHaveBeenCalledWith(BROWSER_BG_DARK);

		// Switch theme to light
		store.settings.theme = "light";
		host.updateTheme();
		expect(mockSetBackgroundColor).toHaveBeenLastCalledWith(BROWSER_BG_LIGHT);
	});
});
