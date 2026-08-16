import * as net from "node:net";
import { $which } from "./which";

export interface SshDestination {
	host: string;
	port?: number;
	user?: string;
}

export interface SshExecOptions {
	destination: SshDestination;
	command: readonly string[];
	timeoutMs?: number;
	knownHostsPath?: string;
	identityFilePath?: string;
}

export class SshError extends Error {
	readonly exitCode?: number;
	readonly stderr: string;

	constructor(message: string, exitCode?: number, stderr = "") {
		super(message);
		this.name = "SshError";
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

export function validateHost(host: string): void {
	if (!host || typeof host !== "string" || host.includes(" ") || host.includes("\n") || host.startsWith("-")) {
		throw new SshError(`Invalid SSH host: ${JSON.stringify(host)}`);
	}
}

export function validatePort(port?: number): number {
	if (port === undefined) return 22;
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
		throw new SshError(`Invalid SSH port: ${port}`);
	}
	return port;
}

export function validateUser(user?: string): string | undefined {
	if (user === undefined) return undefined;
	if (
		typeof user !== "string" ||
		user.length === 0 ||
		user.includes(" ") ||
		user.includes("\n") ||
		user.startsWith("-")
	) {
		throw new SshError(`Invalid SSH user: ${JSON.stringify(user)}`);
	}
	return user;
}

/** Construct strict fail-closed SSH argument vector with enforced host key verification. */
export function buildSshArgv(options: SshExecOptions): string[] {
	validateHost(options.destination.host);
	const port = validatePort(options.destination.port);
	const user = validateUser(options.destination.user);

	const sshBin = $which("ssh") ?? "ssh";
	const args: string[] = [
		sshBin,
		"-p",
		String(port),
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		"ClearAllForwardings=yes",
		"-S",
		"none",
	];

	if (options.knownHostsPath) {
		args.push("-o", `UserKnownHostsFile=${options.knownHostsPath}`);
	}

	if (options.identityFilePath) {
		args.push("-i", options.identityFilePath);
	}

	const target = user ? `${user}@${options.destination.host}` : options.destination.host;
	args.push(target, "--", ...options.command);

	return args;
}

/** Probe TCP reachability of SSH host and port before attempting handshake. */
export async function probeSshTcpReachability(destination: SshDestination, timeoutMs = 3000): Promise<boolean> {
	validateHost(destination.host);
	const port = validatePort(destination.port);

	const socket = new net.Socket();
	return new Promise<boolean>(resolve => {
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeoutMs);

		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});

		socket.once("error", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(false);
		});

		socket.connect(port, destination.host);
	});
}

/** Run an SSH command with strict argv array, non-interactive env, and strict host key checks. */
export async function runSsh(options: SshExecOptions): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const argv = buildSshArgv(options);
	const [bin, ...args] = argv;

	const proc = Bun.spawn([bin, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const readStreamToText = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
		if (!stream || typeof stream.getReader !== "function") return "";
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const chunks: string[] = [];
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) chunks.push(decoder.decode(value, { stream: true }));
			}
		} catch {}
		return chunks.join("");
	};

	const stdoutPromise = readStreamToText(proc.stdout as ReadableStream<Uint8Array>);
	const stderrPromise = readStreamToText(proc.stderr as ReadableStream<Uint8Array>);

	const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);

	if (exitCode !== 0) {
		throw new SshError(`SSH command failed with exit code ${exitCode}`, exitCode, stderr);
	}

	return { stdout, stderr, exitCode };
}
