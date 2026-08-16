import * as net from "node:net";
import type { WorkspaceServiceV1 } from "@oh-my-pi/pi-wire";
import type { WorkspaceSupervisor } from "./supervisor";
export interface ServiceLogEntry {
	timestamp: number;
	stream: "stdout" | "stderr";
	line: string;
}

export interface WorkspaceServiceOptions {
	id: string;
	name: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	port?: number;
	url?: string;
	restartPolicy?: "no" | "on-failure" | "always";
	maxRestarts?: number;
	readyTimeoutMs?: number;
	supervisor?: WorkspaceSupervisor;
	onStatusChange?: (id: string, status: WorkspaceServiceV1["status"], error?: string) => void;
	onLog?: (id: string, entry: ServiceLogEntry) => void;
}

export class WorkspaceServiceRunner {
	readonly id: string;
	readonly name: string;
	readonly command: string;
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly port?: number;
	readonly url?: string;
	readonly restartPolicy: "no" | "on-failure" | "always";
	readonly maxRestarts: number;
	readonly readyTimeoutMs: number;
	readonly #supervisor?: WorkspaceSupervisor;
	readonly #onStatusChange?: (id: string, status: WorkspaceServiceV1["status"], error?: string) => void;
	readonly #onLog?: (id: string, entry: ServiceLogEntry) => void;

	#status: WorkspaceServiceV1["status"] = "declared";
	#process?: Bun.Subprocess;
	#pid?: number;
	#restartCount = 0;
	#logs: ServiceLogEntry[] = [];
	#maxLogLines = 1000;
	#restartTimer?: NodeJS.Timeout;
	#runGeneration = 0;
	#isDisposed = false;
	#exitResolvers = Promise.withResolvers<number>();
	constructor(options: WorkspaceServiceOptions) {
		this.id = options.id;
		this.name = options.name;
		this.command = options.command;
		this.cwd = options.cwd;
		this.env = options.env;
		this.port = options.port;
		this.url = options.url;
		this.restartPolicy = options.restartPolicy ?? "no";
		this.maxRestarts = options.maxRestarts ?? 5;
		this.readyTimeoutMs = options.readyTimeoutMs ?? 15000;
		this.#supervisor = options.supervisor;
		this.#onStatusChange = options.onStatusChange;
		this.#onLog = options.onLog;
	}

	get status(): WorkspaceServiceV1["status"] {
		return this.#status;
	}

	get pid(): number | undefined {
		return this.#pid;
	}
	get logs(): readonly ServiceLogEntry[] {
		return this.#logs;
	}

	get exited(): Promise<number> {
		return this.#exitResolvers.promise;
	}

	async start(): Promise<void> {
		if (this.#isDisposed) throw new Error("Service is disposed");
		this.#setStatus("starting");

		const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
		const args = process.platform === "win32" ? ["/d", "/s", "/c", this.command] : ["-c", this.command];

		try {
			const proc = Bun.spawn([shell, ...args], {
				cwd: this.cwd,
				env: { ...process.env, ...this.env },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			this.#process = proc;
			this.#pid = proc.pid;

			if (this.#supervisor && proc.pid) {
				void this.#supervisor.registerProcess(this.id, "service", proc.pid).catch(() => {});
			}

			// Stream stdout/stderr and coordinate exit
			const stdoutPromise = this.#consumeStream(proc.stdout as ReadableStream<Uint8Array>, "stdout");
			const stderrPromise = this.#consumeStream(proc.stderr as ReadableStream<Uint8Array>, "stderr");
			void Promise.all([stdoutPromise, stderrPromise]).then(async () => {
				const code = await proc.exited;
				this.#handleExit(code);
			});

			if (this.port) {
				await this.#waitForPort(this.port, this.readyTimeoutMs);
			}

			if (this.#status === "starting") {
				this.#setStatus("running");
			}
		} catch (error) {
			this.#setStatus("failed", error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.#runGeneration++;
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = undefined;
		}

		if (this.#status === "stopped" || !this.#process) return;
		this.#setStatus("stopping");

		const proc = this.#process;
		this.#process = undefined;

		try {
			proc.kill();
		} catch {}

		if (this.#supervisor) {
			await this.#supervisor.stopProcess(this.id, { gracefulMs: 100, forceMs: 300 });
		}

		this.#setStatus("stopped");
	}

	dispose(): void {
		this.#isDisposed = true;
		this.#runGeneration++;
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = undefined;
		}
		void this.stop();
	}

	#setStatus(status: WorkspaceServiceV1["status"], error?: string): void {
		this.#status = status;
		this.#onStatusChange?.(this.id, status, error);
	}

	async #consumeStream(
		stream: ReadableStream<Uint8Array> | null | undefined,
		kind: "stdout" | "stderr",
	): Promise<void> {
		if (!stream) return;
		try {
			const text = await new Response(stream).text();
			if (text.length === 0) return;
			const lines = text.split("\n");
			for (const rawLine of lines) {
				const line = rawLine.replace(/\r$/, "");
				if (line.length === 0) continue;
				const entry: ServiceLogEntry = {
					timestamp: Date.now(),
					stream: kind,
					line,
				};
				this.#logs.push(entry);
				if (this.#logs.length > this.#maxLogLines) {
					this.#logs.shift();
				}
				this.#onLog?.(this.id, entry);
			}
		} catch (error) {
			this.#setStatus("failed", error instanceof Error ? error.message : String(error));
		}
	}
	#handleExit(exitCode: number): void {
		if (this.#status === "stopping" || this.#status === "stopped" || this.#isDisposed) {
			this.#setStatus("stopped");
			this.#exitResolvers.resolve(exitCode);
			return;
		}

		this.#exitResolvers.resolve(exitCode);

		if (this.#supervisor) {
			this.#supervisor.unregisterProcess(this.id);
		}

		const failed = exitCode !== 0;
		if (failed) {
			this.#setStatus("failed", `Process exited with code ${exitCode}`);
		} else {
			this.#setStatus("stopped");
		}

		const gen = this.#runGeneration;
		const shouldRestart = this.restartPolicy === "always" || (this.restartPolicy === "on-failure" && failed);
		if (shouldRestart && this.#restartCount < this.maxRestarts && !this.#isDisposed) {
			this.#restartCount++;
			const delay = Math.min(100 * 2 ** this.#restartCount, 2000);
			this.#restartTimer = setTimeout(() => {
				this.#restartTimer = undefined;
				if (
					!this.#isDisposed &&
					this.#runGeneration === gen &&
					this.#status !== "stopping" &&
					this.#status !== "stopped"
				) {
					void this.start().catch(() => {});
				}
			}, delay);
		}
	}

	async #waitForPort(port: number, timeoutMs: number): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (this.#isDisposed) return;
			const isListening = await new Promise<boolean>(resolve => {
				const socket = new net.Socket();
				socket.once("connect", () => {
					socket.destroy();
					resolve(true);
				});
				socket.once("error", () => {
					socket.destroy();
					resolve(false);
				});
				socket.connect(port, "127.0.0.1");
			});
			if (isListening) return;
			await Bun.sleep(100);
		}
		throw new Error(`Service failed to listen on port ${port} within ${timeoutMs}ms`);
	}
}

export class WorkspaceServiceManager {
	readonly #services = new Map<string, WorkspaceServiceRunner>();
	readonly #supervisor?: WorkspaceSupervisor;
	readonly #onStatusChange?: (id: string, status: WorkspaceServiceV1["status"], error?: string) => void;

	constructor(
		options: {
			supervisor?: WorkspaceSupervisor;
			onStatusChange?: (id: string, status: WorkspaceServiceV1["status"], error?: string) => void;
		} = {},
	) {
		this.#supervisor = options.supervisor;
		this.#onStatusChange = options.onStatusChange;
	}

	get serviceCount(): number {
		return this.#services.size;
	}

	getService(id: string): WorkspaceServiceRunner | undefined {
		return this.#services.get(id);
	}

	declareService(options: WorkspaceServiceOptions): WorkspaceServiceRunner {
		if (this.#services.has(options.id)) {
			throw new Error(`Service ${options.id} is already declared`);
		}
		const runner = new WorkspaceServiceRunner({
			...options,
			supervisor: this.#supervisor,
			onStatusChange: (id, status, err) => {
				options.onStatusChange?.(id, status, err);
				this.#onStatusChange?.(id, status, err);
			},
		});
		this.#services.set(options.id, runner);
		return runner;
	}

	async startService(id: string): Promise<void> {
		const service = this.#services.get(id);
		if (!service) throw new Error(`Service ${id} not found`);
		await service.start();
	}

	async stopService(id: string): Promise<void> {
		const service = this.#services.get(id);
		if (!service) return;
		await service.stop();
	}

	removeService(id: string): void {
		const service = this.#services.get(id);
		if (!service) return;
		service.dispose();
		this.#services.delete(id);
	}

	async stopAll(): Promise<void> {
		const tasks = Array.from(this.#services.values()).map(s => s.stop());
		await Promise.all(tasks);
		this.#services.clear();
	}
}
