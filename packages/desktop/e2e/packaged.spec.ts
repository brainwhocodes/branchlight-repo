import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopRoot = path.resolve(".");

function findPackagedBinary(): string | undefined {
	const packageRoot = path.join(desktopRoot, "out", `Mars Kommander-${process.platform}-${process.arch}`);
	const candidates =
		process.platform === "darwin"
			? [path.join(packageRoot, "Mars Kommander.app", "Contents", "MacOS", "Mars Kommander")]
			: process.platform === "win32"
				? [path.join(packageRoot, "Mars Kommander.exe")]
				: [path.join(packageRoot, "Mars Kommander"), path.join(packageRoot, "mars-kommander")];
	return candidates.find(candidate => existsSync(candidate));
}

test("loads the contained Mars Kommander app and bundles the OMP runtime", async () => {
	const packagedBinary = findPackagedBinary();
	test.skip(!packagedBinary, "Packaged application not found; run the platform package step first");

	const userData = await mkdtemp(path.join(os.tmpdir(), "mars-kommander-packaged-"));
	const testWorkspace = path.join(userData, "workspace");
	const app = await electron.launch({
		executablePath: packagedBinary!,
		args: [`--user-data-dir=${userData}`],
		env: {
			...process.env,
			BRANCHLIGHT_WORKSPACE: testWorkspace,
			ELECTRON_ENABLE_SECURITY_WARNINGS: "0",
		},
	});

	try {
		const packageState = await app.evaluate(({ app }) => ({
			isPackaged: app.isPackaged,
			name: app.getName(),
			resourcesPath: process.resourcesPath,
			backendName: process.platform === "win32" ? "omp.exe" : "omp",
		}));
		expect(packageState.isPackaged).toBe(true);
		expect(packageState.name).toBe("Mars Kommander");
		expect(existsSync(path.join(packageState.resourcesPath, packageState.backendName))).toBe(true);

		const page = await app.firstWindow();
		const consoleErrors: string[] = [];
		page.on("console", message => {
			if (message.type() === "error") consoleErrors.push(message.text());
		});
		page.on("pageerror", error => consoleErrors.push(error.message));
		await page.setViewportSize({ width: 1440, height: 900 });

		await expect.poll(() => page.evaluate(() => document.styleSheets.length), { timeout: 15_000 }).toBeGreaterThan(0);
		await expect(page.getByLabel("Mars Kommander")).toBeVisible();
		await expect(page.getByRole("tab", { name: /OMP Chat/ })).toHaveAttribute("aria-selected", "true");
		await expect(page.getByRole("heading", { name: "Make the next useful thing." })).toBeVisible();
		await expect(page.getByRole("button", { name: /Choose a workspace/ })).toBeVisible();
		await expect(page.getByRole("button", { name: "Open browser tab" })).toBeVisible();
		expect(consoleErrors).toEqual([]);
	} finally {
		await app.close().catch(() => {});
		await rm(userData, { recursive: true, force: true }).catch(() => {});
	}
});
