import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { ensureSecureRuntimeRoot, secureRuntimePath } from "@oh-my-pi/pi-utils/local-runtime";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	parseWorkspaceDocumentV1,
	parseWorkspaceEventV1,
	type WorkspaceCommandV1,
	type WorkspaceDocumentV1,
	type WorkspaceEventV1,
} from "@oh-my-pi/pi-wire";
import { createInitialWorkspaceDocumentV1 } from "./schema";
import type { WorkspaceCommandResultV1, WorkspaceReducerStateV1 } from "./types";

export const DEFAULT_STORE_BASENAME = "workspace-state.jsonl";
export const SNAPSHOT_COMPACT_THRESHOLD = 50;

interface StoredSnapshotRecord {
	type: "snapshot";
	document: WorkspaceDocumentV1;
	seenCommandIds: string[];
	nextEventSequence: number;
}

interface StoredCommitRecord {
	type: "commit";
	commandId: string;
	document: WorkspaceDocumentV1;
	events: WorkspaceEventV1[];
	nextEventSequence: number;
}

function migrateStoredDocument(
	raw: unknown,
	recordLabel: string,
): { document: WorkspaceDocumentV1; migrated: boolean } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { document: parseWorkspaceDocumentV1(raw), migrated: false };
	}
	const value = structuredClone(raw) as Record<string, unknown>;
	const rawTabs = value.tabs;
	const rawWorkspaces = value.workspaces;
	if (!Array.isArray(rawTabs) || !Array.isArray(rawWorkspaces)) {
		return { document: parseWorkspaceDocumentV1(value), migrated: false };
	}

	let migrated = false;
	const activeWorkspaceId = typeof value.activeWorkspaceId === "string" ? value.activeWorkspaceId : undefined;
	for (const rawTab of rawTabs) {
		if (typeof rawTab !== "object" || rawTab === null || Array.isArray(rawTab)) continue;
		const tab = rawTab as Record<string, unknown>;
		if ("workspaceId" in tab) continue;
		const locationId = tab.locationId;
		const generation = tab.generation;
		const matches = rawWorkspaces.filter(rawWorkspace => {
			if (typeof rawWorkspace !== "object" || rawWorkspace === null || Array.isArray(rawWorkspace)) return false;
			const workspace = rawWorkspace as Record<string, unknown>;
			return workspace.locationId === locationId && workspace.generation === generation;
		}) as Array<Record<string, unknown>>;
		if (matches.length === 0) {
			throw new Error(
				`Workspace store migration failed in ${recordLabel}: tab '${String(tab.id)}' has no workspace matching location '${String(locationId)}' generation '${String(generation)}'`,
			);
		}
		const selected = matches.find(workspace => workspace.id === activeWorkspaceId) ?? matches[0];
		if (matches.length > 1) {
			logger.warn("Workspace store migration resolved an ambiguous tab workspace", {
				record: recordLabel,
				tabId: typeof tab.id === "string" ? tab.id : "unknown",
				workspaceId: selected.id,
				candidateCount: matches.length,
			});
		}
		tab.workspaceId = selected.id;
		migrated = true;
	}
	return { document: parseWorkspaceDocumentV1(value), migrated };
}
function stripUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => stripUndefined(item));
	if (typeof value !== "object" || value === null) return value;
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (child !== undefined) result[key] = stripUndefined(child);
	}
	return result;
}
type StoredRecord = StoredSnapshotRecord | StoredCommitRecord;

export interface WorkspaceStoreOptions {
	runtimeRoot: string;
	basename?: string;
	compactThreshold?: number;
}

export class WorkspaceStore {
	readonly #runtimeRoot: string;
	readonly #basename: string;
	readonly #filePath: string;
	readonly #compactThreshold: number;
	#isOpen = false;
	#writeLock: Promise<void> = Promise.resolve();
	#uncompactedCommits = 0;

	constructor(options: WorkspaceStoreOptions) {
		this.#runtimeRoot = options.runtimeRoot;
		this.#basename = options.basename ?? DEFAULT_STORE_BASENAME;
		this.#filePath = secureRuntimePath(this.#runtimeRoot, this.#basename);
		this.#compactThreshold = options.compactThreshold ?? SNAPSHOT_COMPACT_THRESHOLD;
	}

	get runtimeRoot(): string {
		return this.#runtimeRoot;
	}

	get filePath(): string {
		return this.#filePath;
	}

	get isOpen(): boolean {
		return this.#isOpen;
	}

	async open(): Promise<WorkspaceReducerStateV1> {
		await ensureSecureRuntimeRoot(this.#runtimeRoot);
		this.#isOpen = true;
		const state = await this.load();
		return state;
	}

	async close(): Promise<void> {
		this.#isOpen = false;
		await this.#writeLock;
	}

	async load(): Promise<WorkspaceReducerStateV1> {
		if (!this.#isOpen) {
			await ensureSecureRuntimeRoot(this.#runtimeRoot);
		}
		let content = "";
		try {
			content = await fsp.readFile(this.#filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				const initialDoc = createInitialWorkspaceDocumentV1();
				const state: WorkspaceReducerStateV1 = {
					document: initialDoc,
					seenCommandIds: new Set<string>(),
					nextEventSequence: 1,
				};
				await this.saveSnapshot(state);
				return state;
			}
			throw error;
		}

		const lines = content
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0);
		if (lines.length === 0) {
			const initialDoc = createInitialWorkspaceDocumentV1();
			const state: WorkspaceReducerStateV1 = {
				document: initialDoc,
				seenCommandIds: new Set<string>(),
				nextEventSequence: 1,
			};
			await this.saveSnapshot(state);
			return state;
		}

		let currentDoc: WorkspaceDocumentV1 = createInitialWorkspaceDocumentV1();
		const seenCommandIds = new Set<string>();
		let nextEventSequence = 1;
		let commitsSinceSnapshot = 0;
		let migrated = false;

		for (const [lineIndex, line] of lines.entries()) {
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch (error) {
				throw new Error(`Invalid JSON record in workspace store: ${String(error)}`);
			}
			if (typeof record !== "object" || record === null || !("type" in record)) {
				throw new Error("Invalid store record structure");
			}
			const typedRecord = record as StoredRecord;
			if (typedRecord.type === "snapshot") {
				const migration = migrateStoredDocument(typedRecord.document, `snapshot line ${lineIndex + 1}`);
				currentDoc = migration.document;
				migrated ||= migration.migrated;
				seenCommandIds.clear();
				if (Array.isArray(typedRecord.seenCommandIds)) {
					for (const id of typedRecord.seenCommandIds) {
						if (typeof id === "string") seenCommandIds.add(id);
					}
				}
				if (typeof typedRecord.nextEventSequence === "number" && Number.isFinite(typedRecord.nextEventSequence)) {
					nextEventSequence = typedRecord.nextEventSequence;
				}
				commitsSinceSnapshot = 0;
			} else if (typedRecord.type === "commit") {
				const migration = migrateStoredDocument(typedRecord.document, `commit line ${lineIndex + 1}`);
				currentDoc = migration.document;
				migrated ||= migration.migrated;
				if (typeof typedRecord.commandId === "string") {
					seenCommandIds.add(typedRecord.commandId);
				}
				if (typeof typedRecord.nextEventSequence === "number" && Number.isFinite(typedRecord.nextEventSequence)) {
					nextEventSequence = typedRecord.nextEventSequence;
				}
				commitsSinceSnapshot++;
			}
		}

		this.#uncompactedCommits = commitsSinceSnapshot;
		const state: WorkspaceReducerStateV1 = {
			document: currentDoc,
			seenCommandIds,
			nextEventSequence,
		};
		if (migrated) await this.#backupAndInstallMigratedSnapshot(state);
		return state;
	}

	async #backupAndInstallMigratedSnapshot(state: WorkspaceReducerStateV1): Promise<void> {
		const backupPath = secureRuntimePath(
			this.#runtimeRoot,
			`${this.#basename}.migration-backup.${Date.now()}.${Math.random().toString(36).slice(2)}`,
		);
		await fsp.copyFile(this.#filePath, backupPath, fs.constants.COPYFILE_EXCL);
		await fsp.chmod(backupPath, 0o600);
		await this.saveSnapshot(state);
		logger.info("Workspace store migrated and compacted", { path: this.#filePath, backupPath });
	}

	async saveSnapshot(state: WorkspaceReducerStateV1): Promise<void> {
		const parsedDoc = parseWorkspaceDocumentV1(stripUndefined(state.document));
		const record: StoredSnapshotRecord = {
			type: "snapshot",
			document: parsedDoc,
			seenCommandIds: Array.from(state.seenCommandIds),
			nextEventSequence: state.nextEventSequence,
		};
		const payload = `${JSON.stringify(record)}\n`;
		await this.#withWriteLock(async () => {
			const tempFile = secureRuntimePath(
				this.#runtimeRoot,
				`${this.#basename}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`,
			);
			const handle = await fsp.open(
				tempFile,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
				0o600,
			);
			try {
				await handle.writeFile(payload, "utf8");
			} finally {
				await handle.close();
			}
			await fsp.rename(tempFile, this.#filePath);
			await fsp.chmod(this.#filePath, 0o600);
			this.#uncompactedCommits = 0;
		});
	}

	async commitResult(command: WorkspaceCommandV1, result: WorkspaceCommandResultV1): Promise<void> {
		if (result.status !== "accepted") return;
		const record: StoredCommitRecord = {
			type: "commit",
			commandId: command.commandId,
			document: parseWorkspaceDocumentV1(stripUndefined(result.document)),
			events: result.events.map(e => parseWorkspaceEventV1(e)),
			nextEventSequence: result.state.nextEventSequence,
		};
		const line = `${JSON.stringify(record)}\n`;

		await this.#withWriteLock(async () => {
			const handle = await fsp.open(
				this.#filePath,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
				0o600,
			);
			try {
				await handle.writeFile(line, "utf8");
			} finally {
				await handle.close();
			}
			this.#uncompactedCommits++;
		});

		if (this.#uncompactedCommits >= this.#compactThreshold) {
			await this.saveSnapshot(result.state);
		}
	}

	async #withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
		const prevLock = this.#writeLock;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#writeLock = promise;
		try {
			await prevLock;
			return await fn();
		} finally {
			resolve();
		}
	}
}
