import * as path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	testMatch: /performance\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	use: { trace: "retain-on-failure" },
	globalTimeout: 150_000,
	snapshotDir: path.resolve("test-results", "snapshots"),
});
