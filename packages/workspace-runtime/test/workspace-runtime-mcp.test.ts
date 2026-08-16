import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceCommandV1 } from "@oh-my-pi/pi-wire";
import { WorkspaceClient, WorkspaceMcpServer, WorkspaceServer } from "../src";

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

describe("WorkspaceMcpServer", () => {
	let testRoot: string;
	let server: WorkspaceServer;
	let client: WorkspaceClient;
	let mcpServer: WorkspaceMcpServer;

	beforeEach(async () => {
		const tmp = await fsp.realpath(os.tmpdir());
		testRoot = await fsp.mkdtemp(path.join(tmp, "omp-test-mcp-"));
		server = new WorkspaceServer({ runtimeRoot: testRoot });
		await server.start();

		client = new WorkspaceClient({ runtimeRoot: testRoot });
		await client.connect();

		await client.executeCommand(
			makeCommand(
				"ws-1",
				"workspace.create",
				0,
				{
					locationId: "loc-1",
					locationName: "Local",
					address: { kind: "local", path: "/tmp" },
					name: "MCP Workspace",
				},
				"cmd-mcp-ws",
			),
		);

		mcpServer = new WorkspaceMcpServer(client);
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

	it("registers mandated branchlight_<domain>_<verb> tools", () => {
		expect(mcpServer.tools.length).toBeGreaterThanOrEqual(10);
		for (const tool of mcpServer.tools) {
			expect(tool.name).toMatch(/^branchlight_[a-z]+_[a-z]+$/);
		}
		expect(mcpServer.tools.some(t => t.name === "branchlight_workspace_list")).toBe(true);
		expect(mcpServer.tools.some(t => t.name === "branchlight_terminal_open")).toBe(true);
		expect(mcpServer.tools.some(t => t.name === "branchlight_browser_navigate")).toBe(true);
	});

	it("executes tool calls and returns structured content", async () => {
		// 1. branchlight_workspace_list
		const listRes = await mcpServer.executeTool("branchlight_workspace_list", {});
		expect(listRes.isError).toBeFalsy();
		expect(listRes.content[0].text).toContain("MCP Workspace");

		// 2. branchlight_terminal_open
		const openRes = await mcpServer.executeTool("branchlight_terminal_open", {
			tabName: "Terminal MCP",
		});
		expect(openRes.isError).toBeFalsy();

		// 3. branchlight_notification_list
		const notifRes = await mcpServer.executeTool("branchlight_notification_list", {});
		expect(notifRes.isError).toBeFalsy();
		expect(notifRes.content[0].text).toBe("[]");
	});

	it("enforces capability restrictions on scoped MCP servers", async () => {
		const scopedMcp = new WorkspaceMcpServer({
			client,
			capabilities: [
				{
					capabilityId: "scoped-read-only",
					scope: "workspace",
					operations: ["attention.notify", "attention.dismiss"],
				},
			],
		});

		// Allowed call
		const readRes = await scopedMcp.executeTool("branchlight_workspace_list", {});
		expect(readRes.isError).toBeFalsy();

		// Unauthorized operation (branchlight_terminal_open mapped to terminal.open)
		const writeRes = await scopedMcp.executeTool("branchlight_terminal_open", {
			tabName: "Forbidden Terminal",
		});
		expect(writeRes.isError).toBe(true);
		expect(writeRes.content[0].text).toContain("Unauthorized");
	});
});
