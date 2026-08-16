import { encodeLocalJsonlFrame, LocalJsonlDecoder, LocalRequestCorrelator } from "@oh-my-pi/pi-utils/local-runtime";
import type {
	WorkspaceAgentProfileV1,
	WorkspaceCommandV1,
	WorkspaceEventV1,
	WorkspaceSessionV1,
} from "@oh-my-pi/pi-wire";
import type { WorkspaceClient } from "../client";
import type { WorkspaceSupervisor } from "../supervisor";
import { WorkspaceTerminalSession } from "../terminal";
import type { WorkspaceCapabilityGrantV1 } from "../types";

function isWritableStream(obj: unknown): obj is { write: (d: string | Uint8Array) => void } {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"write" in obj &&
		typeof (obj as { write: unknown }).write === "function"
	);
}

function writeSubprocessStdin(proc: Bun.Subprocess | undefined, data: string): void {
	if (!proc?.stdin || !isWritableStream(proc.stdin)) return;
	try {
		proc.stdin.write(data);
	} catch {}
}

export interface AgentSessionAdapterOptions {
	sessionId: string;
	agentId?: string;
	terminalId?: string;
	profile: WorkspaceAgentProfileV1;
	client: WorkspaceClient;
	supervisor?: WorkspaceSupervisor;
	onMessage?: (sessionId: string, message: string) => void;
	onEvent?: (event: WorkspaceEventV1) => void;
	onData?: (data: string) => void;
	onStatusChange?: (sessionId: string, status: WorkspaceSessionV1["status"]) => void;
	onError?: (sessionId: string, error: Error) => void;
}

export interface AgentSessionAdapter {
	readonly sessionId: string;
	readonly protocol: WorkspaceAgentProfileV1["protocol"];
	readonly status: WorkspaceSessionV1["status"];
	readonly capabilities: readonly WorkspaceCapabilityGrantV1[];
	start(): Promise<void>;
	sendMessage(message: string, elementEdit?: Record<string, unknown>): Promise<void>;
	stop(): Promise<void>;
}

export class OmpAgentAdapter implements AgentSessionAdapter {
	readonly sessionId: string;
	readonly agentId: string;
	readonly protocol = "omp" as const;
	readonly #profile: WorkspaceAgentProfileV1;
	readonly #client: WorkspaceClient;
	readonly #supervisor?: WorkspaceSupervisor;
	readonly #onMessage?: (sessionId: string, message: string) => void;
	readonly #onEvent?: (event: WorkspaceEventV1) => void;
	readonly #onStatusChange?: (sessionId: string, status: WorkspaceSessionV1["status"]) => void;
	readonly #onError?: (sessionId: string, error: Error) => void;

	#status: WorkspaceSessionV1["status"] = "opening";
	#capabilities: WorkspaceCapabilityGrantV1[] = [];
	#process?: Bun.Subprocess;
	#unsubscribe?: () => void;
	#isClosed = false;

	constructor(options: AgentSessionAdapterOptions) {
		this.sessionId = options.sessionId;
		this.agentId = options.agentId ?? `agent-${options.sessionId}`;
		this.#profile = options.profile;
		this.#client = options.client;
		this.#supervisor = options.supervisor;
		this.#onMessage = options.onMessage;
		this.#onEvent = options.onEvent;
		this.#onStatusChange = options.onStatusChange;
		this.#onError = options.onError;

		this.#capabilities = [
			{
				capabilityId: `scoped-${this.sessionId}`,
				scope: "session",
				entityId: this.sessionId,
				operations: [
					"agent.message",
					"terminal.input",
					"terminal.resize",
					"selection.set",
					"attention.notify",
					"attention.dismiss",
				],
			},
		];
	}

	get status(): WorkspaceSessionV1["status"] {
		return this.#status;
	}

	get capabilities(): readonly WorkspaceCapabilityGrantV1[] {
		return this.#capabilities;
	}

	async start(): Promise<void> {
		if (this.#isClosed) throw new Error("Agent adapter is closed");

		// If profile specifies an executable, spawn the real OMP agent process
		if (this.#profile.exec) {
			const args = this.#profile.args ?? [];
			try {
				const proc = Bun.spawn([this.#profile.exec, ...args], {
					cwd: this.#profile.cwd,
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				});
				this.#process = proc;

				if (this.#supervisor && proc.pid) {
					void this.#supervisor.registerProcess(this.sessionId, "agent", proc.pid).catch(() => {});
				}

				// Read stdout lines from spawned OMP process
				const decoder = new LocalJsonlDecoder();
				void (async () => {
					if (!proc.stdout) return;
					const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							if (!value || value.length === 0) continue;
							const frames = decoder.push(value);
							for (const frame of frames) {
								if (typeof frame === "object" && frame !== null) {
									const msg = frame as Record<string, unknown>;
									if (typeof msg.message === "string") {
										this.#onMessage?.(this.sessionId, msg.message);
									}
								}
							}
						}
					} catch {}
				})();
			} catch (error) {
				this.#status = "closed";
				const err = error instanceof Error ? error : new Error(String(error));
				this.#onError?.(this.sessionId, err);
				throw err;
			}
		}

		// Subscribe to real runtime event stream
		this.#unsubscribe = this.#client.onEvent(event => {
			this.#onEvent?.(event);
			if (event.type === "element.edit") {
				const p = event.payload as Record<string, unknown>;
				if (p.sessionId === this.sessionId && typeof p.value === "string") {
					this.#onMessage?.(this.sessionId, p.value);
				}
			}
		});

		this.#status = "active";
		this.#onStatusChange?.(this.sessionId, "active");
	}

	async sendMessage(message: string, elementEdit?: Record<string, unknown>): Promise<void> {
		if (this.#status !== "active" || this.#isClosed) {
			throw new Error("Agent adapter is not active");
		}

		// If a real child process is active, send frame to stdin
		if (this.#process) {
			const frame = encodeLocalJsonlFrame({ type: "prompt", sessionId: this.sessionId, message, elementEdit });
			writeSubprocessStdin(this.#process, frame);
		}

		const doc = this.#client.document;
		const cmd: WorkspaceCommandV1 = {
			version: 1,
			commandId: `cmd-agent-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			workspaceId: doc?.activeWorkspaceId ?? "default",
			expectedRevision: doc?.revision ?? 0,
			issuedAt: Date.now(),
			type: "agent.message",
			payload: {
				id: this.agentId,
				message,
				...(elementEdit ? { elementEdit } : {}),
			},
		};
		const result = await this.#client.executeCommand(cmd);
		if (result.status === "rejected") {
			const err = new Error(result.error?.message ?? "Message rejected");
			this.#onError?.(this.sessionId, err);
			throw err;
		}
		this.#onMessage?.(this.sessionId, message);
	}

	async stop(): Promise<void> {
		if (this.#isClosed) return;
		this.#isClosed = true;

		if (this.#process) {
			try {
				this.#process.kill();
			} catch {}
			this.#process = undefined;
		}

		if (this.#supervisor) {
			await this.#supervisor.stopProcess(this.sessionId, { gracefulMs: 100, forceMs: 300 }).catch(() => {});
		}

		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
		}
		this.#status = "closed";
		this.#onStatusChange?.(this.sessionId, "closed");
	}
}

export class AcpAgentAdapter implements AgentSessionAdapter {
	readonly sessionId: string;
	readonly agentId: string;
	readonly protocol = "acp" as const;
	readonly #profile: WorkspaceAgentProfileV1;
	readonly #client: WorkspaceClient;
	readonly #supervisor?: WorkspaceSupervisor;
	readonly #onMessage?: (sessionId: string, message: string) => void;
	readonly #onStatusChange?: (sessionId: string, status: WorkspaceSessionV1["status"]) => void;
	readonly #onError?: (sessionId: string, error: Error) => void;

	#status: WorkspaceSessionV1["status"] = "opening";
	#capabilities: WorkspaceCapabilityGrantV1[] = [];
	#process?: Bun.Subprocess;
	#correlator = new LocalRequestCorrelator<Record<string, unknown>>();
	#decoder = new LocalJsonlDecoder();
	#reqCounter = 0;
	#isClosed = false;

	constructor(options: AgentSessionAdapterOptions) {
		this.sessionId = options.sessionId;
		this.agentId = options.agentId ?? `agent-acp-${options.sessionId}`;
		this.#profile = options.profile;
		this.#client = options.client;
		this.#supervisor = options.supervisor;
		this.#onMessage = options.onMessage;
		this.#onStatusChange = options.onStatusChange;
		this.#onError = options.onError;

		this.#capabilities = [
			{
				capabilityId: `acp-${this.sessionId}`,
				scope: "session",
				entityId: this.sessionId,
				operations: ["agent.message", "attention.notify", "attention.dismiss"],
			},
		];
	}

	get status(): WorkspaceSessionV1["status"] {
		return this.#status;
	}

	get capabilities(): readonly WorkspaceCapabilityGrantV1[] {
		return this.#capabilities;
	}

	async start(): Promise<void> {
		if (this.#isClosed) throw new Error("ACP adapter is closed");

		// If configured with an executable, launch the ACP agent subprocess
		if (this.#profile.exec) {
			const args = this.#profile.args ?? [];
			try {
				const proc = Bun.spawn([this.#profile.exec, ...args], {
					cwd: this.#profile.cwd,
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				});
				this.#process = proc;

				if (this.#supervisor && proc.pid) {
					void this.#supervisor.registerProcess(this.sessionId, "agent", proc.pid).catch(() => {});
				}

				// Pipe stdout JSON-RPC frames from ACP process
				void (async () => {
					if (!proc.stdout) return;
					const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							if (!value || value.length === 0) continue;
							const frames = this.#decoder.push(value);
							for (const frame of frames) {
								if (typeof frame === "object" && frame !== null) {
									const msg = frame as Record<string, unknown>;
									const id = typeof msg.id === "string" ? msg.id : undefined;
									if (id) {
										this.#correlator.resolve(id, msg);
									}
									if (typeof msg.method === "string" && msg.method === "notifications/message") {
										if (typeof msg.params === "object" && msg.params !== null && "message" in msg.params) {
											const messageText = (msg.params as Record<string, unknown>).message;
											if (typeof messageText === "string") {
												this.#onMessage?.(this.sessionId, messageText);
											}
										}
									}
								}
							}
						}
					} catch {}
				})();

				// Send ACP initialize handshake
				await this.sendJsonRpcRequest("initialize", {
					protocolVersion: "1.0",
					capabilities: this.#capabilities,
				});
			} catch (error) {
				this.#status = "closed";
				const err = error instanceof Error ? error : new Error(String(error));
				this.#onError?.(this.sessionId, err);
				throw err;
			}
		}

		this.#status = "active";
		this.#onStatusChange?.(this.sessionId, "active");
	}

	async sendJsonRpcRequest(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const requestId = `acp-req-${++this.#reqCounter}-${Date.now()}`;
		const payload = {
			jsonrpc: "2.0",
			id: requestId,
			method,
			params,
		};
		return this.#correlator.request(
			requestId,
			() => {
				if (this.#process) {
					writeSubprocessStdin(this.#process, encodeLocalJsonlFrame(payload));
				}
			},
			{ timeoutMs: 5000 },
		);
	}

	async handleJsonRpc(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		const method = request.method;
		const id = request.id;

		if (method === "session/initialize") {
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "1.0",
					sessionId: this.sessionId,
					capabilities: this.#capabilities,
				},
			};
		}

		if (method === "session/prompt") {
			const params =
				typeof request.params === "object" && request.params !== null
					? (request.params as Record<string, unknown>)
					: {};
			const prompt = typeof params.prompt === "string" ? params.prompt : "";
			const elementEdit =
				typeof params.elementEdit === "object" && params.elementEdit !== null
					? (params.elementEdit as Record<string, unknown>)
					: undefined;
			await this.sendMessage(prompt, elementEdit);
			return {
				jsonrpc: "2.0",
				id,
				result: {
					status: "accepted",
				},
			};
		}

		return {
			jsonrpc: "2.0",
			id,
			error: {
				code: -32601,
				message: `Method not found: ${String(method)}`,
			},
		};
	}

	async sendMessage(message: string, elementEdit?: Record<string, unknown>): Promise<void> {
		if (this.#status !== "active" || this.#isClosed) {
			throw new Error("ACP adapter is not active");
		}
		const doc = this.#client.document;
		const cmd: WorkspaceCommandV1 = {
			version: 1,
			commandId: `cmd-acp-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			workspaceId: doc?.activeWorkspaceId ?? "default",
			expectedRevision: doc?.revision ?? 0,
			issuedAt: Date.now(),
			type: "agent.message",
			payload: {
				id: this.agentId,
				message,
				...(elementEdit ? { elementEdit } : {}),
			},
		};
		const result = await this.#client.executeCommand(cmd);
		if (result.status === "rejected") {
			const err = new Error(result.error?.message ?? "ACP message rejected");
			this.#onError?.(this.sessionId, err);
			throw err;
		}
		this.#onMessage?.(this.sessionId, message);
	}

	async stop(): Promise<void> {
		if (this.#isClosed) return;
		this.#isClosed = true;

		if (this.#process) {
			try {
				this.#process.kill();
			} catch {}
			this.#process = undefined;
		}

		if (this.#supervisor) {
			await this.#supervisor.stopProcess(this.sessionId, { gracefulMs: 100, forceMs: 300 }).catch(() => {});
		}

		this.#correlator.close();
		this.#status = "closed";
		this.#onStatusChange?.(this.sessionId, "closed");
	}
}

export class RawTerminalAgentAdapter implements AgentSessionAdapter {
	readonly sessionId: string;
	readonly terminalId: string;
	readonly protocol = "terminal" as const;
	readonly #profile: WorkspaceAgentProfileV1;
	readonly #client: WorkspaceClient;
	readonly #supervisor?: WorkspaceSupervisor;
	readonly #onData?: (data: string) => void;
	readonly #onStatusChange?: (sessionId: string, status: WorkspaceSessionV1["status"]) => void;

	#terminalSession?: WorkspaceTerminalSession;
	#status: WorkspaceSessionV1["status"] = "opening";
	#capabilities: WorkspaceCapabilityGrantV1[] = [];
	#unsubscribe?: () => void;
	#isClosed = false;

	constructor(options: AgentSessionAdapterOptions) {
		this.sessionId = options.sessionId;
		this.terminalId = options.terminalId ?? `term-${options.sessionId}`;
		this.#profile = options.profile;
		this.#client = options.client;
		this.#supervisor = options.supervisor;
		this.#onData = options.onData;
		this.#onStatusChange = options.onStatusChange;

		this.#capabilities = [
			{
				capabilityId: `terminal-${this.sessionId}`,
				scope: "session",
				entityId: this.sessionId,
				operations: ["terminal.input", "terminal.resize"],
			},
		];
	}

	get status(): WorkspaceSessionV1["status"] {
		return this.#status;
	}

	get capabilities(): readonly WorkspaceCapabilityGrantV1[] {
		return this.#capabilities;
	}

	async start(): Promise<void> {
		if (this.#isClosed) throw new Error("Terminal adapter is closed");

		// If configured with an executable or PTY, instantiate the terminal session
		if (this.#profile.exec || this.#profile.args) {
			const session = new WorkspaceTerminalSession({
				id: this.terminalId,
				shell: this.#profile.exec,
				args: this.#profile.args,
				cwd: this.#profile.cwd,
				supervisor: this.#supervisor,
				onData: (_id, chunk) => {
					this.#onData?.(chunk.data);
				},
				onExit: () => {
					void this.stop();
				},
			});
			this.#terminalSession = session;
			await session.start();
		}

		// Subscribe to real runtime event stream for terminal updates
		this.#unsubscribe = this.#client.onEvent(event => {
			if (event.type === "terminal.changed") {
				const p = event.payload as Record<string, unknown>;
				if (p.id === this.terminalId && typeof p.data === "string") {
					this.#onData?.(p.data);
				}
			}
		});

		this.#status = "active";
		this.#onStatusChange?.(this.sessionId, "active");
	}

	async sendMessage(message: string): Promise<void> {
		if (this.#status !== "active" || this.#isClosed) {
			throw new Error("Terminal adapter is not active");
		}

		if (this.#terminalSession) {
			this.#terminalSession.write(message);
		}

		const doc = this.#client.document;
		const cmd: WorkspaceCommandV1 = {
			version: 1,
			commandId: `cmd-term-in-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			workspaceId: doc?.activeWorkspaceId ?? "default",
			expectedRevision: doc?.revision ?? 0,
			issuedAt: Date.now(),
			type: "terminal.input",
			payload: {
				id: this.terminalId,
				data: message,
			},
		};
		const result = await this.#client.executeCommand(cmd);
		if (result.status === "rejected") {
			throw new Error(result.error?.message ?? "Terminal input rejected");
		}
	}

	async stop(): Promise<void> {
		if (this.#isClosed) return;
		this.#isClosed = true;

		if (this.#terminalSession) {
			await this.#terminalSession.close();
			this.#terminalSession = undefined;
		}

		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
		}
		this.#status = "closed";
		this.#onStatusChange?.(this.sessionId, "closed");
	}
}

export function createAgentSessionAdapter(options: AgentSessionAdapterOptions): AgentSessionAdapter {
	switch (options.profile.protocol) {
		case "acp":
			return new AcpAgentAdapter(options);
		case "terminal":
			return new RawTerminalAgentAdapter(options);
		default:
			return new OmpAgentAdapter(options);
	}
}
