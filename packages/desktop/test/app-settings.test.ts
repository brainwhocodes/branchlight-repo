import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppSettingsStore } from "../src/main/app-settings";

describe("AppSettingsStore", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), "bl-settings-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	it("returns platform-correct defaults when no settings file exists", async () => {
		const store = new AppSettingsStore(tempDir, "/custom/workspace");
		const settings = await store.load();

		expect(settings.theme).toBe("dark");
		expect(settings.confirmCloseTab).toBe(true);
		expect(settings.browser.defaultUrl).toBe("https://omp.sh");
		expect(settings.workspace.defaultPath).toBe("/custom/workspace");

		if (process.platform === "darwin") {
			expect(settings.terminal.shell).toBe("/bin/zsh");
		}
	});

	it("updates settings and persists them to settings.json", async () => {
		const store = new AppSettingsStore(tempDir, "/initial");
		await store.load();

		const updated = await store.update({
			theme: "light",
			confirmCloseTab: false,
			terminal: {
				fontSize: 18,
				cursorStyle: "block",
				cursorBlink: false,
			},
			browser: {
				defaultUrl: "https://example.com",
			},
		});

		expect(updated.theme).toBe("light");
		expect(updated.confirmCloseTab).toBe(false);
		expect(updated.terminal.fontSize).toBe(18);
		expect(updated.terminal.cursorStyle).toBe("block");
		expect(updated.terminal.cursorBlink).toBe(false);
		expect(updated.browser.defaultUrl).toBe("https://example.com");

		// Verify on-disk file
		const savedContent = await readFile(path.join(tempDir, "settings.json"), "utf8");
		const parsed = JSON.parse(savedContent);
		expect(parsed.theme).toBe("light");
		expect(parsed.terminal.fontSize).toBe(18);

		// Reload from new store instance
		const store2 = new AppSettingsStore(tempDir, "/initial");
		const reloaded = await store2.load();
		expect(reloaded.theme).toBe("light");
		expect(reloaded.terminal.fontSize).toBe(18);
	});

	it("resets to default settings cleanly", async () => {
		const store = new AppSettingsStore(tempDir, "/initial");
		await store.load();

		await store.update({ theme: "light", terminal: { fontSize: 20 } });
		expect(store.settings.theme).toBe("light");

		const reset = await store.reset();
		expect(reset.theme).toBe("dark");
		expect(reset.terminal.fontSize).toBe(14);

		// Verify on disk
		const store2 = new AppSettingsStore(tempDir, "/initial");
		const reloaded = await store2.load();
		expect(reloaded.theme).toBe("dark");
		expect(reloaded.terminal.fontSize).toBe(14);
	});

	it("recovers from corrupt settings file without crashing", async () => {
		const settingsPath = path.join(tempDir, "settings.json");
		await writeFile(settingsPath, "NOT VALID JSON {{{{", "utf8");

		const store = new AppSettingsStore(tempDir, "/initial");
		const settings = await store.load();

		expect(settings.theme).toBe("dark");
		expect(settings.terminal.fontSize).toBe(14);

		// File is repaired
		const savedContent = await readFile(settingsPath, "utf8");
		expect(() => JSON.parse(savedContent)).not.toThrow();
	});
});
