import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { electronExecutablePath } from "./electron-path";

const desktopRoot = path.resolve(".");
const mainBundle = path.join(desktopRoot, ".vite", "build", "main.js");
const electronBinary = electronExecutablePath();

test("proves OMP terminal attachment and authoritative session delivery against compiled OMP", async () => {
	test.skip(process.env.BRANCHLIGHT_REAL_OMP !== "1", "set BRANCHLIGHT_REAL_OMP=1 to run with real OMP runtime");
	const userData = await mkdtemp(path.join(os.tmpdir(), "mars-real-"));
	const workFolder = await mkdtemp(path.join(os.tmpdir(), "mars-real-work-"));

	const app = await electron.launch({
		executablePath: electronBinary,
		args: [`--user-data-dir=${userData}`, mainBundle],
		env: {
			...process.env,
			BRANCHLIGHT_WORKSPACE: workFolder,
			ELECTRON_ENABLE_SECURITY_WARNINGS: "1",
		},
	});

	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });

		const terminalTab = page.locator(".tab-select", { hasText: "Terminal" });
		await expect(terminalTab).toBeVisible({ timeout: 15_000 });
		const terminalPane = page.getByRole("region", { name: "terminal pane" });
		const paneId = await terminalPane.getAttribute("data-pane-id");
		expect(paneId).toBeTruthy();

		// Start OMP inside runtime terminal
		await page.evaluate(async ({ id }: { id: string }) => {
			await window.branchlight.writeTerminal(id, "omp\r");
		}, { id: paneId! });

		// Verify authoritative agent attachment
		await expect(page.locator(".agent-role-pill")).toHaveText("omp", { timeout: 30_000 });

		// Detach without closing terminal
		await page.evaluate(async ({ id }: { id: string }) => {
			await window.branchlight.writeTerminal(id, "\x04");
		}, { id: paneId! });

		await expect(page.locator(".tab-select", { hasText: "Terminal" })).toBeVisible({ timeout: 15_000 });
	} finally {
		await app.close();
	}
});
