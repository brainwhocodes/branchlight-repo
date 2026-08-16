<script context="module" lang="ts">
	import ghosttyWasmUrl from "ghostty-web/ghostty-vt.wasm?url";
	import { Ghostty } from "ghostty-web";

	const ghosttyReady = Ghostty.load(ghosttyWasmUrl);
</script>

<script lang="ts">
	import { onMount } from "svelte";
	import { FitAddon, Terminal } from "ghostty-web";
	import type { BranchlightSettings, WorkspaceEvent } from "../../shared/contracts";

	export let paneId: string;
	export let workspaceId: string;
	export let tabId: string;
	export let active: boolean;
	export let onActivate: () => void;
	export let onReady: (cwd: string) => void;
	export let onStatus: (status: "starting" | "ready" | "exited" | "error", message?: string) => void;
	export let onTitle: (title: string) => void;
	export let terminalSettings: BranchlightSettings["terminal"] | undefined = undefined;
	export let theme: "dark" | "light" | undefined = undefined;

	const DARK_TERMINAL_THEME = {
		background: "#191613",
		foreground: "#e6ddd2",
		cursor: "#dc8450",
		cursorAccent: "#191613",
		selectionBackground: "#77513d",
		black: "#191613",
		red: "#d66f58",
		green: "#9dae75",
		yellow: "#d4a45c",
		blue: "#7c9eb7",
		magenta: "#b58aab",
		cyan: "#7eaaa4",
		white: "#e6ddd2",
		brightBlack: "#736b63",
		brightRed: "#e68a72",
		brightGreen: "#b8c78b",
		brightYellow: "#e7b96f",
		brightBlue: "#96b7ce",
		brightMagenta: "#caa2c1",
		brightCyan: "#99c2bc",
		brightWhite: "#f3ece3",
	};

	const LIGHT_TERMINAL_THEME = {
		background: "#fcfaf7",
		foreground: "#28231d",
		cursor: "#c45c26",
		cursorAccent: "#fcfaf7",
		selectionBackground: "#edd6c8",
		black: "#28231d",
		red: "#b33820",
		green: "#4f6e24",
		yellow: "#946808",
		blue: "#265d85",
		magenta: "#7b3d6e",
		cyan: "#216b63",
		white: "#fcfaf7",
		brightBlack: "#6b6257",
		brightRed: "#cb4d34",
		brightGreen: "#638930",
		brightYellow: "#b38012",
		brightBlue: "#3777a6",
		brightMagenta: "#99538a",
		brightCyan: "#32857c",
		brightWhite: "#191613",
	};
	let host: HTMLDivElement;
	let terminal: Terminal | undefined;
	let fitAddon: FitAddon | undefined;
	let acceptingInput = false;
	let currentStatus: "starting" | "ready" | "exited" | "error" = "starting";
	let pendingInputQueue: string[] = [];

	function handleWorkspaceEvent(event: WorkspaceEvent): void {
		if (!("paneId" in event) || event.paneId !== paneId) return;
		if (event.type === "terminal-data") {
			terminal?.write(event.data);
			if (currentStatus !== "ready" && currentStatus !== "exited") {
				currentStatus = "ready";
				acceptingInput = true;
				onStatus("ready");
			}
		} else if (event.type === "terminal-exit") {
			acceptingInput = false;
			currentStatus = "exited";
			terminal?.writeln(`\r\n\x1b[38;2;151;142;132m[process exited ${event.exitCode}]\x1b[0m`);
			onStatus("exited");
		} else if (event.type === "terminal-error") {
			acceptingInput = false;
			currentStatus = "error";
			terminal?.writeln(`\r\n\x1b[38;2;214;112;82m[terminal error] ${event.message}\x1b[0m`);
			onStatus("error", event.message);
		}
	}

	function reportNonfatalError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		terminal?.writeln(`\r\n\x1b[38;2;214;112;82m[input error] ${message}\x1b[0m`);
	}

	$: if (active && terminal) {
		fitAddon?.fit();
		terminal.focus();
	}
	$: if (terminal && terminalSettings) {
		let fontChanged = false;
		if (terminal.options.fontSize !== terminalSettings.fontSize) {
			terminal.options.fontSize = terminalSettings.fontSize;
			fontChanged = true;
		}
		if (terminal.options.fontFamily !== terminalSettings.fontFamily) {
			terminal.options.fontFamily = terminalSettings.fontFamily;
			fontChanged = true;
		}
		if (terminal.options.cursorStyle !== terminalSettings.cursorStyle) {
			terminal.options.cursorStyle = terminalSettings.cursorStyle;
		}
		if (terminal.options.cursorBlink !== terminalSettings.cursorBlink) {
			terminal.options.cursorBlink = terminalSettings.cursorBlink;
		}
		if (terminal.options.scrollback !== terminalSettings.scrollback) {
			terminal.options.scrollback = terminalSettings.scrollback;
		}
		if (fontChanged) {
			fitAddon?.fit();
		}
	}
	$: if (terminal && theme) {
		terminal.options.theme = theme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
	}
	onMount(() => {
		let disposed = false;
		const unsubscribe = window.branchlight.onWorkspaceEvent(handleWorkspaceEvent);
		void (async () => {
			try {
				const [ghostty, state] = await Promise.all([
					ghosttyReady,
					window.branchlight.createTerminal({
						id: paneId,
						tabId,
						workspaceId,
						cols: 100,
						rows: 30,
					}),
				]);
				if (disposed) return;

				const instance = new Terminal({
					cols: 100,
					rows: 30,
					cursorBlink: terminalSettings?.cursorBlink ?? true,
					cursorStyle: terminalSettings?.cursorStyle ?? "bar",
					fontSize: terminalSettings?.fontSize ?? 14,
					fontFamily: terminalSettings?.fontFamily || '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
					scrollback: terminalSettings?.scrollback ?? 10_000,
					smoothScrollDuration: 120,
					ghostty,
					theme: theme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME,
				});
				terminal = instance;
				const fit = new FitAddon();
				fitAddon = fit;
				instance.loadAddon(fit);
				instance.open(host);
				fit.fit();
				fit.observeResize();

				instance.onData(data => {
					if (acceptingInput) {
						void window.branchlight.writeTerminal(paneId, data).catch(reportNonfatalError);
					} else {
						pendingInputQueue.push(data);
					}
				});
				instance.onResize(({ cols, rows }) => {
					const safeC = Math.max(2, Math.min(500, cols));
					const safeR = Math.max(2, Math.min(500, rows));
					if (safeC >= 2 && safeC <= 500 && safeR >= 2 && safeR <= 500) {
						void window.branchlight.resizeTerminal(paneId, safeC, safeR).catch(() => {});
					}
				});
				instance.onTitleChange(title => {
					const clean = title.trim().slice(0, 120);
					if (clean) onTitle(clean);
				});

				onReady(state.cwd);
				acceptingInput = true;
				currentStatus = "ready";
				onStatus("ready");

				if (pendingInputQueue.length > 0) {
					const buffered = pendingInputQueue.join("");
					pendingInputQueue = [];
					void window.branchlight.writeTerminal(paneId, buffered).catch(reportNonfatalError);
				}

				if (active) {
					fit.fit();
					instance.focus();
				}
			} catch (error) {
				currentStatus = "error";
				acceptingInput = false;
				onStatus("error", error instanceof Error ? error.message : String(error));
			}
		})();
		return () => {
			disposed = true;
			acceptingInput = false;
			unsubscribe();
			terminal?.dispose();
			terminal = undefined;
		};
	});
</script>

<div
	bind:this={host}
	class="terminal-surface"
	class:is-active={active}
	role="application"
	aria-label="Terminal"
	onpointerdown={() => {
		onActivate();
		terminal?.focus();
	}}
></div>
