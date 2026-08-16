import * as git from "@oh-my-pi/pi-utils/git";

export interface WorktreeCreateOptions {
	repoDir: string;
	worktreePath: string;
	branch?: string;
	commit?: string;
}

export interface WorktreeInfo {
	path: string;
	branch?: string;
	commit?: string;
	isClean: boolean;
}

export class WorkspaceGitManager {
	async isGitRepository(dir: string): Promise<boolean> {
		return git.isGitRepository(dir);
	}

	async isJjRepository(dir: string): Promise<boolean> {
		return git.isJjRepository(dir);
	}

	async createWorktree(options: WorktreeCreateOptions): Promise<WorktreeInfo> {
		const entry = await git.addWorktree(options.repoDir, options.worktreePath, {
			branch: options.branch,
			commit: options.commit,
		});
		return {
			path: entry.path,
			branch: entry.branch,
			isClean: true,
		};
	}

	async removeWorktree(repoDir: string, worktreePath: string, force = false): Promise<void> {
		await git.removeWorktree(repoDir, worktreePath, { force });
	}

	async listWorktrees(repoDir: string): Promise<string[]> {
		const entries = await git.listWorktrees(repoDir);
		return entries.map(e => e.path);
	}
}
