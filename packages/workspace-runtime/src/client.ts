import * as net from "node:net";
import {
	DEFAULT_CONTROL_TOKEN_BASENAME,
	DEFAULT_ENDPOINT_BASENAME,
	encodeLocalJsonlFrame,
	LocalConnectionClosedError,
	LocalJsonlDecoder,
	LocalRequestCorrelator,
	readControlToken,
	secureRuntimeEndpoint,
} from "@oh-my-pi/pi-utils/local-runtime";
import {
	parseWorkspaceDocumentV1,
	parseWorkspaceEventV1,
	type WorkspaceCommandV1,
	type WorkspaceDocumentV1,
	type WorkspaceEventV1,
	type WorkspacePrincipalV1,
} from "@oh-my-pi/pi-wire";
import { WorkspaceRuntimeError } from "./errors";
import type {
	TerminalInputFrame,
	TerminalOutputFrame,
	TerminalResizeFrame,
	TerminalStatusFrame,
	TerminalSubscribeFrame,
	TerminalUnsubscribeFrame,
} from "./terminal-protocol";
import type { WorkspaceCommandResultV1 } from "./types";

export interface WorkspaceClientOptions {
	runtimeRoot: string;
	token?: string;
	tokenBasename?: string;
	endpointBasename?: string;
	principal?: WorkspacePrincipalV1;
	connectTimeoutMs?: number;
}

export type WorkspaceEventListener = (event: WorkspaceEventV1) => void;
export type WorkspaceDocumentListener = (document: WorkspaceDocumentV1) => void;
export interface ClientConnectionState {
	connected: boolean;
	unexpected: boolean;
}
export type WorkspaceConnectionListener = (state: ClientConnectionState) => void;
export class WorkspaceClient {
	readonly #runtimeRoot: string;
	readonly #tokenBasename: string;
	readonly #endpointBasename: string;
	#explicitToken?: string;
	readonly #principal?: WorkspacePrincipalV1;
	readonly #connectTimeoutMs: number;
	readonly #correlator = new LocalRequestCorrelator<Record<string, unknown>>();
	readonly #eventListeners = new Set<WorkspaceEventListener>();
	readonly #documentListeners = new Set<WorkspaceDocumentListener>();
	readonly #connectionStateListeners = new Set<WorkspaceConnectionListener>();
	#socket?: net.Socket;
	#decoder = new LocalJsonlDecoder();
	#isConnected = false;
	#closing = false;
	#document?: WorkspaceDocumentV1;
	#authenticatedPrincipal?: WorkspacePrincipalV1;
	readonly #terminalOutputListeners = new Map<string, Set<(frame: TerminalOutputFrame) => void>>();
	#requestIdCounter = 0;
	constructor(options: WorkspaceClientOptions) {
		this.#runtimeRoot = options.runtimeRoot;
		this.#tokenBasename = options.tokenBasename ?? DEFAULT_CONTROL_TOKEN_BASENAME;
		this.#endpointBasename = options.endpointBasename ?? DEFAULT_ENDPOINT_BASENAME;
		this.#explicitToken = options.token;
		this.#principal = options.principal;
		this.#connectTimeoutMs = options.connectTimeoutMs ?? 5000;
	}

	get isConnected(): boolean {
		return this.#isConnected;
	}
	get document(): WorkspaceDocumentV1 | undefined {
		return this.#document;
	}

	get principal(): WorkspacePrincipalV1 | undefined {
		return this.#authenticatedPrincipal ?? this.#principal;
	}

	async connect(): Promise<WorkspaceDocumentV1> {
		if (this.#isConnected && this.#document) return this.#document;

		const token = this.#explicitToken ?? (await readControlToken(this.#runtimeRoot, this.#tokenBasename));
		const endpoint = secureRuntimeEndpoint(this.#runtimeRoot, this.#endpointBasename);

		const socket = net.createConnection(endpoint);
		this.#socket = socket;
		this.#decoder = new LocalJsonlDecoder();

		const { promise, resolve, reject } = Promise.withResolvers<WorkspaceDocumentV1>();
		const timer = setTimeout(() => {
			socket.destroy(new Error("Connection timeout"));
			reject(new Error("Connection to workspace runtime timed out"));
		}, this.#connectTimeoutMs);

		let authenticated = false;

		socket.on("connect", () => {
			const authFrame = {
				type: "auth",
				token,
				principal: this.#principal,
			};
			socket.write(encodeLocalJsonlFrame(authFrame));
		});

		socket.on("data", chunk => {
			let frames: unknown[];
			try {
				frames = this.#decoder.push(chunk);
			} catch (error) {
				socket.destroy(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			for (const frame of frames) {
				if (typeof frame !== "object" || frame === null) continue;
				const msg = frame as Record<string, unknown>;

				if (!authenticated) {
					if (msg.type === "auth.ok") {
						authenticated = true;
						this.#isConnected = true;
						this.#closing = false;
						clearTimeout(timer);
						const doc = parseWorkspaceDocumentV1(msg.document);
						this.#document = doc;
						if (msg.principal && typeof msg.principal === "object") {
							this.#authenticatedPrincipal = msg.principal as WorkspacePrincipalV1;
						}
						socket.write(encodeLocalJsonlFrame({ type: "subscribe" }));
						for (const listener of this.#connectionStateListeners) {
							try {
								listener({ connected: true, unexpected: false });
							} catch {}
						}
						resolve(doc);
						continue;
					}
					if (msg.type === "auth.error") {
						clearTimeout(timer);
						socket.destroy();
						reject(new WorkspaceRuntimeError("unauthorized", `Authentication failed: ${String(msg.message)}`));
						continue;
					}
				}

				if (msg.type === "terminal.output") {
					const terminalId = msg.terminalId;
					if (typeof terminalId === "string") {
						const listeners = this.#terminalOutputListeners.get(terminalId);
						if (listeners) {
							const output: TerminalOutputFrame = {
								type: "terminal.output",
								terminalId,
								offset: typeof msg.offset === "number" ? msg.offset : 0,
								data: typeof msg.data === "string" ? msg.data : "",
								timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
							};
							for (const listener of listeners) listener(output);
						}
					}
					continue;
				}

				if (msg.type === "events" && Array.isArray(msg.events)) {
					if (msg.document) {
						try {
							const doc = parseWorkspaceDocumentV1(msg.document);
							this.#document = doc;
							for (const listener of this.#documentListeners) {
								try {
									listener(doc);
								} catch {}
							}
						} catch {}
					}
					for (const rawEvent of msg.events) {
						try {
							const event = parseWorkspaceEventV1(rawEvent);
							for (const listener of this.#eventListeners) listener(event);
						} catch {}
					}
					continue;
				}

				const requestId = msg.requestId;
				if (typeof requestId === "string") this.#correlator.resolve(requestId, msg);
			}
		});

		socket.on("close", () => {
			const unexpected = !this.#closing;
			this.#isConnected = false;
			this.#socket = undefined;
			this.#correlator.close(new LocalConnectionClosedError("Workspace connection closed"));
			this.#terminalOutputListeners.clear();
			for (const listener of this.#connectionStateListeners) {
				try {
					listener({ connected: false, unexpected });
				} catch {}
			}
		});
		socket.on("error", error => {
			if (!authenticated) {
				clearTimeout(timer);
				reject(error);
			}
		});

		return promise;
	}

	async close(): Promise<void> {
		this.#closing = true;
		this.#isConnected = false;
		if (this.#socket) {
			this.#socket.destroy();
			this.#socket = undefined;
		}
		this.#correlator.close();
		for (const listener of this.#connectionStateListeners) {
			try {
				listener({ connected: false, unexpected: false });
			} catch {}
		}
	}

	async executeCommand(
		command: WorkspaceCommandV1,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<WorkspaceCommandResultV1> {
		if (!this.#isConnected || !this.#socket) {
			throw new Error("Client is not connected to workspace runtime");
		}
		const requestId = `req-${++this.#requestIdCounter}-${Date.now()}`;
		const timeoutMs = options.timeoutMs ?? 10000;
		const payload = {
			type: "command",
			requestId,
			command,
		};
		const response = await this.#correlator.request(
			requestId,
			() => {
				this.#socket?.write(encodeLocalJsonlFrame(payload));
			},
			{ timeoutMs, signal: options.signal },
		);
		const result = response.result as WorkspaceCommandResultV1;
		if (result.status === "accepted" || result.status === "duplicate") {
			if (!this.#document || result.document.revision >= this.#document.revision) {
				this.#document = result.document;
				for (const listener of this.#documentListeners) listener(result.document);
			}
		}
		return result;
	}
	async executeCommandWithRetry(
		createCmd: (doc: WorkspaceDocumentV1) => WorkspaceCommandV1,
		options: { maxRetries?: number; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<WorkspaceCommandResultV1> {
		if (!this.#isConnected || !this.#socket) {
			throw new Error("Client is not connected to workspace runtime");
		}
		const maxRetries = options.maxRetries ?? 5;
		let currentDoc = this.#document ?? (await this.getDocument({ timeoutMs: options.timeoutMs }));
		const template = createCmd(currentDoc);
		const commandId = template.commandId;
		const issuedAt = template.issuedAt;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			if (attempt > 0) {
				currentDoc = this.#document ?? (await this.getDocument({ timeoutMs: options.timeoutMs }));
			}
			const cmd: WorkspaceCommandV1 = {
				...template,
				commandId,
				issuedAt,
				expectedRevision: currentDoc.revision,
			};
			const res = await this.executeCommand(cmd, options);
			if (res.status === "accepted" || res.status === "duplicate") {
				return res;
			}
			if (res.status === "rejected" && res.error?.code === "stale_revision" && attempt < maxRetries - 1) {
				await this.getDocument({ timeoutMs: options.timeoutMs }).catch(() => {});
				continue;
			}
			return res;
		}
		throw new Error("Command failed after retries due to concurrent revisions");
	}

	async getDocument(options: { timeoutMs?: number } = {}): Promise<WorkspaceDocumentV1> {
		if (!this.#isConnected || !this.#socket) {
			throw new Error("Client is not connected to workspace runtime");
		}
		const requestId = `req-${++this.#requestIdCounter}-${Date.now()}`;
		const timeoutMs = options.timeoutMs ?? 5000;
		const payload = {
			type: "get.document",
			requestId,
		};
		const response = await this.#correlator.request(
			requestId,
			() => {
				this.#socket?.write(encodeLocalJsonlFrame(payload));
			},
			{ timeoutMs },
		);
		const doc = parseWorkspaceDocumentV1(response.document);
		this.#document = doc;
		return doc;
	}

	async subscribeTerminal(
		terminalId: string,
		fromOffset: number,
		listener?: (frame: TerminalOutputFrame) => void,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<TerminalStatusFrame> {
		if (listener) {
			const listeners = this.#terminalOutputListeners.get(terminalId) ?? new Set();
			listeners.add(listener);
			this.#terminalOutputListeners.set(terminalId, listeners);
		}
		const requestId = `req-terminal-subscribe-${++this.#requestIdCounter}-${Date.now()}`;
		const payload: TerminalSubscribeFrame = { type: "terminal.subscribe", requestId, terminalId, fromOffset };
		const response = await this.#requestTransient(payload, options);
		if (response.type !== "terminal.status") throw new Error("Invalid terminal status response");
		return response as unknown as TerminalStatusFrame;
	}

	async sendTerminalInput(
		terminalId: string,
		data: string,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		const requestId = `req-terminal-input-${++this.#requestIdCounter}-${Date.now()}`;
		const payload: TerminalInputFrame = { type: "terminal.input", requestId, terminalId, data };
		await this.#requestTransient(payload, options);
	}

	async resizeTerminal(
		terminalId: string,
		columns: number,
		rows: number,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		const requestId = `req-terminal-resize-${++this.#requestIdCounter}-${Date.now()}`;
		const payload: TerminalResizeFrame = { type: "terminal.resize", requestId, terminalId, columns, rows };
		await this.#requestTransient(payload, options);
	}

	async unsubscribeTerminal(
		terminalId: string,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		const requestId = `req-terminal-unsubscribe-${++this.#requestIdCounter}-${Date.now()}`;
		const payload: TerminalUnsubscribeFrame = { type: "terminal.unsubscribe", requestId, terminalId };
		await this.#requestTransient(payload, options);
	}

	onTerminalOutput(terminalId: string, listener: (frame: TerminalOutputFrame) => void): () => void {
		const listeners = this.#terminalOutputListeners.get(terminalId) ?? new Set();
		listeners.add(listener);
		this.#terminalOutputListeners.set(terminalId, listeners);
		return () => {
			const current = this.#terminalOutputListeners.get(terminalId);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) this.#terminalOutputListeners.delete(terminalId);
		};
	}

	async #requestTransient(
		payload: TerminalSubscribeFrame | TerminalInputFrame | TerminalResizeFrame | TerminalUnsubscribeFrame,
		options: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<Record<string, unknown>> {
		if (!this.#isConnected || !this.#socket) throw new Error("Client is not connected to workspace runtime");
		const timeoutMs = options.timeoutMs ?? 5000;
		const response = await this.#correlator.request(
			payload.requestId,
			() => {
				this.#socket?.write(encodeLocalJsonlFrame(payload));
			},
			{ timeoutMs, signal: options.signal },
		);
		if (response.type === "terminal.error") {
			throw new Error(typeof response.message === "string" ? response.message : "Terminal request failed");
		}
		if (response.type === "terminal.result" && response.ok === false) {
			throw new Error(typeof response.message === "string" ? response.message : "Terminal request failed");
		}
		return response;
	}

	async ping(options: { timeoutMs?: number } = {}): Promise<number> {
		if (!this.#isConnected || !this.#socket) {
			throw new Error("Client is not connected to workspace runtime");
		}
		const requestId = `req-${++this.#requestIdCounter}-${Date.now()}`;
		const timeoutMs = options.timeoutMs ?? 5000;
		const payload = {
			type: "ping",
			requestId,
		};
		const response = await this.#correlator.request(
			requestId,
			() => {
				this.#socket?.write(encodeLocalJsonlFrame(payload));
			},
			{ timeoutMs },
		);
		return typeof response.timestamp === "number" ? response.timestamp : Date.now();
	}

	async shutdownRuntime(options: { timeoutMs?: number } = {}): Promise<void> {
		if (!this.#isConnected || !this.#socket) return;
		const requestId = `req-shutdown-${++this.#requestIdCounter}-${Date.now()}`;
		const timeoutMs = options.timeoutMs ?? 5000;
		const payload = {
			type: "runtime.shutdown",
			requestId,
		};
		try {
			await this.#correlator.request(
				requestId,
				() => {
					this.#socket?.write(encodeLocalJsonlFrame(payload));
				},
				{ timeoutMs },
			);
		} catch {}
		await this.close();
	}
	onEvent(listener: WorkspaceEventListener): () => void {
		this.#eventListeners.add(listener);
		return () => {
			this.#eventListeners.delete(listener);
		};
	}

	onDocument(listener: WorkspaceDocumentListener): () => void {
		this.#documentListeners.add(listener);
		if (this.#document) {
			try {
				listener(this.#document);
			} catch {}
		}
		return () => {
			this.#documentListeners.delete(listener);
		};
	}

	onConnectionState(listener: WorkspaceConnectionListener): () => void {
		this.#connectionStateListeners.add(listener);
		try {
			listener({ connected: this.#isConnected, unexpected: false });
		} catch {}
		return () => {
			this.#connectionStateListeners.delete(listener);
		};
	}
}
