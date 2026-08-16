import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceClient, WorkspaceServer } from "@oh-my-pi/pi-workspace-runtime";
import { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shutdownDesktopServices } from "../src/main/shutdown";
import { WorkspaceHost } from "../src/main/workspace-host";

vi.mock("electron", () => {
	class MockWebContents {
		isDestroyed() {
			return false;
		}
		close() {}
	}
	class MockWebContentsView {
		webContents = new MockWebContents();
		setBackgroundColor() {}
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

describe("Sequential application shutdown and terminal teardown", () => {
	it("executes teardown sequence in strict order and blocks later stages until earlier stages release", async () => {
		const order: string[] = [];
		const hostStopGate = Promise.withResolvers<void>();
		const workspaceStopGate = Promise.withResolvers<void>();

		const mockHost = {
			stopAll: vi.fn(async () => {
				await hostStopGate.promise;
				order.push("host.stopAll");
			}),
			close: vi.fn(async () => {
				order.push("host.close");
			}),
		};
		const mockWorkspace = {
			stop: vi.fn(async () => {
				await workspaceStopGate.promise;
				order.push("workspace.stop");
			}),
		};
		const mockClient = {
			close: vi.fn(async () => {
				expect(order).toContain("workspace.stop");
				expect(order).toContain("host.stopAll");
				order.push("client.close");
			}),
		};
		const mockQuit = vi.fn(() => {
			expect(order).toContain("host.close");
			order.push("quit");
		});

		const shutdownPromise = shutdownDesktopServices({
			host: mockHost,
			workspace: mockWorkspace,
			runtimeClient: mockClient,
			quit: mockQuit,
		});
		expect(order).toHaveLength(0);
		expect(mockClient.close).not.toHaveBeenCalled();
		hostStopGate.resolve();
		await Promise.resolve();
		expect(order).toEqual(["host.stopAll"]);
		expect(mockClient.close).not.toHaveBeenCalled();
		workspaceStopGate.resolve();
		await shutdownPromise;
		expect(order).toEqual(["host.stopAll", "workspace.stop", "client.close", "host.close", "quit"]);
	});

	it("continues through client cleanup even if workspace stop throws", async () => {
		const order: string[] = [];
		const mockWorkspace = {
			stop: vi.fn(async () => {
				order.push("workspace.stop:throw");
				throw new Error("Teardown error");
			}),
		};
		const mockClient = {
			close: vi.fn(async () => {
				order.push("client.close");
			}),
		};
		const mockQuit = vi.fn(() => {
			order.push("quit");
		});

		await shutdownDesktopServices({
			workspace: mockWorkspace,
			runtimeClient: mockClient,
			quit: mockQuit,
		});
		expect(order).toEqual(["workspace.stop:throw", "client.close", "quit"]);
	});

	describe("Integration with runtime server authority", () => {
		let testDir: string;
		let server: WorkspaceServer;
		let client: WorkspaceClient;
		let workspaceHost: WorkspaceHost;

		beforeEach(async () => {
			const rawDir = await fs.mkdtemp(path.join(os.tmpdir(), "branchlight-shutdown-test-"));
			testDir = await fs.realpath(rawDir);
			server = new WorkspaceServer({ runtimeRoot: testDir });
			await server.start();

			client = new WorkspaceClient({ runtimeRoot: testDir });
			await client.connect();

			await client.executeCommand({
				version: 1,
				commandId: "cmd-ws-1",
				workspaceId: "ws-shutdown",
				expectedRevision: 0,
				issuedAt: Date.now(),
				type: "workspace.create",
				payload: {
					name: "Shutdown Workspace",
					locationId: "loc-shutdown",
					locationName: "Local",
					address: { kind: "local", path: testDir },
				},
			});

			await client.executeCommand({
				version: 1,
				commandId: "cmd-prof-1",
				workspaceId: "ws-shutdown",
				expectedRevision: 1,
				issuedAt: Date.now(),
				type: "profile.create",
				payload: {
					id: "profile-omp",
					name: "Oh My Pi",
					protocol: "omp",
					config: {},
				},
			});

			const mockWindow = new BrowserWindow();
			workspaceHost = new WorkspaceHost(mockWindow);
			workspaceHost.setClient(client);
			workspaceHost.syncWithDocument(client.document!);
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

		it("disconnects the desktop presentation without closing runtime-owned panes or PTYs", async () => {
			await workspaceHost.createTerminal({
				id: "pane-term-1",
				tabId: "tab-term-1",
				workspaceId: "ws-shutdown",
				cols: 80,
				rows: 24,
			});

			const attachRes = await client.executeCommand({
				version: 1,
				commandId: "cmd-attach-shutdown",
				workspaceId: "ws-shutdown",
				expectedRevision: client.document?.revision ?? 2,
				issuedAt: Date.now(),
				type: "agent.attach",
				payload: {
					id: "agent-shutdown-1",
					profileId: "profile-omp",
					sessionId: "sess-shutdown-1",
					terminalId: "term-pane-term-1",
					paneId: "pane-term-1",
				},
			});
			expect(attachRes.status).toBe("accepted");

			let quitCalled = false;
			await shutdownDesktopServices({
				workspace: workspaceHost,
				runtimeClient: client,
				quit: () => {
					quitCalled = true;
				},
			});

			expect(quitCalled).toBe(true);
			expect(server.isListening).toBe(true);
			expect(client.isConnected).toBe(false);

			const probe = new WorkspaceClient({ runtimeRoot: testDir });
			await probe.connect();
			let document = await probe.getDocument();
			await vi.waitFor(async () => {
				document = await probe.getDocument();
				expect(document.agents.find(item => item.id === "agent-shutdown-1")?.status).toBe("stopped");
			});
			expect(document.terminals.some(item => item.id === "term-pane-term-1")).toBe(true);
			expect(document.sessions.find(item => item.id === "sess-shutdown-1")?.status).toBe("closed");
			const terminal = document.terminals.find(item => item.id === "term-pane-term-1");
			expect(terminal?.status).toBe("running");
			await probe.close();
		});
	});
});
