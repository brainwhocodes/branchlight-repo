import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRpcFileDiff } from "../src/modes/rpc/rpc-file-diff";

const tempDirectories: string[] = [];
const decoder = new TextDecoder();

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { force: true, recursive: true })));
});

async function createRepository(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-diff-"));
	tempDirectories.push(directory);
	runGit(directory, ["init"]);
	runGit(directory, ["config", "user.email", "fixture@example.com"]);
	runGit(directory, ["config", "user.name", "Fixture"]);
	await fs.writeFile(path.join(directory, "tracked.txt"), "line one\nline two\n", "utf8");
	runGit(directory, ["add", "tracked.txt"]);
	runGit(directory, ["commit", "-m", "fixture"]);
	return directory;
}

function runGit(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	if (result.exitCode !== 0) throw new Error(decoder.decode(result.stderr));
}

describe("getRpcFileDiff", () => {
	it("returns the aggregate staged and unstaged diff against HEAD", async () => {
		const repository = await createRepository();
		await fs.writeFile(path.join(repository, "tracked.txt"), "line one\nline changed\nnew line\n", "utf8");

		const result = await getRpcFileDiff(repository, "tracked.txt");

		expect(result).toMatchObject({ status: "modified", additions: 2, deletions: 1, truncated: false });
		expect(result.diff).toContain("-line two");
		expect(result.diff).toContain("+line changed");
		expect(result.diff).toContain("+new line");
	});

	it("renders untracked files as additions", async () => {
		const repository = await createRepository();
		await fs.writeFile(path.join(repository, "fresh.txt"), "fresh line\n", "utf8");

		const result = await getRpcFileDiff(repository, "fresh.txt");

		expect(result).toMatchObject({ path: "fresh.txt", status: "added", additions: 1, deletions: 0 });
		expect(result.diff).toContain("+fresh line");
	});

	it("reports a clean tracked file without fabricating a patch", async () => {
		const repository = await createRepository();

		await expect(getRpcFileDiff(repository, "tracked.txt")).resolves.toMatchObject({
			status: "clean",
			diff: "",
			additions: 0,
			deletions: 0,
		});
	});

	it("rejects paths outside the workspace", async () => {
		const repository = await createRepository();

		await expect(getRpcFileDiff(repository, "../outside.txt")).rejects.toThrow("outside the workspace");
	});

	it("caps rendered patch lines while preserving full change counts", async () => {
		const repository = await createRepository();
		const lines = Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n");
		await fs.writeFile(path.join(repository, "large.txt"), `${lines}\n`, "utf8");

		const result = await getRpcFileDiff(repository, "large.txt");

		expect(result).toMatchObject({ status: "added", additions: 2_100, deletions: 0, truncated: true });
	});
});
