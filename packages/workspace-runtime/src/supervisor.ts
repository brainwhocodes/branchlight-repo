import {
	captureProcessIdentity,
	inspectProcessIdentity,
	type ProcessIdentity,
	type ProcessShutdownOptions,
	shutdownProcessTree,
} from "@oh-my-pi/pi-utils/local-runtime";
import type { WorkspacePendingCleanupV1 } from "@oh-my-pi/pi-wire";

export interface SupervisedProcessEntry {
	id: string;
	kind: "terminal" | "service" | "agent";
	pid: number;
	identity?: ProcessIdentity;
	startedAt: number;
}

export interface WorkspaceSupervisorOptions {
	gracefulMs?: number;
	forceMs?: number;
}

export class WorkspaceSupervisor {
	readonly #processes = new Map<string, SupervisedProcessEntry>();
	readonly #options: WorkspaceSupervisorOptions;
	#cleanupTimer?: NodeJS.Timeout;
	#isDisposed = false;

	constructor(options: WorkspaceSupervisorOptions = {}) {
		this.#options = options;
	}

	get processCount(): number {
		return this.#processes.size;
	}

	get processes(): readonly SupervisedProcessEntry[] {
		return Array.from(this.#processes.values());
	}

	async registerProcess(
		id: string,
		kind: "terminal" | "service" | "agent",
		pid: number,
	): Promise<SupervisedProcessEntry> {
		if (this.#isDisposed) {
			throw new Error("Supervisor is disposed");
		}
		const entry: SupervisedProcessEntry = {
			id,
			kind,
			pid,
			startedAt: Date.now(),
		};
		this.#processes.set(id, entry);

		try {
			const inspection = await captureProcessIdentity(pid);
			if (this.#processes.get(id) === entry && !this.#isDisposed) {
				entry.identity = inspection.identity;
			}
		} catch {}

		return entry;
	}

	unregisterProcess(id: string): boolean {
		return this.#processes.delete(id);
	}

	getProcess(id: string): SupervisedProcessEntry | undefined {
		return this.#processes.get(id);
	}

	async isProcessAlive(id: string): Promise<boolean> {
		const entry = this.#processes.get(id);
		if (!entry) return false;
		if (entry.identity) {
			const check = await inspectProcessIdentity(entry.identity);
			return check.status === "matched";
		}
		const check = await captureProcessIdentity(entry.pid);
		return check.status === "matched";
	}

	async stopProcess(id: string, options?: ProcessShutdownOptions): Promise<boolean> {
		const entry = this.#processes.get(id);
		if (!entry) return false;
		this.#processes.delete(id);
		if (entry.identity) {
			const result = await shutdownProcessTree(entry.identity, {
				gracefulMs: options?.gracefulMs ?? this.#options.gracefulMs,
				forceMs: options?.forceMs ?? this.#options.forceMs,
			});
			return result.status !== "matched" || result.graceful || result.forced;
		}
		return false;
	}

	async stopAll(): Promise<void> {
		this.#isDisposed = true;
		if (this.#cleanupTimer) {
			clearTimeout(this.#cleanupTimer);
			this.#cleanupTimer = undefined;
		}
		const tasks = Array.from(this.#processes.values()).map(async entry => {
			if (entry.identity) {
				await shutdownProcessTree(entry.identity, {
					gracefulMs: 500,
					forceMs: 1000,
				}).catch(() => {});
			}
		});
		this.#processes.clear();
		await Promise.all(tasks);
	}

	async processPendingCleanup(items: readonly WorkspacePendingCleanupV1[]): Promise<string[]> {
		const cleanedUpIds: string[] = [];
		for (const item of items) {
			const entry = this.#processes.get(item.entityId);
			if (entry?.identity) {
				const result = await shutdownProcessTree(entry.identity, {
					gracefulMs: 300,
					forceMs: 700,
				}).catch(() => ({ status: "dead" as const, graceful: false, forced: false, pid: entry.pid }));
				if (result.status !== "matched" || result.graceful || result.forced) {
					this.#processes.delete(item.entityId);
					cleanedUpIds.push(item.id);
				}
			} else {
				cleanedUpIds.push(item.id);
			}
		}
		return cleanedUpIds;
	}
}
