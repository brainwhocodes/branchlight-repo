import * as path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	testMatch: /real\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	timeout: 180_000,
	expect: { timeout: 45_000 },
	webServer: {
		command: "bunx vite --config vite.e2e.config.ts --host localhost --port 5173",
		cwd: path.resolve("."),
		url: "http://localhost:5173/",
		timeout: 30_000,
	},
	reporter: [["list"]],
});
