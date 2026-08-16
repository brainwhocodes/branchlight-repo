import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import {
	DEFAULT_CONTROL_TOKEN_BASENAME,
	DEFAULT_ENDPOINT_BASENAME,
	encodeLocalJsonlFrame,
	ensureSecureRuntimeRoot,
	LocalJsonlDecoder,
	rotateControlToken,
	secureRuntimeEndpoint,
	secureRuntimePath,
	verifyControlToken,
} from "@oh-my-pi/pi-utils/local-runtime";
import {
	parseWorkspaceCommandV1,
	type WorkspaceCommandV1,
	type WorkspaceDocumentV1,
	type WorkspaceEventV1,
	type WorkspacePrincipalV1,
} from "@oh-my-pi/pi-wire";
import { WorkspaceApplication } from "./application";
import { buildChildEnvironment } from "./env";
import { reduceWorkspace } from "./reducer";
import { parseWorkspaceCommandInputV1, rejectedSchemaResult } from "./schema";
import { WorkspaceStore } from "./store";
import { WorkspaceSupervisor } from "./supervisor";
import { type TerminalOutputChunk, WorkspaceTerminalManager } from "./terminal";
import {
	TERMINAL_MAX_DIMENSION,
	TERMINAL_MAX_INPUT_BYTES,
	TERMINAL_MAX_OUTPUT_CHUNK_BYTES,
	TERMINAL_MIN_DIMENSION,
} from "./terminal-protocol";
import type {
	WorkspaceAuthorizationV1,
	WorkspaceCapabilityGrantV1,
	WorkspaceCommandResultV1,
	WorkspaceEffectIntentV1,
	WorkspaceOperationV1,
} from "./types";

export interface WorkspaceServerOptions {
	runtimeRoot: string;
	tokenBasename?: string;
	endpointBasename?: string;
	storeBasename?: string;
	executablePath?: string;
}

interface TerminalTokenRecord {
	token: string;
	authorization: WorkspaceAuthorizationV1;
	workspaceId: string;
	terminalId: string;
	paneId?: string;
	generation: number;
}

interface ClientSession {
	socket: net.Socket;
	decoder: LocalJsonlDecoder;
	authenticated: boolean;
	token?: string;
	principal?: WorkspacePrincipalV1;
	authorization: WorkspaceAuthorizationV1;
	subscribed: boolean;
	terminalSubscriptions: Set<string>;
	attachedAgentIds: Set<string>;
	leaseCleanupStarted: boolean;
}

function splitTerminalOutput(data: string, maxBytes: number): string[] {
	if (Buffer.byteLength(data, "utf8") <= maxBytes) return [data];
	const result: string[] = [];
	let current = "";
	let currentBytes = 0;
	for (const character of data) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (current && currentBytes + characterBytes > maxBytes) {
			result.push(current);
			current = "";
			currentBytes = 0;
		}
		current += character;
		currentBytes += characterBytes;
	}
	if (current) result.push(current);
	return result;
}
export class WorkspaceServer {
	readonly #runtimeRoot: string;
	readonly #tokenBasename: string;
	readonly #endpointBasename: string;
	readonly #store: WorkspaceStore;
	readonly #supervisor: WorkspaceSupervisor;
	readonly #executablePath?: string;
	#app!: WorkspaceApplication;
	#server?: net.Server;
	#controlToken!: string;
	#endpointPath!: string;
	readonly #clients = new Set<ClientSession>();
	readonly #scopedTokens = new Map<string, WorkspaceAuthorizationV1>();
	readonly #terminalManager: WorkspaceTerminalManager;
	readonly #terminalTokens = new Map<string, TerminalTokenRecord>();
	readonly #effectChains = new Map<string, Promise<void>>();
	#transactionLock: Promise<void> = Promise.resolve();
	#authorityLock?: FileLock;
	#isListening = false;

	constructor(options: WorkspaceServerOptions) {
		this.#runtimeRoot = options.runtimeRoot;
		this.#tokenBasename = options.tokenBasename ?? DEFAULT_CONTROL_TOKEN_BASENAME;
		this.#endpointBasename = options.endpointBasename ?? DEFAULT_ENDPOINT_BASENAME;
		this.#executablePath = options.executablePath;
		this.#store = new WorkspaceStore({
			runtimeRoot: options.runtimeRoot,
			basename: options.storeBasename,
		});
		this.#supervisor = new WorkspaceSupervisor();
		this.#terminalManager = new WorkspaceTerminalManager({
			supervisor: this.#supervisor,
			onData: (id, chunk) => this.#broadcastTerminalOutput(id, chunk),
			onExit: id => void this.#updateTerminalStatus(id, "exited"),
			onError: (id, error) => void this.#updateTerminalStatus(id, "failed", { error: error.message }),
		});
	}

	get runtimeRoot(): string {
		return this.#runtimeRoot;
	}

	get controlToken(): string {
		return this.#controlToken;
	}

	get endpointPath(): string {
		return this.#endpointPath;
	}

	get document(): WorkspaceDocumentV1 {
		return this.#app.document;
	}

	get isListening(): boolean {
		return this.#isListening;
	}

	get clientCount(): number {
		return this.#clients.size;
	}

	async start(): Promise<void> {
		await ensureSecureRuntimeRoot(this.#runtimeRoot);
		const authorityLockPath = secureRuntimePath(this.#runtimeRoot, "authority.lock");
		const lock = FileLock.tryAcquire(authorityLockPath);
		if (!lock.acquired) {
			throw new Error(`Workspace runtime authority lock already held at ${this.#runtimeRoot}`);
		}
		this.#authorityLock = lock;
		try {
			this.#controlToken = await rotateControlToken(this.#runtimeRoot, this.#tokenBasename);
			this.#endpointPath = secureRuntimeEndpoint(this.#runtimeRoot, this.#endpointBasename);

			const initialState = await this.#store.open();
			this.#app = new WorkspaceApplication(initialState);

			// Clean up any stale socket file on Unix before listening
			if (process.platform !== "win32") {
				try {
					await fsp.unlink(this.#endpointPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}

			const server = net.createServer(socket => this.#handleConnection(socket));
			this.#server = server;

			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(this.#endpointPath, () => {
					server.removeListener("error", reject);
					this.#isListening = true;
					resolve();
				});
			});

			for (const terminal of this.#app.document.terminals) {
				if (terminal.status !== "closed") {
					void this.#ensureTerminalSession(terminal.id);
				}
			}
		} catch (error) {
			this.#authorityLock?.release();
			this.#authorityLock = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.#isListening = false;
		for (const client of this.#clients) client.socket.destroy();
		this.#clients.clear();
		await this.#terminalManager.closeAll();

		if (this.#server) {
			await new Promise<void>(resolve => {
				this.#server?.close(() => resolve());
			});
			this.#server = undefined;
		}

		await this.#store.close();

		if (process.platform !== "win32" && this.#endpointPath) {
			try {
				await fsp.unlink(this.#endpointPath);
			} catch {}
		}

		if (this.#authorityLock) {
			this.#authorityLock.release();
			this.#authorityLock = undefined;
		}
	}
	registerScopedToken(token: string, authorization: WorkspaceAuthorizationV1): void {
		this.#scopedTokens.set(token, authorization);
	}

	revokeScopedToken(token: string): boolean {
		const removed = this.#scopedTokens.delete(token);
		for (const [terminalId, record] of this.#terminalTokens) {
			if (record.token === token) this.#terminalTokens.delete(terminalId);
		}
		return removed;
	}

	async executeCommand(command: unknown, authorization: WorkspaceAuthorizationV1): Promise<WorkspaceCommandResultV1> {
		const result = await this.#withTransaction(async () => {
			let parsed: WorkspaceCommandV1;
			try {
				parsed = parseWorkspaceCommandInputV1(command);
			} catch (error) {
				return rejectedSchemaResult(this.#app.state, error);
			}

			const currentState = this.#app.state;
			const result = reduceWorkspace(currentState, parsed, authorization);
			if (result.status === "accepted") {
				this.#revokeTokensBeforeCommit(parsed, currentState.document);
				await this.#store.commitResult(parsed, result);
				this.#app.installState(result.state);
				if (result.events.length > 0) this.#broadcastEvents(result.events, result.document.revision);
			}
			return result;
		});
		if (result.status !== "accepted") return result;
		for (const effect of result.effects) await this.#queueEffect(effect);
		return {
			...result,
			state: this.#app.state,
			document: this.#app.document,
		};
	}

	async #withTransaction<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.#transactionLock;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#transactionLock = promise;
		try {
			await prev;
			return await fn();
		} finally {
			resolve();
		}
	}

	#handleConnection(socket: net.Socket): void {
		const session: ClientSession = {
			socket,
			decoder: new LocalJsonlDecoder(),
			authenticated: false,
			authorization: {
				principal: { kind: "user", id: "anonymous" },
				capabilities: [],
			},
			subscribed: false,
			terminalSubscriptions: new Set(),
			attachedAgentIds: new Set(),
			leaseCleanupStarted: false,
		};
		this.#clients.add(session);
		socket.on("data", async chunk => {
			let frames: unknown[];
			try {
				frames = session.decoder.push(chunk);
			} catch (error) {
				socket.destroy(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			for (const frame of frames) {
				await this.#handleFrame(session, frame);
			}
		});
		socket.on("close", () => {
			session.terminalSubscriptions.clear();
			this.#clients.delete(session);
			void this.#cleanupClientAgentLeases(session);
		});

		socket.on("error", () => {
			session.terminalSubscriptions.clear();
			this.#clients.delete(session);
			void this.#cleanupClientAgentLeases(session);
		});
	}
	async #cleanupClientAgentLeases(session: ClientSession): Promise<void> {
		if (session.leaseCleanupStarted) return;
		session.leaseCleanupStarted = true;
		const agentIds = [...session.attachedAgentIds];
		session.attachedAgentIds.clear();
		if (!this.#app) return;
		for (const agentId of agentIds) {
			const agent = this.#app.document.agents.find(item => item.id === agentId);
			if (agent?.status !== "running") continue;
			const terminal = agent.terminalId
				? this.#app.document.terminals.find(item => item.id === agent.terminalId)
				: undefined;
			const pane = terminal ? this.#app.document.panes.find(item => item.entityId === terminal.id) : undefined;
			const tab = pane ? this.#app.document.tabs.find(item => item.id === pane.tabId) : undefined;
			const workspaceId = tab?.workspaceId ?? this.#app.document.activeWorkspaceId;
			if (!workspaceId) continue;
			const command: WorkspaceCommandV1 = {
				version: 1,
				commandId: `cmd-lease-detach-${crypto.randomUUID()}`,
				workspaceId,
				expectedRevision: this.#app.document.revision,
				issuedAt: Date.now(),
				type: "agent.detach",
				payload: { id: agentId, reason: "connection-closed" },
			};
			for (let attempt = 0; attempt < 5; attempt++) {
				command.expectedRevision = this.#app.document.revision;
				const result = await this.executeCommand(command, this.#app.authorization);
				if (result.status === "accepted" || result.status === "duplicate") break;
				if (result.error?.code !== "stale_revision") break;
			}
		}
	}

	#recordClientAgentLease(
		session: ClientSession,
		command: WorkspaceCommandV1,
		result: WorkspaceCommandResultV1,
	): void {
		if (result.status !== "accepted" && result.status !== "duplicate") return;
		if (command.type === "agent.attach" && typeof command.payload.id === "string") {
			const agent = result.document.agents.find(item => item.id === command.payload.id);
			if (agent?.status === "running") session.attachedAgentIds.add(agent.id);
		}
		if (command.type === "agent.detach" && typeof command.payload.id === "string") {
			session.attachedAgentIds.delete(command.payload.id);
		}
		for (const agentId of session.attachedAgentIds) {
			const agent = result.document.agents.find(item => item.id === agentId);
			if (agent?.status !== "running") session.attachedAgentIds.delete(agentId);
		}
	}
	async #handleFrame(session: ClientSession, frame: unknown): Promise<void> {
		if (typeof frame !== "object" || frame === null || !("type" in frame)) {
			this.#sendFrame(session.socket, { type: "error", message: "Malformed frame" });
			return;
		}
		const msg = frame as Record<string, unknown>;
		const type = msg.type;

		if (!session.authenticated) {
			if (type !== "auth") {
				this.#sendFrame(session.socket, { type: "auth.error", message: "Authentication required" });
				session.socket.destroy();
				return;
			}
			const token = msg.token;
			if (typeof token !== "string") {
				this.#sendFrame(session.socket, { type: "auth.error", message: "Invalid control token" });
				session.socket.destroy();
				return;
			}

			if (verifyControlToken(token, this.#controlToken)) {
				session.authenticated = true;
				session.token = token;
				const principal: WorkspacePrincipalV1 = { kind: "user", id: "operator" };
				session.principal = principal;
				const fullCapabilities: WorkspaceCapabilityGrantV1[] = [
					{
						capabilityId: "full-access",
						scope: "workspace",
						operations: [
							"workspace.create",
							"workspace.start",
							"workspace.stop",
							"workspace.delete",
							"profile.create",
							"profile.update",
							"profile.delete",
							"tab.update",
							"tab.close",
							"terminal.open",
							"terminal.status",
							"terminal.input",
							"terminal.resize",
							"terminal.close",
							"terminal.subscribe",
							"terminal.unsubscribe",
							"agent.start",
							"agent.attach",
							"agent.message",
							"agent.stop",
							"agent.detach",
							"browser.open",
							"browser.navigate",
							"browser.close",
							"selection.set",
							"preview.open",
							"preview.close",
							"service.declare",
							"service.start",
							"service.stop",
							"worktree.create",
							"worktree.remove",
							"remote.connect",
							"remote.disconnect",
							"attention.notify",
							"attention.dismiss",
							"cleanup.retry",
							"cleanup.cancel",
						],
					},
				];
				session.authorization = {
					principal,
					capabilities: fullCapabilities,
				};
				this.#sendFrame(session.socket, {
					type: "auth.ok",
					principal,
					document: this.#app.document,
				});
				return;
			}

			// Check server-registered scoped tokens
			let matchedAuth: WorkspaceAuthorizationV1 | undefined;
			for (const [registeredToken, auth] of this.#scopedTokens) {
				if (verifyControlToken(token, registeredToken)) {
					matchedAuth = auth;
					break;
				}
			}

			if (matchedAuth) {
				session.authenticated = true;
				session.token = token;
				session.principal = matchedAuth.principal;
				session.authorization = matchedAuth;
				this.#sendFrame(session.socket, {
					type: "auth.ok",
					principal: matchedAuth.principal,
					document: this.#app.document,
				});
				return;
			}

			this.#sendFrame(session.socket, { type: "auth.error", message: "Invalid control token" });
			session.socket.destroy();
			return;
		}

		if (type === "command") {
			const requestId = msg.requestId;
			if (typeof requestId !== "string") {
				this.#sendFrame(session.socket, { type: "error", message: "requestId is required" });
				return;
			}
			try {
				const command = parseWorkspaceCommandV1(msg.command);
				const result = await this.executeCommand(command, session.authorization);
				this.#recordClientAgentLease(session, command, result);
				this.#sendFrame(session.socket, {
					type: "command.result",
					requestId,
					result,
				});
			} catch (error) {
				this.#sendFrame(session.socket, {
					type: "command.result",
					requestId,
					result: {
						status: "rejected",
						state: this.#app.state,
						document: this.#app.document,
						events: [],
						effects: [],
						error: {
							code: "invalid_command",
							message: error instanceof Error ? error.message : String(error),
						},
					},
				});
			}
			return;
		}
		if (typeof type === "string" && type.startsWith("terminal.")) {
			await this.#handleTerminalFrame(session, msg);
			return;
		}
		if (type === "runtime.shutdown") {
			if (session.principal?.id !== "operator") {
				this.#sendFrame(session.socket, { type: "error", message: "Unauthorized shutdown request" });
				return;
			}
			this.#sendFrame(session.socket, {
				type: "runtime.shutdown.ok",
				requestId: msg.requestId,
			});
			setTimeout(async () => {
				await this.stop();
			}, 50);
			return;
		}

		if (type === "subscribe") {
			session.subscribed = true;
			this.#sendFrame(session.socket, { type: "subscribe.ok" });
			return;
		}

		if (type === "ping") {
			this.#sendFrame(session.socket, {
				type: "pong",
				requestId: msg.requestId,
				timestamp: Date.now(),
			});
			return;
		}

		if (type === "get.document") {
			this.#sendFrame(session.socket, {
				type: "document",
				requestId: msg.requestId,
				document: this.#app.document,
			});
			return;
		}

		this.#sendFrame(session.socket, { type: "error", message: `Unknown frame type: ${String(type)}` });
	}

	#revokeTokensBeforeCommit(command: WorkspaceCommandV1, document: WorkspaceDocumentV1): void {
		if (command.type === "terminal.close" && typeof command.payload.id === "string") {
			this.#revokeTerminalToken(command.payload.id);
			return;
		}
		if (command.type !== "tab.close" || typeof command.payload.id !== "string") return;
		const tab = document.tabs.find(item => item.id === command.payload.id);
		if (!tab) return;
		for (const pane of document.panes) {
			if (pane.tabId !== tab.id || pane.kind !== "terminal") continue;
			this.#revokeTerminalToken(pane.entityId);
		}
	}
	async #queueEffect(effect: WorkspaceEffectIntentV1): Promise<void> {
		const previous = this.#effectChains.get(effect.intentId) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(() => this.#executeEffect(effect));
		this.#effectChains.set(effect.intentId, next);
		try {
			await next;
		} finally {
			if (this.#effectChains.get(effect.intentId) === next) this.#effectChains.delete(effect.intentId);
		}
	}

	async #executeEffect(effect: WorkspaceEffectIntentV1): Promise<void> {
		if (effect.kind !== "terminal") return;
		const id = typeof effect.payload.id === "string" ? effect.payload.id : undefined;
		if (!id) return;
		try {
			if (effect.operation === "terminal.open") {
				await this.#startTerminal(effect, id);
				return;
			}
			if (effect.operation === "terminal.input") {
				const data = effect.payload.data;
				if (typeof data !== "string") throw new Error("terminal input data is invalid");
				this.#terminalManager.write(id, data);
				return;
			}
			if (effect.operation === "terminal.resize") {
				const columns = effect.payload.columns;
				const rows = effect.payload.rows;
				if (
					typeof columns !== "number" ||
					!Number.isSafeInteger(columns) ||
					typeof rows !== "number" ||
					!Number.isSafeInteger(rows) ||
					columns < TERMINAL_MIN_DIMENSION ||
					columns > TERMINAL_MAX_DIMENSION ||
					rows < TERMINAL_MIN_DIMENSION ||
					rows > TERMINAL_MAX_DIMENSION
				)
					throw new Error("invalid terminal dimensions");
				this.#terminalManager.resize(id, columns, rows);
				return;
			}
			if (effect.operation === "terminal.close" || effect.operation === "tab.close") {
				this.#revokeTerminalToken(id);
				await this.#terminalManager.close(id);
			}
		} catch (error) {
			await this.#updateTerminalStatus(id, "failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #startTerminal(effect: WorkspaceEffectIntentV1, terminalId: string): Promise<void> {
		const terminal = this.#app.document.terminals.find(item => item.id === terminalId);
		if (!terminal || this.#terminalManager.getSession(terminalId)) return;
		const tokenRecord = this.#mintTerminalToken(effect.workspaceId, terminal);
		const payload = effect.payload;
		const shell = typeof payload.shell === "string" ? payload.shell : undefined;
		const args =
			Array.isArray(payload.args) && payload.args.every(item => typeof item === "string") ? payload.args : undefined;
		const inheritedPath = process.platform === "win32" ? ";" : ":";
		const env = buildChildEnvironment({
			explicitBindings: {
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
			},
			scopedDescriptor: {
				BRANCHLIGHT_TERMINAL: "1",
				BRANCHLIGHT_TERMINAL_ID: terminal.id,
				BRANCHLIGHT_PANE_ID: terminal.paneId ?? "",
				BRANCHLIGHT_WORKSPACE_ID: effect.workspaceId,
				...(terminal.profileId ? { BRANCHLIGHT_PROFILE_ID: terminal.profileId } : {}),
				PI_RUNTIME_DIR: this.#runtimeRoot,
				PI_RUNTIME_TOKEN: tokenRecord.token,
				PI_BROWSER_CDP_URL: "http://127.0.0.1:9222",
			},
		});
		if (this.#executablePath) {
			const executableDirectory = path.dirname(this.#executablePath);
			env.PATH = `${executableDirectory}${inheritedPath}${env.PATH ?? ""}`;
		}
		try {
			await this.#terminalManager.createSession({
				id: terminal.id,
				shell,
				args,
				cwd: terminal.cwd,
				env,
				columns: terminal.columns,
				rows: terminal.rows,
			});
			await this.#updateTerminalStatus(terminal.id, "running", {
				cwd: terminal.cwd,
				columns: terminal.columns,
				rows: terminal.rows,
			});
		} catch (error) {
			await this.#updateTerminalStatus(terminal.id, "failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	async #ensureTerminalSession(terminalId: string): Promise<void> {
		const terminal = this.#app.document.terminals.find(item => item.id === terminalId);
		if (!terminal || terminal.status === "closed" || this.#terminalManager.getSession(terminalId)) return;
		const workspaceId =
			this.#app.document.workspaces.find(ws => ws.locationId === terminal.locationId)?.id ??
			this.#app.document.activeWorkspaceId ??
			"ws_main";
		await this.#startTerminal(
			{
				workspaceId,
				operation: "terminal.open",
				targetId: terminal.id,
				payload: {},
			} as unknown as WorkspaceEffectIntentV1,
			terminal.id,
		);
	}

	#mintTerminalToken(
		workspaceId: string,
		terminal: {
			id: string;
			paneId?: string;
			locationId: string;
			generation: number;
		},
	): TerminalTokenRecord {
		this.#revokeTerminalToken(terminal.id);
		const token = crypto.randomBytes(32).toString("hex");
		const authorization: WorkspaceAuthorizationV1 = {
			principal: { kind: "agent", id: terminal.id },
			capabilities: [
				{
					capabilityId: `terminal-${terminal.id}-${terminal.generation}`,
					scope: "terminal",
					workspaceId,
					locationId: terminal.locationId,
					entityId: terminal.id,
					paneId: terminal.paneId,
					generation: terminal.generation,
					operations: ["agent.attach", "agent.detach"],
				},
			],
		};
		const record: TerminalTokenRecord = {
			token,
			authorization,
			workspaceId,
			terminalId: terminal.id,
			paneId: terminal.paneId,
			generation: terminal.generation,
		};
		this.#terminalTokens.set(terminal.id, record);
		this.#scopedTokens.set(token, authorization);
		return record;
	}

	#revokeTerminalToken(terminalId: string): void {
		const record = this.#terminalTokens.get(terminalId);
		if (!record) return;
		this.#terminalTokens.delete(terminalId);
		this.#scopedTokens.delete(record.token);
		for (const client of this.#clients) {
			if (client.token === record.token) client.socket.destroy();
		}
	}

	async #updateTerminalStatus(
		terminalId: string,
		status: "starting" | "running" | "exited" | "failed" | "closed",
		fields: { error?: string; cwd?: string; columns?: number; rows?: number } = {},
	): Promise<void> {
		if (!this.#app) return;
		const terminal = this.#app.document.terminals.find(item => item.id === terminalId);
		if (!terminal) return;
		const pane = this.#app.document.panes.find(item => item.entityId === terminalId);
		const tab = pane ? this.#app.document.tabs.find(item => item.id === pane.tabId) : undefined;
		const workspaceId = tab?.workspaceId ?? this.#app.document.activeWorkspaceId;
		if (!workspaceId) return;
		const commandId = `cmd-term-status-${crypto.randomUUID()}`;
		const issuedAt = Date.now();
		for (let attempt = 0; attempt < 5; attempt++) {
			const current = this.#app.document;
			const result = await this.executeCommand(
				{
					version: 1,
					commandId,
					workspaceId,
					expectedRevision: current.revision,
					issuedAt,
					type: "terminal.status",
					payload: {
						id: terminalId,
						status,
						...(fields.error !== undefined ? { error: fields.error } : {}),
						...(fields.cwd !== undefined ? { cwd: fields.cwd } : {}),
						...(fields.columns !== undefined ? { columns: fields.columns } : {}),
						...(fields.rows !== undefined ? { rows: fields.rows } : {}),
					},
				},
				this.#app.authorization,
			);
			if (result.status === "accepted" || result.status === "duplicate") return;
			if (result.error?.code !== "stale_revision") return;
		}
	}

	#authorizeTerminalFrame(
		session: ClientSession,
		operation: WorkspaceOperationV1,
		terminalId: string,
	): { terminal: WorkspaceDocumentV1["terminals"][number]; paneId?: string; workspaceId: string } {
		const terminal = this.#app.document.terminals.find(item => item.id === terminalId);
		if (!terminal) throw new Error(`Terminal ${terminalId} does not exist`);
		const pane = this.#app.document.panes.find(item => item.entityId === terminal.id);
		const tab = pane ? this.#app.document.tabs.find(item => item.id === pane.tabId) : undefined;
		const workspaceId = tab?.workspaceId ?? this.#app.document.activeWorkspaceId;
		if (!workspaceId) throw new Error(`Terminal ${terminalId} has no workspace`);
		const now = Date.now();
		const grant = session.authorization.capabilities.find(
			item =>
				item.operations.includes(operation) &&
				!item.revoked &&
				(item.expiresAt === undefined || item.expiresAt > now) &&
				(item.workspaceId === undefined || item.workspaceId === workspaceId) &&
				(item.locationId === undefined || item.locationId === terminal.locationId) &&
				(item.entityId === undefined || item.entityId === terminal.id) &&
				(item.paneId === undefined || item.paneId === pane?.id) &&
				(item.generation === undefined || item.generation === terminal.generation) &&
				(item.scope === "workspace" ||
					item.scope === "location" ||
					item.scope === "session" ||
					item.scope === "terminal" ||
					item.scope === "agent"),
		);
		if (!grant) throw new Error(`Principal ${session.authorization.principal.id} is not authorized for ${operation}`);
		return { terminal, paneId: pane?.id, workspaceId };
	}

	async #handleTerminalFrame(session: ClientSession, msg: Record<string, unknown>): Promise<void> {
		const type = msg.type;
		const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
		const terminalId = typeof msg.terminalId === "string" ? msg.terminalId : undefined;
		if (!requestId || !terminalId) {
			this.#sendFrame(session.socket, {
				type: "terminal.error",
				requestId,
				message: "requestId and terminalId are required",
			});
			return;
		}
		try {
			if (type === "terminal.subscribe") {
				const target = this.#authorizeTerminalFrame(session, "terminal.subscribe", terminalId);
				await this.#ensureTerminalSession(terminalId);
				const fromOffset =
					typeof msg.fromOffset === "number" && Number.isSafeInteger(msg.fromOffset) && msg.fromOffset >= 0
						? msg.fromOffset
						: 0;
				session.terminalSubscriptions.add(terminalId);
				const terminalSession = this.#terminalManager.getSession(terminalId);
				for (const chunk of terminalSession?.getHistory(fromOffset) ?? []) {
					this.#sendTerminalOutput(session, terminalId, chunk);
				}
				this.#sendTerminalSnapshot(session, target.terminal, requestId);
				return;
			}
			if (type === "terminal.unsubscribe") {
				this.#authorizeTerminalFrame(session, "terminal.unsubscribe", terminalId);
				session.terminalSubscriptions.delete(terminalId);
				this.#sendFrame(session.socket, { type: "terminal.result", requestId, terminalId, ok: true });
				return;
			}
			if (type === "terminal.input") {
				this.#authorizeTerminalFrame(session, "terminal.input", terminalId);
				await this.#ensureTerminalSession(terminalId);
				const data = msg.data;
				if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > TERMINAL_MAX_INPUT_BYTES)
					throw new Error(`terminal input exceeds ${TERMINAL_MAX_INPUT_BYTES} bytes`);
				this.#terminalManager.write(terminalId, data);
				this.#sendFrame(session.socket, { type: "terminal.result", requestId, terminalId, ok: true });
				return;
			}
			if (type === "terminal.resize") {
				this.#authorizeTerminalFrame(session, "terminal.resize", terminalId);
				await this.#ensureTerminalSession(terminalId);
				const columns = msg.columns;
				const rows = msg.rows;
				if (
					typeof columns !== "number" ||
					!Number.isSafeInteger(columns) ||
					typeof rows !== "number" ||
					!Number.isSafeInteger(rows) ||
					columns < TERMINAL_MIN_DIMENSION ||
					columns > TERMINAL_MAX_DIMENSION ||
					rows < TERMINAL_MIN_DIMENSION ||
					rows > TERMINAL_MAX_DIMENSION
				)
					throw new Error("invalid terminal dimensions");
				this.#terminalManager.resize(terminalId, columns, rows);
				this.#sendFrame(session.socket, { type: "terminal.result", requestId, terminalId, ok: true });
				return;
			}
			if (type === "terminal.status") {
				const target = this.#authorizeTerminalFrame(session, "terminal.status", terminalId);
				this.#sendTerminalSnapshot(session, target.terminal, requestId);
				return;
			}
			this.#sendFrame(session.socket, {
				type: "terminal.error",
				requestId,
				terminalId,
				message: `Unknown terminal frame ${String(type)}`,
			});
		} catch (error) {
			this.#sendFrame(session.socket, {
				type: "terminal.error",
				requestId,
				terminalId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#sendTerminalSnapshot(
		session: ClientSession,
		terminal: WorkspaceDocumentV1["terminals"][number],
		requestId: string,
	): void {
		const terminalSession = this.#terminalManager.getSession(terminal.id);
		this.#sendFrame(session.socket, {
			type: "terminal.status",
			requestId,
			terminalId: terminal.id,
			status: terminalSession?.status ?? terminal.status,
			pid: terminalSession?.pid,
			cwd: terminalSession?.cwd ?? terminal.cwd,
			columns: terminalSession?.columns ?? terminal.columns,
			rows: terminalSession?.rows ?? terminal.rows,
			totalBytesProduced: terminalSession?.totalBytesProduced ?? 0,
		});
	}

	#sendTerminalOutput(session: ClientSession, terminalId: string, chunk: TerminalOutputChunk): void {
		let offset = chunk.offset;
		for (const data of splitTerminalOutput(chunk.data, TERMINAL_MAX_OUTPUT_CHUNK_BYTES)) {
			this.#sendFrame(session.socket, {
				type: "terminal.output",
				terminalId,
				offset,
				data,
				timestamp: chunk.timestamp,
			});
			offset += Buffer.byteLength(data, "utf8");
		}
	}

	#broadcastTerminalOutput(terminalId: string, chunk: TerminalOutputChunk): void {
		for (const client of this.#clients) {
			if (!client.authenticated || !client.terminalSubscriptions.has(terminalId)) continue;
			let offset = chunk.offset;
			for (const data of splitTerminalOutput(chunk.data, TERMINAL_MAX_OUTPUT_CHUNK_BYTES)) {
				this.#sendFrame(client.socket, {
					type: "terminal.output",
					terminalId,
					offset,
					data,
					timestamp: chunk.timestamp,
				});
				offset += Buffer.byteLength(data, "utf8");
			}
		}
	}
	#sendFrame(socket: net.Socket, payload: unknown): void {
		if (socket.destroyed) return;
		try {
			const frame = encodeLocalJsonlFrame(payload);
			socket.write(frame);
		} catch {}
	}

	#broadcastEvents(events: readonly WorkspaceEventV1[], revision: number): void {
		const payload = {
			type: "events",
			events,
			revision,
			document: this.#app.document,
		};
		for (const client of this.#clients) {
			if (client.authenticated && client.subscribed) {
				this.#sendFrame(client.socket, payload);
			}
		}
	}
}
