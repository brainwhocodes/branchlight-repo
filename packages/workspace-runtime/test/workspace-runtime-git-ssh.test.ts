import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git, ssh } from "@oh-my-pi/pi-utils";
import { WorkspaceGitManager, WorkspaceSshManager } from "../src";

describe("WorkspaceGitManager & WorkspaceSshManager", () => {
	let testDir: string;
	let gitManager: WorkspaceGitManager;
	let sshManager: WorkspaceSshManager;
	const spies: Array<{ mockRestore: () => void }> = [];

	beforeEach(async () => {
		const tmp = await fsp.realpath(os.tmpdir());
		testDir = await fsp.mkdtemp(path.join(tmp, "omp-test-git-"));
		gitManager = new WorkspaceGitManager();
		sshManager = new WorkspaceSshManager();
	});

	afterEach(async () => {
		for (const spy of spies) {
			try {
				spy.mockRestore();
			} catch {}
		}
		spies.length = 0;
		try {
			await fsp.rm(testDir, { recursive: true, force: true });
		} catch {}
	});
	it("detects Git and JJ repository roots and rejects pure-JJ worktree creation", async () => {
		const jjRepo = path.join(testDir, "jj-repo");
		await fsp.mkdir(path.join(jjRepo, ".jj"), { recursive: true });

		expect(await gitManager.isJjRepository(jjRepo)).toBe(true);
		expect(await gitManager.isGitRepository(jjRepo)).toBe(false);

		await expect(
			gitManager.createWorktree({
				repoDir: jjRepo,
				worktreePath: path.join(testDir, "worktree-jj"),
			}),
		).rejects.toThrow("unsupported_worktree_provider");
	});

	it("WorkspaceGitManager delegates to central git utilities for worktree lifecycle", async () => {
		const gitRepo = path.join(testDir, "real-git-repo");
		const wtPath = path.join(testDir, "feature-wt");

		const addSpy = spyOn(git, "addWorktree").mockResolvedValue({
			path: wtPath,
			head: "664d32c1d8ef554137b73e81dfb5174b1b38cfe6",
			branch: "refs/heads/feature-1",
			detached: false,
		});

		const listSpy = spyOn(git, "listWorktrees").mockResolvedValue([
			{
				path: gitRepo,
				head: "664d32c1d8ef554137b73e81dfb5174b1b38cfe6",
				branch: "refs/heads/main",
				detached: false,
			},
			{
				path: wtPath,
				head: "664d32c1d8ef554137b73e81dfb5174b1b38cfe6",
				branch: "refs/heads/feature-1",
				detached: false,
			},
		]);

		const removeSpy = spyOn(git, "removeWorktree").mockResolvedValue();
		spies.push(addSpy, listSpy, removeSpy);

		try {
			const wtInfo = await gitManager.createWorktree({
				repoDir: gitRepo,
				worktreePath: wtPath,
				branch: "feature-1",
			});

			expect(wtInfo.path).toBe(wtPath);
			expect(wtInfo.branch).toBe("refs/heads/feature-1");
			expect(wtInfo.isClean).toBe(true);
			expect(addSpy).toHaveBeenCalledWith(gitRepo, wtPath, { branch: "feature-1", commit: undefined });

			const worktrees = await gitManager.listWorktrees(gitRepo);
			expect(worktrees).toEqual([gitRepo, wtPath]);
			expect(listSpy).toHaveBeenCalledWith(gitRepo);

			await gitManager.removeWorktree(gitRepo, wtPath, true);
			expect(removeSpy).toHaveBeenCalledWith(gitRepo, wtPath, { force: true });
		} finally {
			addSpy.mockRestore();
			listSpy.mockRestore();
			removeSpy.mockRestore();
		}
	});
	it("enforces that buildGitEnv strips ambient repository-scoping GIT_* variables", () => {
		const rawEnv = git.buildGitEnv({
			CUSTOM_VAR: "allowed-value",
		});

		expect(rawEnv.GIT_DIR).toBeUndefined();
		expect(rawEnv.GIT_COMMON_DIR).toBeUndefined();
		expect(rawEnv.GIT_WORK_TREE).toBeUndefined();
		expect(rawEnv.GIT_INDEX_FILE).toBeUndefined();
		expect(rawEnv.GIT_OPTIONAL_LOCKS).toBe("0");
		expect(rawEnv.CUSTOM_VAR).toBe("allowed-value");
	});

	it("executes standalone git smoke child process verifying process-level Git and worktree lifecycle", async () => {
		const smokeScript = path.resolve(__dirname, "../../utils/scripts/git-smoke.ts");
		const proc = Bun.spawn([process.execPath, smokeScript], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const err = await Bun.readableStreamToText(proc.stderr);
			throw new Error(`git-smoke failed with code ${exitCode}: ${err}`);
		}
		expect(exitCode).toBe(0);
	});

	it("enforces fail-closed SSH argument vector with StrictHostKeyChecking=yes and -S none", () => {
		const argv = ssh.buildSshArgv({
			destination: {
				host: "ssh.example.com",
				port: 2222,
				user: "remote-user",
			},
			command: ["uname", "-a"],
			knownHostsPath: "/tmp/known_hosts",
		});

		expect(argv).toContain("-p");
		expect(argv).toContain("2222");
		expect(argv).toContain("-o");
		expect(argv).toContain("BatchMode=yes");
		expect(argv).toContain("StrictHostKeyChecking=yes");
		expect(argv).toContain("ClearAllForwardings=yes");
		expect(argv).toContain("-S");
		expect(argv).toContain("none");
		expect(argv).toContain("UserKnownHostsFile=/tmp/known_hosts");
		expect(argv).toContain("remote-user@ssh.example.com");
		expect(argv).toContain("--");
		expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["uname", "-a"]);

		// Rejects invalid host / port injection attempts
		expect(() =>
			ssh.buildSshArgv({
				destination: { host: "-oProxyCommand=calc.exe" },
				command: ["id"],
			}),
		).toThrow("Invalid SSH host");

		expect(() =>
			ssh.buildSshArgv({
				destination: { host: "example.com", port: 999999 },
				command: ["id"],
			}),
		).toThrow("Invalid SSH port");
	});

	it("manages SSH connection state and disconnection", () => {
		sshManager.registerConnection("ssh-loc-1", {
			kind: "ssh",
			host: "127.0.0.1",
			path: "/home/user/project",
			user: "developer",
		});

		const conn = sshManager.getConnection("ssh-loc-1");
		expect(conn).toBeDefined();
		expect(conn?.status).toBe("connected");
		expect(conn?.address.host).toBe("127.0.0.1");

		const disconnected = sshManager.disconnect("ssh-loc-1");
		expect(disconnected).toBe(true);
		expect(sshManager.getConnection("ssh-loc-1")).toBeUndefined();
	});
});
