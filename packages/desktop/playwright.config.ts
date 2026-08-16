import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	testMatch: /(desktop|omp-selection)\.spec\.ts/,
	workers: 1,
	timeout: 45_000,
	expect: { timeout: 8_000 },
	webServer: {
		command: "bunx vite --config vite.e2e.config.ts --host 127.0.0.1 --port 5173",
		cwd: path.resolve("."),
		url: "http://127.0.0.1:5173/",
		timeout: 30_000,
		env: {
			VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
		},
	},
	reporter: [["list"]],
});
