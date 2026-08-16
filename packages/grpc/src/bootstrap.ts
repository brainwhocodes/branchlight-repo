import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withResolvers } from "./promises";
import type { OmpGrpcBootstrap, WaitForOmpGrpcBootstrapOptions } from "./types";
import { OMP_GRPC_MAX_MESSAGE_BYTES, OMP_GRPC_PROTOCOL_VERSION } from "./types";

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000;
const BOOTSTRAP_POLL_INTERVAL_MS = 10;

export function generateOmpGrpcToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

export async function writeOmpGrpcBootstrapFile(filePath: string, bootstrap: OmpGrpcBootstrap): Promise<void> {
	validateBootstrap(bootstrap);
	const directory = path.dirname(filePath);
	await fs.mkdir(directory, { recursive: true });
	const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${generateOmpGrpcToken()}.tmp`);
	let temporaryExists = false;
	try {
		const handle = await fs.open(temporaryPath, "wx", 0o600);
		temporaryExists = true;
		try {
			await handle.writeFile(`${JSON.stringify(bootstrap)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.chmod(temporaryPath, 0o600);
		await fs.rename(temporaryPath, filePath);
		temporaryExists = false;
		await fs.chmod(filePath, 0o600);
	} finally {
		if (temporaryExists) await fs.unlink(temporaryPath).catch(() => undefined);
	}
}

export async function readOmpGrpcBootstrapFile(filePath: string): Promise<OmpGrpcBootstrap> {
	const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
	return validateBootstrap(value);
}

export async function waitForOmpGrpcBootstrapFile(
	filePath: string,
	options: WaitForOmpGrpcBootstrapOptions = {},
): Promise<OmpGrpcBootstrap> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
		throw new RangeError("timeoutMs must be a non-negative finite number");
	const deadline = performance.now() + timeoutMs;
	while (true) {
		if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Operation aborted", "AbortError");
		try {
			return await readOmpGrpcBootstrapFile(filePath);
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw new Error(`timed out waiting for gRPC bootstrap file: ${filePath}`);
		await abortableSleep(Math.min(BOOTSTRAP_POLL_INTERVAL_MS, remaining), options.signal);
	}
}

function validateBootstrap(value: unknown): OmpGrpcBootstrap {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("invalid gRPC bootstrap: expected an object");
	const record = value as Record<string, unknown>;
	if (record.protocol !== "grpc") throw new Error("invalid gRPC bootstrap protocol");
	if (record.protocolVersion !== OMP_GRPC_PROTOCOL_VERSION)
		throw new Error("unsupported gRPC bootstrap protocol version");
	if (typeof record.host !== "string" || record.host.length === 0) throw new Error("invalid gRPC bootstrap host");
	if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) {
		throw new Error("invalid gRPC bootstrap port");
	}
	if (typeof record.token !== "string" || record.token.length < 32) throw new Error("invalid gRPC bootstrap token");
	if (
		!Number.isSafeInteger(record.maxMessageBytes) ||
		(record.maxMessageBytes as number) < 1 ||
		(record.maxMessageBytes as number) > OMP_GRPC_MAX_MESSAGE_BYTES
	) {
		throw new Error("invalid gRPC bootstrap message limit");
	}
	return record as unknown as OmpGrpcBootstrap;
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		const slept = withResolvers<void>();
		setTimeout(slept.resolve, milliseconds);
		await slept.promise;
		return;
	}
	if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
	const { promise, resolve, reject } = withResolvers<void>();
	const timer: NodeJS.Timeout = setTimeout(resolve, milliseconds);
	const onAbort = (): void => {
		clearTimeout(timer);
		reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await promise;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
