import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertBoundedText, assertSessionName, resolveWorkspaceTarget, safeExternalUrl } from "../src/main/guards";
import { SessionRegistry } from "../src/main/session-registry";
import type { SessionRecordV1 } from "../src/shared/contracts";

const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function record(id: string): SessionRecordV1 {
	const now = new Date().toISOString();
	return {
		id,
		kind: id.startsWith("work") ? "work" : "code",
		cwd: ".",
		ompSessionId: id,
		sessionFile: `${id}.jsonl`,
		title: null,
		createdAt: now,
		lastOpenedAt: now,
	};
}

describe("SessionRegistry", () => {
	it("preserves malformed JSON and starts empty with a recovery warning", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "branchlight-registry-"));
		tempDirectories.push(directory);
		const filePath = path.join(directory, "sessions-v1.json");
		await writeFile(filePath, "{not json", "utf8");

		const registry = new SessionRegistry(directory);
		const value = await registry.load();

		expect(value.sessions).toHaveLength(0);
		expect(value.activeByKind).toEqual({ work: null, code: null });
		expect(registry.warning).toMatch(/preserved|unreadable/);
		const files = await readdir(directory);
		expect(files.some(file => file.startsWith("sessions-v1.corrupt-") && file.endsWith(".json"))).toBe(true);
	});

	it("serializes concurrent updates and leaves one complete JSON document", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "branchlight-registry-"));
		tempDirectories.push(directory);
		const registry = new SessionRegistry(directory);
		await registry.load();

		await Promise.all([registry.create(record("work-one")), registry.create(record("code-one"))]);

		const text = await readFile(path.join(directory, "sessions-v1.json"), "utf8");
		const saved = JSON.parse(text) as { sessions: SessionRecordV1[] };
		expect(saved.sessions.map(item => item.id).sort()).toEqual(["code-one", "work-one"]);
		expect(registry.value.sessions).toHaveLength(2);
	});
});

describe("guards", () => {
	it("enforces UTF-8 and Unicode-name limits", () => {
		expect(() => assertBoundedText("x".repeat(512 * 1024 + 1), "prompt")).toThrow(/512 KiB/);
		expect(assertSessionName("    ")).toBe("");
		expect(() => assertSessionName("x".repeat(161))).toThrow(/160/);
	});

	it("allows only explicitly safe external URL schemes", () => {
		expect(safeExternalUrl("https://example.com/path").protocol).toBe("https:");
		expect(safeExternalUrl("http://127.0.0.1:4567/status").hostname).toBe("127.0.0.1");
		expect(() => safeExternalUrl("http://example.com")).toThrow();
		expect(() => safeExternalUrl("file:///secret.txt")).toThrow();
		expect(() => safeExternalUrl("javascript:alert(1)")).toThrow();
	});

	it("realpaths workspace targets and marks executable types reveal-only", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "branchlight-target-"));
		tempDirectories.push(directory);
		const document = path.join(directory, "note.md");
		const script = path.join(directory, "run.sh");
		await writeFile(document, "note", "utf8");
		await writeFile(script, "echo no", "utf8");

		await expect(resolveWorkspaceTarget(directory, "note.md")).resolves.toMatchObject({
			target: await realpath(document),
			revealOnly: false,
		});
		await expect(resolveWorkspaceTarget(directory, path.join(directory, "missing.txt"))).rejects.toThrow();
		await expect(
			resolveWorkspaceTarget(directory, path.join(directory, "..", path.basename(directory), "note.md")),
		).resolves.toMatchObject({ revealOnly: false });
		await expect(resolveWorkspaceTarget(directory, script)).resolves.toMatchObject({ revealOnly: true });
	});
});
