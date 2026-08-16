import {
	OMP_GRPC_MAX_MESSAGE_BYTES,
	OMP_GRPC_PROTOCOL_VERSION,
	type OmpGrpcClientConnection,
	type OmpGrpcServerFrame,
} from "@oh-my-pi/pi-grpc";
import type { RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "../shared/rpc-wire";

type RpcEventListener = (event: unknown) => void;
type RpcExtensionListener = (request: RpcExtensionUIRequest) => void;

type PendingRequest = {
	command: string;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
};

export class RpcClient {
	#connection: OmpGrpcClientConnection;
	#pending = new Map<string, PendingRequest>();
	#events = new Set<RpcEventListener>();
	#extensions = new Set<RpcExtensionListener>();
	#sequence = 0;
	#closed = false;
	#readyReceived = false;
	#ready = Promise.withResolvers<void>();
	#closePromise: Promise<void> | undefined;
	#readTask: Promise<void>;

	constructor(connection: OmpGrpcClientConnection) {
		this.#connection = connection;
		this.#readTask = this.#readFrames();
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
		await this.#ready.promise;
	}

	async prompt(message: string): Promise<void> {
		const response = await this.request({ type: "prompt", message });
		if (!response.success) throw new Error(response.error);
	}

	async request(command: RpcCommand): Promise<RpcResponse> {
		if (this.#closed) throw new Error("RPC process is closed");
		if (!this.#readyReceived) throw new Error("RPC process is not ready");
		const { id: commandId, type, ...payload } = command;
		const id = commandId ?? `branchlight-${++this.#sequence}`;
		if (this.#pending.has(id)) throw new Error(`RPC request id is already pending: ${id}`);
		const pending = Promise.withResolvers<RpcResponse>();
		this.#pending.set(id, { command: type, resolve: pending.resolve, reject: pending.reject });
		try {
			await this.#connection.send({
				kind: "command",
				command: { id, command: type, payload },
			});
		} catch (error) {
			this.#pending.delete(id);
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return pending.promise;
	}

	sendExtensionResponse(response: RpcExtensionUIResponse): void {
		if (this.#closed) return;
		const { type, ...payload } = response;
		void this.#connection
			.send({ kind: "push", type, payload })
			.catch(error => this.#fail(error instanceof Error ? error : new Error(String(error))));
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		if (!this.#closed) {
			this.#closed = true;
			const error = new Error("RPC process stopped");
			for (const request of this.#pending.values()) request.reject(error);
			this.#pending.clear();
		}
		await this.#connection.close();
		await this.#readTask.catch(() => {});
	}

	#dispatch(frame: OmpGrpcServerFrame): void {
		if (!this.#readyReceived) {
			if (frame.kind !== "ready") {
				this.#fail(new Error("OMP gRPC stream did not begin with Ready"));
				return;
			}
			if (
				frame.protocolVersion !== OMP_GRPC_PROTOCOL_VERSION ||
				frame.maxMessageBytes !== OMP_GRPC_MAX_MESSAGE_BYTES
			) {
				this.#fail(new Error("OMP advertised unsupported gRPC limits"));
			} else {
				this.#readyReceived = true;
				this.#ready.resolve();
			}
			return;
		}
		if (frame.kind === "ready") {
			this.#fail(new Error("OMP gRPC stream sent duplicate Ready"));
			return;
		}
		if (frame.kind === "response") {
			if (frame.id !== undefined) {
				const pending = this.#pending.get(frame.id);
				if (pending) {
					if (frame.command !== pending.command) {
						this.#fail(
							new Error(
								`OMP gRPC response command mismatch for ${frame.id}: expected ${pending.command}, received ${frame.command}`,
							),
						);
						return;
					}
					this.#pending.delete(frame.id);
					pending.resolve({
						type: "response",
						id: frame.id,
						command: frame.command,
						success: frame.success,
						...(frame.data !== undefined ? { data: frame.data } : {}),
						...(frame.error !== undefined ? { error: frame.error } : {}),
						...(frame.code !== undefined ? { code: frame.code } : {}),
					});
				}
			}
			return;
		}
		const event = { ...frame.payload, type: frame.type };
		if (event.type === "extension_ui_request") {
			for (const listener of this.#extensions) listener(event as RpcExtensionUIRequest);
			return;
		}
		for (const listener of this.#events) listener(event);
	}

	async #readFrames(): Promise<void> {
		try {
			for await (const frame of this.#connection.frames) {
				if (this.#closed) return;
				this.#dispatch(frame);
			}
			if (!this.#closed) this.#fail(new Error("OMP gRPC stream closed"));
		} catch (error) {
			this.#fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	#fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#ready.reject(error);
		for (const request of this.#pending.values()) request.reject(error);
		this.#pending.clear();
		for (const listener of this.#events) listener({ type: "rpc_error", message: error.message });
	}
}
