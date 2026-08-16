import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceClient, WorkspaceServer } from "@oh-my-pi/pi-workspace-runtime";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopHost } from "../src/main/desktop-host";
import { WorkspaceHost } from "../src/main/workspace-host";

vi.mock("electron", () => {
	class MockWebContents {
		debugger = {
			isAttached: () => true,
			attach: vi.fn(),
			sendCommand: vi.fn(async (method: string) => {
				if (method === "DOM.describeNode") {
					return {
						node: {
							localName: "button",
							attributes: [
								"id",
								"submit-order",
								"class",
								"btn-primary",
								"role",
								"button",
								"aria-label",
								"Submit",
							],
						},
					};
				}
				if (method === "DOM.getBoxModel") {
					return {
						model: {
							border: [10, 20, 110, 20, 110, 60, 10, 60],
							width: 100,
							height: 40,
						},
					};
				}
				return {};
			}),
			on: vi.fn(),
			removeAllListeners: vi.fn(),
		};
		isDestroyed = () => false;
		loadURL = vi.fn(async () => {});
		on = vi.fn();
		setWindowOpenHandler = vi.fn();
		capturePage = vi.fn(async () => ({
			toJPEG: () => Buffer.from("fake-jpeg-bytes"),
			getSize: () => ({ width: 800, height: 600 }),
		}));
	}

	class MockWebContentsView {
		webContents = new MockWebContents();
		setBackgroundColor = vi.fn();
		setBounds = vi.fn();
	}

	return {
		app: { getPath: () => "/tmp/branchlight-test-user-data" },
		BrowserWindow: class {
			isDestroyed = () => false;
			webContents = {
				isDestroyed: () => false,
				send: vi.fn(),
			};
			contentView = {
				addChildView: vi.fn(),
				removeChildView: vi.fn(),
			};
		},
		WebContentsView: MockWebContentsView,
		Menu: { buildFromTemplate: () => ({ popup: vi.fn() }) },
		dialog: { showOpenDialog: vi.fn() },
		shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
	};
});

describe("Element Selection End-to-End Workflow with Authenticated Runtime", () => {
	let testDir: string;
	let server: WorkspaceServer;
	let client: WorkspaceClient;
	let desktopHost: DesktopHost;
	let workspaceHost: WorkspaceHost;

	beforeEach(async () => {
		const rawDir = await mkdtemp(path.join(os.tmpdir(), "branchlight-auth-test-"));
		testDir = await realpath(rawDir);
		server = new WorkspaceServer({ runtimeRoot: testDir });
		await server.start();

		client = new WorkspaceClient({ runtimeRoot: testDir });
		await client.connect();

		// 1. Create workspace with location
		const createWsCmd = {
			version: 1 as const,
			commandId: "cmd-ws-create-1",
			workspaceId: "ws_alpha",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create" as const,
			payload: {
				name: "Alpha Workspace",
				locationId: "loc_alpha",
				locationName: "Local Location",
				address: { kind: "local", path: testDir },
			},
		};
		const res1 = await client.executeCommand(createWsCmd);
		expect(res1.status).toBe("accepted");

		// 2. Create agent profile and start agent
		const createProfCmd = {
			version: 1 as const,
			commandId: "cmd-prof-create-1",
			workspaceId: "ws_alpha",
			expectedRevision: 1,
			issuedAt: Date.now(),
			type: "profile.create" as const,
			payload: {
				id: "prof_main",
				name: "Main Profile",
				config: {},
			},
		};
		const res2 = await client.executeCommand(createProfCmd);
		expect(res2.status).toBe("accepted");

		const startAgentCmd = {
			version: 1 as const,
			commandId: "cmd-agent-start-1",
			workspaceId: "ws_alpha",
			expectedRevision: 2,
			issuedAt: Date.now(),
			type: "agent.start" as const,
			payload: {
				id: "agent_alpha",
				profileId: "prof_main",
				sessionId: "session_alpha",
			},
		};
		const res3 = await client.executeCommand(startAgentCmd);
		expect(res3.status).toBe("accepted");

		// 3. Open browser pane
		const openBrowserCmd = {
			version: 1 as const,
			commandId: "cmd-browser-open-1",
			workspaceId: "ws_alpha",
			expectedRevision: 3,
			issuedAt: Date.now(),
			type: "browser.open" as const,
			payload: {
				id: "browser_1",
				paneId: "pane-browser-1",
				tabId: "tab_alpha",
				url: "https://omp.sh",
			},
		};
		const res4 = await client.executeCommand(openBrowserCmd);
		expect(res4.status).toBe("accepted");

		desktopHost = new DesktopHost(testDir);
		await desktopHost.load();
		expect(client.principal).toBeDefined();
		desktopHost.setWorkspaceAuthority(client.principal!, res4.document);
		const mockWindow = new (await import("electron")).BrowserWindow();

		workspaceHost = new WorkspaceHost(mockWindow as unknown as BrowserWindow);
		workspaceHost.setClient(client);
		workspaceHost.syncWithDocument(res4.document);
	});

	afterEach(async () => {
		await client.close();
		if (server.isListening) {
			await server.stop();
		}
		await workspaceHost.stop();
		await desktopHost.close();
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("executes complete authenticated start -> inspect -> commit -> cancel flow", async () => {
		// 1. Create browser pane in workspace
		const browserState = await workspaceHost.createBrowser({
			id: "pane-browser-1",
			url: "https://omp.sh",
			workspaceId: "ws_alpha",
			tabId: "tab_alpha",
		});
		expect(browserState.id).toBe("pane-browser-1");

		// 2. Reject selection without explicit target agent or on unauthenticated agent
		expect(() => desktopHost.resolveSelectionScope("pane-browser-1", "unknown_agent", 1)).toThrow(
			"not found in authenticated workspace authority",
		);

		// 3. Reject missing/invalid documentEpoch or non-existent pane
		expect(() => workspaceHost.getBrowserDocumentEpoch("non-existent-pane")).toThrow("not found");
		const doc = client.document!;
		const defaultAgent = doc.agents[0];
		expect(defaultAgent).toBeDefined();

		expect(() => desktopHost.resolveSelectionScope("pane-browser-1", defaultAgent.id, undefined)).toThrow(
			"Valid positive documentEpoch is required",
		);

		// 4. Resolve authenticated SelectionAuthScope from verified authority
		const epoch = workspaceHost.getBrowserDocumentEpoch("pane-browser-1");
		expect(epoch).toBe(1);

		const scope = desktopHost.resolveSelectionScope("pane-browser-1", defaultAgent.id, epoch);
		expect(scope.documentEpoch).toBe(1);
		expect(scope.workspaceId).toBe("ws_alpha");
		expect(scope.paneId).toBe("pane-browser-1");
		expect(scope.locationId).toBe("loc_alpha");
		expect(scope.locationGeneration).toBe(1);
		expect(scope.agentId).toBe(defaultAgent.id);

		// 5. Start selection on the browser pane with authenticated scope
		const pickingState = await workspaceHost.startSelection(scope);
		expect(pickingState.phase).toBe("picking");
		expect(pickingState.workspaceId).toBe("ws_alpha");
		expect(pickingState.paneId).toBe("pane-browser-1");

		// 6. Commit selection delivers to agent and ends selection cleanly
		const committedState = await workspaceHost.commitSelection("pane-browser-1");
		expect(committedState.phase).toBe("idle");
		expect(workspaceHost.getSelectionState("pane-browser-1").phase).toBe("idle");
	});

	it("surfaces delivery_failed error when agent message is rejected", async () => {
		const doc = client.document!;
		const defaultAgent = doc.agents[0]!;
		const epoch = workspaceHost.getBrowserDocumentEpoch("pane-browser-1");
		const scope = desktopHost.resolveSelectionScope("pane-browser-1", defaultAgent.id, epoch);

		await workspaceHost.startSelection(scope);

		// Spy on executeCommandWithRetry to simulate agent.message command rejection
		const originalExecute = client.executeCommandWithRetry.bind(client);
		vi.spyOn(client, "executeCommandWithRetry").mockImplementation(async (buildCmd, opts) => {
			const cmd = buildCmd(client.document!);
			if (cmd.type === "agent.message") {
				return {
					status: "rejected",
					error: { code: "invalid_command", message: "Agent is busy" },
				} as never;
			}
			return originalExecute(buildCmd, opts);
		});

		const errorState = await workspaceHost.commitSelection("pane-browser-1");
		expect(errorState.phase).toBe("error");
		expect(errorState.error?.code).toBe("delivery_failed");
		expect(errorState.error?.message).toContain("Agent is busy");

		// Clean up
		await workspaceHost.cancelSelection("pane-browser-1");
	});
});
