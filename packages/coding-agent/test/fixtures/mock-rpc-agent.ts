#!/usr/bin/env bun
/** Test fixture: a stand-in for the coding-agent gRPC mode. */
import {
	listenOmpGrpc,
	OMP_GRPC_MAX_MESSAGE_BYTES,
	OMP_GRPC_PROTOCOL_VERSION,
	type OmpGrpcServerFrame,
	writeOmpGrpcBootstrapFile,
} from "@oh-my-pi/pi-grpc";

if (Bun.env.MOCK_RPC_PID_FILE) {
	await Bun.write(Bun.env.MOCK_RPC_PID_FILE, String(process.pid));
}
if (Bun.env.MOCK_RPC_IGNORE_SIGTERM === "1") {
	process.on("SIGTERM", () => {});
}

const host = Bun.env.OMP_GRPC_HOST;
const port = Number(Bun.env.OMP_GRPC_PORT);
const token = Bun.env.OMP_GRPC_TOKEN;
const readyFile = Bun.env.OMP_GRPC_READY_FILE;
if (!host || !Number.isSafeInteger(port) || port < 0 || !token || !readyFile) {
	process.stderr.write("Missing gRPC bootstrap environment\n");
	process.exit(2);
}

const legacyState = {
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionId: "mock-session",
	autoCompactionEnabled: false,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
};

const server = await listenOmpGrpc({ host, port, token });
await writeOmpGrpcBootstrapFile(readyFile, server.bootstrap);
const connection = await server.accept();
await connection.send({
	kind: "ready",
	protocolVersion: OMP_GRPC_PROTOCOL_VERSION,
	maxMessageBytes: OMP_GRPC_MAX_MESSAGE_BYTES,
});

async function respond(frame: OmpGrpcServerFrame): Promise<void> {
	await connection.send(frame);
}

const scenario = Bun.env.MOCK_RPC_SCENARIO;

async function push(type: string, payload: Record<string, unknown> = {}): Promise<void> {
	await respond({ kind: "push", type, payload });
}

const subagentProgress = {
	index: 0,
	id: "SubagentA",
	agent: "task",
	agentSource: "bundled",
	status: "running",
	task: "Do work",
	assignment: "Implement work",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	cost: 0,
	durationMs: 0,
};

try {
	for await (const clientFrame of connection.frames) {
		if (clientFrame.kind === "push") {
			if (scenario === "host-tools" && clientFrame.type === "host_tool_update") {
				await push("tool_execution_update", {
					toolCallId: "toolu_host_1",
					toolName: "echo_host",
					args: { message: "hello" },
					partialResult: clientFrame.payload.partialResult,
				});
			} else if (scenario === "host-tools" && clientFrame.type === "host_tool_result") {
				await push("tool_execution_end", {
					toolCallId: "toolu_host_1",
					toolName: "echo_host",
					result: clientFrame.payload.result,
					isError: clientFrame.payload.isError === true,
				});
				await push("agent_end", { messages: [] });
			}
			continue;
		}

		const { id, command, payload } = clientFrame.command;
		if (Bun.env.MOCK_RPC_EXIT_ON_COMMAND) {
			process.stderr.write(Bun.env.MOCK_RPC_EXIT_STDERR ?? "");
			process.exit(Number(Bun.env.MOCK_RPC_EXIT_ON_COMMAND));
		}
		if (Bun.env.MOCK_RPC_IGNORE_COMMANDS === "1") continue;

		if (scenario === "host-tools" && command === "set_host_tools") {
			const toolNames = Array.isArray(payload.tools)
				? payload.tools
						.map(tool =>
							typeof tool === "object" && tool !== null && "name" in tool && typeof tool.name === "string"
								? tool.name
								: undefined,
						)
						.filter((name): name is string => name !== undefined)
				: [];
			await respond({ kind: "response", id, command, success: true, data: { toolNames } });
			continue;
		}
		if (scenario === "host-tools" && command === "prompt") {
			await respond({ kind: "response", id, command, success: true });
			await push("agent_start");
			await push("host_tool_call", {
				id: "host-call-1",
				toolCallId: "toolu_host_1",
				toolName: "echo_host",
				arguments: { message: "hello" },
			});
			continue;
		}

		if (scenario === "subagents") {
			if (command === "set_subagent_subscription") {
				await respond({
					kind: "response",
					id,
					command,
					success: true,
					data: { level: typeof payload.level === "string" ? payload.level : "off" },
				});
				continue;
			}
			if (command === "get_subagents") {
				await respond({
					kind: "response",
					id,
					command,
					success: true,
					data: {
						subagents: [
							{
								id: "SubagentA",
								index: 0,
								agent: "task",
								agentSource: "bundled",
								status: "running",
								lastUpdate: 1,
							},
						],
					},
				});
				continue;
			}
			if (command === "get_subagent_messages") {
				await respond({
					kind: "response",
					id,
					command,
					success: true,
					data: {
						sessionFile: typeof payload.sessionFile === "string" ? payload.sessionFile : "/tmp/subagent.jsonl",
						fromByte: typeof payload.fromByte === "number" ? payload.fromByte : 0,
						nextByte: 0,
						reset: false,
						entries: [],
						messages: [],
					},
				});
				continue;
			}
			if (command === "prompt") {
				await respond({ kind: "response", id, command, success: true });
				await push("notice", { level: "info", message: "subagent test" });
				await push("subagent_lifecycle", {
					payload: {
						id: "SubagentA",
						index: 0,
						agent: "task",
						agentSource: "bundled",
						status: "started",
						sessionFile: "/tmp/subagent.jsonl",
					},
				});
				await push("subagent_progress", {
					payload: {
						index: 0,
						agent: "task",
						agentSource: "bundled",
						task: "Do work",
						assignment: "Implement work",
						sessionFile: "/tmp/subagent.jsonl",
						progress: subagentProgress,
					},
				});
				await push("subagent_event", {
					payload: { id: "SubagentA", event: { type: "agent_start" } },
				});
				await push("agent_end", { messages: [] });
				continue;
			}
		}

		if (command === "get_messages_page") {
			if (Bun.env.MOCK_RPC_PAGE_BUSY === "1") {
				await respond({
					kind: "response",
					id,
					command,
					success: false,
					error: "Cannot page messages while the session is changing",
					code: "session_busy",
				});
				continue;
			}
			if (Bun.env.MOCK_RPC_PAGE_STALE === "1" && payload.cursor !== undefined) {
				await respond({
					kind: "response",
					id,
					command,
					success: false,
					error: "RPC message cursor is stale",
					code: "stale_cursor",
				});
				continue;
			}
			const first = payload.cursor === undefined;
			await respond({
				kind: "response",
				id,
				command,
				success: true,
				data: first
					? {
							messages: [{ role: "user", content: "first", timestamp: 1 }],
							nextCursor: "second-page",
							totalMessages: 2,
						}
					: {
							messages: [{ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 }],
							totalMessages: 2,
						},
			});
			continue;
		}

		if (command === "get_messages" && (Bun.env.MOCK_RPC_PAGE_BUSY === "1" || Bun.env.MOCK_RPC_PAGE_STALE === "1")) {
			await respond({
				kind: "response",
				id,
				command,
				success: true,
				data: {
					messages: [{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 }],
				},
			});
			continue;
		}

		if (command === "get_state") {
			if (Bun.env.MOCK_RPC_MISMATCHED_RESPONSE === "1") {
				await respond({
					kind: "response",
					id,
					command: "get_messages",
					success: true,
					data: { messages: [] },
				});
			}
			const data =
				Bun.env.MOCK_RPC_LARGE_RESPONSE === "1"
					? { payload: "😀".repeat(400_000) }
					: {
							...legacyState,
							...(Bun.env.MOCK_RPC_INVALID_TPS === "1"
								? { fastModeEnabled: false, fastModeActive: false, tokensPerSecond: "invalid" }
								: {}),
						};
			await respond({ kind: "response", id, command, success: true, data });
			continue;
		}

		await respond({ kind: "response", id, command, success: true, data: {} });
	}
	if (Bun.env.MOCK_RPC_CLOSED_FILE) {
		await Bun.write(Bun.env.MOCK_RPC_CLOSED_FILE, "closed");
	}
} finally {
	await connection.close().catch(() => {});
	await server.close().catch(() => {});
}
