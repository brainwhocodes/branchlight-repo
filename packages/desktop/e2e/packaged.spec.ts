import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopRoot = path.resolve(".");

function findPackagedBinary(): string | undefined {
	const outDir = path.join(desktopRoot, "out");
	if (!existsSync(outDir)) return undefined;
	const candidates = [
		path.join(outDir, "Branchlight-darwin-arm64", "Branchlight.app", "Contents", "MacOS", "Branchlight"),
		path.join(outDir, "Branchlight-darwin-x64", "Branchlight.app", "Contents", "MacOS", "Branchlight"),
		path.join(outDir, "Branchlight-linux-x64", "branchlight"),
		path.join(outDir, "Branchlight-win32-x64", "Branchlight.exe"),
		path.join(outDir, "@branchlight-desktop-darwin-arm64", "Branchlight.app", "Contents", "MacOS", "Branchlight"),
		path.join(outDir, "@branchlight-desktop-win32-x64", "Branchlight.exe"),
	];
	return candidates.find(c => existsSync(c));
}

test("loads the packaged Mars Kommander shell and exercises terminal/browser panes", async () => {
	const packagedBinary = findPackagedBinary();
	test.skip(!packagedBinary, "Packaged application not found in out directory; run bun run package first");

	const userData = await mkdtemp(path.join(os.tmpdir(), "mars-cli-packaged-e2e-"));
	const testWorkspace = path.join(userData, "workspace");
	const app = await electron.launch({
		executablePath: packagedBinary!,
		args: [`--user-data-dir=${userData}`],
		env: {
			...process.env,
			BRANCHLIGHT_WORKSPACE: testWorkspace,
			ELECTRON_ENABLE_SECURITY_WARNINGS: "1",
		},
	});

	try {
		const page = await app.firstWindow();
		await expect.poll(() => page.evaluate(() => document.styleSheets.length), { timeout: 15_000 }).toBeGreaterThan(0);
		await expect(page.getByLabel("Mars Kommander")).toBeVisible();
		const terminalTab = page.locator(".tab-select", { hasText: "Terminal" });
		await expect(terminalTab).toBeVisible();

		// Open browser tab
		await page.getByRole("button", { name: "New tab" }).click();
		await page.getByRole("menuitem", { name: /Browser tab/ }).click();
		await expect(page.locator(".tab-select", { hasText: "Browser" })).toBeVisible({ timeout: 10_000 });

		// Switch back to terminal and write echo
		await terminalTab.click();
		const terminalPane = page.getByRole("region", { name: "terminal pane" });
		const paneId = await terminalPane.getAttribute("data-pane-id");
		expect(paneId).toBeTruthy();
		await page.evaluate(async ({ id }: { id: string }) => {
			await window.branchlight.writeTerminal(id, "echo PACKAGED_MARS_PROOF\r");
		}, { id: paneId! });

		await expect(page.locator(".terminal-surface canvas")).toBeVisible();
	} finally {
		await app.close();
	}
});
