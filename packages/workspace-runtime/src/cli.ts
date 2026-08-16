import * as path from "node:path";
import { WorkspaceClient } from "./client";
import { captureSanitizedUserEnvironment } from "./env";
import { parseWorkspaceCommandJsonV1 } from "./schema";
import { WorkspaceServer } from "./server";

const argv = process.argv.slice(2);
const firstArg = argv[0];

// Hidden worker runtime server selector
if (firstArg === "__omp_worker_runtime_server") {
	const bootstrapRuntimeDir = process.env.BRANCHLIGHT_BOOTSTRAP_RUNTIME_DIR;
	const tokenBasename = process.env.BRANCHLIGHT_BOOTSTRAP_TOKEN_BASENAME;
	const endpointBasename = process.env.BRANCHLIGHT_BOOTSTRAP_ENDPOINT_BASENAME;
	const executablePath = process.env.BRANCHLIGHT_BOOTSTRAP_EXECUTABLE_PATH;
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
} else {
	// Public CLI / management commands
	captureSanitizedUserEnvironment();

	const resolveRuntimeRoot = (): string => {
		if (process.env.BRANCHLIGHT_RUNTIME_DIR) {
			return path.resolve(process.env.BRANCHLIGHT_RUNTIME_DIR);
		}
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
		return path.join(home, ".branchlight", "runtime");
	};

	const runtimeRoot = resolveRuntimeRoot();
	const command = firstArg ?? "status";

	if (command === "status") {
		const client = new WorkspaceClient({ runtimeRoot });
		try {
			const doc = await client.connect();
			process.stdout.write(
				`${JSON.stringify(
					{
						status: "running",
						version: doc.version,
						revision: doc.revision,
						activeWorkspaceId: doc.activeWorkspaceId,
						workspacesCount: doc.workspaces.length,
						terminalsCount: doc.terminals.length,
						browsersCount: doc.browsers.length,
					},
					null,
					2,
				)}\n`,
			);
			await client.close();
		} catch (error) {
			process.stderr.write(
				`Workspace runtime is not running: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exit(1);
		}
	} else if (command === "workspace" && argv[1] === "list") {
		const client = new WorkspaceClient({ runtimeRoot });
		try {
			const doc = await client.connect();
			process.stdout.write(`${JSON.stringify(doc.workspaces, null, 2)}\n`);
			await client.close();
		} catch (error) {
			process.stderr.write(`Failed to list workspaces: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		}
	} else if (command === "command") {
		const rawJson = argv[1];
		if (!rawJson) {
			process.stderr.write("Usage: branchlight command <json>\n");
			process.exit(1);
		}
		const client = new WorkspaceClient({ runtimeRoot });
		try {
			await client.connect();
			const cmd = parseWorkspaceCommandJsonV1(rawJson);
			const result = await client.executeCommand(cmd);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			await client.close();
			if (result.status === "rejected") {
				process.exit(1);
			}
		} catch (error) {
			process.stderr.write(`Command failed: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		}
	} else {
		process.stdout.write("Branchlight Workspace Runtime CLI\nCommands: status, workspace list, command <json>\n");
	}
}
