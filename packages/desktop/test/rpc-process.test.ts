import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { OMP_GRPC_MAX_MESSAGE_BYTES, type OmpGrpcBootstrap, type OmpGrpcClientConnection } from "@oh-my-pi/pi-grpc";
import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../src/main/rpc-client";
import { RpcProcess, type RpcProcessDependencies } from "../src/main/rpc-process";

const BOOTSTRAP: OmpGrpcBootstrap = {
	protocol: "grpc",
	protocolVersion: 1,
	host: "127.0.0.1",
	port: 43123,
	token: "test-token",
	maxMessageBytes: OMP_GRPC_MAX_MESSAGE_BYTES,
};

class FakeChild extends EventEmitter {
	readonly pid: number;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly stderr = new PassThrough();

	constructor(pid: number) {
		super();
		this.pid = pid;
	}

	exit(): void {
		if (this.exitCode !== null) return;
		this.exitCode = 0;
		this.emit("exit", 0, null);
	}
}

class FakeClient {
	readonly startGate: PromiseWithResolvers<void> | undefined;
	readonly child: FakeChild;
	abortNever = false;
	closeCount = 0;
	metrics: unknown = { pid: 100, residentMemoryBytes: 4096 };
	#events: Array<(event: unknown) => void> = [];

	constructor(child: FakeChild, holdStart: boolean) {
		this.child = child;
		this.startGate = holdStart ? Promise.withResolvers<void>() : undefined;
	}

	onEvent(listener: (event: unknown) => void): () => void {
		this.#events.push(listener);
		return () => {
			this.#events = this.#events.filter(candidate => candidate !== listener);
		};
	}

	onExtension(): () => void {
		return () => {};
	}

	start(): Promise<void> {
		return this.startGate?.promise ?? Promise.resolve();
	}

	request(command: { type: string }): Promise<unknown> {
		if (command.type === "abort" && this.abortNever) return Promise.withResolvers<unknown>().promise;
		if (command.type === "get_state") {
			return Promise.resolve({
				type: "response",
				command: "get_state",
				success: true,
				data: { runtime: this.metrics },
			});
		}
		return Promise.resolve({ type: "response", command: command.type, success: true });
	}

	async close(): Promise<void> {
		this.closeCount++;
		this.child.exit();
	}

	emit(event: unknown): void {
		for (const listener of this.#events) listener(event);
	}
}

type Harness = {
	dependencies: Partial<RpcProcessDependencies>;
	children: FakeChild[];
	clients: FakeClient[];
	spawnArgs: string[][];
	removedTempDirs: { count: number };
	holdNextClientStart: () => void;
};

function createHarness(): Harness {
	const children: FakeChild[] = [];
	const clients: FakeClient[] = [];
	const removedTempDirs = { count: 0 };
	const spawnArgs: string[][] = [];
	let holdClientStart = false;
	const dependencies: Partial<RpcProcessDependencies> = {
		createTempDir: async () =>
			({
				join: (name: string) => `/tmp/rpc-process-test/${name}`,
				remove: async () => {
					removedTempDirs.count++;
				},
			}) as never,
		spawn: ((_: string, args: readonly string[]) => {
			spawnArgs.push([...args]);
			const child = new FakeChild(100 + children.length);
			children.push(child);
			return child as unknown as ChildProcessWithoutNullStreams;
		}) as typeof spawn,
		generateToken: () => BOOTSTRAP.token,
		waitForBootstrap: async () => BOOTSTRAP,
		connect: async () => ({}) as OmpGrpcClientConnection,
		createClient: () => {
			const client = new FakeClient(children.at(-1)!, holdClientStart);
			holdClientStart = false;
			clients.push(client);
			return client as unknown as RpcClient;
		},
		killTree: async pid => {
			children.find(child => child.pid === pid)?.exit();
		},
		platform: "linux",
		ompExecutablePath: () => "/opt/branchlight/omp",
		rpcConfigPath: () => "/opt/branchlight/rpc-config.yml",
	};
	return {
		dependencies,
		children,
		clients,
		removedTempDirs,
		spawnArgs,
		holdNextClientStart: () => {
			holdClientStart = true;
		},
	};
}

function createProcess(harness: Harness, states: string[] = [], sessionFile?: string): RpcProcess {
	return new RpcProcess({
		cwd: "/workspace",
		sessionFile,
		onEvent: () => {},
		onExtension: () => {},
		onState: state => states.push(state),
		dependencies: harness.dependencies,
	});
}

async function waitForClient(harness: Harness): Promise<FakeClient> {
	await vi.waitFor(() => expect(harness.clients).toHaveLength(1));
	return harness.clients[0]!;
}

describe("RpcProcess lifecycle", () => {
	it("coalesces concurrent starts onto one child process", async () => {
		const harness = createHarness();
		const process = createProcess(harness);

		const first = process.start();
		const second = process.start();

		expect(second).toBe(first);
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(harness.children).toHaveLength(1);
		await process.stop();
	});

	it("cannot be resurrected when stopped while the client is waiting for Ready", async () => {
		const harness = createHarness();
		harness.holdNextClientStart();
		const states: string[] = [];
		const process = createProcess(harness, states);
		const starting = process.start();
		const rejectedStart = expect(starting).rejects.toThrow("startup was stopped");
		const client = await waitForClient(harness);

		const stopping = process.stop();
		client.startGate?.resolve();
		client.emit({ type: "agent_start" });
		await rejectedStart;
		await stopping;

		expect(process.state).toBe("stopped");
		expect(process.client).toBeUndefined();
		expect(states.at(-1)).toBe("stopped");
		expect(client.closeCount).toBe(1);
		expect(harness.children[0]!.exitCode).toBe(0);
		expect(harness.removedTempDirs.count).toBe(1);
		expect(states.slice(states.indexOf("stopping") + 1)).not.toContain("ready");
		expect(states.slice(states.indexOf("stopping") + 1)).not.toContain("running");
	});

	it("waits for shutdown and uses the newest session file on restart", async () => {
		const harness = createHarness();
		const process = createProcess(harness, [], "constructor-session.jsonl");
		await process.start();
		const stopping = process.stop();
		const restarted = process.start("latest-session.jsonl");
		await stopping;
		await restarted;

		expect(harness.spawnArgs).toHaveLength(2);
		expect(harness.spawnArgs[0]).toContain("constructor-session.jsonl");
		expect(harness.spawnArgs[1]).toContain("latest-session.jsonl");
		expect(harness.spawnArgs[1]).not.toContain("constructor-session.jsonl");
		await process.stop();
	});

	it("bounds an unresponsive abort request and repeated stop calls are safe", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			const states: string[] = [];
			const process = createProcess(harness, states);
			await process.start();
			const client = harness.clients[0]!;
			client.abortNever = true;
			client.emit({ type: "agent_start" });
			expect(process.state).toBe("running");

			const firstStop = process.stop();
			const secondStop = process.stop();
			expect(secondStop).toBe(firstStop);
			await vi.advanceTimersByTimeAsync(2_000);
			await expect(firstStop).resolves.toBeUndefined();
			await expect(process.stop()).resolves.toBeUndefined();
			expect(client.closeCount).toBe(1);
			expect(states.filter(state => state === "stopping")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("samples validated runtime metrics from the live client", async () => {
		const harness = createHarness();
		const process = createProcess(harness);
		await process.start();
		expect(process.pid).toBe(100);

		await expect(process.sample()).resolves.toEqual({ pid: 100, residentMemoryBytes: 4096 });
		harness.clients[0]!.metrics = { pid: Number.NaN, residentMemoryBytes: -1 };
		await expect(process.sample()).rejects.toThrow("metrics are unavailable");
		await process.stop();
		expect(process.pid).toBeUndefined();
	});
});
