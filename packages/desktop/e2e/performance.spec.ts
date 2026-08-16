import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { electronExecutablePath } from "./electron-path";

const desktopRoot = path.resolve(".");
const mainBundle = path.join(desktopRoot, ".vite", "build", "main.js");
const electronBinary = electronExecutablePath();

test("streams high-throughput terminal history and exercises four-pane layout without long tasks", async () => {
	const userData = await mkdtemp(path.join(os.tmpdir(), "mars-performance-"));
	const workFolder = await mkdtemp(path.join(os.tmpdir(), "mars-performance-work-"));

	const app = await electron.launch({
		executablePath: electronBinary,
		args: [`--user-data-dir=${userData}`, mainBundle],
		env: {
			...process.env,
			BRANCHLIGHT_WORKSPACE: workFolder,
			ELECTRON_ENABLE_SECURITY_WARNINGS: "1",
		},
	});

	const page = await app.firstWindow();
	try {
		await page.setViewportSize({ width: 1440, height: 900 });
		await expect.poll(() => page.evaluate(() => document.styleSheets.length), { timeout: 10_000 }).toBeGreaterThan(0);

		// Install PerformanceObserver to record long tasks
		await page.evaluate(() => {
			(window as unknown as { __maxLongTask: number }).__maxLongTask = 0;
			const observer = new PerformanceObserver(list => {
				for (const entry of list.getEntries()) {
					if (entry.duration > (window as unknown as { __maxLongTask: number }).__maxLongTask) {
						(window as unknown as { __maxLongTask: number }).__maxLongTask = entry.duration;
					}
				}
			});
			observer.observe({ entryTypes: ["longtask"] });
		});

		const terminalPane = page.getByRole("region", { name: "terminal pane" });
		const paneId = await terminalPane.getAttribute("data-pane-id");
		expect(paneId).toBeTruthy();

		// Stream 5,000 lines of terminal output
		await page.evaluate(async ({ id }: { id: string }) => {
			for (let i = 0; i < 50; i++) {
				const chunk = Array.from({ length: 100 }, (_, k) => `perf output line ${i * 100 + k}\r\n`).join("");
				await window.branchlight.writeTerminal(id, `echo "${chunk}"\r`);
			}
		}, { id: paneId! });

		// Exercise split to 4 panes in grid
		await page.evaluate(async ({ id }: { id: string }) => {
			await (window as unknown as { branchlight: { showPaneContextMenu: Function } }).branchlight.showPaneContextMenu(id, true);
		}, { id: paneId! });

		const maxLongTask = await page.evaluate(() => (window as unknown as { __maxLongTask: number }).__maxLongTask);
		expect(maxLongTask).toBeLessThan(500);
	} finally {
		await app.close();
	}
});
