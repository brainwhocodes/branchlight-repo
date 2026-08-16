import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";

/** Default maximum encoded JSONL frame, including its trailing newline. */
export const DEFAULT_LOCAL_FRAME_BYTES = 1024 * 1024;
/** Default maximum JSON payload before framing. */
export const DEFAULT_LOCAL_PAYLOAD_BYTES = 1024 * 1024 - 1;
export const DEFAULT_CONTROL_TOKEN_BASENAME = "control.token";
export const DEFAULT_ENDPOINT_BASENAME = "control.sock";

export class LocalFrameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalFrameError";
	}
}

export class LocalFrameTooLargeError extends LocalFrameError {
	readonly bytes: number;
	readonly limit: number;

	constructor(bytes: number, limit: number) {
		super(`JSONL frame exceeds ${limit} bytes (received ${bytes})`);
		this.name = "LocalFrameTooLargeError";
		this.bytes = bytes;
		this.limit = limit;
	}
}

export class LocalFrameParseError extends LocalFrameError {
	constructor(cause: unknown) {
		super(`Invalid JSONL frame: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "LocalFrameParseError";
	}
}

export class LocalRequestTimeoutError extends Error {
	readonly requestId: string;
	constructor(requestId: string, timeoutMs: number) {
		super(`Local request ${requestId} timed out after ${timeoutMs}ms`);
		this.name = "LocalRequestTimeoutError";
		this.requestId = requestId;
	}
}

export class LocalConnectionClosedError extends Error {
	constructor(message = "Local connection closed") {
		super(message);
		this.name = "LocalConnectionClosedError";
	}
}

/** Encode one domain-free JSON value as a bounded JSONL frame. */
export function encodeLocalJsonlFrame(
	value: unknown,
	options: { maxFrameBytes?: number; maxPayloadBytes?: number } = {},
): string {
	const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_LOCAL_FRAME_BYTES;
	const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_LOCAL_PAYLOAD_BYTES;
	const payload = JSON.stringify(value);
	if (payload === undefined) throw new LocalFrameError("JSONL values must be JSON-serializable");
	const payloadBytes = Buffer.byteLength(payload, "utf8");
	if (payloadBytes > maxPayloadBytes) throw new LocalFrameTooLargeError(payloadBytes, maxPayloadBytes);
	const frame = `${payload}\n`;
	const frameBytes = Buffer.byteLength(frame, "utf8");
	if (frameBytes > maxFrameBytes) throw new LocalFrameTooLargeError(frameBytes, maxFrameBytes);
	return frame;
}

/** Incremental bounded JSONL decoder. Chunks may split UTF-8 sequences or frames. */
export class LocalJsonlDecoder {
	readonly #maxFrameBytes: number;
	#buffer = Buffer.alloc(0);

	constructor(maxFrameBytes = DEFAULT_LOCAL_FRAME_BYTES) {
		if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 2) throw new RangeError("Invalid JSONL frame cap");
		this.#maxFrameBytes = maxFrameBytes;
	}

	push(chunk: string | Uint8Array): unknown[] {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
		if (bytes.length === 0) return [];
		this.#buffer = Buffer.concat([this.#buffer, bytes]);
		const frames: unknown[] = [];
		for (;;) {
			const newline = this.#buffer.indexOf(0x0a);
			if (newline < 0) {
				if (this.#buffer.length >= this.#maxFrameBytes) {
					throw new LocalFrameTooLargeError(this.#buffer.length, this.#maxFrameBytes);
				}
				break;
			}
			const frameBytes = newline + 1;
			if (frameBytes > this.#maxFrameBytes) throw new LocalFrameTooLargeError(frameBytes, this.#maxFrameBytes);
			const line = this.#buffer.subarray(0, newline);
			this.#buffer = this.#buffer.subarray(frameBytes);
			if (line.length === 0) continue;
			try {
				frames.push(JSON.parse(line.toString("utf8")) as unknown);
			} catch (error) {
				throw new LocalFrameParseError(error);
			}
		}
		return frames;
	}

	finish(): void {
		if (this.#buffer.length !== 0) throw new LocalFrameError("Incomplete JSONL frame");
	}
}

interface PendingLocalRequest<T> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/** Correlates transport responses by opaque request id, without defining envelopes. */
export class LocalRequestCorrelator<TResponse = unknown> {
	readonly #pending = new Map<string, PendingLocalRequest<TResponse>>();

	request<T extends TResponse = TResponse>(
		requestId: string,
		send: () => void,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<T> {
		if (this.#pending.has(requestId)) throw new Error(`Duplicate local request id: ${requestId}`);
		if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
			throw new RangeError("Invalid local request timeout");
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = setTimeout(() => {
			const pending = this.#pending.get(requestId);
			if (!pending) return;
			this.#pending.delete(requestId);
			pending.onAbort?.();
			reject(new LocalRequestTimeoutError(requestId, options.timeoutMs));
		}, options.timeoutMs);
		const pending: PendingLocalRequest<TResponse> = {
			resolve: resolve as (value: TResponse) => void,
			reject,
			timer,
			signal: options.signal,
		};
		this.#pending.set(requestId, pending);
		if (options.signal) {
			const onAbort = (): void => {
				if (!this.#pending.delete(requestId)) return;
				clearTimeout(timer);
				reject(new LocalConnectionClosedError("Local request aborted"));
			};
			pending.onAbort = () => options.signal?.removeEventListener("abort", onAbort);
			options.signal.addEventListener("abort", onAbort, { once: true });
			if (options.signal.aborted) onAbort();
		}
		if (!this.#pending.has(requestId)) return promise;
		try {
			send();
		} catch (error) {
			this.reject(requestId, error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	resolve(requestId: string, response: TResponse): boolean {
		const pending = this.#pending.get(requestId);
		if (!pending) return false;
		this.#pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.onAbort?.();
		pending.resolve(response);
		return true;
	}

	reject(requestId: string, error: Error): boolean {
		const pending = this.#pending.get(requestId);
		if (!pending) return false;
		this.#pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.onAbort?.();
		pending.reject(error);
		return true;
	}

	close(error = new LocalConnectionClosedError()): void {
		for (const [requestId, pending] of this.#pending) {
			this.#pending.delete(requestId);
			clearTimeout(pending.timer);
			pending.onAbort?.();
			pending.reject(error);
		}
	}

	get size(): number {
		return this.#pending.size;
	}
}

function assertSafeBasename(basename: string): void {
	if (
		!basename ||
		basename === "." ||
		basename === ".." ||
		path.basename(basename) !== basename ||
		basename.includes("\\")
	) {
		throw new Error(`Invalid runtime basename: ${JSON.stringify(basename)}`);
	}
}

function modeBits(mode: number): number {
	return mode & 0o777;
}

function ownerUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwnedMode(stat: fs.Stats, expectedMode: number, label: string): void {
	const uid = ownerUid();
	if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} is not owned by the current user`);
	if (modeBits(stat.mode) !== expectedMode) throw new Error(`${label} must have mode ${expectedMode.toString(8)}`);
}

function assertAbsoluteNoSymlink(root: string): void {
	if (!path.isAbsolute(root)) throw new Error("Runtime root must be absolute");
	const parsed = path.parse(root);
	let current = parsed.root;
	for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (stat.isSymbolicLink()) throw new Error(`Runtime path contains a symlink: ${current}`);
		if (!stat.isDirectory()) throw new Error(`Runtime path component is not a directory: ${current}`);
	}
}

/** Ensure an absolute, owner-only runtime root with no symlink/reparse components. */
export async function ensureSecureRuntimeRoot(root: string): Promise<string> {
	assertAbsoluteNoSymlink(root);
	const parsed = path.parse(root);
	let current = parsed.root;
	for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const stat = await fsp.lstat(current);
			if (stat.isSymbolicLink()) throw new Error(`Runtime path contains a symlink: ${current}`);
			if (!stat.isDirectory()) throw new Error(`Unsafe runtime root component: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await fsp.mkdir(current, { mode: 0o700 });
			const stat = await fsp.lstat(current);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new Error(`Runtime root is not a directory: ${current}`);
		}
	}
	const stat = await fsp.lstat(root);
	assertOwnedMode(stat, 0o700, root);
	return root;
}

export function secureRuntimePath(root: string, basename: string): string {
	assertAbsoluteNoSymlink(root);
	assertSafeBasename(basename);
	return path.join(root, basename);
}

/** Return a fixed-name local endpoint after checking the runtime root shape. */
export function secureRuntimeEndpoint(root: string, basename = DEFAULT_ENDPOINT_BASENAME): string {
	assertSafeBasename(basename);
	if (process.platform === "win32") {
		const hash = nodeCrypto
			.createHash("sha256")
			.update(path.normalize(root).toLowerCase())
			.digest("hex")
			.slice(0, 16);
		return `\\\\.\\pipe\\omp-${hash}-${basename}`;
	}
	return secureRuntimePath(root, basename);
}

async function assertSecureFile(filePath: string, expectedMode: number): Promise<void> {
	const stat = await fsp.lstat(filePath);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe runtime file: ${filePath}`);
	assertOwnedMode(stat, expectedMode, filePath);
}

/** Create a private file exactly once, refusing symlinks and replacement races. */
export async function createSecureRuntimeFile(
	root: string,
	basename: string,
	contents: string | Uint8Array,
): Promise<string> {
	await ensureSecureRuntimeRoot(root);
	const filePath = secureRuntimePath(root, basename);
	const handle = await fsp.open(
		filePath,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		await handle.writeFile(contents);
	} finally {
		await handle.close();
	}
	await fsp.chmod(filePath, 0o600);
	await assertSecureFile(filePath, 0o600);
	return filePath;
}

/** Rotate a fixed-name token using an exclusive, owner-only temporary file and atomic rename. */
export async function rotateControlToken(root: string, basename = DEFAULT_CONTROL_TOKEN_BASENAME): Promise<string> {
	await ensureSecureRuntimeRoot(root);
	assertSafeBasename(basename);
	const target = secureRuntimePath(root, basename);
	try {
		const stat = await fsp.lstat(target);
		if (stat.isSymbolicLink() || stat.isDirectory()) throw new Error(`Unsafe control token path: ${target}`);
		assertOwnedMode(stat, 0o600, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = secureRuntimePath(root, `.${basename}.${nodeCrypto.randomUUID()}.tmp`);
	const token = nodeCrypto.randomBytes(32).toString("base64url");
	await createSecureRuntimeFile(root, path.basename(temporary), token);
	await fsp.rename(temporary, target);
	await fsp.chmod(target, 0o600);
	await assertSecureFile(target, 0o600);
	return token;
}

export async function readControlToken(root: string, basename = DEFAULT_CONTROL_TOKEN_BASENAME): Promise<string> {
	await ensureSecureRuntimeRoot(root);
	const filePath = secureRuntimePath(root, basename);
	await assertSecureFile(filePath, 0o600);
	return (await fsp.readFile(filePath, "utf8")).trim();
}

/** Constant-time token verification; malformed lengths never compare partially. */
export function verifyControlToken(provided: string, expected: string): boolean {
	const left = Buffer.from(provided, "utf8");
	const right = Buffer.from(expected, "utf8");
	return left.length === right.length && nodeCrypto.timingSafeEqual(left, right);
}

export type ProcessIdentityStatus = "matched" | "dead" | "mismatched" | "unverifiable";

export interface ProcessIdentity {
	pid: number;
	startToken: string;
}

export interface ProcessIdentityInspection {
	pid: number;
	status: ProcessIdentityStatus;
	observedStartToken?: string;
	expectedStartToken?: string;
}

function readProcessIdentityToken(processRef: Process): string | undefined {
	try {
		return processRef.identityToken;
	} catch {
		return undefined;
	}
}

/** Inspect a fresh PID and compare its native kernel start/birth token. */
export async function inspectProcessIdentity(identity: ProcessIdentity): Promise<ProcessIdentityInspection> {
	if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return { pid: identity.pid, status: "dead" };
	const processRef = Process.fromPid(identity.pid);
	if (!processRef || processRef.status() !== ProcessStatus.Running)
		return { pid: identity.pid, status: "dead", expectedStartToken: identity.startToken };
	const observed = readProcessIdentityToken(processRef);
	if (observed === undefined)
		return { pid: identity.pid, status: "unverifiable", expectedStartToken: identity.startToken };
	return {
		pid: identity.pid,
		expectedStartToken: identity.startToken,
		observedStartToken: observed,
		status: observed === identity.startToken ? "matched" : "mismatched",
	};
}

export async function captureProcessIdentity(
	pid: number,
): Promise<ProcessIdentityInspection & { identity?: ProcessIdentity }> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { pid, status: "dead" };
	const processRef = Process.fromPid(pid);
	if (!processRef || processRef.status() !== ProcessStatus.Running) return { pid, status: "dead" };
	const observed = readProcessIdentityToken(processRef);
	if (observed === undefined) return { pid, status: "unverifiable" };
	const identity = { pid, startToken: observed };
	return { pid, status: "matched", observedStartToken: observed, expectedStartToken: observed, identity };
}

export interface ProcessShutdownOptions {
	gracefulMs?: number;
	forceMs?: number;
}

export interface ProcessShutdownResult extends ProcessIdentityInspection {
	graceful: boolean;
	forced: boolean;
}

/** Gracefully stop a verified process tree, with bounded force fallback and no PID-only action. */
export async function shutdownProcessTree(
	identity: ProcessIdentity,
	options: ProcessShutdownOptions = {},
): Promise<ProcessShutdownResult> {
	const gracefulMs = Math.max(0, Math.floor(options.gracefulMs ?? 1_000));
	const forceMs = Math.max(1, Math.floor(options.forceMs ?? 2_000));
	let inspection = await inspectProcessIdentity(identity);
	if (inspection.status !== "matched") return { ...inspection, graceful: false, forced: false };
	const processRef = Process.fromPid(identity.pid);
	if (!processRef) return { ...inspection, status: "dead", graceful: false, forced: false };
	try {
		if (process.platform === "win32") {
			const timeout = Promise.withResolvers<boolean>();
			const timer = setTimeout(() => timeout.resolve(false), gracefulMs + forceMs);
			try {
				const stopped = await Promise.race([
					processRef.terminate({ group: true, gracefulMs, timeoutMs: forceMs }),
					timeout.promise,
				]);
				return { ...(await inspectProcessIdentity(identity)), graceful: stopped, forced: !stopped };
			} finally {
				clearTimeout(timer);
			}
		}
		processRef.killTree(15);
		const stopped = await processRef.waitForExit({ timeoutMs: gracefulMs });
		if (stopped) return { ...(await inspectProcessIdentity(identity)), graceful: true, forced: false };
		inspection = await inspectProcessIdentity(identity);
		if (inspection.status !== "matched") return { ...inspection, graceful: false, forced: false };
		const forceRef = Process.fromPid(identity.pid);
		if (!forceRef) return { ...inspection, status: "dead", graceful: false, forced: false };
		forceRef.killTree(9);
		await forceRef.waitForExit({ timeoutMs: forceMs });
		return { ...(await inspectProcessIdentity(identity)), graceful: false, forced: true };
	} catch {
		return { ...(await inspectProcessIdentity(identity)), graceful: false, forced: false };
	}
}

/** Verify an authenticated opaque token without introducing a domain envelope. */
export function authenticateLocalToken(provided: string, expected: string): void {
	if (!verifyControlToken(provided, expected)) throw new Error("Invalid local control token");
}
