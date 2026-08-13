<script lang="ts">
	import AltArrowLeft from "@solar-icons/svelte/linear/alt-arrow-left";
	import AltArrowRight from "@solar-icons/svelte/linear/alt-arrow-right";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import Code from "@solar-icons/svelte/linear/code";
	import Global from "@solar-icons/svelte/linear/global";
	import Lock from "@solar-icons/svelte/linear/lock";
	import Refresh from "@solar-icons/svelte/linear/refresh";
	import Sidebar from "@solar-icons/svelte/linear/sidebar";
	import Stop from "@solar-icons/svelte/linear/stop";
	import type { BrowserNavigationAction, BrowserViewState } from "../../shared/contracts";
	import type { WorkspaceLayout, WorkspacePane } from "../workspace-types";
	import BrowserSurface from "./BrowserSurface.svelte";
	import TerminalSurface from "./TerminalSurface.svelte";

	export let pane: WorkspacePane;
	export let browserState: BrowserViewState | undefined;
	export let tabActive: boolean;
	export let focused: boolean;
	export let canSplit: boolean;
	export let onActivate: () => void;
	export let onBrowserCreated: (state: BrowserViewState) => void;
	export let onBrowserError: (message: string) => void;
	export let onBrowserNavigate: (url: string) => void;
	export let onBrowserControl: (action: BrowserNavigationAction) => void;
	export let onTerminalReady: (cwd: string) => void;
	export let onTerminalStatus: (status: "starting" | "ready" | "exited" | "error", message?: string) => void;
	export let onTerminalTitle: (title: string) => void;
	export let onSplit: (layout: WorkspaceLayout) => void;
	export let onClose: () => void;

	let addressFocused = false;
	let addressDraft = pane.url ?? "https://omp.sh";
	$: title = pane.kind === "browser" ? browserState?.title || pane.title : pane.title;
	$: if (!addressFocused && browserState?.url && addressDraft !== browserState.url) addressDraft = browserState.url;
	$: detail = pane.kind === "browser"
		? browserState?.loading
			? "Loading"
			: browserState?.error
				? "Unavailable"
				: "Browser"
		: pane.status === "starting"
			? "Starting"
			: pane.status === "error"
				? "Error"
				: pane.status === "exited"
					? "Exited"
					: "Terminal";

	function navigate(): void {
		addressFocused = false;
		onBrowserNavigate(addressDraft);
	}
</script>

<section
	class="workspace-pane"
	class:is-focused={focused}
	class:is-browser={pane.kind === "browser"}
	data-pane-id={pane.id}
	aria-label={`${pane.kind} pane`}
>
	<header class="pane-header" role="group" aria-label={`${pane.kind} pane controls`} onpointerdown={onActivate}>
		<div class="pane-heading">
			<span class="pane-kind-icon" aria-hidden="true">
				{#if pane.kind === "browser"}<Global size={16} />{:else}<Code size={16} />{/if}
			</span>
			<strong title={title}>{title}</strong>
			<span class="pane-detail" class:is-error={detail === "Error" || detail === "Unavailable"}>{detail}</span>
		</div>
		<div class="pane-actions">
			<button class="chrome-button" type="button" disabled={!canSplit} aria-label={`Split ${pane.kind} right`} onclick={(event) => { event.stopPropagation(); onSplit("columns"); }}>
				<Sidebar size={16} aria-hidden="true" />
			</button>
			<button class="chrome-button split-below" type="button" disabled={!canSplit} aria-label={`Split ${pane.kind} below`} onclick={(event) => { event.stopPropagation(); onSplit("rows"); }}>
				<Sidebar size={16} aria-hidden="true" />
			</button>
			<button class="chrome-button" type="button" aria-label={`Close ${pane.kind} pane`} onclick={(event) => { event.stopPropagation(); onClose(); }}>
				<CloseCircle size={16} aria-hidden="true" />
			</button>
		</div>
	</header>
	{#if pane.kind === "browser"}
		<form class="browser-bar" aria-label="Browser address bar" onsubmit={(event) => { event.preventDefault(); navigate(); }}>
			<button type="button" class="chrome-button" aria-label="Back" disabled={!browserState?.canGoBack} onclick={() => onBrowserControl("back")}>
				<AltArrowLeft size={17} aria-hidden="true" />
			</button>
			<button type="button" class="chrome-button" aria-label="Forward" disabled={!browserState?.canGoForward} onclick={() => onBrowserControl("forward")}>
				<AltArrowRight size={17} aria-hidden="true" />
			</button>
			<button
				type="button"
				class="chrome-button"
				aria-label={browserState?.loading ? "Stop loading" : "Reload"}
				onclick={() => onBrowserControl(browserState?.loading ? "stop" : "reload")}
			>
				{#if browserState?.loading}<Stop size={15} aria-hidden="true" />{:else}<Refresh size={16} aria-hidden="true" />{/if}
			</button>
			<label class="address-field">
				<span class="address-lock" aria-hidden="true"><Lock size={14} /></span>
				<span class="sr-only">Address</span>
				<input
					aria-label="Address"
					spellcheck="false"
					autocomplete="off"
					bind:value={addressDraft}
					onfocus={() => { addressFocused = true; }}
					onblur={() => { addressFocused = false; }}
				/>
			</label>
		</form>
	{/if}
	<div class="pane-surface">
		{#if pane.kind === "browser"}
			<BrowserSurface
				paneId={pane.id}
				url={pane.url ?? "https://omp.sh"}
				active={tabActive}
				onCreated={onBrowserCreated}
				onError={onBrowserError}
			/>
		{:else}
			<TerminalSurface
				paneId={pane.id}
				active={tabActive && focused}
				onActivate={onActivate}
				onReady={onTerminalReady}
				onStatus={onTerminalStatus}
				onTitle={onTerminalTitle}
			/>
			{#if pane.status === "error"}
				<div class="terminal-failure" role="alert">
					<strong>Terminal unavailable</strong>
					<span>{pane.error ?? "The terminal process could not start."}</span>
				</div>
			{/if}
		{/if}
	</div>
</section>
