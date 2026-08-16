import * as path from "node:path";

console.log("Compiling OMP runtime backend binary...");
const cwd = path.resolve(import.meta.dir, "../../coding-agent");
const child = Bun.spawn([process.execPath, "scripts/build-binary.ts"], {
	cwd,
	stdout: "inherit",
	stderr: "inherit",
	env: { ...Bun.env, ...(process.platform === "win32" ? { CMAKE_GENERATOR: "Ninja" } : {}) },
});
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`OMP backend build failed with exit code ${exitCode}`);
