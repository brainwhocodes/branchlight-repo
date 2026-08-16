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
	import Target from "@solar-icons/svelte/linear/target";
	import type { BranchlightSettings, BrowserNavigationAction, BrowserViewState } from "../../shared/contracts";
	import type {
		ElementSelectionState,
		SelectionCaptureMode,
		WorkspaceAgent,
		WorkspaceLayout,
		WorkspacePane,
	} from "../workspace-types";
	import BrowserSurface from "./BrowserSurface.svelte";
	import TerminalSurface from "./TerminalSurface.svelte";

	export let pane: WorkspacePane;
	export let workspaceId: string = "ws_main";
	export let tabId: string = "tab_main";
	export let browserState: BrowserViewState | undefined;
	export let tabActive: boolean;
	export let focused: boolean;
	export let canSplit: boolean;
	export let deliverableAgents: WorkspaceAgent[] = [];
	export let selectionState: ElementSelectionState | undefined = undefined;
	export let attachedAgent: WorkspaceAgent | undefined = undefined;
	export let terminalSettings: BranchlightSettings["terminal"] | undefined = undefined;
	export let theme: "dark" | "light" | undefined = undefined;
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
	export let onToggleSelection: (() => void) | undefined = undefined;
	export let onCancelSelection: (() => void) | undefined = undefined;
	export let onCommitSelection: (() => void) | undefined = undefined;
	export let onResetSelection: (() => void) | undefined = undefined;
	export let onChangeCaptureMode: ((mode: SelectionCaptureMode) => void) | undefined = undefined;
	export let onSelectRecipientAgent: ((agentId: string) => void) | undefined = undefined;

	let addressFocused = false;
	let addressDraft = pane.url ?? "https://omp.sh";
	let selectedAgentId = "";
	let captureMode: SelectionCaptureMode = "dom";

	$: activeAgent = attachedAgent ?? pane.agent;
	$: title = pane.kind === "browser"
		? browserState?.title || pane.title
		: activeAgent
			? activeAgent.name || pane.title
			: pane.title;
	$: detail = pane.kind === "browser"
		? pane.status === "error" || browserState?.error
			? "Error"
			: browserState?.loading
				? "Loading"
				: pane.status === "starting"
					? "Starting"
					: pane.status === "exited"
						? "Closed"
						: "Browser"
		: pane.status === "error"
			? "Error"
			: activeAgent
				? (activeAgent.status ? activeAgent.status.charAt(0).toUpperCase() + activeAgent.status.slice(1) : "Agent")
				: pane.status === "starting"
					? "Starting"
					: pane.status === "exited"
						? "Exited"
						: "Terminal";
	$: activeSelection = selectionState ?? pane.selectionState;
	$: isSelecting = Boolean(activeSelection && activeSelection.phase !== "idle");
	$: deliverableList = deliverableAgents ?? [];
	$: hasDeliverableAgents = deliverableList.length > 0;
	$: captureMode = activeSelection?.captureMode ?? "dom";
	$: selectedAgentId = activeSelection?.agentId ?? deliverableList[0]?.id ?? "";
	$: currentRecipient = deliverableList.find(a => a.id === selectedAgentId) ?? deliverableList[0];
	$: targetTooltip = !hasDeliverableAgents
		? "No deliverable agent available in this workspace"
		: isSelecting
			? "Cancel element selection"
			: "Select page element for agent";

	$: targetAriaLabel = !hasDeliverableAgents
		? "Element selection unavailable: no deliverable agent in active workspace"
		: isSelecting
			? "Cancel element selection"
			: "Select page element for agent";

	function navigate(): void {
		addressFocused = false;
		onBrowserNavigate(addressDraft);
	}

	function showPaneContextMenu(event: MouseEvent): void {
		event.preventDefault();
		onActivate();
		window.branchlight.showPaneContextMenu(pane.id, canSplit);
	}

	function handleTargetClick(): void {
		if (isSelecting) {
			onCancelSelection?.();
		} else {
			onToggleSelection?.();
		}
	}

	function handleRecipientChange(agentId: string): void {
		selectedAgentId = agentId;
		onSelectRecipientAgent?.(agentId);
	}

	function handleCaptureModeChange(mode: SelectionCaptureMode): void {
		captureMode = mode;
		onChangeCaptureMode?.(mode);
	}
</script>

<section
	class="workspace-pane"
	class:is-focused={focused}
	class:is-browser={pane.kind === "browser"}
	class:is-selecting={isSelecting}
	data-pane-id={pane.id}
	aria-label={`${pane.kind} pane`}
	oncontextmenu={showPaneContextMenu}
>
	<header class="pane-header" role="group" aria-label={`${pane.kind} pane controls`} onpointerdown={onActivate}>
		<div class="pane-heading">
			<span class="pane-kind-icon" aria-hidden="true">
				{#if pane.kind === "browser"}
					<Global size={16} />
				{:else if activeAgent}
					<span
						class="agent-swatch"
						style={`background-color: ${activeAgent.swatch}`}
						aria-hidden="true"
					></span>
				{:else}
					<Code size={16} />
				{/if}
			</span>
			<strong title={title}>{title}</strong>
			{#if activeAgent}
				<span class="agent-role-pill">{activeAgent.agent}</span>
			{/if}
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
			<button
				type="button"
				class="chrome-button target-button"
				class:is-active={isSelecting}
				disabled={!hasDeliverableAgents}
				title={targetTooltip}
				aria-label={targetAriaLabel}
				onclick={handleTargetClick}
			>
				<Target size={16} aria-hidden="true" />
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

		{#if activeSelection && activeSelection.phase !== "idle"}
			<div
				class="element-selection-bar"
				role="region"
				aria-label="Element selection in progress"
				data-phase={activeSelection.phase}
			>
				<div class="selection-indicator">
					<span class="selection-pulse" aria-hidden="true"></span>
					<span class="selection-phase-badge">{activeSelection.phase}</span>
					<span class="selection-control-notice" title="Mars is controlling this browser">Mars is controlling this browser</span>
				</div>

				<!-- Recipient agent -->
				<div class="selection-recipient">
					<span class="selection-label">Target:</span>
					{#if deliverableList.length > 1 && activeSelection.phase === "picking"}
						<select
							class="recipient-select"
							aria-label="Select target agent"
							value={selectedAgentId}
							onchange={(e) => handleRecipientChange(e.currentTarget.value)}
						>
							{#each deliverableList as agent (agent.id)}
								<option value={agent.id}>{agent.name} ({agent.agent})</option>
							{/each}
						</select>
					{:else}
						<div class="recipient-pill">
							<span
								class="agent-swatch"
								style={`background-color: ${currentRecipient?.swatch ?? '#6948ff'}`}
								aria-hidden="true"
							></span>
							<span class="agent-name">{currentRecipient?.name ?? activeSelection.agentName ?? activeSelection.agentId ?? "Active Agent"}</span>
						</div>
					{/if}
				</div>

				<!-- Capture mode radios (DOM vs Screenshot) -->
				<div class="capture-mode-radios" role="radiogroup" aria-label="Capture mode">
					<label class="capture-mode-option" class:is-selected={captureMode === "dom"}>
						<input
							type="radio"
							name={`capture-mode-${pane.id}`}
							value="dom"
							checked={captureMode === "dom"}
							disabled={activeSelection.phase !== "picking"}
							onchange={() => handleCaptureModeChange("dom")}
						/>
						<span>DOM</span>
					</label>
					<label class="capture-mode-option" class:is-selected={captureMode === "screenshot"}>
						<input
							type="radio"
							name={`capture-mode-${pane.id}`}
							value="screenshot"
							checked={captureMode === "screenshot"}
							disabled={activeSelection.phase !== "picking"}
							onchange={() => handleCaptureModeChange("screenshot")}
						/>
						<span>Screenshot</span>
					</label>
				</div>

				<!-- Hint text -->
				<div class="selection-hint" role="status" aria-live="polite">
					{#if activeSelection.phase === "picking"}
						<span class="hint-text">Click element on page to target for {currentRecipient?.name ?? "agent"}. Esc to cancel.</span>
					{:else if activeSelection.phase === "selected"}
						<span class="hint-text selected">
							Targeted: <code>{activeSelection.selector || activeSelection.elementLabel || activeSelection.tagName || "element"}</code>
						</span>
					{:else if activeSelection.phase === "sending" || activeSelection.phase === "working"}
						<span class="hint-text working">
							<span class="selection-spinner" aria-hidden="true"></span>
							<span>{activeSelection.workingMessage || "Agent is processing element..."}</span>
						</span>
					{:else if activeSelection.phase === "ready" || activeSelection.phase === "preview"}
						<span class="hint-text ready">
							Element changes ready to review.
						</span>
					{:else if activeSelection.phase === "error"}
						<span class="hint-text error">
							{activeSelection.error || "Element selection failed."}
						</span>
					{/if}
				</div>

				<!-- Actions -->
				<div class="selection-actions">
					{#if activeSelection.phase === "selected"}
						<button
							type="button"
							class="selection-btn btn-commit"
							onclick={() => onCommitSelection?.()}
						>
							Send to Agent
						</button>
					{/if}
					{#if activeSelection.phase === "ready" || activeSelection.phase === "preview"}
						<button
							type="button"
							class="selection-btn btn-done"
							onclick={() => onResetSelection?.()}
						>
							Done
						</button>
					{/if}
					{#if activeSelection.phase === "error"}
						<button
							type="button"
							class="selection-btn btn-retry"
							onclick={() => onToggleSelection?.()}
						>
							Retry
						</button>
					{/if}
					<button
						type="button"
						class="selection-btn btn-cancel"
						aria-label="Cancel selection"
						onclick={() => onCancelSelection?.()}
					>
						<CloseCircle size={14} aria-hidden="true" />
						<span>Cancel</span>
					</button>
				</div>
			</div>
		{/if}
	{/if}
	<div class="pane-surface">
		{#if pane.kind === "browser"}
			<BrowserSurface
				paneId={pane.id}
				url={pane.url ?? "https://omp.sh"}
				workspaceId={pane.workspaceId ?? workspaceId}
				tabId={pane.tabId ?? tabId}
				active={tabActive}
				onCreated={onBrowserCreated}
				onError={onBrowserError}
			/>
		{:else}
			<TerminalSurface
				paneId={pane.id}
				workspaceId={pane.workspaceId ?? workspaceId}
				tabId={pane.tabId ?? tabId}
				active={tabActive}
				terminalSettings={terminalSettings}
				theme={theme}
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
