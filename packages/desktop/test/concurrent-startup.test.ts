import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceClient, WorkspaceServer } from "@oh-my-pi/pi-workspace-runtime";
import { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHost } from "../src/main/workspace-host";

vi.mock("electron", () => {
	class MockWebContents {
		isDestroyed() {
			return false;
		}
		close() {}
		loadURL() {
			return Promise.resolve();
		}
		navigationHistory = {
			canGoBack: () => false,
			canGoForward: () => false,
		};
		on() {}
		setWindowOpenHandler() {}
	}
	class MockWebContentsView {
		webContents = new MockWebContents();
		setBackgroundColor() {}
		setBounds() {}
	}
	class MockBrowserWindow {
		contentView = {
			children: [] as unknown[],
			addChildView: vi.fn(),
			removeChildView: vi.fn(),
		};
		webContents = {
			send: vi.fn(),
			isDestroyed: () => false,
		};
		isDestroyed() {
			return false;
		}
	}
	return {
		app: { isPackaged: false, getPath: vi.fn(() => "/tmp") },
		BrowserWindow: MockBrowserWindow,
		WebContentsView: MockWebContentsView,
		Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
	};
});

describe("Concurrent terminal and browser startup with revision retries", () => {
	let testDir: string;
	let server: WorkspaceServer;
	let client: WorkspaceClient;
	let workspaceHost: WorkspaceHost;

	beforeEach(async () => {
		const rawDir = await fs.mkdtemp(path.join(os.tmpdir(), "branchlight-concurrent-test-"));
		testDir = await fs.realpath(rawDir);
		server = new WorkspaceServer({ runtimeRoot: testDir });
		await server.start();

		client = new WorkspaceClient({ runtimeRoot: testDir });
		await client.connect();

		// Create default workspace
		const wsRes = await client.executeCommand({
			version: 1,
			commandId: "cmd-ws-concurrent",
			workspaceId: "ws-concurrent",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create",
			payload: {
				name: "Concurrent Workspace",
				locationId: "loc-concurrent",
				locationName: "Local",
				address: { kind: "local", path: testDir },
			},
		});

		const mockWindow = new BrowserWindow();
		workspaceHost = new WorkspaceHost(mockWindow);
		workspaceHost.setClient(client);
		workspaceHost.syncWithDocument(wsRes.document);
	});

	afterEach(async () => {
		if (workspaceHost) {
			try {
				await workspaceHost.stop();
			} catch {}
		}
		if (client?.isConnected) {
			try {
				await client.close();
			} catch {}
		}
		if (server?.isListening) {
			try {
				await server.stop();
			} catch {}
		}
		if (testDir) {
			try {
				await fs.rm(testDir, { recursive: true, force: true });
			} catch {}
		}
	});

	it("creates terminal and browser concurrently without stale_revision failure", async () => {
		// Launch terminal and browser creation concurrently
		const [termState, browserState] = await Promise.all([
			workspaceHost.createTerminal({
				id: "pane-term-c1",
				tabId: "tab-terminal-c1",
				workspaceId: "ws-concurrent",
				cols: 80,
				rows: 24,
			}),
			workspaceHost.createBrowser({
				id: "pane-browser-c1",
				url: "https://omp.sh",
				workspaceId: "ws-concurrent",
				tabId: "tab-browser-c1",
			}),
		]);

		expect(termState.id).toBe("pane-term-c1");
		expect(browserState.id).toBe("pane-browser-c1");

		// Verify both entities exist authoritatively in the runtime document
		const doc = await client.getDocument();
		expect(doc.terminals.some(t => t.paneId === "pane-term-c1" && t.status !== "closed")).toBe(true);
		expect(doc.browsers.some(b => b.paneId === "pane-browser-c1" && b.status !== "closed")).toBe(true);
		expect(doc.revision).toBeGreaterThanOrEqual(3);
	});
});
