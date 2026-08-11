import * as path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	testMatch: /packaged\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	timeout: 90_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	use: { trace: "retain-on-failure" },
	globalTimeout: 120_000,
	snapshotDir: path.resolve("test-results", "snapshots"),
});
