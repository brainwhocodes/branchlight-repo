import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { type } from "@oh-my-pi/omptype";
import type { WorkspaceCommandV1 } from "@oh-my-pi/pi-wire";
import type { WorkspaceClient } from "../client";
import type { WorkspaceCapabilityGrantV1 } from "../types";

export const EmptySchema = type({});

export const WorkspaceCommandParamSchema = type({
	command: "object",
});

export const TerminalOpenParamSchema = type({
	"tabId?": "string",
	"tabName?": "string",
	"columns?": "number",
	"rows?": "number",
	"cwd?": "string",
});

export const TerminalWriteParamSchema = type({
	id: "string",
	data: "string",
});

export const TerminalReadParamSchema = type({
	id: "string",
	"fromOffset?": "number",
});

export const BrowserNavigateParamSchema = type({
	id: "string",
	url: "string",
});

export const BrowserQueryParamSchema = type({
	id: "string",
	selector: "string",
});

export const ServiceActionParamSchema = type({
	id: "string",
});

export const BRANCHLIGHT_MCP_TOOLS: readonly Tool[] = [
	{
		name: "branchlight_workspace_list",
		description: "List all workspaces and their current status",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "branchlight_workspace_get",
		description: "Get full document state for the active workspace",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "branchlight_workspace_command",
		description: "Execute a structured workspace command",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "object", description: "Structured workspace command" },
			},
			required: ["command"],
		},
	},
	{
		name: "branchlight_terminal_open",
		description: "Open a new terminal pane in the workspace",
		inputSchema: {
			type: "object",
			properties: {
				tabId: { type: "string" },
				tabName: { type: "string" },
				columns: { type: "number" },
				rows: { type: "number" },
				cwd: { type: "string" },
			},
		},
	},
	{
		name: "branchlight_terminal_write",
		description: "Write raw input data to a terminal pane",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				data: { type: "string" },
			},
			required: ["id", "data"],
		},
	},
	{
		name: "branchlight_terminal_read",
		description: "Read terminal output history from offset",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				fromOffset: { type: "number" },
			},
			required: ["id"],
		},
	},
	{
		name: "branchlight_browser_navigate",
		description: "Navigate a browser pane to a URL",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				url: { type: "string" },
			},
			required: ["id", "url"],
		},
	},
	{
		name: "branchlight_browser_query",
		description: "Query elements in a browser pane",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				selector: { type: "string" },
			},
			required: ["id", "selector"],
		},
	},
	{
		name: "branchlight_service_list",
		description: "List declared services in the workspace",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "branchlight_service_start",
		description: "Start a declared workspace service",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
			},
			required: ["id"],
		},
	},
	{
		name: "branchlight_service_stop",
		description: "Stop a running workspace service",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
			},
			required: ["id"],
		},
	},
	{
		name: "branchlight_notification_list",
		description: "List attention notifications",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
];

export interface WorkspaceMcpServerOptions {
	client: WorkspaceClient;
	capabilities?: readonly WorkspaceCapabilityGrantV1[];
	serverName?: string;
	serverVersion?: string;
}

export class WorkspaceMcpServer {
	readonly #client: WorkspaceClient;
	readonly #capabilities?: readonly WorkspaceCapabilityGrantV1[];
	readonly #server: Server;

	constructor(options: WorkspaceMcpServerOptions | WorkspaceClient) {
		if ("getDocument" in options) {
			this.#client = options;
		} else {
			this.#client = options.client;
			this.#capabilities = options.capabilities;
		}

		const name = "serverName" in options && options.serverName ? options.serverName : "branchlight-workspace";
		const version = "serverVersion" in options && options.serverVersion ? options.serverVersion : "1.0.0";

		this.#server = new Server({ name, version }, { capabilities: { tools: {} } });

		this.#setupHandlers();
	}

	get server(): Server {
		return this.#server;
	}

	get tools(): readonly Tool[] {
		return BRANCHLIGHT_MCP_TOOLS;
	}

	#setupHandlers(): void {
		this.#server.setRequestHandler(ListToolsRequestSchema, async () => {
			return { tools: [...BRANCHLIGHT_MCP_TOOLS] };
		});

		this.#server.setRequestHandler(CallToolRequestSchema, async request => {
			const { name, arguments: rawArgs } = request.params;
			const args = typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {};
			const result = await this.executeTool(name, args as Record<string, unknown>);
			return {
				content: result.content,
				isError: result.isError,
			};
		});
	}

	async executeTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
		try {
			if (this.#capabilities) {
				const operationMap: Record<string, string> = {
					branchlight_terminal_open: "terminal.open",
					branchlight_terminal_write: "terminal.input",
					branchlight_browser_navigate: "browser.navigate",
					branchlight_service_start: "service.start",
					branchlight_service_stop: "service.stop",
				};
				const op = operationMap[name];
				if (op) {
					const hasPermission = this.#capabilities.some(g =>
						g.operations.includes(op as WorkspaceCommandV1["type"]),
					);
					if (!hasPermission) {
						return {
							content: [{ type: "text", text: `Unauthorized: missing capability for ${op}` }],
							isError: true,
						};
					}
				}
			}

			switch (name) {
				case "branchlight_workspace_list": {
					const doc = await this.#client.getDocument();
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(doc.workspaces, null, 2),
							},
						],
					};
				}
				case "branchlight_workspace_get": {
					const doc = await this.#client.getDocument();
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(doc, null, 2),
							},
						],
					};
				}
				case "branchlight_workspace_command": {
					const cmd = args.command as WorkspaceCommandV1;
					const result = await this.#client.executeCommand(cmd);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(result, null, 2),
							},
						],
						isError: result.status === "rejected",
					};
				}
				case "branchlight_terminal_open": {
					const cmd: WorkspaceCommandV1 = {
						version: 1,
						commandId: `cmd-term-open-${Date.now()}`,
						workspaceId: this.#client.document?.activeWorkspaceId ?? "default",
						expectedRevision: this.#client.document?.revision ?? 0,
						issuedAt: Date.now(),
						type: "terminal.open",
						payload: {
							tabId: args.tabId,
							tabName: args.tabName,
							columns: args.columns,
							rows: args.rows,
							cwd: args.cwd,
						},
					};
					const result = await this.#client.executeCommand(cmd);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(result, null, 2),
							},
						],
						isError: result.status === "rejected",
					};
				}
				case "branchlight_terminal_write": {
					const id = typeof args.id === "string" ? args.id : "";
					const data = typeof args.data === "string" ? args.data : "";
					const cmd: WorkspaceCommandV1 = {
						version: 1,
						commandId: `cmd-write-${Date.now()}`,
						workspaceId: this.#client.document?.activeWorkspaceId ?? "default",
						expectedRevision: this.#client.document?.revision ?? 0,
						issuedAt: Date.now(),
						type: "terminal.input",
						payload: { id, data },
					};
					const result = await this.#client.executeCommand(cmd);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(result, null, 2),
							},
						],
						isError: result.status === "rejected",
					};
				}
				case "branchlight_terminal_read": {
					const id = typeof args.id === "string" ? args.id : "";
					const doc = await this.#client.getDocument();
					const terminal = doc.terminals.find(t => t.id === id);
					if (!terminal) {
						return {
							content: [{ type: "text", text: `Terminal ${id} not found` }],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(terminal, null, 2),
							},
						],
					};
				}
				case "branchlight_browser_navigate": {
					const id = typeof args.id === "string" ? args.id : "";
					const url = typeof args.url === "string" ? args.url : "";
					const cmd: WorkspaceCommandV1 = {
						version: 1,
						commandId: `cmd-nav-${Date.now()}`,
						workspaceId: this.#client.document?.activeWorkspaceId ?? "default",
						expectedRevision: this.#client.document?.revision ?? 0,
						issuedAt: Date.now(),
						type: "browser.navigate",
						payload: { id, url },
					};
					const result = await this.#client.executeCommand(cmd);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(result, null, 2),
							},
						],
						isError: result.status === "rejected",
					};
				}
				case "branchlight_browser_query": {
					const id = typeof args.id === "string" ? args.id : "";
					const selector = typeof args.selector === "string" ? args.selector : "";
					const doc = await this.#client.getDocument();
					const browser = doc.browsers.find(b => b.id === id);
					if (!browser) {
						return {
							content: [{ type: "text", text: `Browser ${id} not found` }],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ id, selector, url: browser.url }, null, 2),
							},
						],
					};
				}
				case "branchlight_service_list": {
					const doc = await this.#client.getDocument();
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(doc.services, null, 2),
							},
						],
					};
				}
				case "branchlight_service_start": {
					const id = typeof args.id === "string" ? args.id : "";
					const cmd: WorkspaceCommandV1 = {
						version: 1,
						commandId: `cmd-svc-start-${Date.now()}`,
						workspaceId: this.#client.document?.activeWorkspaceId ?? "default",
						expectedRevision: this.#client.document?.revision ?? 0,
						issuedAt: Date.now(),
						type: "service.start",
						payload: { id },
					};
					const result = await this.#client.executeCommand(cmd);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(result, null, 2),
							},
						],
						isError: result.status === "rejected",
					};
				}
				case "branchlight_service_stop": {
					const id = typeof args.id === "string" ? args.id : "";
					const cmd: WorkspaceCommandV1 = {
						version: 1,
						commandId: `cmd-svc-stop-${Date.now()}`,
						workspaceId: this.#client.document?.activeWorkspaceId ?? "default",
						expectedRevision: this.#client.document?.revision ?? 0,
						issuedAt: Date.now(),
						type: "service.stop",
						payload: { id },
					};
					const result = await this.#client.executeCommand(cmd);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(result, null, 2),
							},
						],
						isError: result.status === "rejected",
					};
				}
				case "branchlight_notification_list": {
					const doc = await this.#client.getDocument();
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(doc.notifications, null, 2),
							},
						],
					};
				}
				default:
					return {
						content: [
							{
								type: "text",
								text: `Unknown tool: ${name}`,
							},
						],
						isError: true,
					};
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: error instanceof Error ? error.message : String(error),
					},
				],
				isError: true,
			};
		}
	}
}
