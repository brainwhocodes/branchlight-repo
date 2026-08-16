import * as childProcess from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import {
	captureProcessIdentity,
	DEFAULT_CONTROL_TOKEN_BASENAME,
	DEFAULT_ENDPOINT_BASENAME,
	ensureSecureRuntimeRoot,
	inspectProcessIdentity,
	type ProcessIdentity,
	readControlToken,
	secureRuntimeEndpoint,
	secureRuntimePath,
	shutdownProcessTree,
} from "@oh-my-pi/pi-utils/local-runtime";
import { WorkspaceClient } from "./client";

function sleep(ms: number): Promise<void> {
	if (typeof Bun !== "undefined" && typeof Bun.sleep === "function") return Bun.sleep(ms);
	return new Promise(resolve => setTimeout(resolve, ms));
}

function spawnDaemonProcess(
	execPath: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
): { pid?: number; unref?: () => void } {
	if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
		const child = Bun.spawn([execPath, ...args], {
			cwd: options.cwd,
			env: options.env as Record<string, string>,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		return {
			pid: child.pid,
			unref: () => {
				if (process.platform !== "win32") child.unref();
			},
		};
	}
	const child = childProcess.spawn(execPath, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: "ignore",
		detached: process.platform !== "win32",
	});
	return {
		pid: child.pid,
		unref: () => {
			if (process.platform !== "win32") child.unref();
		},
	};
}

export interface EnsureWorkspaceRuntimeOptions {
	runtimeDir: string;
	tokenBasename?: string;
	endpointBasename?: string;
	executablePath?: string;
	serverEntryPath?: string;
	connectTimeoutMs?: number;
	startupTimeoutMs?: number;
}

export interface WorkspaceRuntimeDescriptor {
	runtimeDir: string;
	endpointPath: string;
	token: string;
	client: WorkspaceClient;
	pid?: number;
	close(): Promise<void>;
	shutdownRuntime(): Promise<void>;
}

export const WORKER_RUNTIME_SERVER_SELECTOR = "__omp_worker_runtime_server";

export async function ensureWorkspaceRuntime(
	options: EnsureWorkspaceRuntimeOptions,
): Promise<WorkspaceRuntimeDescriptor> {
	const runtimeDir = options.runtimeDir;
	const tokenBasename = options.tokenBasename ?? DEFAULT_CONTROL_TOKEN_BASENAME;
	const endpointBasename = options.endpointBasename ?? DEFAULT_ENDPOINT_BASENAME;
	const endpointPath = secureRuntimeEndpoint(runtimeDir, endpointBasename);

	await ensureSecureRuntimeRoot(runtimeDir);

	// 1. First validate and connect if runtime is already running
	try {
		const token = await readControlToken(runtimeDir, tokenBasename);
		const probeClient = new WorkspaceClient({
			runtimeRoot: runtimeDir,
			token,
			tokenBasename,
			endpointBasename,
			connectTimeoutMs: options.connectTimeoutMs ?? 1500,
		});
		await probeClient.connect();
		return {
			runtimeDir,
			endpointPath,
			token,
			client: probeClient,
			close: async () => {
				await probeClient.close().catch(() => {});
			},
			shutdownRuntime: async () => {
				if (probeClient.isConnected) {
					await probeClient.shutdownRuntime().catch(() => {});
				} else {
					try {
						const shutdownClient = new WorkspaceClient({
							runtimeRoot: runtimeDir,
							token,
							tokenBasename,
							endpointBasename,
							connectTimeoutMs: 1500,
						});
						await shutdownClient.connect();
						await shutdownClient.shutdownRuntime();
					} catch {}
				}
			},
		};
	} catch {
		// Proceed to startup lock
	}

	// 2. Acquire exclusive startup lock
	const lockPath = secureRuntimePath(runtimeDir, "startup.lock");
	const lock = FileLock.tryAcquire(lockPath);
	if (!lock.acquired) {
		// Wait for winner to initialize runtime
		const startWait = Date.now();
		const timeoutMs = options.startupTimeoutMs ?? 10000;
		while (Date.now() - startWait < timeoutMs) {
			await sleep(100);
			try {
				const token = await readControlToken(runtimeDir, tokenBasename);
				const client = new WorkspaceClient({
					runtimeRoot: runtimeDir,
					token,
					tokenBasename,
					endpointBasename,
					connectTimeoutMs: 1500,
				});
				await client.connect();
				return {
					runtimeDir,
					endpointPath,
					token,
					client,
					close: async () => {
						await client.close().catch(() => {});
					},
					shutdownRuntime: async () => {
						await client.shutdownRuntime().catch(() => {});
					},
				};
			} catch {}
		}
		throw new Error(`Timed out waiting for workspace runtime startup lock at ${runtimeDir}`);
	}

	try {
		// 3. Under the lock, recheck if another process initialized the runtime
		try {
			const token = await readControlToken(runtimeDir, tokenBasename);
			const client = new WorkspaceClient({
				runtimeRoot: runtimeDir,
				token,
				tokenBasename,
				endpointBasename,
				connectTimeoutMs: 1500,
			});
			await client.connect();
			return {
				runtimeDir,
				endpointPath,
				token,
				client,
				close: async () => {
					await client.close().catch(() => {});
				},
				shutdownRuntime: async () => {
					if (client.isConnected) {
						await client.shutdownRuntime().catch(() => {});
					} else {
						try {
							const shutdownClient = new WorkspaceClient({
								runtimeRoot: runtimeDir,
								token,
								tokenBasename,
								endpointBasename,
								connectTimeoutMs: 1500,
							});
							await shutdownClient.connect();
							await shutdownClient.shutdownRuntime();
						} catch {}
					}
				},
			};
		} catch {}

		// 4. Verify process identity of previous runtime if recorded
		const ownerFile = secureRuntimePath(runtimeDir, "runtime.owner.json");
		try {
			const ownerContent = await fsp.readFile(ownerFile, "utf8");
			const parsed = JSON.parse(ownerContent) as unknown;
			if (typeof parsed === "object" && parsed !== null && "pid" in parsed && "startToken" in parsed) {
				const ownerIdentity = parsed as ProcessIdentity;
				const inspection = await inspectProcessIdentity(ownerIdentity);
				if (inspection.status === "matched") {
					// Live owner exists - fail closed without unlinking
					throw new Error(`Active workspace runtime process ${ownerIdentity.pid} is already running`);
				}
				if (inspection.status === "unverifiable" || inspection.status === "mismatched") {
					// Unverifiable/mismatched identity on a live PID - fail closed without unlinking or killing
					throw new Error(
						`Cannot verify previous workspace runtime process ${ownerIdentity.pid} identity (${inspection.status})`,
					);
				}
				// inspection.status === "dead": previous process is verified dead
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		// 5. Spawn packaged runtime server worker
		const execPath = options.executablePath ?? process.execPath;
		const isCompiledBinary = !execPath.endsWith("bun") && !execPath.endsWith("bun.exe");
		const serverEntryPath = options.serverEntryPath ?? path.join(import.meta.dir, "cli.ts");
		const spawnArgs = isCompiledBinary
			? [WORKER_RUNTIME_SERVER_SELECTOR]
			: [serverEntryPath, WORKER_RUNTIME_SERVER_SELECTOR];

		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			BRANCHLIGHT_BOOTSTRAP_RUNTIME_DIR: runtimeDir,
			BRANCHLIGHT_BOOTSTRAP_TOKEN_BASENAME: tokenBasename,
			BRANCHLIGHT_BOOTSTRAP_ENDPOINT_BASENAME: endpointBasename,
			BRANCHLIGHT_BOOTSTRAP_EXECUTABLE_PATH: execPath,
		};

		const child = spawnDaemonProcess(execPath, spawnArgs, {
			cwd: runtimeDir,
			env,
		});
		if (child.unref) child.unref();

		const childPid = child.pid;
		let childIdentity: ProcessIdentity | undefined;
		if (childPid) {
			const captured = await captureProcessIdentity(childPid);
			if (captured.status === "matched" && captured.identity) {
				childIdentity = captured.identity;
				await fsp.writeFile(ownerFile, JSON.stringify(childIdentity), "utf8");
			}
		}

		// 6. Wait for ready and perform authenticated round trip
		const startReady = Date.now();
		const timeoutMs = options.startupTimeoutMs ?? 10000;
		let authenticatedClient: WorkspaceClient | undefined;
		let runtimeToken = "";

		while (Date.now() - startReady < timeoutMs) {
			await sleep(100);
			try {
				runtimeToken = await readControlToken(runtimeDir, tokenBasename);
				const client = new WorkspaceClient({
					runtimeRoot: runtimeDir,
					token: runtimeToken,
					tokenBasename,
					endpointBasename,
					connectTimeoutMs: 1500,
				});
				await client.connect();
				authenticatedClient = client;
				break;
			} catch {}
		}

		if (!authenticatedClient) {
			if (childIdentity) {
				await shutdownProcessTree(childIdentity, { gracefulMs: 100, forceMs: 500 }).catch(() => {});
			}
			throw new Error(`Timed out waiting for workspace runtime server ready at ${runtimeDir}`);
		}

		const shutdown = async (): Promise<void> => {
			if (authenticatedClient?.isConnected) {
				await authenticatedClient.shutdownRuntime().catch(() => {});
			} else {
				try {
					const shutdownClient = new WorkspaceClient({
						runtimeRoot: runtimeDir,
						token: runtimeToken,
						tokenBasename,
						endpointBasename,
						connectTimeoutMs: 1500,
					});
					await shutdownClient.connect();
					await shutdownClient.shutdownRuntime();
				} catch {}
			}
			if (childIdentity) {
				let attempts = 0;
				while (attempts < 20) {
					const check = await inspectProcessIdentity(childIdentity);
					if (check.status !== "matched") break;
					await sleep(50);
					attempts++;
				}
				const finalCheck = await inspectProcessIdentity(childIdentity);
				if (finalCheck.status === "matched") {
					await shutdownProcessTree(childIdentity, { gracefulMs: 100, forceMs: 500 }).catch(() => {});
				}
			}
			try {
				await fsp.unlink(ownerFile);
			} catch {}
		};

		return {
			runtimeDir,
			endpointPath,
			token: runtimeToken,
			client: authenticatedClient,
			pid: childPid,
			close: async () => {
				await authenticatedClient?.close().catch(() => {});
			},
			shutdownRuntime: shutdown,
		};
	} finally {
		lock.release();
	}
}
