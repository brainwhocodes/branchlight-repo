import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	testMatch: /desktop\.spec\.ts/,
	workers: 1,
	timeout: 45_000,
	expect: { timeout: 8_000 },
	webServer: {
		command: "bunx vite --config vite.e2e.config.ts --host localhost --port 5173",
		cwd: path.resolve("."),
		url: "http://localhost:5173/",
		timeout: 30_000,
	},
	reporter: [["list"]],
});
