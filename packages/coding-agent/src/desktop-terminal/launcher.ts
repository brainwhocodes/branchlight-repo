import * as path from "node:path";
import { filterProcessEnv } from "@oh-my-pi/pi-utils/env";
import { $which } from "@oh-my-pi/pi-utils/which";

const DESKTOP_PACKAGE = path.join("packages", "desktop", "package.json");

async function locateDesktopRoot(cwd: string): Promise<string | undefined> {
	const configured = process.env.BRANCHLIGHT_DESKTOP_ROOT?.trim();
	if (configured) {
		const root = path.resolve(configured);
		if (await Bun.file(path.join(root, "package.json")).exists()) return root;
	}
	let current = path.resolve(cwd);
	for (;;) {
		const manifest = path.join(current, DESKTOP_PACKAGE);
		if (await Bun.file(manifest).exists()) return path.dirname(manifest);
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Launches the Branchlight workspace only when OMP runs inside its source repository. */
export async function launchWorkspaceFromCurrentRepo(cwd: string): Promise<boolean> {
	if (process.env.BRANCHLIGHT_TERMINAL === "1" || process.env.OMP_DESKTOP === "0") return false;
	const desktopRoot = await locateDesktopRoot(cwd);
	if (!desktopRoot) return false;
	const bun = $which("bun");
	if (!bun) throw new Error("Branchlight requires Bun on PATH");
	const backendExecutable = path.resolve(desktopRoot, "..", "coding-agent", "dist", "omp.exe");
	if (!(await Bun.file(backendExecutable).exists())) {
		const build = Bun.spawn([bun, "run", "backend:build"], {
			cwd: desktopRoot,
			env: filterProcessEnv(process.env),
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const buildExitCode = await build.exited;
		if (buildExitCode !== 0) throw new Error(`Branchlight backend build exited with code ${buildExitCode}`);
	}
	const child = Bun.spawn([bun, "run", "start"], {
		cwd: desktopRoot,
		env: {
			...filterProcessEnv(process.env),
			BRANCHLIGHT_LAUNCHED_BY_OMP: "1",
			BRANCHLIGHT_WORKSPACE: cwd,
		},
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`Branchlight exited with code ${exitCode}`);
	return true;
}
