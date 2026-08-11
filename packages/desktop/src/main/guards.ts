import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MAX_EDITOR_BYTES = 512 * 1024;
export const MAX_NAME_CODE_POINTS = 160;
const DOCUMENT_EXTENSIONS: Record<string, true> = {
	".txt": true,
	".md": true,
	".pdf": true,
	".csv": true,
	".json": true,
	".yaml": true,
	".yml": true,
	".doc": true,
	".docx": true,
	".xlsx": true,
	".pptx": true,
	".png": true,
	".jpg": true,
	".jpeg": true,
	".gif": true,
	".webp": true,
};

export function assertBoundedText(value: unknown, label: string): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be text`);
	if (Buffer.byteLength(value, "utf8") > MAX_EDITOR_BYTES) throw new RangeError(`${label} exceeds 512 KiB`);
	return value;
}

export function assertSessionName(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("session name must be text");
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new RangeError("session name cannot be empty");
	if (Array.from(trimmed).length > MAX_NAME_CODE_POINTS) throw new RangeError("session name exceeds 160 characters");
	return trimmed;
}

export function assertSessionKind(value: unknown): "work" | "code" {
	if (value !== "work" && value !== "code") throw new TypeError("invalid session kind");
	return value;
}

export function safeExternalUrl(value: unknown): URL {
	if (typeof value !== "string") throw new TypeError("URL must be text");
	const url = new URL(value);
	if (url.protocol === "https:" || url.protocol === "mailto:") return url;
	if (
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
	)
		return url;
	throw new Error("Only HTTPS, mailto, and loopback HTTP URLs are allowed");
}

export async function resolveWorkspaceTarget(
	workspace: string,
	target: string,
): Promise<{ workspace: string; target: string; revealOnly: boolean }> {
	const [workspaceReal, targetReal] = await Promise.all([fs.realpath(workspace), fs.realpath(target)]);
	const workspaceKey = normalizeForCompare(workspaceReal);
	const targetKey = normalizeForCompare(targetReal);
	if (targetKey !== workspaceKey && !targetKey.startsWith(`${workspaceKey}${path.sep}`))
		throw new Error("Target is outside the workspace");
	const revealOnly = DOCUMENT_EXTENSIONS[path.extname(targetReal).toLowerCase()] !== true;
	return { workspace: workspaceReal, target: targetReal, revealOnly };
}

function normalizeForCompare(value: string): string {
	const normalized = path.resolve(value).replace(/[\\/]$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
