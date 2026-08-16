import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { defineRpcClientTool, RpcClient } from "@oh-my-pi/pi-coding-agent/modes";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolUpdate,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const fixturePath = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

describe("RpcHostToolBridge", () => {
	it("forwards host tool updates and results to the pending execution", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_sum",
				label: "Host Sum",
				description: "Adds numbers in the host process",
				parameters: {
					type: "object",
					properties: {
						left: { type: "number" },
						right: { type: "number" },
					},
					required: ["left", "right"],
					additionalProperties: false,
				},
			},
		]);

		const updates: RpcHostToolUpdate["partialResult"][] = [];
		const execution = tool.execute("toolu_1", { left: 2, right: 3 }, undefined, update => {
			updates.push(update);
		});

		expect(frames).toHaveLength(1);
		const request = frames[0];
		if (request?.type !== "host_tool_call") {
			throw new Error("Expected host_tool_call frame");
		}

		bridge.handleUpdate({
			type: "host_tool_update",
			id: request.id,
			partialResult: {
				content: [{ type: "text", text: "working" }],
			},
		});
		expect(updates).toHaveLength(1);
		expect(updates[0]?.content[0]).toEqual({ type: "text", text: "working" });

		bridge.handleResult({
			type: "host_tool_result",
			id: request.id,
			result: {
				content: [{ type: "text", text: "5" }],
			},
		});

		await expect(execution).resolves.toEqual({
			content: [{ type: "text", text: "5" }],
		});
	});

	it("emits a cancel frame when the host tool execution is aborted", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_wait",
				description: "Waits in the host process",
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		]);

		const controller = new AbortController();
		const execution = tool.execute("toolu_2", {}, controller.signal);
		const request = frames[0];
		if (request?.type !== "host_tool_call") {
			throw new Error("Expected host_tool_call frame");
		}

		controller.abort();

		expect(frames[1]).toMatchObject({
			type: "host_tool_cancel",
			targetId: request.id,
		});
		await expect(execution).rejects.toThrow('Host tool "host_wait" was aborted');
	});
});

describe("RpcClient custom tools", () => {
	it("registers host custom tools and serves tool calls over the RPC transport", async () => {
		const client = new RpcClient({
			cliPath: fixturePath,
			env: { MOCK_RPC_SCENARIO: "host-tools" },
			customTools: [
				defineRpcClientTool<{ message: string }>({
					name: "echo_host",
					description: "Echo a value from the embedding host",
					parameters: {
						type: "object",
						properties: {
							message: { type: "string" },
						},
						required: ["message"],
						additionalProperties: false,
					},
					async execute(args, context) {
						context.sendUpdate(`working:${args.message}`);
						return `host:${args.message}`;
					},
				}),
			],
		});

		try {
			await client.start();
			const events = await client.promptAndWait("Trigger host tool");
			const toolEnd = events.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end",
			);
			expect(toolEnd?.toolName).toBe("echo_host");
			expect(toolEnd?.result).toEqual({
				content: [{ type: "text", text: "host:hello" }],
			});

			const toolUpdate = events.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_update" }> =>
					event.type === "tool_execution_update",
			);
			expect(toolUpdate?.partialResult).toEqual({
				content: [{ type: "text", text: "working:hello" }],
			});
		} finally {
			await client.stop();
		}
	});
});
