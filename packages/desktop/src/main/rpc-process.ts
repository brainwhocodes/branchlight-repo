import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	connectOmpGrpc,
	generateOmpGrpcToken,
	type OmpGrpcClientConnection,
	waitForOmpGrpcBootstrapFile,
} from "@oh-my-pi/pi-grpc";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import type { ProcessState } from "../shared/contracts";
import type { RpcExtensionUIRequest } from "../shared/rpc-wire";
import { ompExecutablePath, rpcConfigPath } from "./backend-path";
import { RpcClient } from "./rpc-client";

const CLIENT_CLOSE_TIMEOUT_MS = 5_000;
const ABORT_TIMEOUT_MS = 2_000;
const CHILD_GRACE_PERIOD_MS = 10_000;
const CHILD_FORCE_REAP_TIMEOUT_MS = 5_000;

export type RpcProcessDependencies = {
	createTempDir: (prefix: string) => Promise<TempDir>;
	spawn: typeof spawn;
	generateToken: typeof generateOmpGrpcToken;
	waitForBootstrap: typeof waitForOmpGrpcBootstrapFile;
	connect: typeof connectOmpGrpc;
	createClient: (connection: OmpGrpcClientConnection) => RpcClient;
	killTree: (pid: number | undefined) => Promise<void>;
	platform: NodeJS.Platform;
	ompExecutablePath: typeof ompExecutablePath;
	rpcConfigPath: typeof rpcConfigPath;
};

type ProcessOptions = {
	cwd: string;
	sessionFile?: string;
	onEvent: (event: unknown) => void;
	onExtension: (request: RpcExtensionUIRequest) => void;
	onState: (state: ProcessState, error?: string) => void;
	dependencies?: Partial<RpcProcessDependencies>;
};

const DEFAULT_DEPENDENCIES: RpcProcessDependencies = {
	createTempDir: prefix => TempDir.create(prefix),
	spawn,
	generateToken: generateOmpGrpcToken,
	waitForBootstrap: waitForOmpGrpcBootstrapFile,
	connect: connectOmpGrpc,
	createClient: connection => new RpcClient(connection),
	killTree,
	platform: process.platform,
	ompExecutablePath,
	rpcConfigPath,
};

export class RpcProcess {
	#options: ProcessOptions;
	#dependencies: RpcProcessDependencies;
	#child: ChildProcessWithoutNullStreams | undefined;
	#client: RpcClient | undefined;
	#bootstrapTemp: TempDir | undefined;
	#startPromise: Promise<RpcClient> | undefined;
	#stopPromise: Promise<void> | undefined;
	#disposePromise: Promise<void> | undefined;
	#startupAbort: AbortController | undefined;
	#generation = 0;
	#state: ProcessState = "stopped";
	#stderr = "";

	constructor(options: ProcessOptions) {
		this.#options = options;
		this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
	}

	get state(): ProcessState {
		return this.#state;
	}
	get client(): RpcClient | undefined {
		return this.#client;
	}
	get pid(): number | undefined {
		return this.#child?.pid;
	}
	get stderrTail(): string {
		return this.#stderr;
	}

	start(sessionFile?: string): Promise<RpcClient> {
		if (this.#startPromise) return this.#startPromise;
		if (!this.#stopPromise && this.#state !== "stopped" && this.#state !== "error")
			return Promise.reject(new Error(`Cannot start from ${this.#state}`));

		const priorStop = this.#stopPromise;
		const generation = ++this.#generation;
		const controller = new AbortController();
		this.#startupAbort = controller;
		const startPromise = this.#startGeneration(
			generation,
			controller,
			sessionFile ?? this.#options.sessionFile,
			priorStop,
		);
		this.#startPromise = startPromise;
		void startPromise.then(
			() => {
				if (this.#startPromise === startPromise) this.#startPromise = undefined;
				if (this.#startupAbort === controller) this.#startupAbort = undefined;
			},
			() => {
				if (this.#startPromise === startPromise) this.#startPromise = undefined;
				if (this.#startupAbort === controller) this.#startupAbort = undefined;
			},
		);
		return startPromise;
	}

	async sample(): Promise<{ pid?: number; residentMemoryBytes?: number }> {
		const client = this.#client;
		const generation = this.#generation;
		if (!client || (this.#state !== "ready" && this.#state !== "running"))
			throw new Error("OMP runtime metrics are unavailable");
		const response = await client.request({ type: "get_state" });
		if (
			generation !== this.#generation ||
			client !== this.#client ||
			(this.#state !== "ready" && this.#state !== "running")
		)
			throw new Error("OMP runtime metrics are unavailable");
		if (!response.success || response.command !== "get_state")
			throw new Error(
				response.success
					? "OMP runtime metrics response was invalid"
					: (response.error ?? "OMP state request failed"),
			);
		const data = response.data;
		const runtime =
			typeof data === "object" && data !== null && !Array.isArray(data)
				? (data as Record<string, unknown>).runtime
				: undefined;
		if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime))
			throw new Error("OMP runtime metrics are unavailable");
		const record = runtime as Record<string, unknown>;
		if (!isFiniteNonnegative(record.pid) || !isFiniteNonnegative(record.residentMemoryBytes))
			throw new Error("OMP runtime metrics are unavailable");
		return { pid: record.pid, residentMemoryBytes: record.residentMemoryBytes };
	}

	stop(): Promise<void> {
		if (this.#stopPromise) {
			if (!this.#startPromise || !this.#startupAbort) return this.#stopPromise;
			const priorStop = this.#stopPromise;
			const pendingStart = this.#startPromise;
			const controller = this.#startupAbort;
			this.#startPromise = undefined;
			this.#startupAbort = undefined;
			++this.#generation;
			controller.abort();
			const stopPromise = this.#cacheStop(priorStop.catch(() => {}).then(() => this.#stopGeneration(pendingStart)));
			if (this.#state !== "stopping" && this.#state !== "stopped") this.#setState("stopping");
			return stopPromise;
		}
		if (
			this.#state === "stopped" &&
			!this.#startPromise &&
			!this.#child &&
			!this.#client &&
			!this.#bootstrapTemp &&
			!this.#disposePromise
		)
			return Promise.resolve();

		const pendingStart = this.#startPromise;
		this.#startPromise = undefined;
		const controller = this.#startupAbort;
		this.#startupAbort = undefined;
		++this.#generation;
		controller?.abort();
		const stopPromise = this.#cacheStop(this.#stopGeneration(pendingStart));
		if (pendingStart || this.#child || this.#client || this.#bootstrapTemp || this.#disposePromise)
			this.#setState("stopping");
		return stopPromise;
	}

	async #startGeneration(
		generation: number,
		controller: AbortController,
		sessionFile: string | undefined,
		priorStop: Promise<void> | undefined,
	): Promise<RpcClient> {
		try {
			await priorStop;
			this.#assertActive(generation, controller);
			if (this.#state === "error") await this.#disposeProcess(0);
			this.#assertActive(generation, controller);
			this.#setState("starting");
			this.#assertActive(generation, controller);
			this.#stderr = "";
			const fixture = process.env.BRANCHLIGHT_RPC_FIXTURE;
			const executable = this.#dependencies.ompExecutablePath();
			const configPath = this.#dependencies.rpcConfigPath();
			const args = fixture
				? [fixture, "--mode", "rpc", "--cwd", this.#options.cwd]
				: ["--mode", "rpc", "--cwd", this.#options.cwd, "--config", configPath];
			if (sessionFile) args.push("--resume", sessionFile);
			const command = fixture ? (process.env.BRANCHLIGHT_NODE ?? "node") : executable;
			const token = this.#dependencies.generateToken();
			const bootstrapTemp = await this.#dependencies.createTempDir("@branchlight-grpc-");
			this.#bootstrapTemp = bootstrapTemp;
			this.#assertActive(generation, controller);
			const readyFile = bootstrapTemp.join("bootstrap.json");
			const child = this.#dependencies.spawn(command, args, {
				cwd: this.#options.cwd,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
				detached: this.#dependencies.platform !== "win32",
				env: {
					...process.env,
					OMP_GRPC_HOST: "127.0.0.1",
					OMP_GRPC_PORT: "0",
					OMP_GRPC_TOKEN: token,
					OMP_GRPC_READY_FILE: readyFile,
				},
			});
			this.#child = child;
			child.stderr.on("data", chunk => {
				if (!this.#isActive(generation, controller)) return;
				this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-16 * 1024);
			});
			child.once("exit", (code, signal) => {
				if (!this.#isActive(generation, controller)) return;
				if (this.#state === "starting" || this.#state === "stopping" || this.#state === "stopped") return;
				this.#setState("error", `OMP exited (${code ?? signal ?? "unknown"})`);
				if (!this.#isActive(generation, controller)) return;
				void this.#disposeProcess(0);
			});
			const bootstrap = await Promise.race([
				this.#dependencies.waitForBootstrap(readyFile, { timeoutMs: 15_000, signal: controller.signal }),
				waitForStartupFailure(child),
			]);
			this.#assertActive(generation, controller);
			if (bootstrap.token !== token) throw new Error("OMP gRPC bootstrap token mismatch");
			const connection = await this.#dependencies.connect(bootstrap);
			const client = this.#dependencies.createClient(connection);
			this.#client = client;
			this.#assertActive(generation, controller);
			client.onEvent(event => {
				if (!this.#isActive(generation, controller)) return;
				const frame = event as Record<string, unknown>;
				if (frame.type === "agent_start") this.#setState("running");
				else if (frame.type === "agent_end" && frame.isTerminal !== false) this.#setState("ready");
				else if (frame.type === "rpc_error") {
					this.#setState("error", typeof frame.message === "string" ? frame.message : "OMP gRPC failed");
					if (!this.#isActive(generation, controller)) return;
					void this.#disposeProcess(0);
				}
				if (!this.#isActive(generation, controller)) return;
				this.#options.onEvent(event);
			});
			client.onExtension(request => {
				if (this.#isActive(generation, controller)) this.#options.onExtension(request);
			});
			await abortable(client.start(), controller.signal);
			this.#assertActive(generation, controller);
			this.#setState("ready");
			this.#assertActive(generation, controller);
			return client;
		} catch (error) {
			if (this.#isActive(generation, controller)) {
				this.#setState(
					"error",
					error instanceof Error ? `${error.message}${this.#stderr ? ` — ${this.#stderr}` : ""}` : String(error),
				);
				if (this.#isActive(generation, controller)) await this.#disposeProcess(0);
			}
			throw error;
		}
	}

	#cacheStop(stopPromise: Promise<void>): Promise<void> {
		this.#stopPromise = stopPromise;
		void stopPromise.then(
			() => {
				if (this.#stopPromise === stopPromise) this.#stopPromise = undefined;
			},
			() => {
				if (this.#stopPromise === stopPromise) this.#stopPromise = undefined;
			},
		);
		return stopPromise;
	}

	async #stopGeneration(pendingStart: Promise<RpcClient> | undefined): Promise<void> {
		await pendingStart?.catch(() => {});
		try {
			if (this.#client) {
				await withTimeout(
					this.#client.request({ type: "abort" }),
					ABORT_TIMEOUT_MS,
					"timed out aborting OMP agent",
				).catch(() => {});
			}
			await this.#disposeProcess(CHILD_GRACE_PERIOD_MS);
		} finally {
			this.#setState("stopped");
		}
	}

	async #disposeProcess(gracePeriodMs: number): Promise<void> {
		if (this.#disposePromise) {
			await this.#disposePromise;
			return;
		}
		const child = this.#child;
		const client = this.#client;
		const bootstrapTemp = this.#bootstrapTemp;
		if (!child && !client && !bootstrapTemp) return;
		this.#child = undefined;
		this.#client = undefined;
		this.#bootstrapTemp = undefined;

		const disposal = this.#disposeResources(child, client, bootstrapTemp, gracePeriodMs);
		this.#disposePromise = disposal;
		try {
			await disposal;
		} finally {
			if (this.#disposePromise === disposal) this.#disposePromise = undefined;
		}
	}

	async #disposeResources(
		child: ChildProcessWithoutNullStreams | undefined,
		client: RpcClient | undefined,
		bootstrapTemp: TempDir | undefined,
		gracePeriodMs: number,
	): Promise<void> {
		const closeClient = client
			? withTimeout(client.close(), CLIENT_CLOSE_TIMEOUT_MS, "timed out closing OMP gRPC client").catch(() => {})
			: Promise.resolve();
		try {
			if (gracePeriodMs > 0) await closeClient;
			if (child?.pid !== undefined && !(await waitForExit(child, gracePeriodMs))) {
				await this.#dependencies.killTree(child.pid);
				await waitForExit(child, CHILD_FORCE_REAP_TIMEOUT_MS);
			}
			await closeClient;
		} finally {
			await bootstrapTemp?.remove().catch(() => {});
		}
	}

	#assertActive(generation: number, controller: AbortController): void {
		if (!this.#isActive(generation, controller)) throw new StartupAbortedError();
	}

	#isActive(generation: number, controller: AbortController): boolean {
		return this.#generation === generation && !controller.signal.aborted && this.#state !== "stopping";
	}

	#setState(state: ProcessState, error?: string): void {
		this.#state = state;
		this.#options.onState(state, error);
	}
}
class StartupAbortedError extends Error {
	constructor() {
		super("OMP startup was stopped");
		this.name = "AbortError";
	}
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new StartupAbortedError());
	const gate = Promise.withResolvers<T>();
	const onAbort = (): void => {
		signal.removeEventListener("abort", onAbort);
		gate.reject(new StartupAbortedError());
	};
	signal.addEventListener("abort", onAbort, { once: true });
	void promise.then(
		value => {
			signal.removeEventListener("abort", onAbort);
			gate.resolve(value);
		},
		error => {
			signal.removeEventListener("abort", onAbort);
			gate.reject(error);
		},
	);
	return gate.promise;
}

function isFiniteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function waitForStartupFailure(child: ChildProcessWithoutNullStreams): Promise<never> {
	const failed = Promise.withResolvers<never>();
	if (child.exitCode !== null || child.signalCode !== null) {
		failed.reject(new Error(`OMP exited (${child.exitCode ?? child.signalCode ?? "unknown"})`));
		return failed.promise;
	}
	child.once("error", error => failed.reject(error));
	child.once("exit", (code, signal) => failed.reject(new Error(`OMP exited (${code ?? signal ?? "unknown"})`)));
	return failed.promise;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	if (timeoutMs <= 0) return false;
	const gate = Promise.withResolvers<boolean>();
	let settled = false;
	let timer: NodeJS.Timeout;
	const onExit = (): void => finish(true);
	const finish = (value: boolean): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		child.off("exit", onExit);
		gate.resolve(value);
	};
	timer = setTimeout(() => finish(false), timeoutMs);
	child.once("exit", onExit);
	return gate.promise;
}

async function killTree(pid: number | undefined): Promise<void> {
	if (!pid) return;
	if (process.platform === "win32") {
		const gate = Promise.withResolvers<void>();
		const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		killer.once("exit", () => gate.resolve());
		killer.once("error", () => gate.resolve());
		await gate.promise;
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already exited */
			}
		}
	}
}
