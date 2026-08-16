import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettingsStore } from "../src/main/app-settings";
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
		};
		setBounds = vi.fn();
		setBackgroundColor = vi.fn();
	},
}));

describe("WorkspaceHost settings integration", () => {
	let tempDir: string;
	let settingsStore: AppSettingsStore;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "bl-settings-test-"));
		settingsStore = new AppSettingsStore(tempDir, "/custom/default/workspace");
		await settingsStore.load();
	});

	afterEach(async () => {
		await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		vi.clearAllMocks();
	});

	function createHost(store: AppSettingsStore) {
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
		const host = new WorkspaceHost(window as never, store);
		return { host, send };
	}

	it("uses configured searchEngine when navigating to a search term", async () => {
		await settingsStore.update({
			browser: {
				searchEngine: "https://duckduckgo.com/?q=%s",
			},
		});

		const { host } = createHost(settingsStore);

		const fakeDoc: WorkspaceDocumentV1 = {
			version: 1,
			revision: 1,
			workspaces: [{ id: "ws_main", label: "Main", locationId: "loc_main" }],
			locations: [{ id: "loc_main", kind: "local", path: "/test", lifecycle: { generation: 1 } }],
			tabs: [
				{
					id: "tab_main",
					workspaceId: "ws_main",
					title: "Tab 1",
					layout: "single",
					activePaneId: "browser-1",
					paneIds: ["browser-1"],
				},
			],
			panes: [{ id: "browser-1", tabId: "tab_main", kind: "browser", entityId: "b-1" }],
			browsers: [{ id: "b-1", paneId: "browser-1", url: "https://omp.sh" }],
			terminals: [],
			agents: [],
		};

		let executedCommand: unknown;
		const fakeClient = {
			isConnected: true,
			document: fakeDoc,
			executeCommandWithRetry: vi.fn(async (builder: (doc: WorkspaceDocumentV1) => unknown) => {
				executedCommand = builder(fakeDoc);
				return { status: "accepted", document: fakeDoc };
			}),
		};

		host.setClient(fakeClient as never);
		host.syncWithDocument(fakeDoc);

		await host.navigateBrowser("browser-1", "vitest testing framework");

		expect(executedCommand).toMatchObject({
			type: "browser.navigate",
			payload: {
				id: "b-1",
				url: "https://duckduckgo.com/?q=vitest%20testing%20framework",
			},
		});
	});

	it("uses configured defaultUrl when opening with an empty url", async () => {
		await settingsStore.update({
			browser: {
				defaultUrl: "https://custom-start.example.com",
			},
		});

		const { host } = createHost(settingsStore);

		const fakeDoc: WorkspaceDocumentV1 = {
			version: 1,
			revision: 1,
			workspaces: [{ id: "ws_main", label: "Main", locationId: "loc_main" }],
			locations: [{ id: "loc_main", kind: "local", path: "/test", lifecycle: { generation: 1 } }],
			tabs: [
				{
					id: "tab_main",
					workspaceId: "ws_main",
					title: "Tab 1",
					layout: "single",
					activePaneId: "browser-1",
					paneIds: ["browser-1"],
				},
			],
			panes: [],
			browsers: [],
			terminals: [],
			agents: [],
		};

		let executedCommand: unknown;
		const fakeClient = {
			isConnected: true,
			document: fakeDoc,
			executeCommandWithRetry: vi.fn(async (builder: (doc: WorkspaceDocumentV1) => unknown) => {
				executedCommand = builder(fakeDoc);
				return { status: "accepted", document: fakeDoc };
			}),
		};

		host.setClient(fakeClient as never);
		host.syncWithDocument(fakeDoc);

		await host.createBrowser({
			id: "browser-2",
			tabId: "tab_main",
			workspaceId: "ws_main",
			url: "",
		});

		expect(executedCommand).toMatchObject({
			type: "browser.open",
			payload: {
				url: "https://custom-start.example.com/",
			},
		});
	});

	it("uses configured workspace.defaultPath and terminal.shell when opening a terminal", async () => {
		await settingsStore.update({
			workspace: {
				defaultPath: "/workspace/projects/custom",
			},
			terminal: {
				shell: "/bin/fish",
			},
		});
		const { host } = createHost(settingsStore);

		const fakeDoc: WorkspaceDocumentV1 = {
			version: 1,
			schemaVersion: 1,
			activeWorkspaceId: "ws_main",
			activeTabId: "tab_main",
			revision: 1,
			workspaces: [{ id: "ws_main", label: "Main", locationId: "loc_main" }],
			locations: [{ id: "loc_main", kind: "local", path: "/test", lifecycle: { generation: 1 } }],
			tabs: [
				{
					id: "tab_main",
					workspaceId: "ws_main",
					title: "Tab 1",
					layout: "single",
					activePaneId: "term-1",
					paneIds: ["term-1"],
				},
			],
			panes: [],
			browsers: [],
			terminals: [],
			agents: [],
		};

		let executedCommand: unknown;
		const fakeClient = {
			isConnected: true,
			document: fakeDoc,
			executeCommandWithRetry: vi.fn(async (builder: (doc: WorkspaceDocumentV1) => unknown) => {
				executedCommand = builder(fakeDoc);
				const updatedDoc: WorkspaceDocumentV1 = {
					...fakeDoc,
					terminals: [{ id: "term-term-pane-1", paneId: "term-pane-1", status: "starting" as const }],
				};
				return { status: "accepted", document: updatedDoc };
			}),
			subscribeTerminalOutput: vi.fn(() => () => {}),
			subscribeTerminal: vi.fn(async () => ({ status: "running" as const, offset: 0 })),
			onTerminalOutput: vi.fn(() => () => {}),
		};
		host.setClient(fakeClient as never);
		host.syncWithDocument(fakeDoc);

		await host.createTerminal({
			id: "term-pane-1",
			tabId: "tab_main",
			workspaceId: "ws_main",
			cols: 80,
			rows: 24,
		});

		expect(executedCommand).toMatchObject({
			type: "terminal.open",
			payload: {
				cwd: "/workspace/projects/custom",
				shell: "/bin/fish",
			},
		});
	});

	it("immediately reflects live settings updates without re-instantiation", async () => {
		const { host } = createHost(settingsStore);

		const fakeDoc: WorkspaceDocumentV1 = {
			version: 1,
			revision: 1,
			workspaces: [{ id: "ws_main", label: "Main", locationId: "loc_main" }],
			locations: [{ id: "loc_main", kind: "local", path: "/test", lifecycle: { generation: 1 } }],
			tabs: [
				{
					id: "tab_main",
					workspaceId: "ws_main",
					title: "Tab 1",
					layout: "single",
					activePaneId: "browser-1",
					paneIds: ["browser-1"],
				},
			],
			panes: [{ id: "browser-1", tabId: "tab_main", kind: "browser", entityId: "b-1" }],
			browsers: [{ id: "b-1", paneId: "browser-1", url: "https://omp.sh" }],
			terminals: [],
			agents: [],
		};

		let executedCommand: unknown;
		const fakeClient = {
			isConnected: true,
			document: fakeDoc,
			executeCommandWithRetry: vi.fn(async (builder: (doc: WorkspaceDocumentV1) => unknown) => {
				executedCommand = builder(fakeDoc);
				return { status: "accepted", document: fakeDoc };
			}),
		};

		host.setClient(fakeClient as never);
		host.syncWithDocument(fakeDoc);

		// First search with default Google
		await host.navigateBrowser("browser-1", "query 1");
		expect(executedCommand).toMatchObject({
			type: "browser.navigate",
			payload: { id: "b-1", url: "https://www.google.com/search?q=query%201" },
		});

		// Update settings live to Brave
		await settingsStore.update({
			browser: { searchEngine: "https://search.brave.com/search?q=%s" },
		});

		// Second search with updated engine
		await host.navigateBrowser("browser-1", "query 2");
		expect(executedCommand).toMatchObject({
			type: "browser.navigate",
			payload: { id: "b-1", url: "https://search.brave.com/search?q=query%202" },
		});

		// Reset settings back to defaults
		await settingsStore.reset();

		// Third search reverts to default Google
		await host.navigateBrowser("browser-1", "query 3");
		expect(executedCommand).toMatchObject({
			type: "browser.navigate",
			payload: { id: "b-1", url: "https://www.google.com/search?q=query%203" },
		});
	});

	it("handles delayed settings loading without falling back to stale defaults on subsequent actions", async () => {
		const uninitializedStore = new AppSettingsStore(tempDir, "/custom/delayed/path");
		const { host } = createHost(uninitializedStore);

		const fakeDoc: WorkspaceDocumentV1 = {
			version: 1,
			revision: 1,
			workspaces: [{ id: "ws_main", label: "Main", locationId: "loc_main" }],
			locations: [{ id: "loc_main", kind: "local", path: "/test", lifecycle: { generation: 1 } }],
			tabs: [
				{
					id: "tab_main",
					workspaceId: "ws_main",
					title: "Tab 1",
					layout: "single",
					activePaneId: "term-1",
					paneIds: ["term-1"],
				},
			],
			panes: [],
			browsers: [],
			terminals: [],
			agents: [],
		};

		let executedCommand: unknown;
		const fakeClient = {
			isConnected: true,
			document: fakeDoc,
			executeCommandWithRetry: vi.fn(async (builder: (doc: WorkspaceDocumentV1) => unknown) => {
				executedCommand = builder(fakeDoc);
				const updatedDoc: WorkspaceDocumentV1 = {
					...fakeDoc,
					terminals: [{ id: "term-term-pane-1", paneId: "term-pane-1", status: "starting" as const }],
				};
				return { status: "accepted", document: updatedDoc };
			}),
			subscribeTerminalOutput: vi.fn(() => () => {}),
			subscribeTerminal: vi.fn(async () => ({ status: "running" as const, offset: 0 })),
			onTerminalOutput: vi.fn(() => () => {}),
		};
		host.setClient(fakeClient as never);
		host.syncWithDocument(fakeDoc);

		// Simulate delayed load completing after host creation
		await uninitializedStore.load();
		await uninitializedStore.update({
			workspace: { defaultPath: "/custom/delayed/path" },
			terminal: { shell: "/bin/zsh" },
		});

		await host.createTerminal({
			id: "term-pane-1",
			tabId: "tab_main",
			workspaceId: "ws_main",
			cols: 80,
			rows: 24,
		});

		expect(executedCommand).toMatchObject({
			type: "terminal.open",
			payload: {
				cwd: "/custom/delayed/path",
				shell: "/bin/zsh",
			},
		});
	});

	it("updates theme in settings store and verifies persistence", async () => {
		const updated = await settingsStore.update({ theme: "light" });
		expect(updated.theme).toBe("light");
		expect(settingsStore.settings.theme).toBe("light");

		const reloaded = new AppSettingsStore(tempDir, "/custom/default/workspace");
		await reloaded.load();
		expect(reloaded.settings.theme).toBe("light");

		const systemTheme = await settingsStore.update({ theme: "system" });
		expect(systemTheme.theme).toBe("system");
		expect(settingsStore.settings.theme).toBe("system");
	});
});
