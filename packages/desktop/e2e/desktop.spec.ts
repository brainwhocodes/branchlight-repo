import * as net from "node:net";
import * as fs from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { electronExecutablePath } from "./electron-path";

const desktopRoot = path.resolve(".");
const mainBundle = path.join(desktopRoot, ".vite", "build", "main.js");
const electronBinary = electronExecutablePath();
const terminalFixture = path.join(desktopRoot, "e2e", "terminal-fixture.cjs");
const rpcFixture = path.join(desktopRoot, "e2e", "rpc-fixture.ts");
const browserFixtureUrl = "http://127.0.0.1:5173/browser-fixture.html";
async function shutdownRuntimeRoot(runtimeRoot: string): Promise<void> {
	try {
		const tokenPath = path.join(runtimeRoot, "control.token");
		const token = (await fs.readFile(tokenPath, "utf8")).trim();
		const socketPath = process.platform === "win32"
			? `\\\\.\\pipe\\omp-workspace-${path.resolve(runtimeRoot).replace(/[^a-zA-Z0-9_-]/g, "_")}`
			: path.join(runtimeRoot, "runtime.sock");
		const socket = net.createConnection(socketPath);
		await new Promise<void>((resolve) => {
			socket.once("connect", () => {
				socket.write(JSON.stringify({ type: "auth", token }) + "\n");
				socket.write(JSON.stringify({ type: "runtime.shutdown", requestId: "e2e-shutdown" }) + "\n");
				setTimeout(() => { socket.destroy(); resolve(); }, 150);
			});
			socket.once("error", () => resolve());
		});
	} catch {}
}



test("runs chatless settings and terminal/browser workspaces", async () => {
	const userData = await mkdtemp(path.join(os.tmpdir(), "bl-e2e-"));
	const testWorkspace = path.join(userData, "workspace");
	const testHome = path.join(userData, "home");
	await fs.mkdir(testWorkspace, { recursive: true });
	await fs.mkdir(path.join(testHome, ".config"), { recursive: true });
	const app = await electron.launch({
		executablePath: electronBinary,
		args: [`--user-data-dir=${userData}`, mainBundle],
		env: {
			...process.env,
			PATH: `${path.resolve(desktopRoot, "../coding-agent/dist")}${path.delimiter}${process.env.PATH ?? ""}`,
			HOME: testHome,
			USERPROFILE: testHome,
			XDG_CONFIG_HOME: path.join(testHome, ".config"),
			BRANCHLIGHT_AUTH_FILE: path.join(userData, "auth-state"),
			BRANCHLIGHT_NODE: "bun",
			BRANCHLIGHT_RPC_FIXTURE: rpcFixture,
			BRANCHLIGHT_WORKSPACE: testWorkspace,
			PI_CODING_AGENT_DIR: path.join(userData, "omp-agent"),
			OPENAI_API_KEY: "sk-mock-key-for-test",
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
		const workspace = page.getByRole("main", { name: "Workspace" });
		const activeStage = workspace.locator(".tab-stage.is-active");
		let terminalPanes = workspace.getByRole("region", { name: "terminal pane" });
		await expect(terminalPanes).toHaveCount(1);
		await expect(terminalPanes.locator(".terminal-surface canvas")).toHaveCount(1);
		await expect(terminalPanes.getByRole("textbox", { name: "Address" })).toHaveCount(0);
		await expect(terminalPanes.getByRole("alert")).toHaveCount(0);
		await expect(terminalPanes.locator(".pane-detail")).toHaveText("Terminal");

		const initialPaneId = await terminalPanes.getAttribute("data-pane-id");
		expect(initialPaneId).toBeTruthy();
		const initialCanvas = terminalPanes.locator(".terminal-surface canvas");
		await initialCanvas.evaluate(canvas => {
			(canvas as unknown as { __testNodeMarker: string }).__testNodeMarker = "persistent-terminal-canvas-1";
		});
		await page.evaluate(async ({ paneId }: { paneId: string }) => {
			await window.branchlight.writeTerminal(paneId, "echo STREAM_PERSIST_BEFORE_SETTINGS\r");
		}, { paneId: initialPaneId ?? "" });

		await expect(page.getByRole("button", { name: "Sessions", exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Work", exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Code", exact: true })).toHaveCount(0);
		await expect(page.getByRole("combobox", { name: "Message OMP" })).toHaveCount(0);

		await expect(page.getByRole("button", { name: "Minimize Mars Kommander" })).toBeVisible();
		await page.getByRole("button", { name: "Open settings" }).click();
		await expect(page.getByRole("button", { name: "Open settings" })).toHaveAttribute("aria-current", "page");
		await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
		const settingsSurface = page.getByRole("main");
		const settingsColors = await settingsSurface.evaluate(element => {
			const canvas = document.createElement("canvas");
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Canvas is unavailable");
			const resolveColor = (color: string): number[] => {
				context.clearRect(0, 0, 1, 1);
				context.fillStyle = color;
				context.fillRect(0, 0, 1, 1);
				return [...context.getImageData(0, 0, 1, 1).data];
			};
			const style = getComputedStyle(element);
			return {
				background: resolveColor(style.backgroundColor),
				foreground: resolveColor(style.color),
			};
		});
		expect(settingsColors.background[3]).toBe(255);
		expect(settingsColors.foreground[3]).toBe(255);
		expect(Math.max(...settingsColors.background.slice(0, 3))).toBeLessThan(80);
		expect(Math.min(...settingsColors.foreground.slice(0, 3))).toBeGreaterThan(120);

		await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
		const categories = page.getByRole("tablist", { name: "Setting categories" });
		await expect(categories).toBeVisible();
		await expect(categories.getByRole("tab", { name: "General" })).toBeVisible();
		await expect(categories.getByRole("tab", { name: "Terminal" })).toBeVisible();
		await expect(categories.getByRole("tab", { name: "Browser" })).toBeVisible();
		await expect(categories.getByRole("tab", { name: "Workspace" })).toBeVisible();

		const themeSelect = page.getByRole("combobox", { name: "Theme" });
		await expect(themeSelect).toHaveValue("dark");
		const confirmClose = page.getByRole("checkbox", { name: "Confirm before closing tabs" });
		await expect(confirmClose).toBeChecked();
		await confirmClose.uncheck();
		await expect(page.getByRole("status")).toHaveText("Tab close confirmation updated.");

		await categories.getByRole("tab", { name: "Terminal" }).click();
		const fontSize = page.getByRole("combobox", { name: "Font size (pt)" });
		await expect(fontSize).toHaveValue("14");
		await fontSize.selectOption("16");
		await expect(page.getByRole("status")).toHaveText("Font size updated.");

		await categories.getByRole("tab", { name: "Browser" }).click();
		const defaultUrl = page.getByRole("textbox", { name: "Default homepage URL" });
		await expect(defaultUrl).toHaveValue("https://omp.sh");

		await categories.getByRole("tab", { name: "Workspace" }).click();
		const workspacePathInput = page.getByRole("textbox", { name: "Default root directory" });
		await expect(workspacePathInput).toBeVisible();

		await page.getByRole("button", { name: "Reset defaults" }).click();
		await expect(page.getByRole("status")).toHaveText("Reset to default settings.");

		const refreshSettings = page.getByRole("button", { name: "Refresh" });
		await refreshSettings.click();
		await expect(page.getByRole("status")).toHaveText("Settings refreshed.");

		await page.screenshot({ path: "test-results/settings-1440.png", fullPage: true });
		await page.getByRole("button", { name: "Back to workspace" }).click();
		await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveAttribute("aria-current", "page");
		await expect(terminalPanes.locator(".terminal-surface canvas")).toHaveCount(1);
		const retainedMarker = await terminalPanes.locator(".terminal-surface canvas").evaluate(canvas => {
			return (canvas as unknown as { __testNodeMarker?: string }).__testNodeMarker;
		});
		expect(retainedMarker).toBe("persistent-terminal-canvas-1");
		await expect(page.getByRole("button", { name: "Work", exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Code", exact: true })).toHaveCount(0);
		await expect(page.getByRole("combobox", { name: "Message OMP" })).toHaveCount(0);

		await page.getByRole("button", { name: "Maximize Mars Kommander" }).click();
		await expect(page.getByRole("button", { name: "Restore Mars Kommander" })).toBeVisible();
		await page.getByRole("button", { name: "Restore Mars Kommander" }).click();
		await page.getByRole("button", { name: "Terminal", exact: true }).click();
		terminalPanes = workspace.getByRole("region", { name: "terminal pane" });
		await page.getByRole("button", { name: "Split terminal below" }).click();
		await expect(terminalPanes).toHaveCount(2);
		await expect(terminalPanes.locator(".terminal-surface canvas")).toHaveCount(2);
		await expect(terminalPanes.getByRole("textbox", { name: "Address" })).toHaveCount(0);
		await expect.poll(async () => {
			const boxes = await terminalPanes.evaluateAll(panes => panes.map(pane => pane.getBoundingClientRect().toJSON()));
			return boxes.length === 2 && boxes[1].y > boxes[0].y;
		}, { timeout: 8000 }).toBe(true);
		await expect(terminalPanes).toContainText(["Terminal", "Terminal"]);

		const multiPaneIds = await terminalPanes.evaluateAll(panes => panes.map(p => p.getAttribute("data-pane-id") ?? ""));
		expect(multiPaneIds).toHaveLength(2);
		expect(multiPaneIds[0]).toBeTruthy();
		expect(multiPaneIds[1]).toBeTruthy();

		// Exercise typing into both split panes concurrently in the same window
		await page.evaluate(async ({ paneId }: { paneId: string }) => {
			await window.branchlight.writeTerminal(paneId, "echo MULTI_PANE_1_ACTIVE\r");
		}, { paneId: multiPaneIds[0] ?? "" });
		await page.evaluate(async ({ paneId }: { paneId: string }) => {
			await window.branchlight.writeTerminal(paneId, "echo MULTI_PANE_2_ACTIVE\r");
		}, { paneId: multiPaneIds[1] ?? "" });
		await page.getByRole("button", { name: "OMP Browser", exact: true }).click();
		const browserPanes = workspace.getByRole("region", { name: "browser pane" });
		await expect(browserPanes).toHaveCount(1);
		await expect(activeStage.locator(".terminal-surface")).toHaveCount(0);
		const firstAddress = browserPanes.getByRole("textbox", { name: "Address" });
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
		await expect(browserPanes).toHaveCount(2);
		await expect(browserPanes.getByRole("textbox", { name: "Address" })).toHaveCount(2);
		await expect(activeStage.locator(".terminal-surface")).toHaveCount(0);
		const secondAddress = browserPanes.getByRole("textbox", { name: "Address" }).nth(1);
		await secondAddress.fill(browserFixtureUrl);
		await secondAddress.press("Enter");
		await expect(secondAddress).toHaveValue(browserFixtureUrl);
		const attachedBrowserViews = () => app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? -1,
		);
		await expect.poll(attachedBrowserViews).toBe(2);

		await page.getByRole("button", { name: "New tab" }).click();
		await expect.poll(attachedBrowserViews).toBe(0);
		const browserNewTabMenu = page.getByRole("menu");
		await expect(browserNewTabMenu).toBeVisible();
		expect(await browserNewTabMenu.evaluate(menu => {
			const bounds = menu.getBoundingClientRect();
			const center = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
			return center !== null && menu.contains(center);
		})).toBe(true);
		await page.getByRole("button", { name: "New tab" }).click();
		await expect(browserNewTabMenu).toHaveCount(0);
		await expect.poll(attachedBrowserViews).toBe(2);


		await page.getByRole("button", { name: "Terminal", exact: true }).click();
		terminalPanes = workspace.getByRole("region", { name: "terminal pane" });
		await expect(terminalPanes.locator(".terminal-surface canvas")).toHaveCount(2);
		await expect(workspace.getByRole("region", { name: "browser pane" })).toHaveCount(0);
		await expect(terminalPanes.getByRole("textbox", { name: "Address" })).toHaveCount(0);

		await page.getByRole("button", { name: "New tab" }).click();
		await expect(page.getByRole("menuitem", { name: /Browser tab/ })).toBeVisible();
		await page.getByRole("menuitem", { name: /Terminal tab/ }).click();
		await expect(page.getByRole("button", { name: "Terminal 2", exact: true })).toHaveAttribute("aria-current", "page");
		terminalPanes = workspace.getByRole("region", { name: "terminal pane" });
		await expect(terminalPanes.locator(".terminal-surface canvas")).toHaveCount(1);
		await expect(terminalPanes.getByRole("textbox", { name: "Address" })).toHaveCount(0);

		await page.setViewportSize({ width: 960, height: 640 });
		expect(await page.evaluate(() =>
			document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth,
		)).toBe(true);
		await page.screenshot({ path: "test-results/workspace-960.png", fullPage: true });

		const axe = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
		expect(axe.violations.filter(violation => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
		expect(consoleErrors).toEqual([]);
	} finally {
		try {
			await app.close();
		} catch {}
		await shutdownRuntimeRoot(path.join(userData, "runtime"));
		try {
			await fs.rm(userData, { recursive: true, force: true });
		} catch {}
	}
});

