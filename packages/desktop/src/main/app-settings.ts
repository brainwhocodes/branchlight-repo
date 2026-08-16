import * as fsp from "node:fs/promises";
import * as path from "node:path";

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT"
	);
}

import type { BranchlightSettings, UpdateBranchlightSettingsInput } from "../shared/contracts";
import { defaultWorkspacePath } from "./backend-path";

export function defaultBranchlightSettings(defaultPath = defaultWorkspacePath()): BranchlightSettings {
	return {
		theme: "dark",
		confirmCloseTab: true,
		terminal: {
			shell:
				process.platform === "win32"
					? (process.env.COMSPEC ?? "cmd.exe")
					: process.platform === "darwin"
						? "/bin/zsh"
						: (process.env.SHELL ?? "/bin/bash"),
			fontSize: 14,
			fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
			cursorBlink: true,
			cursorStyle: "bar",
			scrollback: 10000,
		},
		browser: {
			defaultUrl: "https://omp.sh",
			searchEngine: "https://www.google.com/search?q=%s",
		},
		workspace: {
			defaultPath,
		},
	};
}

function mergeBranchlightSettings(
	base: BranchlightSettings,
	updates: UpdateBranchlightSettingsInput,
): BranchlightSettings {
	return {
		theme:
			updates.theme === "light" || updates.theme === "system"
				? updates.theme
				: updates.theme === "dark"
					? "dark"
					: base.theme,
		confirmCloseTab: typeof updates.confirmCloseTab === "boolean" ? updates.confirmCloseTab : base.confirmCloseTab,
		terminal: {
			...base.terminal,
			...(typeof updates.terminal?.shell === "string" && updates.terminal.shell.trim().length > 0
				? { shell: updates.terminal.shell.trim() }
				: {}),
			...(typeof updates.terminal?.fontSize === "number" && Number.isFinite(updates.terminal.fontSize)
				? { fontSize: Math.max(8, Math.min(48, Math.round(updates.terminal.fontSize))) }
				: {}),
			...(typeof updates.terminal?.fontFamily === "string" && updates.terminal.fontFamily.trim().length > 0
				? { fontFamily: updates.terminal.fontFamily.trim() }
				: {}),
			...(typeof updates.terminal?.cursorBlink === "boolean" ? { cursorBlink: updates.terminal.cursorBlink } : {}),
			...(updates.terminal?.cursorStyle === "block" ||
			updates.terminal?.cursorStyle === "underline" ||
			updates.terminal?.cursorStyle === "bar"
				? { cursorStyle: updates.terminal.cursorStyle }
				: {}),
			...(typeof updates.terminal?.scrollback === "number" && Number.isFinite(updates.terminal.scrollback)
				? { scrollback: Math.max(500, Math.min(100_000, Math.round(updates.terminal.scrollback))) }
				: {}),
		},
		browser: {
			...base.browser,
			...(typeof updates.browser?.defaultUrl === "string" && updates.browser.defaultUrl.trim().length > 0
				? { defaultUrl: updates.browser.defaultUrl.trim() }
				: {}),
			...(typeof updates.browser?.searchEngine === "string" && updates.browser.searchEngine.trim().length > 0
				? { searchEngine: updates.browser.searchEngine.trim() }
				: {}),
		},
		workspace: {
			...base.workspace,
			...(typeof updates.workspace?.defaultPath === "string" && updates.workspace.defaultPath.trim().length > 0
				? { defaultPath: updates.workspace.defaultPath.trim() }
				: {}),
		},
	};
}

export class AppSettingsStore {
	readonly #filePath: string;
	#settings: BranchlightSettings;

	constructor(userDataPath: string, initialDefaultPath?: string) {
		this.#filePath = path.join(userDataPath, "settings.json");
		this.#settings = defaultBranchlightSettings(initialDefaultPath);
	}

	get settings(): BranchlightSettings {
		return structuredClone(this.#settings);
	}

	async load(): Promise<BranchlightSettings> {
		try {
			const content = await fsp.readFile(this.#filePath, "utf8");
			const parsed = JSON.parse(content) as unknown;
			if (typeof parsed === "object" && parsed !== null) {
				this.#settings = mergeBranchlightSettings(this.#settings, parsed as UpdateBranchlightSettingsInput);
			}
		} catch (error) {
			if (!isEnoent(error)) {
				// Corrupt/invalid settings file: write clean defaults
				await this.save();
			}
		}
		return this.settings;
	}

	async update(updates: UpdateBranchlightSettingsInput): Promise<BranchlightSettings> {
		this.#settings = mergeBranchlightSettings(this.#settings, updates);
		await this.save();
		return this.settings;
	}

	async reset(): Promise<BranchlightSettings> {
		this.#settings = defaultBranchlightSettings();
		await this.save();
		return this.settings;
	}

	async save(): Promise<void> {
		await fsp.mkdir(path.dirname(this.#filePath), { recursive: true });
		const tempFile = `${this.#filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
		await fsp.writeFile(tempFile, JSON.stringify(this.#settings, null, 2), "utf8");
		await fsp.rename(tempFile, this.#filePath);
	}
}
