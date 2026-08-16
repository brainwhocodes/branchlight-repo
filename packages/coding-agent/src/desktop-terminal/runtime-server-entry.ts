import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureWorkspaceRuntime } from "@oh-my-pi/pi-workspace-runtime/bootstrap";
import { WorkspaceClient } from "@oh-my-pi/pi-workspace-runtime/client";
import { captureSanitizedUserEnvironment } from "@oh-my-pi/pi-workspace-runtime/env";
import { WorkspaceServer } from "@oh-my-pi/pi-workspace-runtime/server";

export async function startRuntimeServerFromEnvironment(): Promise<void> {
	const bootstrapRuntimeDir = process.env.BRANCHLIGHT_BOOTSTRAP_RUNTIME_DIR;
	const tokenBasename = process.env.BRANCHLIGHT_BOOTSTRAP_TOKEN_BASENAME;
	const endpointBasename = process.env.BRANCHLIGHT_BOOTSTRAP_ENDPOINT_BASENAME;
	const executablePath = process.env.BRANCHLIGHT_BOOTSTRAP_EXECUTABLE_PATH;

	delete process.env.BRANCHLIGHT_BOOTSTRAP_RUNTIME_DIR;
	delete process.env.BRANCHLIGHT_BOOTSTRAP_TOKEN_BASENAME;
	delete process.env.BRANCHLIGHT_BOOTSTRAP_ENDPOINT_BASENAME;
	delete process.env.BRANCHLIGHT_BOOTSTRAP_EXECUTABLE_PATH;

	captureSanitizedUserEnvironment();

	if (!bootstrapRuntimeDir) {
		process.stderr.write("Fatal: missing BRANCHLIGHT_BOOTSTRAP_RUNTIME_DIR\n");
		process.exit(1);
	}

	const server = new WorkspaceServer({
		runtimeRoot: bootstrapRuntimeDir,
		tokenBasename,
		endpointBasename,
		executablePath,
	});

	await server.start();

	const onExit = async (): Promise<void> => {
		await server.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void onExit());
	process.on("SIGTERM", () => void onExit());
}

export async function smokeTestRuntimeServer(): Promise<void> {
	const realTmp = await fs.realpath(os.tmpdir());
	const tmpDir = await fs.mkdtemp(path.join(realTmp, "omp-smoke-runtime-"));
	try {
		const descriptor = await ensureWorkspaceRuntime({
			runtimeDir: tmpDir,
			connectTimeoutMs: 3000,
			startupTimeoutMs: 5000,
		});
		await descriptor.client.ping();
		await descriptor.close();

		// Reconnect with a fresh client
		const client2 = new WorkspaceClient({
			runtimeRoot: tmpDir,
			token: descriptor.token,
			connectTimeoutMs: 3000,
		});
		await client2.connect();
		await client2.ping();

		// Explicit operator shutdown via connected client2
		await client2.shutdownRuntime();
		await client2.close();

		// Verify daemon is stopped
		let stopped = false;
		for (let i = 0; i < 30; i++) {
			await Bun.sleep(50);
			const probeClient = new WorkspaceClient({
				runtimeRoot: tmpDir,
				token: descriptor.token,
				connectTimeoutMs: 100,
			});
			try {
				await probeClient.connect();
				await probeClient.close().catch(() => {});
			} catch {
				stopped = true;
				break;
			}
		}
		if (!stopped) {
			throw new Error("Workspace runtime daemon did not shut down as expected");
		}
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}
