import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connect } from "puppeteer-core";

const desktopRoot = path.resolve(".");
const mainBundle = path.join(desktopRoot, ".vite", "build", "main.js");
const electronBinary = path.join(desktopRoot, "node_modules", "electron", "dist", "electron.exe");
const terminalFixture = path.join(desktopRoot, "e2e", "terminal-fixture.cjs");
const browserFixtureUrl = "http://localhost:5173/browser-fixture.html";

test("runs homogeneous terminal and named browser workspaces", async () => {
	const userData = await mkdtemp(path.join(os.tmpdir(), "branchlight-workspace-e2e-"));
	const app = await electron.launch({
		executablePath: electronBinary,
		args: [`--user-data-dir=${userData}`, mainBundle],
		env: {
			...process.env,
			BRANCHLIGHT_AUTH_FILE: path.join(userData, "auth-state"),
			BRANCHLIGHT_NODE: "node",
			BRANCHLIGHT_TERMINAL_FIXTURE: terminalFixture,
			BRANCHLIGHT_WORKSPACE: desktopRoot,
			ELECTRON_ENABLE_SECURITY_WARNINGS: "1",
		},
	});

	try {
		const page = await app.firstWindow();
		const consoleErrors: string[] = [];
		page.on("console", message => {
			if (message.type() === "error") consoleErrors.push(message.text());
		});
		page.on("pageerror", error => consoleErrors.push(error.message));
		await page.setViewportSize({ width: 1440, height: 900 });
		await expect.poll(() => page.evaluate(() => document.styleSheets.length), { timeout: 8_000 }).toBeGreaterThan(0);
		const shellRgb = await page.evaluate(() => {
			const canvas = document.createElement("canvas");
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Canvas is unavailable");
			context.fillStyle = getComputedStyle(document.body).backgroundColor;
			context.fillRect(0, 0, 1, 1);
			return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
		});
		expect(Math.max(...shellRgb)).toBeLessThan(80);

		await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveAttribute("aria-current", "page");
		let activeStage = page.locator(".tab-stage.is-active");
		await expect(activeStage.locator(".workspace-pane")).toHaveCount(1);
		await expect(activeStage.locator(".terminal-surface")).toHaveCount(1);
		await expect(activeStage.getByRole("textbox", { name: "Address" })).toHaveCount(0);
		await expect.poll(async () => {
			const failureView = activeStage.locator(".terminal-failure");
			const failure = await failureView.count() > 0 ? await failureView.textContent() : null;
			return failure ? `Error: ${failure}` : await activeStage.locator(".pane-detail").textContent();
		}).toBe("Terminal");
		await expect(page.getByText("WASM VT", { exact: false })).toBeVisible();

		await page.getByRole("button", { name: "Maximize Branchlight" }).click();
		await expect(page.getByRole("button", { name: "Restore Branchlight" })).toBeVisible();
		await page.getByRole("button", { name: "Restore Branchlight" }).click();

		await page.getByRole("button", { name: "Split terminal below" }).click();
		await expect(activeStage.locator(".workspace-pane")).toHaveCount(2);
		await expect(activeStage.locator(".terminal-surface")).toHaveCount(2);
		await expect(activeStage.getByRole("textbox", { name: "Address" })).toHaveCount(0);
		await expect(activeStage).toHaveClass(/layout-rows/);
		await expect(activeStage.locator(".pane-detail")).toHaveText(["Terminal", "Terminal"]);

		await page.getByRole("button", { name: "OMP Browser", exact: true }).click();
		activeStage = page.locator(".tab-stage.is-active");
		await expect(activeStage.locator(".workspace-pane.is-browser")).toHaveCount(1);
		await expect(activeStage.locator(".terminal-surface")).toHaveCount(0);
		const firstAddress = activeStage.getByRole("textbox", { name: "Address" });
		await expect(firstAddress).toHaveCount(1);
		await firstAddress.fill(browserFixtureUrl);
		await firstAddress.press("Enter");
		await expect(firstAddress).toHaveValue(browserFixtureUrl);

		await page.getByRole("button", { name: "OMP Browser", exact: true }).dblclick();
		const renameInput = page.getByRole("textbox", { name: "Tab name" });
		await renameInput.fill("Research Docs");
		await renameInput.press("Enter");
		await expect(page.getByRole("button", { name: "Research Docs", exact: true })).toHaveAttribute("aria-current", "page");

		await page.getByRole("button", { name: "Split browser right" }).click();
		await expect(activeStage.locator(".workspace-pane.is-browser")).toHaveCount(2);
		await expect(activeStage.getByRole("textbox", { name: "Address" })).toHaveCount(2);
		await expect(activeStage.locator(".terminal-surface")).toHaveCount(0);
		const secondAddress = activeStage.getByRole("textbox", { name: "Address" }).nth(1);
		await secondAddress.fill(browserFixtureUrl);
		await secondAddress.press("Enter");
		await expect(secondAddress).toHaveValue(browserFixtureUrl);

		const cdpPort = await app.evaluate(({ app: electronApp }) =>
			Number.parseInt(electronApp.commandLine.getSwitchValue("remote-debugging-port"), 10),
		);
		expect(cdpPort).toBeGreaterThan(0);
		const cdpUrl = `http://127.0.0.1:${cdpPort}`;
		const cdpBrowser = await connect({ browserURL: cdpUrl });
		try {
			await expect.poll(async () => {
				const pages = await cdpBrowser.pages();
				return await Promise.all(pages.map(candidate => candidate.title()));
			}).toEqual(expect.arrayContaining([
				expect.stringContaining("Branchlight · Research Docs / 1 · Branchlight Browser Fixture"),
				expect.stringContaining("Branchlight · Research Docs / 2 · Branchlight Browser Fixture"),
			]));
			const pages = await cdpBrowser.pages();
			const namedPage = (await Promise.all(pages.map(async candidate => ({ candidate, title: await candidate.title() }))))
				.find(item => item.title.includes("Research Docs / 2"))?.candidate;
			expect(namedPage).toBeDefined();
			await namedPage?.click("#fixture-action");
			await expect.poll(() => namedPage?.$eval("#fixture-output", node => node.textContent)).toBe("Connected");
		} finally {
			await cdpBrowser.disconnect();
		}
		await page.screenshot({ path: "test-results/browser-split-1440.png", fullPage: true });


		await page.getByRole("button", { name: "Terminal", exact: true }).click();
		activeStage = page.locator(".tab-stage.is-active");
		await expect(activeStage.locator(".terminal-surface")).toHaveCount(2);
		await expect(activeStage.locator(".browser-surface")).toHaveCount(0);
		await expect(activeStage.getByRole("textbox", { name: "Address" })).toHaveCount(0);

		await page.getByRole("button", { name: "New tab" }).click();
		await expect(page.getByRole("menuitem", { name: /Browser tab/ })).toBeVisible();
		await page.getByRole("menuitem", { name: /Terminal tab/ }).click();
		await expect(page.getByRole("button", { name: "Terminal 2", exact: true })).toHaveAttribute("aria-current", "page");
		activeStage = page.locator(".tab-stage.is-active");
		await expect(activeStage.locator(".terminal-surface")).toHaveCount(1);
		await expect(activeStage.getByRole("textbox", { name: "Address" })).toHaveCount(0);

		await page.setViewportSize({ width: 960, height: 640 });
		expect(await page.evaluate(() =>
			document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth,
		)).toBe(true);
		await page.screenshot({ path: "test-results/workspace-960.png", fullPage: true });

		const axe = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
		expect(axe.violations.filter(violation => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
		expect(consoleErrors).toEqual([]);
	} finally {
		await app.close();
	}
});
