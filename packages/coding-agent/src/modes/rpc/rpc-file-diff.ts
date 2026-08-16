import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as git from "../../utils/git";

const MAX_DIFF_BYTES = 256 * 1024;
const MAX_DIFF_LINES = 2_000;

export type RpcFileDiffStatus = "modified" | "added" | "deleted" | "renamed" | "clean" | "binary" | "unavailable";

export interface RpcFileDiffResult {
	path: string;
	diff: string;
	status: RpcFileDiffStatus;
	additions: number;
	deletions: number;
	truncated: boolean;
	message?: string;
}

export async function getRpcFileDiff(
	cwd: string,
	targetInput: string,
	signal?: AbortSignal,
): Promise<RpcFileDiffResult> {
	const target = targetInput.trim();
	if (!target || target.length > 4_096) throw new TypeError("File diff path must contain 1–4096 characters");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) throw new TypeError("File diff path must reference the workspace");

	const requestedWorkspace = path.resolve(cwd);
	const workspace = await fs.realpath(requestedWorkspace).catch(() => requestedWorkspace);
	const candidate = resolveWorkspaceTarget(requestedWorkspace, workspace, target);
	await assertResolvedInside(workspace, candidate);

	const repoRoot = await git.repo.root(workspace, signal);
	if (!repoRoot) return unavailable(target, "This workspace is not inside a Git repository.");
	assertInside(repoRoot, candidate);

	const gitPath = path.relative(repoRoot, candidate).split(path.sep).join("/");
	const statusText = await git.status(repoRoot, {
		pathspecs: [gitPath],
		porcelainV1: true,
		signal,
		untrackedFiles: "all",
	});
	if (!statusText) {
		return {
			path: target,
			diff: "",
			status: "clean",
			additions: 0,
			deletions: 0,
			truncated: false,
			message: "No working tree changes for this file.",
		};
	}

	const status = fileStatus(statusText);
	let diffText: string;
	if (status === "added" && statusText.startsWith("??")) {
		const realCandidate = await fs.realpath(candidate).catch(() => null);
		if (!realCandidate) return unavailable(target, "The changed file is no longer available.");
		assertInside(workspace, realCandidate);
		diffText = await git.diff(repoRoot, {
			allowFailure: true,
			noIndex: { left: "/dev/null", right: gitPath },
			signal,
		});
	} else {
		const head = await git.head.sha(repoRoot, signal);
		if (!head) {
			const realCandidate = await fs.realpath(candidate).catch(() => null);
			if (!realCandidate) return unavailable(target, "The changed file is no longer available.");
			assertInside(workspace, realCandidate);
			diffText = await git.diff(repoRoot, {
				allowFailure: true,
				noIndex: { left: "/dev/null", right: gitPath },
				signal,
			});
		} else {
			diffText = await git.diff(repoRoot, { base: head, files: [gitPath], signal });
		}
	}

	const binary = diffText.includes("GIT binary patch") || diffText.includes("Binary files ");
	const summary = summarizeDiff(diffText);
	return {
		path: target,
		diff: binary ? "" : summary.diff,
		status: binary ? "binary" : status,
		additions: summary.additions,
		deletions: summary.deletions,
		truncated: binary ? false : summary.truncated,
		...(binary ? { message: "Binary changes cannot be previewed as text." } : {}),
	};
}

function resolveWorkspaceTarget(requestedWorkspace: string, workspace: string, target: string): string {
	if (!path.isAbsolute(target)) {
		const candidate = path.resolve(workspace, target);
		assertInside(workspace, candidate);
		return candidate;
	}

	const candidate = path.normalize(target);
	if (isInside(workspace, candidate)) return candidate;
	const relative = path.relative(requestedWorkspace, candidate);
	if (!isRelativeInside(relative)) throw new Error("File diff target is outside the workspace");
	return path.resolve(workspace, relative);
}

function assertInside(root: string, target: string): void {
	if (!isInside(root, target)) throw new Error("File diff target is outside the workspace");
}

function isInside(root: string, target: string): boolean {
	return isRelativeInside(path.relative(root, target));
}

function isRelativeInside(relative: string): boolean {
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertResolvedInside(workspace: string, target: string): Promise<void> {
	let existing = target;
	for (;;) {
		let resolved: string;
		try {
			resolved = await fs.realpath(existing);
		} catch (error) {
			const parent = path.dirname(existing);
			if (parent === existing) throw error;
			existing = parent;
			continue;
		}
		assertInside(workspace, resolved);
		return;
	}
}

function fileStatus(statusText: string): Exclude<RpcFileDiffStatus, "clean" | "binary" | "unavailable"> {
	const indexStatus = statusText[0];
	const worktreeStatus = statusText[1];
	if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
	if (indexStatus === "R" || worktreeStatus === "R" || indexStatus === "C" || worktreeStatus === "C") return "renamed";
	if ((indexStatus === "?" && worktreeStatus === "?") || indexStatus === "A" || worktreeStatus === "A") return "added";
	return "modified";
}

function summarizeDiff(text: string): { diff: string; additions: number; deletions: number; truncated: boolean } {
	let additions = 0;
	let deletions = 0;
	let lineCount = 0;
	let lineLimit = text.length;
	let start = 0;
	for (let index = 0; index <= text.length; index += 1) {
		if (index < text.length && text.charCodeAt(index) !== 10) continue;
		if (text.charCodeAt(start) === 43 && !text.startsWith("+++", start)) additions += 1;
		else if (text.charCodeAt(start) === 45 && !text.startsWith("---", start)) deletions += 1;
		lineCount += 1;
		if (lineCount === MAX_DIFF_LINES && index < text.length) lineLimit = index + 1;
		start = index + 1;
	}

	let end = lineLimit;
	if (Buffer.byteLength(text.slice(0, end), "utf8") > MAX_DIFF_BYTES) {
		let low = 0;
		let high = end;
		while (low < high) {
			const midpoint = Math.ceil((low + high) / 2);
			if (Buffer.byteLength(text.slice(0, midpoint), "utf8") <= MAX_DIFF_BYTES) low = midpoint;
			else high = midpoint - 1;
		}
		end = low;
		if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
	}
	return { additions, deletions, diff: text.slice(0, end), truncated: end < text.length };
}

function unavailable(target: string, message: string): RpcFileDiffResult {
	return {
		path: target,
		diff: "",
		status: "unavailable",
		additions: 0,
		deletions: 0,
		truncated: false,
		message,
	};
}
