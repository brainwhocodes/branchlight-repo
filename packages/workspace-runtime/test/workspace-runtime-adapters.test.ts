import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceAgentProfileV1, WorkspaceCommandV1 } from "@oh-my-pi/pi-wire";
import {
	AcpAgentAdapter,
	createAgentSessionAdapter,
	RawTerminalAgentAdapter,
	WorkspaceClient,
	WorkspaceServer,
} from "../src";

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

describe("Agent Session Adapters Real Round-Trip", () => {
	let testRoot: string;
	let server: WorkspaceServer;
	let client: WorkspaceClient;

	beforeEach(async () => {
		const tmp = await fsp.realpath(os.tmpdir());
		testRoot = await fsp.mkdtemp(path.join(tmp, "omp-test-adapters-"));
		server = new WorkspaceServer({ runtimeRoot: testRoot });
		await server.start();

		client = new WorkspaceClient({ runtimeRoot: testRoot });
		await client.connect();

		// Set up workspace, location, profile, session, and agent
		const r1 = await client.executeCommand(
			makeCommand(
				"ws-test",
				"workspace.create",
				0,
				{
					locationId: "loc-test",
					locationName: "Local Test",
					address: { kind: "local", path: "/tmp" },
					name: "Test Workspace",
				},
				"cmd-setup-ws",
			),
		);
		expect(r1.status).toBe("accepted");

		const r2 = await client.executeCommand(
			makeCommand(
				"ws-test",
				"profile.create",
				1,
				{
					id: "prof-omp",
					name: "OMP Profile",
					protocol: "omp",
					config: {},
				},
				"cmd-setup-prof",
			),
		);
		expect(r2.status).toBe("accepted");

		const r3 = await client.executeCommand(
			makeCommand(
				"ws-test",
				"agent.start",
				2,
				{
					id: "agent-1",
					profileId: "prof-omp",
					sessionId: "sess-omp-1",
				},
				"cmd-setup-agent",
			),
		);
		expect(r3.status).toBe("accepted");

		const r4 = await client.executeCommand(
			makeCommand(
				"ws-test",
				"terminal.open",
				3,
				{
					id: "term-1",
					locationId: "loc-test",
					label: "Terminal 1",
				},
				"cmd-setup-term",
			),
		);
		expect(r4.status).toBe("accepted");
	});

	afterEach(async () => {
		await client.close();
		if (server.isListening) {
			await server.stop();
		}
		try {
			await fsp.rm(testRoot, { recursive: true, force: true });
		} catch {}
	});

	it("executes real round-trip message and element edit over OmpAgentAdapter", async () => {
		const messages: string[] = [];
		const statuses: string[] = [];

		const profile: WorkspaceAgentProfileV1 = {
			id: "prof-omp",
			name: "OMP Profile",
			protocol: "omp",
			config: {},
			capabilityIds: [],
		};

		const adapter = createAgentSessionAdapter({
			sessionId: "sess-omp-1",
			agentId: "agent-1",
			profile,
			client,
			onMessage: (_id, msg) => messages.push(msg),
			onStatusChange: (_id, status) => statuses.push(status),
		});

		expect(adapter.protocol).toBe("omp");
		expect(adapter.status).toBe("opening");

		await adapter.start();
		expect(adapter.status).toBe("active");
		expect(statuses).toContain("active");

		// Send real message with element edit to the workspace
		await adapter.sendMessage("Create component", {
			sessionId: "sess-omp-1",
			target: "term-1",
			operation: "insert",
			value: "export const App = () => null;",
		});

		expect(messages).toContain("Create component");

		// Verify document on server updated with the element edit
		const updatedDoc = await client.getDocument();
		expect(updatedDoc.elementEdits).toHaveLength(1);
		expect(updatedDoc.elementEdits[0].value).toBe("export const App = () => null;");
		expect(updatedDoc.elementEdits[0].sessionId).toBe("sess-omp-1");

		await adapter.stop();
		expect(adapter.status).toBe("closed");
	});

	it("handles ACP JSON-RPC handshake and session prompts", async () => {
		const profile: WorkspaceAgentProfileV1 = {
			id: "prof-acp",
			name: "ACP Profile",
			protocol: "acp",
			config: {},
			capabilityIds: [],
		};

		const adapter = createAgentSessionAdapter({
			sessionId: "sess-omp-1",
			agentId: "agent-1",
			profile,
			client,
		});

		expect(adapter instanceof AcpAgentAdapter).toBe(true);
		await adapter.start();

		// 1. session/initialize
		const initRes = await (adapter as AcpAgentAdapter).handleJsonRpc({
			jsonrpc: "2.0",
			id: "req-1",
			method: "session/initialize",
			params: {},
		});
		expect(initRes.result).toBeDefined();
		expect((initRes.result as Record<string, unknown>).protocolVersion).toBe("1.0");

		// 2. session/prompt
		const promptRes = await (adapter as AcpAgentAdapter).handleJsonRpc({
			jsonrpc: "2.0",
			id: "req-2",
			method: "session/prompt",
			params: {
				prompt: "Refactor error handler",
			},
		});
		expect(promptRes.result).toEqual({ status: "accepted" });

		await adapter.stop();
		expect(adapter.status).toBe("closed");
	});

	it("routes raw terminal input commands through RawTerminalAgentAdapter", async () => {
		const profile: WorkspaceAgentProfileV1 = {
			id: "prof-term",
			name: "Terminal Profile",
			protocol: "terminal",
			config: {},
			capabilityIds: [],
		};

		const adapter = createAgentSessionAdapter({
			sessionId: "sess-omp-1",
			terminalId: "term-1",
			profile,
			client,
		});

		expect(adapter instanceof RawTerminalAgentAdapter).toBe(true);
		await adapter.start();

		// Send terminal input
		await adapter.sendMessage("ls -la\n");

		await adapter.stop();
		expect(adapter.status).toBe("closed");
	});
});
