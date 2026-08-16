import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceCommandV1, WorkspaceDocumentV1, WorkspaceEventV1 } from "@oh-my-pi/pi-wire";
import { createInitialWorkspaceDocumentV1, WorkspaceClient, WorkspaceServer, WorkspaceStore } from "../src";

function makeCommand(
	workspaceId: string,
	type: WorkspaceCommandV1["type"],
	expectedRevision: number,
	payload: Record<string, unknown>,
	commandId = `cmd-${Math.random().toString(36).slice(2)}`,
): WorkspaceCommandV1 {
	return {
		version: 1,
		commandId,
		workspaceId,
		expectedRevision,
		issuedAt: Date.now(),
		type,
		payload,
	};
}

describe("WorkspaceStore persistence & replay", () => {
	let testRoot: string;

	beforeEach(async () => {
		const tmp = await fsp.realpath(os.tmpdir());
		testRoot = await fsp.mkdtemp(path.join(tmp, "omp-test-store-"));
	});

	afterEach(async () => {
		try {
			await fsp.rm(testRoot, { recursive: true, force: true });
		} catch {}
	});

	it("initializes new store with empty document and persists snapshots atomically", async () => {
		const store = new WorkspaceStore({ runtimeRoot: testRoot });
		const state = await store.open();
		expect(state.document.version).toBe(1);
		expect(state.document.revision).toBe(0);
		expect(state.seenCommandIds.size).toBe(0);

		// Mutate and save snapshot
		const nextDoc: WorkspaceDocumentV1 = {
			...state.document,
			revision: 1,
			locations: [
				{
					id: "loc-1",
					name: "Local",
					address: { kind: "local", path: "/tmp" },
					lifecycle: { status: "active", generation: 1, updatedAt: 0 },
				},
			],
			workspaces: [{ id: "ws-1", name: "Workspace 1", locationId: "loc-1", generation: 1 }],
			updatedAt: Date.now(),
		};
		await store.saveSnapshot({
			document: nextDoc,
			seenCommandIds: new Set(["cmd-1"]),
			nextEventSequence: 2,
		});
		await store.close();

		// Re-open and verify persistence
		const store2 = new WorkspaceStore({ runtimeRoot: testRoot });
		const state2 = await store2.open();
		expect(state2.document.revision).toBe(1);
		expect(state2.document.workspaces).toHaveLength(1);
		expect(state2.document.workspaces[0].id).toBe("ws-1");
		expect(state2.seenCommandIds.has("cmd-1")).toBe(true);
		expect(state2.nextEventSequence).toBe(2);
		await store2.close();
	});
	it("migrates legacy tabs, preserves command history, and writes a secure backup", async () => {
		const initial = createInitialWorkspaceDocumentV1(0);
		const legacyDocument: Record<string, unknown> = {
			...initial,
			revision: 1,
			activeWorkspaceId: "ws-legacy",
			locations: [
				{
					id: "loc-legacy",
					name: "Legacy",
					address: { kind: "local", path: testRoot },
					lifecycle: { status: "active", generation: 1, updatedAt: 0 },
				},
			],
			workspaces: [
				{
					id: "ws-legacy",
					name: "Legacy Workspace",
					locationId: "loc-legacy",
					generation: 1,
				},
			],
			tabs: [
				{
					id: "tab-legacy",
					locationId: "loc-legacy",
					generation: 1,
					name: "Legacy Terminal",
					paneKind: "terminal",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-legacy"],
					activePaneId: "pane-legacy",
				},
			],
			panes: [
				{
					id: "pane-legacy",
					tabId: "tab-legacy",
					generation: 1,
					kind: "terminal",
					entityId: "terminal-legacy",
				},
			],
			terminals: [
				{
					id: "terminal-legacy",
					locationId: "loc-legacy",
					paneId: "pane-legacy",
					generation: 1,
					label: "Legacy Terminal",
					status: "exited",
				},
			],
		};
		const original = `${JSON.stringify({
			type: "snapshot",
			document: legacyDocument,
			seenCommandIds: ["cmd-preserve"],
			nextEventSequence: 4,
		})}\n`;
		await fsp.writeFile(path.join(testRoot, "workspace-state.jsonl"), original, { mode: 0o600 });

		const store = new WorkspaceStore({ runtimeRoot: testRoot });
		const state = await store.open();
		expect(state.document.tabs[0].workspaceId).toBe("ws-legacy");
		expect(state.seenCommandIds.has("cmd-preserve")).toBe(true);
		const names = await fsp.readdir(testRoot);
		expect(names.some(name => name.includes("migration-backup"))).toBe(true);
		const installed = await fsp.readFile(path.join(testRoot, "workspace-state.jsonl"), "utf8");
		expect(JSON.parse(installed).type).toBe("snapshot");
		expect(installed).not.toBe(original);
		await store.close();
	});

	it("replays commit log after restart and detects duplicate commands", async () => {
		const store = new WorkspaceStore({ runtimeRoot: testRoot });
		const state = await store.open();

		const doc1: WorkspaceDocumentV1 = {
			...state.document,
			revision: 1,
			locations: [
				{
					id: "loc-1",
					name: "Local",
					address: { kind: "local", path: "/tmp" },
					lifecycle: { status: "active", generation: 1, updatedAt: 0 },
				},
			],
			workspaces: [{ id: "ws-1", name: "Alpha", locationId: "loc-1", generation: 1 }],
			updatedAt: Date.now(),
		};
		const cmd1 = makeCommand(
			"ws-1",
			"workspace.create",
			0,
			{
				locationId: "loc-1",
				locationName: "Local",
				address: { kind: "local", path: "/tmp" },
				name: "Alpha",
			},
			"cmd-create-1",
		);

		await store.commitResult(cmd1, {
			status: "accepted",
			state: {
				document: doc1,
				seenCommandIds: new Set(["cmd-create-1"]),
				nextEventSequence: 2,
			},
			document: doc1,
			events: [
				{
					version: 1,
					eventId: "ev-1",
					workspaceId: "ws-1",
					sequence: 1,
					revision: 1,
					occurredAt: Date.now(),
					type: "workspace.created",
					payload: { workspaceId: "ws-1" },
				},
			],
			effects: [],
		});
		await store.close();

		// Reopen store to verify replay
		const store2 = new WorkspaceStore({ runtimeRoot: testRoot });
		const state2 = await store2.open();
		expect(state2.document.revision).toBe(1);
		expect(state2.document.workspaces[0].id).toBe("ws-1");
		expect(state2.seenCommandIds.has("cmd-create-1")).toBe(true);
		expect(state2.nextEventSequence).toBe(2);
		await store2.close();
	});
});

describe("WorkspaceServer & WorkspaceClient authority lifecycle", () => {
	let testRoot: string;
	let server: WorkspaceServer;

	beforeEach(async () => {
		const tmp = await fsp.realpath(os.tmpdir());
		testRoot = await fsp.mkdtemp(path.join(tmp, "omp-test-authority-"));
		server = new WorkspaceServer({ runtimeRoot: testRoot });
		await server.start();
	});

	afterEach(async () => {
		if (server.isListening) {
			await server.stop();
		}
		try {
			await fsp.rm(testRoot, { recursive: true, force: true });
		} catch {}
	});

	it("authenticates client with root control token and rejects invalid token", async () => {
		// Valid client
		const client = new WorkspaceClient({ runtimeRoot: testRoot });
		const doc = await client.connect();
		expect(doc.version).toBe(1);
		expect(client.isConnected).toBe(true);
		await client.close();

		// Invalid token client
		const badClient = new WorkspaceClient({
			runtimeRoot: testRoot,
			token: "invalid-token-here",
		});
		await expect(badClient.connect()).rejects.toThrow();
	});
	it("detaches agents when their authenticated connection closes", async () => {
		const operator = new WorkspaceClient({ runtimeRoot: testRoot });
		await operator.connect();
		const workspace = await operator.executeCommand(
			makeCommand(
				"ws-lease",
				"workspace.create",
				0,
				{
					locationId: "loc-lease",
					locationName: "Lease",
					address: { kind: "local", path: testRoot },
					name: "Lease Workspace",
				},
				"cmd-lease-workspace",
			),
		);
		expect(workspace.status).toBe("accepted");
		const profile = await operator.executeCommand(
			makeCommand(
				"ws-lease",
				"profile.create",
				workspace.document.revision,
				{
					id: "profile-lease",
					name: "Lease Profile",
					protocol: "omp",
					config: {},
				},
				"cmd-lease-profile",
			),
		);
		expect(profile.status).toBe("accepted");
		const terminal = await operator.executeCommand(
			makeCommand(
				"ws-lease",
				"terminal.open",
				profile.document.revision,
				{
					id: "terminal-lease",
					paneId: "pane-lease",
					tabId: "tab-lease",
					tabName: "Lease",
					locationId: "loc-lease",
					label: "Lease Terminal",
					profileId: "profile-lease",
					columns: 80,
					rows: 24,
				},
				"cmd-lease-terminal",
			),
		);
		expect(terminal.status).toBe("accepted");

		const scopedToken = "lease-scoped-token";
		server.registerScopedToken(scopedToken, {
			principal: { kind: "agent", id: "terminal-lease" },
			capabilities: [
				{
					capabilityId: "lease-capability",
					scope: "terminal",
					workspaceId: "ws-lease",
					locationId: "loc-lease",
					entityId: "terminal-lease",
					paneId: "pane-lease",
					generation: 1,
					operations: ["agent.attach", "agent.detach"],
				},
			],
		});
		const scoped = new WorkspaceClient({ runtimeRoot: testRoot, token: scopedToken });
		await scoped.connect();
		const attached = await scoped.executeCommand(
			makeCommand(
				"ws-lease",
				"agent.attach",
				terminal.document.revision,
				{
					id: "agent-lease",
					profileId: "profile-lease",
					sessionId: "session-lease",
					terminalId: "terminal-lease",
					paneId: "pane-lease",
				},
				"cmd-lease-attach",
			),
		);
		expect(attached.status).toBe("accepted");
		expect(attached.document.agents.find(item => item.id === "agent-lease")?.status).toBe("running");

		await scoped.close();
		let cleaned = await operator.getDocument();
		for (
			let attempt = 0;
			attempt < 20 && cleaned.agents.find(item => item.id === "agent-lease")?.status === "running";
			attempt++
		) {
			await Bun.sleep(10);
			cleaned = await operator.getDocument();
		}
		expect(cleaned.agents.find(item => item.id === "agent-lease")?.status).toBe("stopped");
		expect(cleaned.sessions.find(item => item.id === "session-lease")?.status).toBe("closed");
		await operator.close();
	});

	it("executes commands, persists changes, and broadcasts events in real-time", async () => {
		const client1 = new WorkspaceClient({ runtimeRoot: testRoot });
		await client1.connect();

		const eventSignal = Promise.withResolvers<WorkspaceEventV1>();
		const unsubscribe = client1.onEvent(event => {
			eventSignal.resolve(event);
		});

		const cmd = makeCommand(
			"ws-demo",
			"workspace.create",
			0,
			{
				locationId: "loc-demo",
				locationName: "Local Test",
				address: { kind: "local", path: "/tmp/demo" },
				name: "Demo Workspace",
			},
			"cmd-demo-1",
		);

		const result = await client1.executeCommand(cmd);
		expect(result.status).toBe("accepted");
		expect(result.document.revision).toBe(1);
		expect(result.document.workspaces).toHaveLength(1);
		expect(result.document.workspaces[0].name).toBe("Demo Workspace");

		const receivedEvent = await eventSignal.promise;
		expect(receivedEvent.type).toBe("workspace.created");

		unsubscribe();
		await client1.close();
	});
	it("prevents competing server startup with authority lock and preserves first server integrity", async () => {
		const client = new WorkspaceClient({ runtimeRoot: testRoot });
		await client.connect();
		const initialPing = await client.ping();
		expect(typeof initialPing).toBe("number");
		const originalToken = server.controlToken;

		// Competing server attempts to start in same runtime root
		const competingServer = new WorkspaceServer({ runtimeRoot: testRoot });
		await expect(competingServer.start()).rejects.toThrow(/authority lock already held/i);

		// First server's token, endpoint, and client connection remain 100% usable
		expect(server.controlToken).toBe(originalToken);
		expect(server.isListening).toBe(true);
		const postPing = await client.ping();
		expect(typeof postPing).toBe("number");

		// Command execution still works on the original server
		const cmd = makeCommand(
			"ws-contend",
			"workspace.create",
			0,
			{
				locationId: "loc-contend",
				locationName: "Contend Location",
				address: { kind: "local", path: "/tmp/contend" },
				name: "Contend Workspace",
			},
			"cmd-contend-1",
		);
		const res = await client.executeCommand(cmd);
		expect(res.status).toBe("accepted");

		await client.close();
	});

	it("handles accept -> restart -> duplicate recovery seamlessly", async () => {
		const client = new WorkspaceClient({ runtimeRoot: testRoot });
		await client.connect();

		const cmd = makeCommand(
			"ws-test",
			"workspace.create",
			0,
			{
				locationId: "loc-1",
				locationName: "Local",
				address: { kind: "local", path: "/tmp" },
				name: "Persistent Workspace",
			},
			"cmd-persist-1",
		);

		const result1 = await client.executeCommand(cmd);
		expect(result1.status).toBe("accepted");
		expect(result1.document.revision).toBe(1);
		await client.close();

		// Stop server
		await server.stop();

		// Restart server with same runtimeRoot
		const server2 = new WorkspaceServer({ runtimeRoot: testRoot });
		await server2.start();

		const client2 = new WorkspaceClient({ runtimeRoot: testRoot });
		const doc2 = await client2.connect();
		expect(doc2.revision).toBe(1);
		expect(doc2.workspaces).toHaveLength(1);
		expect(doc2.workspaces[0].name).toBe("Persistent Workspace");

		// Duplicate command execution
		const dupResult = await client2.executeCommand(cmd);
		expect(dupResult.status).toBe("duplicate");

		await client2.close();
		await server2.stop();
	});

	it("enforces server-assigned scoped token capability boundaries", async () => {
		const scopedToken = "agent-scoped-secret-token";
		server.registerScopedToken(scopedToken, {
			principal: { kind: "agent", id: "agent-worker" },
			capabilities: [
				{
					capabilityId: "scoped-agent",
					scope: "workspace",
					operations: ["attention.notify", "attention.dismiss"],
				},
			],
		});

		const scopedClient = new WorkspaceClient({
			runtimeRoot: testRoot,
			token: scopedToken,
		});
		await scopedClient.connect();

		// Allowed operation
		const notifyCmd = makeCommand(
			"ws-test",
			"attention.notify",
			0,
			{
				severity: "info",
				title: "Hello",
				message: "Agent ready",
			},
			"cmd-agent-notify",
		);

		const notifyResult = await scopedClient.executeCommand(notifyCmd);
		expect(notifyResult.status).toBe("accepted");

		// Unauthorized operation (workspace.create is not in scoped operations)
		const createCmd = makeCommand(
			"ws-forbidden",
			"workspace.create",
			1,
			{
				locationId: "loc-forbidden",
				locationName: "Forbidden",
				address: { kind: "local", path: "/tmp" },
				name: "Forbidden",
			},
			"cmd-forbidden-create",
		);

		const createResult = await scopedClient.executeCommand(createCmd);
		expect(createResult.status).toBe("rejected");
		expect(createResult.error?.code).toBe("unauthorized");

		await scopedClient.close();

		// Revoking token prevents further auth
		const revoked = server.revokeScopedToken(scopedToken);
		expect(revoked).toBe(true);

		const revokedClient = new WorkspaceClient({
			runtimeRoot: testRoot,
			token: scopedToken,
		});
		await expect(revokedClient.connect()).rejects.toThrow();
	});

	it("broadcasts document updates to all subscribed clients when commands are executed", async () => {
		const clientA = new WorkspaceClient({ runtimeRoot: testRoot });
		const clientB = new WorkspaceClient({ runtimeRoot: testRoot });

		const initialDocA = await clientA.connect();
		const initialDocB = await clientB.connect();
		expect(initialDocA.revision).toBe(0);
		expect(initialDocB.revision).toBe(0);
		expect(clientB.document?.revision).toBe(0);

		const documentReceived = Promise.withResolvers<WorkspaceDocumentV1>();
		const unsubscribeB = clientB.onDocument(doc => {
			if (doc.revision > 0) {
				documentReceived.resolve(doc);
			}
		});

		const cmd = makeCommand(
			"ws-broadcast",
			"workspace.create",
			0,
			{
				locationId: "loc-b",
				locationName: "Broadcast Location",
				address: { kind: "local", path: "/tmp/broadcast" },
				name: "Broadcast Workspace",
			},
			"cmd-bcast-1",
		);

		const resultA = await clientA.executeCommand(cmd);
		expect(resultA.status).toBe("accepted");
		expect(resultA.document.revision).toBe(1);
		expect(clientA.document?.revision).toBe(1);

		const updatedDocB = await documentReceived.promise;
		expect(updatedDocB.revision).toBe(1);
		expect(updatedDocB.workspaces).toHaveLength(1);
		expect(updatedDocB.workspaces[0].name).toBe("Broadcast Workspace");
		expect(clientB.document?.revision).toBe(1);
		expect(clientB.document?.workspaces[0].name).toBe("Broadcast Workspace");

		unsubscribeB();
		await clientA.close();
		await clientB.close();
	});
	it("executes commands with optimistic retry on stale revision and reuses commandId", async () => {
		const clientA = new WorkspaceClient({ runtimeRoot: testRoot });
		const clientB = new WorkspaceClient({ runtimeRoot: testRoot });
		await clientA.connect();
		await clientB.connect();

		// Client A creates workspace (revision moves from 0 to 1)
		const cmdA = makeCommand(
			"ws-retry",
			"workspace.create",
			0,
			{
				locationId: "loc-retry",
				locationName: "Retry Loc",
				address: { kind: "local", path: "/tmp" },
				name: "Retry Workspace",
			},
			"cmd-init",
		);
		await clientA.executeCommand(cmdA);

		// Client B had revision 0 initially; executeCommandWithRetry automatically retries and succeeds
		let capturedCommandId = "";
		const resultB = await clientB.executeCommandWithRetry(currentDoc => {
			const c = makeCommand(
				"ws-retry",
				"profile.create",
				currentDoc.revision,
				{
					id: "prof-retry",
					name: "Retry Profile",
					config: {},
					capabilityIds: [],
				},
				"cmd-profile-retry",
			);
			capturedCommandId = c.commandId;
			return c;
		});

		expect(resultB.status).toBe("accepted");
		expect(resultB.document.revision).toBe(2);
		expect(resultB.document.agentProfiles.some(p => p.id === "prof-retry")).toBe(true);

		// Duplicate execution returns duplicate without error
		const dupResult = await clientB.executeCommandWithRetry(currentDoc => {
			return makeCommand(
				"ws-retry",
				"profile.create",
				currentDoc.revision,
				{
					id: "prof-retry",
					name: "Retry Profile",
					config: {},
					capabilityIds: [],
				},
				capturedCommandId,
			);
		});
		expect(dupResult.status).toBe("duplicate");

		await clientA.close();
		await clientB.close();
	});
});
