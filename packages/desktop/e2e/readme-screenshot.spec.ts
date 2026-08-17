import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopRoot = path.resolve(".");
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const screenshotPath =
	process.env.MARS_README_SCREENSHOT?.trim() ||
	path.join(repositoryRoot, "docs", "assets", "mars-kommander-app.png");

function packagedBinary(): string {
	const packageRoot = path.join(desktopRoot, "out", `Mars Kommander-${process.platform}-${process.arch}`);
	const candidates =
		process.platform === "darwin"
			? [path.join(packageRoot, "Mars Kommander.app", "Contents", "MacOS", "Mars Kommander")]
			: process.platform === "win32"
				? [path.join(packageRoot, "Mars Kommander.exe")]
				: [path.join(packageRoot, "Mars Kommander"), path.join(packageRoot, "mars-kommander")];
	const binary = candidates.find(candidate => existsSync(candidate));
	if (!binary) throw new Error(`Packaged Mars Kommander binary was not found in ${packageRoot}`);
	return binary;
}

test("capture the Mars Kommander README screenshot", async () => {
	const userData = await mkdtemp(path.join(os.tmpdir(), "mars-kommander-readme-"));
	const workspace = path.join(userData, "workspace");
	const app = await electron.launch({
		executablePath: packagedBinary(),
		args: [`--user-data-dir=${userData}`],
		env: {
			...process.env,
			BRANCHLIGHT_WORKSPACE: workspace,
			ELECTRON_ENABLE_SECURITY_WARNINGS: "0",
		},
	});

	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await expect.poll(() => page.evaluate(() => document.styleSheets.length), { timeout: 15_000 }).toBeGreaterThan(0);
		await expect(page.getByLabel("Mars Kommander")).toBeVisible();
		await expect(page.getByRole("heading", { name: "Make the next useful thing." })).toBeVisible();
		await page.evaluate(() => {
			document.documentElement.dataset.theme = "dark";
		});
		await mkdir(path.dirname(screenshotPath), { recursive: true });
		await page.screenshot({ path: screenshotPath });
	} finally {
		await app.close().catch(() => {});
		await rm(userData, { recursive: true, force: true }).catch(() => {});
	}
});
