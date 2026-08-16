import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { $which } from "./which";

export const GIT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
export const GIT_NETWORK_TIMEOUT_MS = 30 * 60 * 1000;
export const GIT_COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
export const GIT_COMMAND_TIMEOUT_EXIT_CODE = 124;
export const GIT_SPAWN_ENOENT_EXIT_CODE = 127;
export const GIT_OUTPUT_TRUNCATED_MARKER = "\n[git subprocess output truncated after 8 MiB]\n";
export const GIT_COMMAND_TERMINATE_GRACE_MS = 5_000;

export const SHORT_LIVED_GIT_CONFIG: readonly (readonly [key: string, value: string])[] = [
	["core.fsmonitor", "false"],
	["core.untrackedCache", "false"],
];

export const AMBIENT_GIT_ENV: Readonly<Record<string, undefined>> = Object.freeze({
	GIT_DIR: undefined,
	GIT_COMMON_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
	GIT_OBJECT_DIRECTORY: undefined,
	GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
});

export const GIT_NON_INTERACTIVE_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({
	GIT_ASKPASS: "true",
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	GIT_OPTIONAL_LOCKS: "0",
	LC_ALL: undefined,
	LC_MESSAGES: "C",
	SSH_ASKPASS: "/usr/bin/false",
});

export interface GitExecOptions {
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	stdin?: string | Uint8Array | ArrayBuffer | SharedArrayBuffer;
	env?: Record<string, string | undefined>;
	maxOutputBytes?: number;
	readOnly?: boolean;
}

export interface GitExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GitWorktreeEntry {
	path: string;
	head?: string;
	branch?: string;
	bare?: boolean;
	detached?: boolean;
	locked?: boolean;
	prunable?: boolean;
}

export interface AddWorktreeOptions extends GitExecOptions {
	branch?: string;
	commit?: string;
	force?: boolean;
	detach?: boolean;
}

export interface RemoveWorktreeOptions extends GitExecOptions {
	force?: boolean;
}

export class GitError extends Error {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
	readonly command: readonly string[];

	constructor(command: readonly string[], exitCode: number, stdout: string, stderr: string) {
		const detail = stderr.trim() || stdout.trim() || `Exit code ${exitCode}`;
		super(`git ${command.join(" ")} failed: ${detail}`);
		this.name = "GitError";
		this.command = [...command];
		this.exitCode = exitCode;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

function resolveTimeoutMs(timeoutMs: number | undefined, fallback: number = GIT_COMMAND_TIMEOUT_MS): number {
	if (timeoutMs === undefined) return fallback;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return fallback;
	return Math.trunc(timeoutMs);
}

function resolveOutputLimit(maxOutputBytes: number | undefined): number {
	if (maxOutputBytes === undefined) return GIT_COMMAND_OUTPUT_LIMIT_BYTES;
	if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 0) return GIT_COMMAND_OUTPUT_LIMIT_BYTES;
	return Math.trunc(maxOutputBytes);
}

function normalizeStdin(input: GitExecOptions["stdin"]): "ignore" | Uint8Array {
	if (input === undefined) return "ignore";
	if (typeof input === "string") return new TextEncoder().encode(input);
	if (input instanceof Uint8Array) return input;
	return new Uint8Array(input);
}

function buildNonInteractiveEnv(
	env: Record<string, string | undefined>,
	pinnedEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const preservedCharacterLocale =
		env.LC_ALL !== undefined && /(?:^|[._-])utf-?8(?:$|[.@_-])/i.test(env.LC_ALL) ? env.LC_ALL : undefined;
	return {
		...env,
		...(preservedCharacterLocale === undefined ? {} : { LC_CTYPE: preservedCharacterLocale }),
		...pinnedEnv,
	};
}

export function buildGitEnv(overrides?: Record<string, string | undefined>): Record<string, string | undefined> {
	return buildNonInteractiveEnv(
		{
			...process.env,
			GIT_OPTIONAL_LOCKS: "0",
			...AMBIENT_GIT_ENV,
			...overrides,
		},
		GIT_NON_INTERACTIVE_ENV,
	);
}

function hasGitConfig(args: readonly string[], key: string, value: string): boolean {
	const expected = `${key}=${value}`;
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] === "-c" && args[index + 1] === expected) {
			return true;
		}
	}
	return false;
}

export function withShortLivedGitConfig(args: readonly string[]): string[] {
	const prefix: string[] = [];
	for (const [key, value] of SHORT_LIVED_GIT_CONFIG) {
		if (hasGitConfig(args, key, value)) continue;
		prefix.push("-c", `${key}=${value}`);
	}
	return [...prefix, ...args];
}

async function waitForChildExit(child: Subprocess, timeoutMs: number): Promise<boolean> {
	if (timeoutMs <= 0) return false;
	const timeout = Promise.withResolvers<false>();
	const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
	timer.unref?.();
	try {
		return await Promise.race([
			child.exited.then(
				() => true,
				() => true,
			),
			timeout.promise,
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function terminateTimedOutChild(child: Subprocess): Promise<void> {
	child.kill("SIGTERM");
	if (await waitForChildExit(child, GIT_COMMAND_TERMINATE_GRACE_MS)) return;
	child.kill("SIGKILL");
	await waitForChildExit(child, GIT_COMMAND_TERMINATE_GRACE_MS);
}

async function waitForExitWithTimeout(
	child: Subprocess,
	commandLabel: string,
	timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: false } | { timedOut: true; stderr: string }> {
	if (timeoutMs === 0) {
		await terminateTimedOutChild(child);
		return { timedOut: true, stderr: `${commandLabel} timed out after 0ms` };
	}
	const timeout = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => timeout.resolve("timeout"), timeoutMs);
	timer.unref?.();
	try {
		const result = await Promise.race([
			child.exited.then(exitCode => ({ kind: "exit" as const, exitCode })),
			timeout.promise.then(() => ({ kind: "timeout" as const })),
		]);
		if (result.kind === "exit") {
			return { timedOut: false, exitCode: result.exitCode };
		}
		await terminateTimedOutChild(child);
		return { timedOut: true, stderr: `${commandLabel} timed out after ${timeoutMs}ms` };
	} finally {
		clearTimeout(timer);
	}
}

async function readCappedText(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let remaining = maxBytes;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!truncated && value.length <= remaining) {
				chunks.push(decoder.decode(value, { stream: true }));
				remaining -= value.length;
				continue;
			}
			if (!truncated && remaining > 0) {
				chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
				remaining = 0;
			}
			truncated = true;
		}
		chunks.push(decoder.decode());
		if (truncated) chunks.push(GIT_OUTPUT_TRUNCATED_MARKER);
		return chunks.join("");
	} finally {
		reader.releaseLock();
	}
}

async function cancelOutput(stream: ReadableStream<Uint8Array>): Promise<void> {
	try {
		await stream.cancel();
	} catch {}
}

/** Central hardened Git process runner with lock avoidance, timeout, abort, and non-interactive env. */
export async function runGit(args: readonly string[], options: GitExecOptions = {}): Promise<GitExecResult> {
	const gitBin = $which("git") ?? "git";
	const cwd = options.cwd ?? process.cwd();
	const commandArgs = withShortLivedGitConfig(options.readOnly ? ["--no-optional-locks", ...args] : [...args]);

	let child: Subprocess;
	try {
		child = Bun.spawn([gitBin, ...commandArgs], {
			cwd,
			env: buildGitEnv(options.env),
			signal: options.signal,
			stdin: normalizeStdin(options.stdin),
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new GitError(commandArgs, GIT_SPAWN_ENOENT_EXIT_CODE, "", message);
	}

	let onAbort: (() => void) | undefined;
	if (options.signal) {
		onAbort = () => {
			child.kill("SIGTERM");
		};
		options.signal.addEventListener("abort", onAbort, { once: true });
		if (options.signal.aborted) onAbort();
	}

	const stdoutStream = child.stdout;
	const stderrStream = child.stderr;
	if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
		throw new Error("Failed to capture git command output.");
	}

	const maxOutputBytes = resolveOutputLimit(options.maxOutputBytes);
	const stdoutPromise = readCappedText(stdoutStream, maxOutputBytes);
	const stderrPromise = readCappedText(stderrStream, maxOutputBytes);

	try {
		const exit = await waitForExitWithTimeout(
			child,
			`git ${commandArgs.join(" ")}`,
			resolveTimeoutMs(options.timeoutMs),
		);

		if (exit.timedOut) {
			void stdoutPromise.catch(() => undefined);
			void stderrPromise.catch(() => undefined);
			await Promise.all([cancelOutput(stdoutStream), cancelOutput(stderrStream)]);
			throw new GitError(commandArgs, GIT_COMMAND_TIMEOUT_EXIT_CODE, "", exit.stderr);
		}

		const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
		const exitCode = exit.exitCode ?? 0;

		if (exitCode !== 0) {
			throw new GitError(commandArgs, exitCode, stdout, stderr);
		}

		return { exitCode, stdout, stderr };
	} finally {
		if (options.signal && onAbort) {
			options.signal.removeEventListener("abort", onAbort);
		}
	}
}

export async function isGitRepository(dir: string): Promise<boolean> {
	try {
		const gitDir = path.join(dir, ".git");
		const stat = await fsp.stat(gitDir);
		return stat.isDirectory() || stat.isFile();
	} catch {
		return false;
	}
}

export async function isJjRepository(dir: string): Promise<boolean> {
	try {
		const jjDir = path.join(dir, ".jj");
		const stat = await fsp.stat(jjDir);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

export async function assertWorktreeSupported(dir: string): Promise<void> {
	const isJj = await isJjRepository(dir);
	const isGit = await isGitRepository(dir);
	if (isJj && !isGit) {
		throw new Error("unsupported_worktree_provider: JJ repositories do not support git worktrees");
	}
}

export function parseWorktreeList(text: string): GitWorktreeEntry[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return trimmed
		.split(/\n\s*\n/)
		.map(block => block.trim())
		.filter(Boolean)
		.map(block => {
			const entry: GitWorktreeEntry = { detached: false, path: "" };
			for (const line of block.split("\n")) {
				if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length).trim();
				else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length).trim();
				else if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length).trim();
				else if (line === "detached") entry.detached = true;
				else if (line === "bare") entry.bare = true;
				else if (line.startsWith("locked")) entry.locked = true;
				else if (line.startsWith("prunable")) entry.prunable = true;
			}
			return entry;
		});
}

export async function listWorktrees(repoDir: string, options: GitExecOptions = {}): Promise<GitWorktreeEntry[]> {
	await assertWorktreeSupported(repoDir);
	const result = await runGit(["worktree", "list", "--porcelain"], { ...options, cwd: repoDir, readOnly: true });
	return parseWorktreeList(result.stdout);
}

export async function addWorktree(
	repoDir: string,
	worktreePath: string,
	options: AddWorktreeOptions = {},
): Promise<GitWorktreeEntry> {
	await assertWorktreeSupported(repoDir);
	await fsp.mkdir(path.dirname(worktreePath), { recursive: true });

	const args = ["worktree", "add"];
	if (options.force) args.push("--force");
	if (options.detach) args.push("--detach");
	if (options.branch) {
		args.push("-b", options.branch, worktreePath);
		args.push(options.commit ?? "HEAD");
	} else {
		args.push(worktreePath);
		if (options.commit) args.push(options.commit);
	}

	await runGit(args, { ...options, cwd: repoDir });
	const entries = await listWorktrees(repoDir, options);
	const canonical = path.resolve(worktreePath);
	const match = entries.find(e => path.resolve(e.path) === canonical);
	return match ?? { path: worktreePath, branch: options.branch, detached: Boolean(options.detach) };
}

export async function removeWorktree(
	repoDir: string,
	worktreePath: string,
	options: RemoveWorktreeOptions = {},
): Promise<void> {
	await assertWorktreeSupported(repoDir);
	const args = ["worktree", "remove"];
	if (options.force) args.push("--force");
	args.push(worktreePath);
	await runGit(args, { ...options, cwd: repoDir });
}

export const worktree = {
	add: addWorktree,
	remove: removeWorktree,
	list: listWorktrees,
};
