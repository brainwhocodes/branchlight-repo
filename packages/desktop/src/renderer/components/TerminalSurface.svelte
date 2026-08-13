<script context="module" lang="ts">
	import ghosttyWasmUrl from "ghostty-web/ghostty-vt.wasm?url";
	import { Ghostty } from "ghostty-web";

	const ghosttyReady = Ghostty.load(ghosttyWasmUrl);
</script>

<script lang="ts">
	import { onMount } from "svelte";
	import { FitAddon, Terminal } from "ghostty-web";
	import type { WorkspaceEvent } from "../../shared/contracts";

	export let paneId: string;
	export let active: boolean;
	export let onActivate: () => void;
	export let onReady: (cwd: string) => void;
	export let onStatus: (status: "starting" | "ready" | "exited" | "error", message?: string) => void;
	export let onTitle: (title: string) => void;

	let host: HTMLDivElement;
	let terminal: Terminal | undefined;
	let acceptingInput = false;

	function handleWorkspaceEvent(event: WorkspaceEvent): void {
		if (event.paneId !== paneId) return;
		if (event.type === "terminal-data") terminal?.write(event.data);
		else if (event.type === "terminal-exit") {
			acceptingInput = false;
			terminal?.writeln(`\r\n\x1b[38;2;151;142;132m[process exited ${event.exitCode}]\x1b[0m`);
			onStatus("exited");
		} else if (event.type === "terminal-error") {
			acceptingInput = false;
			terminal?.writeln(`\r\n\x1b[38;2;214;112;82m[terminal error] ${event.message}\x1b[0m`);
			onStatus("error", event.message);
		}
	}

	function reportTerminalError(error: unknown): void {
		acceptingInput = false;
		onStatus("error", error instanceof Error ? error.message : String(error));
	}

	$: if (active && terminal) terminal.focus();
	onMount(() => {
		let disposed = false;
		const unsubscribe = window.branchlight.onWorkspaceEvent(handleWorkspaceEvent);
		onStatus("starting");
		void (async () => {
			try {
				const ghostty = await ghosttyReady;
				if (disposed) return;
				const instance = new Terminal({
					cols: 100,
					rows: 30,
					cursorBlink: true,
					cursorStyle: "bar",
					fontSize: 14,
					fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
					scrollback: 10_000,
					smoothScrollDuration: 120,
					ghostty,
					theme: {
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
					},
				});
				terminal = instance;
				const fit = new FitAddon();
				instance.loadAddon(fit);
				instance.open(host);
				fit.fit();
				fit.observeResize();
				instance.onData(data => {
					if (acceptingInput) void window.branchlight.writeTerminal(paneId, data).catch(reportTerminalError);
				});
				instance.onResize(({ cols, rows }) => void window.branchlight.resizeTerminal(paneId, cols, rows));
				instance.onTitleChange(title => {
					const clean = title.trim().slice(0, 120);
					if (clean) onTitle(clean);
				});
				const state = await window.branchlight.createTerminal(paneId, instance.cols, instance.rows);
				if (disposed) {
					void window.branchlight.closeTerminal(paneId);
					return;
				}
				onReady(state.cwd);
				acceptingInput = true;
				onStatus("ready");
				if (active) instance.focus();
			} catch (error) {
				onStatus("error", error instanceof Error ? error.message : String(error));
			}
		})();
		return () => {
			disposed = true;
			acceptingInput = false;
			unsubscribe();
			terminal?.dispose();
			terminal = undefined;
			void window.branchlight.closeTerminal(paneId);
		};
	});
</script>

<div
	bind:this={host}
	class="terminal-surface"
	class:is-active={active}
	role="application"
	aria-label="Terminal"
	onpointerdown={onActivate}
></div>
