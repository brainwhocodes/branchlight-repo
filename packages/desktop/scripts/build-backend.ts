import { spawn } from "node:child_process";
import * as path from "node:path";

const cwd = path.resolve(import.meta.dir, "../../coding-agent");
const child = spawn(process.platform === "win32" ? "bun.exe" : "bun", ["scripts/build-binary.ts"], {
	cwd,
	stdio: "inherit",
	env: { ...process.env, ...(process.platform === "win32" ? { CMAKE_GENERATOR: "Ninja" } : {}) },
});
const exit = await new Promise<number>(resolve => {
	child.once("exit", code => resolve(code ?? 1));
	child.once("error", () => resolve(1));
});
if (exit !== 0) throw new Error(`OMP backend build failed with exit code ${exit}`);
