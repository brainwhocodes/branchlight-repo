import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type RuntimeDescriptor,
	type RuntimeReport,
	type RuntimeSample,
	RuntimeSupervisor,
	RuntimeSupervisorClosedError,
	RuntimeSupervisorStoppedError,
} from "../src/main/runtime-supervisor";

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
};

type RuntimeHarness = { descriptor: RuntimeDescriptor; starts: number; stops: number };

function deferred<T>(): Deferred<T> {
	return Promise.withResolvers<T>();
}

function runtime(
	id: string,
	options: { start?: () => Promise<void>; stop?: () => Promise<void>; sample?: () => Promise<RuntimeSample> } = {},
): RuntimeHarness {
	const harness: RuntimeHarness = {
		starts: 0,
		stops: 0,
		descriptor: {
			id,
			async start() {
				harness.starts++;
				await options.start?.();
			},
			async stop() {
				harness.stops++;
				await options.stop?.();
			},
			async sample() {
				return (await options.sample?.()) ?? {};
			},
		},
	};
	return harness;
}

function supervisor(overrides: Partial<ConstructorParameters<typeof RuntimeSupervisor>[0]> = {}): RuntimeSupervisor {
	return new RuntimeSupervisor({ maxResident: 1, idleTimeoutMs: 60_000, sampleIntervalMs: 60_000, ...overrides });
}

async function settle(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("RuntimeSupervisor", () => {
	it("validates positive finite constructor bounds", () => {
		for (const maxResident of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => supervisor({ maxResident })).toThrow(RangeError);
		}
		for (const idleTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => supervisor({ idleTimeoutMs })).toThrow(RangeError);
		}
		for (const sampleIntervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => supervisor({ sampleIntervalMs })).toThrow(RangeError);
		}
	});

	it("never exceeds the resident cap and admits queued runtimes FIFO", async () => {
		let residents = 0;
		let maximumResidents = 0;
		const makeRuntime = (id: string) =>
			runtime(id, {
				start: async () => {
					residents++;
					maximumResidents = Math.max(maximumResidents, residents);
				},
				stop: async () => {
					residents--;
				},
			});
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		const c = makeRuntime("c");
		const manager = supervisor();
		manager.register(a.descriptor);
		manager.register(b.descriptor);
		manager.register(c.descriptor);
		const releaseA = deferred<void>();
		const order: string[] = [];

		const first = manager.run("a", async () => {
			order.push("a");
			await releaseA.promise;
		});
		const second = manager.run("b", () => order.push("b"));
		const third = manager.run("c", () => order.push("c"));
		await settle();
		expect(order).toEqual(["a"]);
		expect(manager.report("b").phase).toBe("queued");
		expect(manager.report("c").phase).toBe("queued");

		releaseA.resolve();
		await Promise.all([first, second, third]);
		expect(order).toEqual(["a", "b", "c"]);
		expect(maximumResidents).toBe(1);
		await manager.close();
	});

	it("coalesces concurrent starts for the same runtime", async () => {
		const startGate = deferred<void>();
		const item = runtime("shared", { start: () => startGate.promise });
		const manager = supervisor();
		manager.register(item.descriptor);
		const calls: string[] = [];
		const first = manager.run("shared", () => calls.push("first"));
		const second = manager.run("shared", () => calls.push("second"));
		await settle();
		expect(item.starts).toBe(1);
		expect(calls).toEqual([]);
		startGate.resolve();
		await Promise.all([first, second]);
		expect(item.starts).toBe(1);
		expect(calls).toEqual(["first", "second"]);
		await manager.close();
	});

	it("evicts the least-recently-used idle runtime under pressure", async () => {
		let now = 0;
		const a = runtime("a");
		const b = runtime("b");
		const c = runtime("c");
		const manager = supervisor({ maxResident: 2, clock: () => now });
		for (const item of [a, b, c]) manager.register(item.descriptor);
		await manager.run("a", () => undefined);
		now = 10;
		await manager.run("b", () => undefined);
		now = 20;
		await manager.run("a", () => undefined);
		now = 30;
		await manager.run("c", () => undefined);
		expect(a.stops).toBe(0);
		expect(b.stops).toBe(1);
		expect(manager.report("b").phase).toBe("dormant");
		expect(manager.reports().map(report => report.id)).toEqual(["a", "b", "c"]);
		await manager.close();
	});

	it("does not evict a runtime while leased or while its process is running", async () => {
		const a = runtime("a");
		const b = runtime("b");
		const manager = supervisor();
		manager.register(a.descriptor);
		manager.register(b.descriptor);
		const releaseA = deferred<void>();
		const first = manager.run("a", async () => {
			await releaseA.promise;
			manager.updateState("a", "running");
		});
		const second = manager.run("b", () => undefined);
		await settle();
		expect(a.stops).toBe(0);
		expect(b.starts).toBe(0);
		releaseA.resolve();
		await first;
		await settle();
		expect(a.stops).toBe(0);
		expect(b.starts).toBe(0);
		manager.updateState("a", "ready");
		await second;
		expect(a.stops).toBe(1);
		await manager.close();
	});

	it("evicts after idle timeout and touch resets the deadline", async () => {
		vi.useFakeTimers();
		const item = runtime("idle");
		const manager = supervisor({ idleTimeoutMs: 1_000, sampleIntervalMs: 10_000 });
		manager.register(item.descriptor);
		await manager.run("idle", () => undefined);
		await vi.advanceTimersByTimeAsync(900);
		manager.touch("idle");
		await vi.advanceTimersByTimeAsync(999);
		expect(item.stops).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(item.stops).toBe(1);
		expect(manager.report("idle").phase).toBe("dormant");
		manager.touch("missing");
		await manager.close();
	});

	it("rejects coalesced waiters on startup failure and releases capacity", async () => {
		const startGate = deferred<void>();
		const broken = runtime("broken", { start: () => startGate.promise });
		const healthy = runtime("healthy");
		const manager = supervisor();
		manager.register(broken.descriptor);
		manager.register(healthy.descriptor);
		const first = manager.run("broken", () => "first");
		const second = manager.run("broken", () => "second");
		const recovered = manager.run("healthy", () => "recovered");
		await settle();
		startGate.reject(new Error("startup failed"));
		await expect(first).rejects.toThrow("startup failed");
		await expect(second).rejects.toThrow("startup failed");
		await expect(recovered).resolves.toBe("recovered");
		expect(healthy.starts).toBe(1);
		expect(manager.report("broken")).toMatchObject({ phase: "dormant", healthy: false, error: "startup failed" });
		await manager.close();
	});

	it("samples reports, emits updates, and survives listener and sampling failures", async () => {
		vi.useFakeTimers();
		let samples = 0;
		const updates: RuntimeReport[] = [];
		const item = runtime("sampled", {
			sample: async () => {
				samples++;
				if (samples === 2) throw new Error("sample unavailable");
				return { pid: 4321, residentMemoryBytes: 8_388_608 };
			},
		});
		const manager = supervisor({
			idleTimeoutMs: 60_000,
			sampleIntervalMs: 100,
			onReport: report => {
				updates.push(report);
				if (report.phase === "starting") throw new Error("observer failed");
			},
		});
		manager.register(item.descriptor);
		await manager.run("sampled", () => undefined);
		await vi.advanceTimersByTimeAsync(100);
		expect(manager.report("sampled")).toMatchObject({ healthy: true, pid: 4321, residentMemoryBytes: 8_388_608 });
		expect(updates.some(report => report.pid === 4321)).toBe(true);
		await vi.advanceTimersByTimeAsync(100);
		expect(manager.report("sampled")).toMatchObject({
			phase: "resident",
			healthy: false,
			error: "sample unavailable",
		});
		expect(item.stops).toBe(0);
		await manager.close();
	});

	it("ignores a sample that resolves after the runtime was restarted", async () => {
		vi.useFakeTimers();
		const staleSample = deferred<RuntimeSample>();
		const a = runtime("a", { sample: () => staleSample.promise });
		const b = runtime("b");
		const manager = supervisor({ sampleIntervalMs: 100 });
		manager.register(a.descriptor);
		manager.register(b.descriptor);
		await manager.run("a", () => undefined);
		await vi.advanceTimersByTimeAsync(100);
		await manager.run("b", () => undefined);
		await manager.run("a", () => undefined);
		staleSample.resolve({ pid: 9999, residentMemoryBytes: 1 });
		await settle();
		expect(manager.report("a")).toMatchObject({
			phase: "resident",
			pid: undefined,
			residentMemoryBytes: undefined,
		});
		await manager.close();
	});

	it("explicit stop rejects queued calls but keeps the descriptor registered", async () => {
		const active = runtime("active");
		const queued = runtime("queued");
		const manager = supervisor();
		manager.register(active.descriptor);
		manager.register(queued.descriptor);
		const release = deferred<void>();
		const running = manager.run("active", () => release.promise);
		const waiting = manager.run("queued", () => "must not run");
		await settle();
		await manager.stop("queued");
		await expect(waiting).rejects.toBeInstanceOf(RuntimeSupervisorStoppedError);
		expect(manager.report("queued").phase).toBe("dormant");
		release.resolve();
		await running;
		await manager.run("queued", () => undefined);
		expect(queued.starts).toBe(1);
		await manager.close();
	});

	it("unregister cancels work, awaits stop, then removes the report", async () => {
		const stopGate = deferred<void>();
		const item = runtime("removed", { stop: () => stopGate.promise });
		const manager = supervisor();
		manager.register(item.descriptor);
		await manager.run("removed", () => undefined);
		const removing = manager.unregister("removed");
		expect(manager.report("removed").phase).toBe("stopping");
		stopGate.resolve();
		await removing;
		expect(() => manager.report("removed")).toThrow("Unknown runtime removed");
		await expect(manager.unregister("removed")).resolves.toBeUndefined();
		await manager.close();
	});

	it("interrupts startup instead of waiting for the runtime to become ready", async () => {
		const startGate = deferred<void>();
		const stopCalled = deferred<void>();
		const item = runtime("starting", {
			start: () => startGate.promise,
			stop: async () => {
				stopCalled.resolve();
				startGate.resolve();
			},
		});
		const manager = supervisor();
		manager.register(item.descriptor);
		const waiting = manager.run("starting", () => "must not run");
		const rejected = expect(waiting).rejects.toBeInstanceOf(RuntimeSupervisorStoppedError);
		await settle();
		const stopping = manager.stop("starting");
		await stopCalled.promise;
		await stopping;
		await rejected;
		expect(item.stops).toBe(1);
		expect(manager.report("starting").phase).toBe("dormant");
		await manager.close();
	});

	it("close is idempotent, rejects queued calls, and stops resident and starting runtimes", async () => {
		const active = runtime("active");
		const startGate = deferred<void>();
		const starting = runtime("starting", { start: () => startGate.promise });
		const manager = supervisor({ maxResident: 2 });
		manager.register(active.descriptor);
		manager.register(starting.descriptor);
		await manager.run("active", () => undefined);
		const startingCall = manager.run("starting", () => "must not run");
		await settle();
		const firstClose = manager.close();
		expect(manager.close()).toBe(firstClose);
		await expect(startingCall).rejects.toBeInstanceOf(RuntimeSupervisorClosedError);
		startGate.resolve();
		await firstClose;
		expect(active.stops).toBe(1);
		expect(starting.stops).toBe(1);
		await manager.close();
		expect(active.stops).toBe(1);
		expect(starting.stops).toBe(1);
		await expect(manager.run("active", () => undefined)).rejects.toBeInstanceOf(RuntimeSupervisorClosedError);
	});
});
