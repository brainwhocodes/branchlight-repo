import * as path from "node:path";
import { app } from "electron";

export function ompExecutablePath(): string {
	return app.isPackaged
		? path.join(process.resourcesPath, "omp.exe")
		: path.resolve(__dirname, "../../../../packages/coding-agent/dist/omp.exe");
}

export function rpcConfigPath(): string {
	return app.isPackaged
		? path.join(process.resourcesPath, "rpc-config.yml")
		: path.resolve(__dirname, "../../../../packages/desktop/resources/rpc-config.yml");
}

export function defaultWorkspacePath(): string {
	const configured = process.env.BRANCHLIGHT_WORKSPACE?.trim();
	if (configured) return path.resolve(configured);
	if (!app.isPackaged) return path.resolve(path.dirname(ompExecutablePath()), "..", "..", "..");
	return process.cwd();
}
