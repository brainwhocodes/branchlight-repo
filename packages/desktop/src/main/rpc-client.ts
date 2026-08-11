import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_REASSEMBLED_BYTES,
	RpcFrameDecoder,
} from "../../../coding-agent/src/modes/rpc/rpc-frame";
import type { RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "../shared/rpc-wire";

type RpcEventListener = (event: unknown) => void;
type RpcExtensionListener = (request: RpcExtensionUIRequest) => void;

type PendingRequest = {
	command: string;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
};

export class RpcClient {
	#child: ChildProcessWithoutNullStreams;
	#decoder = new RpcFrameDecoder();
	#buffer = Buffer.alloc(0);
	#pending = new Map<string, PendingRequest>();
	#events = new Set<RpcEventListener>();
	#extensions = new Set<RpcExtensionListener>();
	#sequence = 0;
	#closed = false;
	#readyResolve: (() => void) | undefined;
	#readyReject: ((error: Error) => void) | undefined;
	#ready = new Promise<void>((resolve, reject) => {
		this.#readyResolve = resolve;
		this.#readyReject = reject;
	});

	constructor(child: ChildProcessWithoutNullStreams) {
		this.#child = child;
		child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
		child.stdout.on("error", error => this.#fail(error instanceof Error ? error : new Error(String(error))));
		child.on("error", error => this.#fail(error instanceof Error ? error : new Error(String(error))));
		child.on("exit", (code, signal) => this.#fail(new Error(`OMP exited (${code ?? signal ?? "unknown"})`)));
	}

	get process(): ChildProcessWithoutNullStreams {
		return this.#child;
	}

	onEvent(listener: RpcEventListener): () => void {
		this.#events.add(listener);
		return () => this.#events.delete(listener);
	}
	onExtension(listener: RpcExtensionListener): () => void {
		this.#extensions.add(listener);
		return () => this.#extensions.delete(listener);
	}

	async start(): Promise<void> {
		await this.#ready;
		const readyResponse = await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
		if (!readyResponse.success || readyResponse.command !== "negotiate_protocol")
			throw new Error("OMP protocol negotiation failed");
	}

	async prompt(message: string): Promise<void> {
		const response = await this.request({ type: "prompt", message });
		if (!response.success) throw new Error(response.error);
	}

	async request(command: RpcCommand): Promise<RpcResponse> {
		if (this.#closed) throw new Error("RPC process is closed");
		const id = command.id ?? `branchlight-${++this.#sequence}`;
		const withId = { ...command, id } as RpcCommand;
		const pending = Promise.withResolvers<RpcResponse>();
		this.#pending.set(id, { command: command.type, resolve: pending.resolve, reject: pending.reject });
		try {
			this.#child.stdin.write(`${JSON.stringify(withId)}\n`);
		} catch (error) {
			this.#pending.delete(id);
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return pending.promise;
	}

	sendExtensionResponse(response: RpcExtensionUIResponse): void {
		if (this.#closed) return;
		this.#child.stdin.write(`${JSON.stringify(response)}\n`);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const error = new Error("RPC process stopped");
		for (const request of this.#pending.values()) request.reject(error);
		this.#pending.clear();
		this.#child.stdin.end();
	}

	#onData(chunk: Buffer): void {
		if (this.#closed) return;
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		while (true) {
			const newline = this.#buffer.indexOf(10);
			if (newline < 0) {
				if (this.#buffer.byteLength >= MAX_RPC_FRAME_BYTES)
					this.#fail(new Error("RPC physical frame exceeds 1 MiB"));
				return;
			}
			if (newline + 1 > MAX_RPC_FRAME_BYTES) {
				this.#fail(new Error("RPC physical frame exceeds 1 MiB"));
				return;
			}
			const line = this.#buffer.subarray(0, newline);
			this.#buffer = this.#buffer.subarray(newline + 1);
			let value: unknown;
			try {
				value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
			} catch (error) {
				this.#fail(new Error(`Invalid RPC JSON: ${error instanceof Error ? error.message : String(error)}`));
				return;
			}
			try {
				const decoded = this.#decoder.push(value);
				if (decoded) this.#dispatch(decoded);
			} catch (error) {
				this.#fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		}
	}

	#dispatch(frame: object): void {
		const candidate = frame as Record<string, unknown>;
		if (candidate.type === "ready") {
			if (
				candidate.maxFrameBytes !== MAX_RPC_FRAME_BYTES ||
				candidate.maxReassembledFrameBytes !== MAX_RPC_REASSEMBLED_BYTES
			) {
				this.#readyReject?.(new Error("OMP advertised unsupported RPC limits"));
			} else this.#readyResolve?.();
			return;
		}
		if (candidate.type === "response") {
			const id = typeof candidate.id === "string" ? candidate.id : undefined;
			if (id) {
				const pending = this.#pending.get(id);
				if (pending) {
					this.#pending.delete(id);
					pending.resolve(candidate as unknown as RpcResponse);
				}
			}
			return;
		}
		if (candidate.type === "extension_ui_request") {
			for (const listener of this.#extensions) listener(candidate as unknown as RpcExtensionUIRequest);
			return;
		}
		for (const listener of this.#events) listener(frame);
	}

	#fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#readyReject?.(error);
		for (const request of this.#pending.values()) request.reject(error);
		this.#pending.clear();
		for (const listener of this.#events) listener({ type: "rpc_error", message: error.message });
	}
}
