import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "../src/git";

async function main() {
	const tmp = await fsp.realpath(os.tmpdir());
	const testDir = await fsp.mkdtemp(path.join(tmp, "omp-git-smoke-"));
	const gitRepo = path.join(testDir, "repo");
	const wtPath = path.join(testDir, "wt");

	try {
		await fsp.mkdir(gitRepo, { recursive: true });

		const initRes = await git.runGit(["init", "-b", "main"], { cwd: gitRepo });
		if (initRes.exitCode !== 0) {
			console.error("git init failed:", initRes.stderr);
			process.exit(1);
		}

		await git.runGit(["config", "user.name", "Smoke Runner"], { cwd: gitRepo });
		await git.runGit(["config", "user.email", "smoke@omp.sh"], { cwd: gitRepo });

		await fsp.writeFile(path.join(gitRepo, "README.md"), "# Smoke\n");
		await git.runGit(["add", "."], { cwd: gitRepo });
		await git.runGit(["commit", "-m", "Initial commit"], {
			cwd: gitRepo,
			env: {
				GIT_AUTHOR_NAME: "Smoke Runner",
				GIT_AUTHOR_EMAIL: "smoke@omp.sh",
				GIT_COMMITTER_NAME: "Smoke Runner",
				GIT_COMMITTER_EMAIL: "smoke@omp.sh",
			},
		});

		const revRes = await git.runGit(["rev-parse", "--verify", "HEAD"], { cwd: gitRepo });
		if (revRes.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(revRes.stdout.trim())) {
			console.error("rev-parse failed:", revRes);
			process.exit(1);
		}

		const wtEntry = await git.addWorktree(gitRepo, wtPath, { branch: "feature-smoke" });
		if (path.resolve(wtEntry.path) !== path.resolve(wtPath) || !wtEntry.branch?.includes("feature-smoke")) {
			console.error("addWorktree failed:", wtEntry);
			process.exit(1);
		}

		const list = await git.listWorktrees(gitRepo);
		const realWt = await fsp.realpath(wtPath);
		if (!list.some(w => w.path === realWt || path.resolve(w.path) === realWt)) {
			console.error("listWorktrees missing wt:", list);
			process.exit(1);
		}

		await git.removeWorktree(gitRepo, wtPath, { force: true });
		const afterList = await git.listWorktrees(gitRepo);
		if (afterList.some(w => w.path === realWt || path.resolve(w.path) === realWt)) {
			console.error("removeWorktree did not remove wt:", afterList);
			process.exit(1);
		}

		process.exit(0);
	} finally {
		await fsp.rm(testDir, { recursive: true, force: true });
	}
}

main().catch(err => {
	console.error("git-smoke unhandled:", err);
	process.exit(1);
});
