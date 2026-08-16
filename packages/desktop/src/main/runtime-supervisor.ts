import type { ProcessState, RuntimePhase, RuntimeReportView } from "../shared/contracts";

export interface RuntimeSample {
	pid?: number;
	residentMemoryBytes?: number;
}

export interface RuntimeDescriptor {
	id: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	sample(): Promise<RuntimeSample>;
}
export type { RuntimePhase, RuntimeReportView };
export type RuntimeReport = RuntimeReportView;
export type RuntimeTimer = number | Timer;

export interface RuntimeSupervisorOptions {
	maxResident: number;
	idleTimeoutMs: number;
	sampleIntervalMs: number;
	clock?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => RuntimeTimer;
	clearTimer?: (timer: RuntimeTimer) => void;
	onReport?: (report: RuntimeReport) => void;
}

type Operation<T> = () => T | Promise<T>;

type PendingRequest<T = unknown> = {
	entry: RuntimeEntry;
	operation: Operation<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
	queuedAt: number;
	active: boolean;
	settled: boolean;
	leaseHeld: boolean;
};

type RuntimeEntry = {
	descriptor: RuntimeDescriptor;
	state: ProcessState;
	resident: boolean;
	residencyVersion: number;
	operationLeases: number;
	lastUsedAt: number;
	order: number;
	healthy: boolean;
	pid?: number;
	residentMemoryBytes?: number;
	sampledAt?: number;
	error?: string;
	startPromise?: Promise<void>;
	stopPromise?: Promise<void>;
	idleTimer?: RuntimeTimer;
	sampleTimer?: RuntimeTimer;
	requests: Set<PendingRequest>;
	unregisterPromise?: Promise<void>;
	startGeneration: number;
};

export class RuntimeSupervisorStoppedError extends Error {
	constructor(id: string) {
		super(`Runtime ${id} was explicitly stopped`);
		this.name = "RuntimeSupervisorStoppedError";
	}
}

export class RuntimeSupervisorClosedError extends Error {
	constructor() {
		super("Runtime supervisor is closed");
		this.name = "RuntimeSupervisorClosedError";
	}
}

/**
 * Owns a bounded set of resident runtimes and admits runtime operations in FIFO
 * order. A request takes its lease when queued, rather than after startup, so a
 * freshly started runtime cannot be selected as an eviction victim before the
 * request which caused its startup begins running.
 */
export class RuntimeSupervisor {
	readonly #maxResident: number;
	readonly #idleTimeoutMs: number;
	readonly #sampleIntervalMs: number;
	readonly #clock: () => number;
	readonly #setTimer: (callback: () => void, delayMs: number) => RuntimeTimer;
	readonly #clearTimer: (timer: RuntimeTimer) => void;
	readonly #onReport?: (report: RuntimeReport) => void;
	readonly #entries = new Map<string, RuntimeEntry>();
	readonly #queue: PendingRequest[] = [];
	#nextOrder = 0;
	#drainPromise?: Promise<void>;
	#closed = false;
	#closePromise?: Promise<void>;

	constructor(options: RuntimeSupervisorOptions) {
		assertPositiveInteger(options.maxResident, "maxResident");
		assertPositiveFinite(options.idleTimeoutMs, "idleTimeoutMs");
		assertPositiveFinite(options.sampleIntervalMs, "sampleIntervalMs");

		this.#maxResident = options.maxResident;
		this.#idleTimeoutMs = options.idleTimeoutMs;
		this.#sampleIntervalMs = options.sampleIntervalMs;
		this.#clock = options.clock ?? Date.now;
		this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.#clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
		this.#onReport = options.onReport;
	}

	register(descriptor: RuntimeDescriptor): void {
		if (this.#closed) throw new RuntimeSupervisorClosedError();
		if (!descriptor || typeof descriptor !== "object") throw new TypeError("descriptor must be an object");
		if (typeof descriptor.id !== "string" || descriptor.id.trim().length === 0) {
			throw new TypeError("descriptor.id must be a non-empty string");
		}
		if (
			typeof descriptor.start !== "function" ||
			typeof descriptor.stop !== "function" ||
			typeof descriptor.sample !== "function"
		) {
			throw new TypeError("descriptor must implement start(), stop(), and sample()");
		}
		if (this.#entries.has(descriptor.id)) throw new Error(`Runtime ${descriptor.id} is already registered`);

		this.#entries.set(descriptor.id, {
			descriptor,
			state: "stopped",
			resident: false,
			residencyVersion: 0,
			operationLeases: 0,
			lastUsedAt: this.#clock(),
			order: this.#nextOrder++,
			healthy: false,
			requests: new Set(),
			startGeneration: 0,
		});
		this.#notify(this.#requiredEntry(descriptor.id));
	}

	run<T>(id: string, operation: Operation<T>): Promise<T> {
		if (this.#closed) return Promise.reject(new RuntimeSupervisorClosedError());
		const entry = this.#requiredEntry(id);
		if (entry.unregisterPromise) return Promise.reject(new RuntimeSupervisorStoppedError(id));
		if (typeof operation !== "function") return Promise.reject(new TypeError("operation must be a function"));

		const pending = Promise.withResolvers<T>();
		const request: PendingRequest<T> = {
			entry,
			operation,
			resolve: pending.resolve,
			reject: pending.reject,
			queuedAt: this.#clock(),
			active: false,
			settled: false,
			leaseHeld: true,
		};
		entry.operationLeases++;
		entry.requests.add(request as PendingRequest);
		this.#clearIdleTimer(entry);
		this.#queue.push(request as PendingRequest);
		this.#notify(entry);
		this.#scheduleDrain();
		return pending.promise;
	}

	updateState(id: string, state: ProcessState): void {
		const entry = this.#requiredEntry(id);
		if (entry.unregisterPromise) return;
		if (state === "starting") entry.startGeneration = entry.residencyVersion;
		entry.state = state;

		if (state === "stopped" || state === "error") {
			this.#clearRuntimeTimers(entry);
			if (entry.resident) {
				entry.resident = false;
				entry.residencyVersion++;
			}
			if (state === "error") entry.healthy = false;
			if (state === "stopped") entry.healthy = false;
			this.#clearSample(entry);
			this.#notify(entry);
			this.#scheduleDrain();
			return;
		}

		if (!entry.resident) return;
		if (state === "ready") {
			entry.healthy = true;
			this.#ensureSampleTimer(entry);
			this.#ensureIdleTimer(entry);
		} else {
			this.#clearIdleTimer(entry);
		}
		this.#notify(entry);
		this.#scheduleDrain();
	}

	async stop(id: string): Promise<void> {
		const entry = this.#requiredEntry(id);
		this.#cancelWaitingRequests(entry, new RuntimeSupervisorStoppedError(id));
		await this.#stopEntry(entry);
	}

	unregister(id: string): Promise<void> {
		const entry = this.#entries.get(id);
		if (!entry) return Promise.resolve();
		if (entry.unregisterPromise) return entry.unregisterPromise;
		this.#cancelWaitingRequests(entry, new RuntimeSupervisorStoppedError(id));
		entry.unregisterPromise = this.#stopEntry(entry).finally(() => {
			if (this.#entries.get(id) === entry) this.#entries.delete(id);
		});
		return entry.unregisterPromise;
	}

	touch(id: string): void {
		const entry = this.#entries.get(id);
		if (!entry?.resident) return;
		entry.lastUsedAt = this.#clock();
		this.#clearIdleTimer(entry);
		this.#ensureIdleTimer(entry);
		this.#notify(entry);
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		const error = new RuntimeSupervisorClosedError();
		for (const entry of this.#entries.values()) {
			this.#cancelWaitingRequests(entry, error);
			this.#clearRuntimeTimers(entry);
		}

		this.#closePromise = (async () => {
			await Promise.allSettled(
				[...this.#entries.values()]
					.filter(entry => entry.resident || entry.startPromise !== undefined)
					.map(entry => this.#stopEntry(entry)),
			);
		})();
		return this.#closePromise;
	}

	report(id: string): RuntimeReport {
		return this.#toReport(this.#requiredEntry(id));
	}

	/** Returns reports in stable descriptor registration order. */
	reports(): RuntimeReport[] {
		return [...this.#entries.values()]
			.sort((left, right) => left.order - right.order)
			.map(entry => this.#toReport(entry));
	}

	#requiredEntry(id: string): RuntimeEntry {
		const entry = this.#entries.get(id);
		if (!entry) throw new Error(`Unknown runtime ${id}`);
		return entry;
	}

	#toReport(entry: RuntimeEntry): RuntimeReport {
		let queuedAt: number | undefined;
		for (const request of entry.requests) {
			if (!request.active && !request.settled && (queuedAt === undefined || request.queuedAt < queuedAt)) {
				queuedAt = request.queuedAt;
			}
		}
		let phase: RuntimePhase;
		if (entry.stopPromise || entry.state === "stopping") phase = "stopping";
		else if (entry.startPromise || (entry.resident && entry.state === "starting")) phase = "starting";
		else if (!entry.resident && queuedAt !== undefined) phase = "queued";
		else if (entry.resident) phase = "resident";
		else phase = "dormant";

		return {
			id: entry.descriptor.id,
			phase,
			processState: entry.state,
			healthy: entry.healthy,
			pid: entry.pid,
			residentMemoryBytes: entry.residentMemoryBytes,
			lastUsedAt: entry.lastUsedAt,
			sampledAt: entry.sampledAt,
			queuedAt,
			error: entry.error,
		};
	}

	#notify(entry: RuntimeEntry): void {
		if (!this.#onReport || this.#entries.get(entry.descriptor.id) !== entry) return;
		try {
			this.#onReport(this.#toReport(entry));
		} catch {
			// Observers must not be able to break runtime supervision.
		}
	}

	#scheduleDrain(): void {
		if (this.#drainPromise) return;
		this.#drainPromise = this.#drain().finally(() => {
			this.#drainPromise = undefined;
			if (this.#queue.some(request => !request.settled) && this.#canAdvanceQueue()) this.#scheduleDrain();
		});
	}

	async #drain(): Promise<void> {
		while (!this.#closed) {
			while (this.#queue[0]?.settled) this.#queue.shift();
			const request = this.#queue[0];
			if (!request) return;
			const entry = request.entry;

			if (entry.resident && !entry.stopPromise) {
				this.#queue.shift();
				this.#admit(request, entry.startPromise ?? Promise.resolve());
				continue;
			}

			if (this.#residentCount() >= this.#maxResident) {
				const victim = this.#leastRecentlyUsedEvictable();
				if (!victim) return;
				await this.#stopEntry(victim).catch(() => undefined);
				continue;
			}

			if (entry.stopPromise) {
				await entry.stopPromise.catch(() => undefined);
				continue;
			}

			const startup = this.#startEntry(entry);
			this.#queue.shift();
			this.#admit(request, startup);
		}
	}

	#canAdvanceQueue(): boolean {
		const request = this.#queue.find(candidate => !candidate.settled);
		if (!request || this.#closed) return false;
		if (request.entry.resident && !request.entry.stopPromise) return true;
		if (this.#residentCount() < this.#maxResident) return true;
		return this.#leastRecentlyUsedEvictable() !== undefined;
	}

	#admit(request: PendingRequest, readiness: Promise<void>): void {
		void (async () => {
			try {
				await readiness;
				if (request.settled) return;
				if (this.#closed) throw new RuntimeSupervisorClosedError();
				request.active = true;
				this.#notify(request.entry);
				const value = await request.operation();
				this.#resolveRequest(request, value);
			} catch (error) {
				this.#rejectRequest(request, error);
			} finally {
				this.#releaseLease(request);
			}
		})();
	}

	#resolveRequest(request: PendingRequest, value: unknown): void {
		if (request.settled) return;
		request.settled = true;
		request.resolve(value);
	}

	#rejectRequest(request: PendingRequest, error: unknown): void {
		if (request.settled) return;
		request.settled = true;
		request.reject(error);
	}

	#releaseLease(request: PendingRequest): void {
		if (!request.leaseHeld) return;
		request.leaseHeld = false;
		const entry = request.entry;
		entry.requests.delete(request);
		entry.operationLeases--;
		entry.lastUsedAt = this.#clock();
		this.#ensureIdleTimer(entry);
		this.#notify(entry);
		this.#scheduleDrain();
	}

	#cancelWaitingRequests(entry: RuntimeEntry, error: Error): void {
		for (const request of [...entry.requests]) {
			if (request.active || request.settled) continue;
			this.#rejectRequest(request, error);
			this.#releaseLease(request);
		}
		this.#scheduleDrain();
	}

	#startEntry(entry: RuntimeEntry): Promise<void> {
		if (entry.startPromise) return entry.startPromise;
		entry.resident = true;
		const residencyVersion = ++entry.residencyVersion;
		entry.startGeneration = residencyVersion;
		entry.state = "starting";
		entry.healthy = false;
		this.#clearSample(entry);
		entry.error = undefined;
		this.#clearRuntimeTimers(entry);
		this.#notify(entry);

		let startup!: Promise<void>;
		startup = (async () => {
			try {
				await Promise.resolve().then(() => entry.descriptor.start());
				if (!entry.resident || entry.residencyVersion !== residencyVersion) {
					throw new Error(`Runtime ${entry.descriptor.id} exited during startup`);
				}
				if (entry.state === "starting" && entry.startGeneration === residencyVersion) entry.state = "ready";
				entry.healthy = true;
				entry.lastUsedAt = this.#clock();
				this.#ensureSampleTimer(entry);
				this.#notify(entry);
			} catch (error) {
				if (entry.residencyVersion === residencyVersion) {
					entry.resident = false;
					entry.residencyVersion++;
					entry.state = "error";
					entry.healthy = false;
					entry.error = errorMessage(error);
					this.#clearRuntimeTimers(entry);
					this.#notify(entry);
				}
				this.#cancelWaitingRequests(entry, asError(error));
				throw error;
			} finally {
				if (entry.startPromise === startup) entry.startPromise = undefined;
				this.#scheduleDrain();
			}
		})();
		entry.startPromise = startup;
		return startup;
	}

	#stopEntry(entry: RuntimeEntry): Promise<void> {
		if (entry.stopPromise) return entry.stopPromise;
		this.#clearRuntimeTimers(entry);
		const shouldStop = entry.resident || entry.startPromise !== undefined;
		if (!shouldStop) {
			entry.state = "stopped";
			entry.healthy = false;
			this.#clearSample(entry);
			this.#notify(entry);
			return Promise.resolve();
		}
		entry.state = "stopping";
		this.#notify(entry);

		let stopping!: Promise<void>;
		stopping = (async () => {
			try {
				const startup = entry.startPromise;
				if (startup) {
					const [stopResult] = await Promise.allSettled([
						Promise.resolve().then(() => entry.descriptor.stop()),
						startup,
					]);
					if (stopResult?.status === "rejected") throw stopResult.reason;
				} else if (entry.resident) {
					await Promise.resolve().then(() => entry.descriptor.stop());
				}
				entry.state = "stopped";
				entry.healthy = false;
				entry.error = undefined;
			} catch (error) {
				entry.state = "error";
				entry.healthy = false;
				entry.error = errorMessage(error);
				throw error;
			} finally {
				entry.resident = false;
				entry.residencyVersion++;
				this.#clearSample(entry);
				if (entry.stopPromise === stopping) entry.stopPromise = undefined;
				this.#notify(entry);
				this.#scheduleDrain();
			}
		})();
		entry.stopPromise = stopping;
		return stopping;
	}

	#residentCount(): number {
		let count = 0;
		for (const entry of this.#entries.values()) {
			if (entry.resident) count++;
		}
		return count;
	}

	#leastRecentlyUsedEvictable(): RuntimeEntry | undefined {
		let victim: RuntimeEntry | undefined;
		for (const entry of this.#entries.values()) {
			if (
				!entry.resident ||
				entry.operationLeases !== 0 ||
				entry.stopPromise ||
				(entry.state !== "ready" && entry.state !== "stopped" && entry.state !== "error")
			) {
				continue;
			}
			if (
				!victim ||
				entry.lastUsedAt < victim.lastUsedAt ||
				(entry.lastUsedAt === victim.lastUsedAt && entry.order < victim.order)
			) {
				victim = entry;
			}
		}
		return victim;
	}

	#ensureIdleTimer(entry: RuntimeEntry): void {
		if (
			this.#closed ||
			entry.idleTimer ||
			!entry.resident ||
			entry.operationLeases !== 0 ||
			entry.state !== "ready"
		) {
			return;
		}
		const lastUsedAt = entry.lastUsedAt;
		entry.idleTimer = this.#createTimer(() => {
			entry.idleTimer = undefined;
			if (
				this.#closed ||
				!entry.resident ||
				entry.operationLeases !== 0 ||
				entry.state !== "ready" ||
				entry.lastUsedAt !== lastUsedAt
			) {
				this.#ensureIdleTimer(entry);
				return;
			}
			void this.#stopEntry(entry).catch(() => undefined);
		}, this.#idleTimeoutMs);
	}

	#ensureSampleTimer(entry: RuntimeEntry): void {
		if (this.#closed || entry.sampleTimer || !entry.resident) return;
		entry.sampleTimer = this.#createTimer(() => {
			entry.sampleTimer = undefined;
			void this.#sample(entry);
		}, this.#sampleIntervalMs);
	}

	async #sample(entry: RuntimeEntry): Promise<void> {
		if (this.#closed || !entry.resident) return;
		const residencyVersion = entry.residencyVersion;
		try {
			const sample = await entry.descriptor.sample();
			if (!entry.resident || entry.residencyVersion !== residencyVersion) return;
			entry.pid = sample.pid;
			entry.residentMemoryBytes = sample.residentMemoryBytes;
			entry.sampledAt = this.#clock();
			entry.healthy = true;
			entry.error = undefined;
		} catch (error) {
			if (!entry.resident || entry.residencyVersion !== residencyVersion) return;
			entry.sampledAt = this.#clock();
			entry.healthy = false;
			entry.error = errorMessage(error);
		} finally {
			if (entry.resident && entry.residencyVersion === residencyVersion) {
				this.#notify(entry);
				this.#ensureSampleTimer(entry);
			}
		}
	}

	#createTimer(callback: () => void, delayMs: number): RuntimeTimer {
		const timer = this.#setTimer(callback, delayMs);
		if (typeof timer !== "number") timer.unref?.();
		return timer;
	}

	#clearIdleTimer(entry: RuntimeEntry): void {
		if (!entry.idleTimer) return;
		this.#clearTimer(entry.idleTimer);
		entry.idleTimer = undefined;
	}

	#clearSample(entry: RuntimeEntry): void {
		entry.pid = undefined;
		entry.residentMemoryBytes = undefined;
		entry.sampledAt = undefined;
	}

	#clearRuntimeTimers(entry: RuntimeEntry): void {
		this.#clearIdleTimer(entry);
		if (!entry.sampleTimer) return;
		this.#clearTimer(entry.sampleTimer);
		entry.sampleTimer = undefined;
	}
}

function assertPositiveFinite(value: number, name: string): void {
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
}

function assertPositiveInteger(value: number, name: string): void {
	assertPositiveFinite(value, name);
	if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer`);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
