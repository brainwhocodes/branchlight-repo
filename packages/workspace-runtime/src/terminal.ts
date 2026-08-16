import { Process, type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import type { WorkspaceTerminalV1 } from "@oh-my-pi/pi-wire";
import type { WorkspaceSupervisor } from "./supervisor";

export const DEFAULT_RING_BUFFER_BYTES = 1024 * 1024; // 1 MB

export interface TerminalOutputChunk {
	offset: number;
	data: string;
	timestamp: number;
}

export interface WorkspaceTerminalSessionOptions {
	id: string;
	shell?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	columns?: number;
	rows?: number;
	maxBufferBytes?: number;
	supervisor?: WorkspaceSupervisor;
	onData?: (id: string, chunk: TerminalOutputChunk) => void;
	onExit?: (id: string, exitCode: number) => void;
	onError?: (id: string, error: Error) => void;
}
function defaultPlatformShell(): string {
	if (process.platform === "win32") return process.env.COMSPEC ?? "cmd.exe";
	if (process.platform === "darwin") return "/bin/zsh";
	return process.env.SHELL ?? "/bin/bash";
}

export class WorkspaceTerminalSession {
	readonly id: string;
	readonly #shell: string;
	readonly #args: string[];
	readonly #cwd?: string;
	readonly #env?: Record<string, string>;
	#cols: number;
	#rows: number;
	readonly #maxBufferBytes: number;
	readonly #supervisor?: WorkspaceSupervisor;
	readonly #onData?: (id: string, chunk: TerminalOutputChunk) => void;
	readonly #onExit?: (id: string, exitCode: number) => void;
	readonly #onError?: (id: string, error: Error) => void;

	#pty?: PtySession;
	#status: WorkspaceTerminalV1["status"] = "starting";
	#pid?: number;
	#chunks: TerminalOutputChunk[] = [];
	#bufferedBytes = 0;
	#totalBytesProduced = 0;
	#isClosed = false;
	#runPromise?: Promise<PtyRunResult>;
	#exitResolvers = Promise.withResolvers<number>();

	constructor(options: WorkspaceTerminalSessionOptions) {
		this.id = options.id;
		this.#shell = options.shell ?? defaultPlatformShell();
		this.#args = options.args ?? [];
		this.#cwd = options.cwd;
		this.#env = options.env;
		this.#cols = options.columns ?? 80;
		this.#rows = options.rows ?? 24;
		this.#maxBufferBytes = options.maxBufferBytes ?? DEFAULT_RING_BUFFER_BYTES;
		this.#supervisor = options.supervisor;
		this.#onData = options.onData;
		this.#onExit = options.onExit;
		this.#onError = options.onError;
	}

	get shell(): string {
		return this.#shell;
	}

	get status(): WorkspaceTerminalV1["status"] {
		return this.#status;
	}

	get pid(): number | undefined {
		return this.#pid;
	}

	get totalBytesProduced(): number {
		return this.#totalBytesProduced;
	}

	get cwd(): string | undefined {
		return this.#cwd;
	}

	get columns(): number {
		return this.#cols;
	}

	get rows(): number {
		return this.#rows;
	}

	async start(): Promise<number> {
		if (this.#status !== "starting" || this.#isClosed) {
			throw new Error(`Terminal ${this.id} is already started or closed`);
		}

		const pty = new PtySession();
		this.#pty = pty;

		const {
			promise: startedPromise,
			resolve: resolveStarted,
			reject: rejectStarted,
		} = Promise.withResolvers<number>();

		const onChunk = (error: Error | null, chunk: string): void => {
			if (error) {
				this.#onError?.(this.id, error);
				return;
			}
			if (chunk.length === 0) return;
			const chunkBytes = Buffer.byteLength(chunk, "utf8");
			const chunkRecord: TerminalOutputChunk = {
				offset: this.#totalBytesProduced,
				data: chunk,
				timestamp: Date.now(),
			};
			this.#totalBytesProduced += chunkBytes;
			this.#appendChunk(chunkRecord);
			this.#onData?.(this.id, chunkRecord);
		};

		const onStart = (error: Error | null, pid: number): void => {
			if (error) {
				this.#status = "closed";
				rejectStarted(error);
				return;
			}
			this.#pid = pid;
			this.#status = "running";
			if (this.#supervisor && pid > 0) {
				void this.#supervisor.registerProcess(this.id, "terminal", pid).catch(() => {});
			}
			resolveStarted(pid);
		};

		try {
			const runPromise =
				this.#args.length > 0
					? pty.startArgv(
							{
								application: this.#shell,
								args: this.#args,
								cwd: this.#cwd,
								env: this.#env,
								cols: this.#cols,
								rows: this.#rows,
							},
							onChunk,
							onStart,
						)
					: pty.start(
							{
								command: this.#shell,
								cwd: this.#cwd,
								env: this.#env,
								cols: this.#cols,
								rows: this.#rows,
							},
							onChunk,
							onStart,
						);

			this.#runPromise = runPromise;

			void runPromise
				.then(result => {
					this.#handleExit(result.exitCode ?? 0);
				})
				.catch(error => {
					this.#handleError(error);
				});
		} catch (error) {
			this.#status = "closed";
			throw error;
		}

		return startedPromise;
	}

	write(data: string): void {
		if (this.#status !== "running" || !this.#pty || this.#isClosed) {
			throw new Error(`Terminal ${this.id} is not running`);
		}
		this.#pty.write(data);
	}

	resize(cols: number, rows: number): void {
		if (cols < 2 || rows < 2) return;
		this.#cols = cols;
		this.#rows = rows;
		if (this.#status === "running" && this.#pty) {
			try {
				this.#pty.resize(cols, rows);
			} catch {}
		}
	}

	getHistory(fromOffset = 0): TerminalOutputChunk[] {
		return this.#chunks
			.filter(chunk => chunk.offset + Buffer.byteLength(chunk.data, "utf8") > fromOffset)
			.map(chunk => {
				if (fromOffset <= chunk.offset) return { ...chunk };
				const bytes = Buffer.from(chunk.data, "utf8");
				const delta = Math.max(0, fromOffset - chunk.offset);
				return {
					...chunk,
					offset: fromOffset,
					data: bytes.subarray(delta).toString("utf8"),
				};
			})
			.filter(chunk => chunk.data.length > 0);
	}

	async close(timeoutMs = 300): Promise<void> {
		if (this.#isClosed) return;
		this.#isClosed = true;

		if (this.#pid) {
			try {
				const proc = Process.fromPid(this.#pid);
				proc?.killTree(9);
			} catch {}
		}

		if (this.#pty) {
			try {
				this.#pty.kill();
			} catch {}
		}

		if (this.#supervisor && this.#pid) {
			await this.#supervisor.stopProcess(this.id, { gracefulMs: 50, forceMs: 200 }).catch(() => {});
		} else if (this.#runPromise) {
			const timer = setTimeout(() => this.#exitResolvers.resolve(-1), Math.min(timeoutMs, 300));
			await Promise.race([this.#runPromise.catch(() => {}), this.#exitResolvers.promise]);
			clearTimeout(timer);
		}

		this.#pty = undefined;
		this.#status = "exited";
		if (this.#supervisor && this.id) {
			this.#supervisor.unregisterProcess(this.id);
		}
	}

	#appendChunk(chunk: TerminalOutputChunk): void {
		this.#chunks.push(chunk);
		const bytes = Buffer.byteLength(chunk.data, "utf8");
		this.#bufferedBytes += bytes;

		while (this.#bufferedBytes > this.#maxBufferBytes && this.#chunks.length > 1) {
			const shifted = this.#chunks.shift();
			if (shifted) {
				this.#bufferedBytes -= Buffer.byteLength(shifted.data, "utf8");
			}
		}
	}

	#handleExit(exitCode: number): void {
		if (this.#isClosed) return;
		this.#status = "exited";
		this.#isClosed = true;
		this.#exitResolvers.resolve(exitCode);
		if (this.#supervisor) {
			this.#supervisor.unregisterProcess(this.id);
		}
		this.#onExit?.(this.id, exitCode);
	}

	#handleError(error: unknown): void {
		if (this.#isClosed) return;
		this.#status = "failed";
		this.#isClosed = true;
		const err = error instanceof Error ? error : new Error(String(error));
		this.#exitResolvers.resolve(-1);
		if (this.#supervisor) {
			this.#supervisor.unregisterProcess(this.id);
		}
		this.#onError?.(this.id, err);
	}
}

export class WorkspaceTerminalManager {
	readonly #sessions = new Map<string, WorkspaceTerminalSession>();
	readonly #supervisor?: WorkspaceSupervisor;
	readonly #onData?: (id: string, chunk: TerminalOutputChunk) => void;
	readonly #onExit?: (id: string, exitCode: number) => void;
	readonly #onError?: (id: string, error: Error) => void;

	constructor(
		options: {
			supervisor?: WorkspaceSupervisor;
			onData?: (id: string, chunk: TerminalOutputChunk) => void;
			onExit?: (id: string, exitCode: number) => void;
			onError?: (id: string, error: Error) => void;
		} = {},
	) {
		this.#supervisor = options.supervisor;
		this.#onData = options.onData;
		this.#onExit = options.onExit;
		this.#onError = options.onError;
	}

	get sessionCount(): number {
		return this.#sessions.size;
	}

	getSession(id: string): WorkspaceTerminalSession | undefined {
		return this.#sessions.get(id);
	}

	async createSession(options: WorkspaceTerminalSessionOptions): Promise<WorkspaceTerminalSession> {
		if (this.#sessions.has(options.id)) {
			throw new Error(`Terminal session ${options.id} already exists`);
		}
		const session = new WorkspaceTerminalSession({
			...options,
			supervisor: this.#supervisor,
			onData: (id, chunk) => {
				options.onData?.(id, chunk);
				this.#onData?.(id, chunk);
			},
			onExit: (id, code) => {
				options.onExit?.(id, code);
				this.#onExit?.(id, code);
			},
			onError: (id, error) => {
				options.onError?.(id, error);
				this.#onError?.(id, error);
			},
		});
		this.#sessions.set(options.id, session);
		try {
			await session.start();
			return session;
		} catch (error) {
			this.#sessions.delete(options.id);
			throw error;
		}
	}

	write(id: string, data: string): void {
		const session = this.#sessions.get(id);
		if (!session) throw new Error(`Terminal ${id} not found`);
		session.write(data);
	}

	resize(id: string, cols: number, rows: number): void {
		const session = this.#sessions.get(id);
		if (!session) return;
		session.resize(cols, rows);
	}

	async close(id: string): Promise<void> {
		const session = this.#sessions.get(id);
		if (!session) return;
		this.#sessions.delete(id);
		await session.close();
	}

	async closeAll(): Promise<void> {
		const sessions = Array.from(this.#sessions.values());
		this.#sessions.clear();
		await Promise.all(sessions.map(session => session.close()));
	}
}
