import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { ProcessState } from "../shared/contracts";
import type { RpcExtensionUIRequest } from "../shared/rpc-wire";
import { ompExecutablePath, rpcConfigPath } from "./backend-path";
import { RpcClient } from "./rpc-client";

type ProcessOptions = {
	cwd: string;
	sessionFile?: string;
	onEvent: (event: unknown) => void;
	onExtension: (request: RpcExtensionUIRequest) => void;
	onState: (state: ProcessState, error?: string) => void;
};

export class RpcProcess {
	#options: ProcessOptions;
	#child: ChildProcessWithoutNullStreams | undefined;
	#client: RpcClient | undefined;
	#state: ProcessState = "stopped";
	#stderr = "";

	constructor(options: ProcessOptions) {
		this.#options = options;
	}

	get state(): ProcessState {
		return this.#state;
	}
	get client(): RpcClient | undefined {
		return this.#client;
	}
	get stderrTail(): string {
		return this.#stderr;
	}

	async start(): Promise<RpcClient> {
		if (this.#state !== "stopped" && this.#state !== "error") throw new Error(`Cannot start from ${this.#state}`);
		this.#setState("starting");
		const fixture = process.env.BRANCHLIGHT_RPC_FIXTURE;
		const executable = ompExecutablePath();
		const configPath = rpcConfigPath();
		const args = fixture
			? [fixture, "--mode", "rpc", "--cwd", this.#options.cwd]
			: ["--mode", "rpc", "--cwd", this.#options.cwd, "--config", configPath];
		if (this.#options.sessionFile) args.push("--resume", this.#options.sessionFile);
		const command = fixture ? (process.env.BRANCHLIGHT_NODE ?? "node") : executable;
		try {
			this.#child = spawn(command, args, {
				cwd: this.#options.cwd,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.#child.stderr.on("data", chunk => {
				this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-16 * 1024);
			});
			this.#child.once("exit", (code, signal) => {
				if (this.#state !== "stopping" && this.#state !== "stopped")
					this.#setState("error", `OMP exited (${code ?? signal ?? "unknown"})`);
			});
			const client = new RpcClient(this.#child);
			this.#client = client;
			client.onEvent(event => {
				const frame = event as Record<string, unknown>;
				if (frame.type === "agent_start") this.#setState("running");
				else if (frame.type === "agent_end" && frame.isTerminal !== false) this.#setState("ready");
				this.#options.onEvent(event);
			});
			client.onExtension(request => this.#options.onExtension(request));
			await client.start();
			this.#setState("ready");
			return client;
		} catch (error) {
			this.#setState(
				"error",
				error instanceof Error ? `${error.message}${this.#stderr ? ` — ${this.#stderr}` : ""}` : String(error),
			);
			await this.#disposeProcess();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.#child) {
			this.#setState("stopped");
			return;
		}
		const wasRunning = this.#state === "running";
		this.#setState("stopping");
		const child = this.#child;
		try {
			if (wasRunning) await this.#client?.request({ type: "abort" });
		} catch {
			/* abort is best effort during shutdown */
		}
		await this.#client?.close();
		const exited = await waitForExit(child, 10_000);
		if (!exited) await killTree(child.pid);
		await this.#disposeProcess();
		this.#setState("stopped");
	}

	async #disposeProcess(): Promise<void> {
		const child = this.#child;
		this.#child = undefined;
		this.#client = undefined;
		if (child && child.exitCode === null && !child.killed) child.kill();
	}

	#setState(state: ProcessState, error?: string): void {
		this.#state = state;
		this.#options.onState(state, error);
	}
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	const gate = Promise.withResolvers<boolean>();
	let settled = false;
	const finish = (value: boolean) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		gate.resolve(value);
	};
	const timer = setTimeout(() => finish(false), timeoutMs);
	child.once("exit", () => finish(true));
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
