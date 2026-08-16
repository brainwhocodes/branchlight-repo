import * as net from "node:net";
import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import type { WebContents } from "electron";
import * as fs from "node:fs/promises";
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

test("OMP terminal attachment enables browser element selection and restores plain pane on detach", async () => {
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "bl-e2e-omp-"));
	const testWorkspace = path.join(userData, "workspace");
	const testHome = path.join(userData, "home");
	await fs.mkdir(testWorkspace, { recursive: true });
	await fs.mkdir(path.join(testHome, ".config"), { recursive: true });
	const ompAgentDir = path.join(userData, "omp-agent");
	await fs.mkdir(ompAgentDir, { recursive: true });
	await fs.writeFile(
		path.join(ompAgentDir, "settings.json"),
		JSON.stringify({ setupVersion: 99, "startup.setupWizard": false, "startup.splash": false }),
		"utf8",
	);
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

		// 1. Verify initial layout: Terminal tab is active, browser tab exists
		const workspace = page.getByRole("main", { name: "Workspace" });
		const terminalTabButton = page.getByRole("button", { name: "Terminal", exact: true });
		await expect(terminalTabButton).toHaveAttribute("aria-current", "page");

		// Switch to browser tab
		const browserTabButton = page.getByRole("button", { name: "OMP Browser", exact: true });
		await browserTabButton.click();
		await expect(browserTabButton).toHaveAttribute("aria-current", "page");

		const browserPane = workspace.getByRole("region", { name: "browser pane" });
		await expect(browserPane).toBeVisible();

		// Navigate to browser fixture
		const addressInput = browserPane.getByRole("textbox", { name: "Address" });
		await addressInput.fill(browserFixtureUrl);
		await addressInput.press("Enter");
		await expect(addressInput).toHaveValue(browserFixtureUrl);

		// 2. Before any agent is running, element selection target button is disabled
		const targetButton = browserPane.getByRole("button", { name: /Element selection unavailable|Select page element/ });
		await expect(targetButton).toBeDisabled();
		await expect(targetButton).toHaveAttribute(
			"aria-label",
			"Element selection unavailable: no deliverable agent in active workspace",
		);

		// Switch back to terminal tab to find the terminal pane id
		const terminalStage = workspace.locator("#stage-workspace-default-tab-terminal");
		await page.getByRole("button", { name: "Terminal", exact: true }).click();
		await expect(terminalStage).toHaveClass(/is-active/);
		const terminalPane = terminalStage.getByRole("region", { name: "terminal pane" });
		const terminalPaneId = await terminalPane.getAttribute("data-pane-id");
		expect(terminalPaneId).toBeTruthy();
		await expect(terminalStage.locator(".terminal-surface canvas")).toBeVisible({ timeout: 10_000 });
		await page.evaluate(async ({ paneId }: { paneId: string }) => {
			await window.branchlight.writeTerminal(paneId, "omp\r");
		}, { paneId: terminalPaneId ?? "" });
		// 4. Verify terminal pane updates to reflect the attached OMP agent via real runtime broadcast
		await expect(page.getByRole("button", { name: "Oh My Pi", exact: true })).toBeVisible({ timeout: 15_000 });
		await expect(terminalStage.locator(".agent-role-pill")).toHaveText("omp");

		// 5. Switch to browser tab: target cursor button is now enabled
		await page.getByRole("button", { name: "OMP Browser", exact: true }).click();
		const activeBrowserStage = workspace.locator(".tab-stage.is-active");
		const activeBrowserPane = activeBrowserStage.getByRole("region", { name: "browser pane" });
		const enabledTargetBtn = activeBrowserPane.getByRole("button", { name: "Select page element for agent" });
		await expect(enabledTargetBtn).toBeEnabled({ timeout: 15_000 });

		// 6. Click target button to enter element selection mode
		await enabledTargetBtn.click();

		// Element selection bar appears with picking phase
		const selectionBar = activeBrowserPane.getByRole("region", { name: "Element selection in progress" });
		await expect(selectionBar).toBeVisible();
		await expect(selectionBar.locator(".selection-phase-badge")).toHaveText("picking");
		await expect(selectionBar.locator(".agent-name")).toHaveText("Oh My Pi");
		await expect(selectionBar.getByRole("radiogroup", { name: "Capture mode" })).toBeVisible();
		await expect(selectionBar.getByText("Click element on page to target for Oh My Pi")).toBeVisible();

		// 7. Inspect a node on the browser page by dispatching real CDP mouse events on the targeted node
		await app.evaluate(async ({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows()[0];
			if (!win) throw new Error("Browser window not found");
			const view = win.contentView.children.find(v => {
				return Boolean(v && typeof v === "object" && "webContents" in v && (v.webContents as WebContents | undefined)?.isDestroyed() === false);
			}) as { webContents: WebContents } | undefined;
			if (!view) throw new Error("Browser view for fixture not found");
			const dbg = view.webContents.debugger;
			if (!dbg.isAttached()) dbg.attach("1.3");
			const doc = (await dbg.sendCommand("DOM.getDocument", { depth: -1 })) as { root: { nodeId: number } };
			const node = (await dbg.sendCommand("DOM.querySelector", {
				nodeId: doc.root.nodeId,
				selector: "#fixture-action",
			})) as { nodeId: number };
			if (!node?.nodeId) throw new Error("Button node #fixture-action not found");

			const box = (await dbg.sendCommand("DOM.getBoxModel", { nodeId: node.nodeId })) as {
				model: { border: number[] };
			};
			const [x1, y1, x2, , , y3] = box.model.border;
			const clickX = Math.round((x1 + x2) / 2);
			const clickY = Math.round((y1 + y3) / 2);

			await dbg.sendCommand("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: clickX,
				y: clickY,
			});
			await dbg.sendCommand("Input.dispatchMouseEvent", {
				type: "mousePressed",
				x: clickX,
				y: clickY,
				button: "left",
				clickCount: 1,
			});
			await dbg.sendCommand("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: clickX,
				y: clickY,
				button: "left",
				clickCount: 1,
			});
		});

		// Selection bar transitions to selected with the targeted selector
		await expect(selectionBar.locator(".selection-phase-badge")).toHaveText("selected", { timeout: 10_000 });
		await expect(selectionBar.locator(".hint-text.selected code")).toHaveText("#fixture-action");

		// 8. Click "Send to Agent" button to deliver element selection & screenshot to attached agent
		const sendBtn = selectionBar.getByRole("button", { name: "Send to Agent" });
		await expect(sendBtn).toBeVisible();
		await sendBtn.click();
		await expect(selectionBar).toHaveCount(0, { timeout: 10_000 });
		// 9. Stop the OMP agent process in the terminal
		await page.getByRole("button", { name: "Oh My Pi", exact: true }).click();
		await page.evaluate(async ({ paneId }: { paneId: string }) => {
			await window.branchlight.writeTerminal(paneId, "\x04");
		}, { paneId: terminalPaneId ?? "" });

		// Verify terminal tab returns to plain Terminal
		const plainTerminalTabButton = page.getByRole("button", { name: "Terminal", exact: true });
		await expect(plainTerminalTabButton).toBeVisible({ timeout: 15_000 });
		const activeTerminalStageAfter = workspace.locator(".tab-stage.is-active");
		await expect(activeTerminalStageAfter.locator(".agent-role-pill")).toHaveCount(0);

		// 10. Switch to browser tab: verify target button is disabled again after detach
		await page.getByRole("button", { name: "OMP Browser", exact: true }).click();
		const activeBrowserStageAfter = workspace.locator(".tab-stage.is-active");
		const disabledTargetBtn = activeBrowserStageAfter.getByRole("button", { name: /Element selection unavailable|Select page element/ });
		await expect(disabledTargetBtn).toBeDisabled({ timeout: 15_000 });
		await expect(disabledTargetBtn).toHaveAttribute(
			"aria-label",
			"Element selection unavailable: no deliverable agent in active workspace",
		);
		// Axe accessibility check
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
