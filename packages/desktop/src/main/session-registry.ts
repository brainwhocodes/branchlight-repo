import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionKind, SessionRecordV1, SessionRegistryV1 } from "../shared/contracts";

const EMPTY_REGISTRY: SessionRegistryV1 = {
	version: 1,
	sessions: [],
	activeByKind: { work: null, code: null },
};

export class SessionRegistry {
	#filePath: string;
	#registry: SessionRegistryV1 = structuredClone(EMPTY_REGISTRY);
	#writeQueue: Promise<void> = Promise.resolve();
	#writeSequence = 0;
	#warning: string | undefined;

	constructor(userDataPath: string) {
		this.#filePath = path.join(userDataPath, "sessions-v1.json");
	}

	get warning(): string | undefined {
		return this.#warning;
	}

	get value(): SessionRegistryV1 {
		return structuredClone(this.#registry);
	}

	async load(): Promise<SessionRegistryV1> {
		try {
			const text = await fs.readFile(this.#filePath, "utf8");
			const parsed: unknown = JSON.parse(text);
			if (!isRegistry(parsed)) throw new Error("registry shape is invalid");
			this.#registry = parsed;
			return this.value;
		} catch (error) {
			if (isMissing(error)) return this.value;
			const corruptPath = path.join(path.dirname(this.#filePath), `sessions-v1.corrupt-${Date.now()}.json`);
			try {
				await fs.rename(this.#filePath, corruptPath);
				this.#warning = `Previous session registry was unreadable and was preserved as ${path.basename(corruptPath)}.`;
			} catch {
				this.#warning = `Previous session registry was unreadable (${error instanceof Error ? error.message : String(error)}).`;
			}
			this.#registry = structuredClone(EMPTY_REGISTRY);
			return this.value;
		}
	}

	async create(record: SessionRecordV1): Promise<void> {
		this.#registry.sessions = [...this.#registry.sessions, record];
		this.#registry.activeByKind[record.kind] = record.id;
		await this.#save();
	}

	async update(id: string, patch: Partial<SessionRecordV1>): Promise<void> {
		this.#registry.sessions = this.#registry.sessions.map(record =>
			record.id === id ? { ...record, ...patch } : record,
		);
		await this.#save();
	}

	async setActive(kind: SessionKind, id: string | null): Promise<void> {
		this.#registry.activeByKind[kind] = id;
		await this.#save();
	}

	async #save(): Promise<void> {
		const content = `${JSON.stringify(this.#registry, null, 2)}\n`;
		const tmpPath = path.join(
			path.dirname(this.#filePath),
			`.sessions-v1.${process.pid}.${++this.#writeSequence}.tmp`,
		);
		this.#writeQueue = this.#writeQueue
			.catch(() => {})
			.then(async () => {
				await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
				await fs.writeFile(tmpPath, content, { encoding: "utf8", flag: "w" });
				await fs.rename(tmpPath, this.#filePath);
			});
		await this.#writeQueue;
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRegistry(value: unknown): value is SessionRegistryV1 {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 1 || !Array.isArray(candidate.sessions)) return false;
	const active = candidate.activeByKind;
	if (typeof active !== "object" || active === null) return false;
	if (!isActive(active as Record<string, unknown>)) return false;
	return candidate.sessions.every(isSessionRecord);
}

function isActive(value: Record<string, unknown>): boolean {
	return (
		(value.work === null || typeof value.work === "string") && (value.code === null || typeof value.code === "string")
	);
}

function isSessionRecord(value: unknown): value is SessionRecordV1 {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		(candidate.kind === "work" || candidate.kind === "code") &&
		typeof candidate.cwd === "string" &&
		typeof candidate.ompSessionId === "string" &&
		typeof candidate.sessionFile === "string" &&
		(candidate.title === null || typeof candidate.title === "string") &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.lastOpenedAt === "string"
	);
}
