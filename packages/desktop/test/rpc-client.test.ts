import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES } from "../../coding-agent/src/modes/rpc/rpc-frame";
import { RpcClient } from "../src/main/rpc-client";
import type { RpcCommand } from "../src/shared/rpc-wire";

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	writes: string[] = [];
	responses: string[] = [];
	stdin = new Writable({
		write: (chunk, _encoding, callback) => {
			const line = String(chunk).trim();
			this.writes.push(line);
			const command = JSON.parse(line) as RpcCommand;
			if (command.type === "negotiate_protocol")
				this.stdout.write(
					`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true })}\n`,
				);
			if (command.type === "prompt")
				this.stdout.write(
					`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { agentInvoked: true } })}\n`,
				);
			if (command.type === "alpha" || command.type === "beta")
				this.responses.push(
					`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: command.type })}\n`,
				);
			callback();
		},
	});

	flushResponsesReverse(): void {
		for (const response of [...this.responses].reverse()) this.stdout.write(response);
		this.responses = [];
	}

	kill(): boolean {
		return true;
	}
}

const asChildProcess = (child: FakeChild): ChildProcessWithoutNullStreams =>
	child as unknown as ChildProcessWithoutNullStreams;

describe("RpcClient", () => {
	it("negotiates v2 and correlates out-of-order responses by id", async () => {
		const child = new FakeChild();
		const client = new RpcClient(asChildProcess(child));
		child.stdout.write(
			`${JSON.stringify({ type: "ready", maxFrameBytes: MAX_RPC_FRAME_BYTES, maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES })}\n`,
		);
		await client.start();

		const alphaPromise = client.request({ type: "alpha" });
		const betaPromise = client.request({ type: "beta" });
		child.flushResponsesReverse();
		const [alpha, beta] = await Promise.all([alphaPromise, betaPromise]);
		expect(alpha.data).toBe("alpha");
		expect(beta.data).toBe("beta");
		expect(child.writes.map(line => JSON.parse(line).type)).toEqual(["negotiate_protocol", "alpha", "beta"]);
		await client.close();
	});
	it("acknowledges prompts without waiting for a terminal agent event", async () => {
		const child = new FakeChild();
		const client = new RpcClient(asChildProcess(child));
		child.stdout.write(
			`${JSON.stringify({ type: "ready", maxFrameBytes: MAX_RPC_FRAME_BYTES, maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES })}\n`,
		);
		await client.start();

		await expect(client.prompt("keep the editor responsive")).resolves.toBeUndefined();
		expect(child.writes.map(line => JSON.parse(line).type)).toEqual(["negotiate_protocol", "prompt"]);
		await client.close();
	});

	it("rejects pending requests when the process exits", async () => {
		const child = new FakeChild();
		const client = new RpcClient(asChildProcess(child));
		child.stdout.write(
			`${JSON.stringify({ type: "ready", maxFrameBytes: MAX_RPC_FRAME_BYTES, maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES })}\n`,
		);
		await client.start();
		const pending = client.request({ type: "never" });
		child.emit("exit", 1, null);
		await expect(pending).rejects.toThrow(/exited/);
	});
});
