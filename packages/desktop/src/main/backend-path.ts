import * as path from "node:path";
import { app } from "electron";

const OMP_EXECUTABLE_NAME = process.platform === "win32" ? "omp.exe" : "omp";
export function ompExecutablePath(): string {
	return app?.isPackaged
		? path.join(process.resourcesPath, OMP_EXECUTABLE_NAME)
		: path.resolve(__dirname, "../../../../packages/coding-agent/dist", OMP_EXECUTABLE_NAME);
}

export function rpcConfigPath(): string {
	return app?.isPackaged
		? path.join(process.resourcesPath, "rpc-config.yml")
		: path.resolve(__dirname, "../../../../packages/desktop/resources/rpc-config.yml");
}

export function runtimeRootDir(): string {
	const configured = process.env.BRANCHLIGHT_RUNTIME_DIR?.trim();
	if (configured) return path.resolve(configured);
	const userDir = app?.getPath ? app.getPath("userData") : path.join(process.cwd(), ".runtime");
	return path.join(userDir, "runtime");
}
export function defaultWorkspacePath(): string {
	const configured = process.env.BRANCHLIGHT_WORKSPACE?.trim();
	if (configured) return path.resolve(configured);
	if (!app?.isPackaged) return path.resolve(__dirname, "../../../../");
	return process.cwd();
}
