<script lang="ts">
	import AddSquare from "@solar-icons/svelte/linear/add-square";
	import AltArrowLeft from "@solar-icons/svelte/linear/alt-arrow-left";
	import AltArrowRight from "@solar-icons/svelte/linear/alt-arrow-right";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import Global from "@solar-icons/svelte/linear/global";
	import MaximizeSquare from "@solar-icons/svelte/linear/maximize-square";
	import Minimize from "@solar-icons/svelte/linear/minimize";
	import Refresh from "@solar-icons/svelte/linear/refresh";
	import Stop from "@solar-icons/svelte/linear/stop";
	import { onMount, tick } from "svelte";
	import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
	import type {
		BranchlightSettings,
		BrowserNavigationAction,
		BrowserViewState,
		WorkspaceEvent,
	} from "../shared/contracts";
	import BranchMark from "./components/BranchMark.svelte";
	import BrowserSurface from "./components/BrowserSurface.svelte";
	import OmpChat from "./OmpChat.svelte";
	import { projectWorkspaceTabs } from "./workspace-projection";
	import type { WorkspaceLayout, WorkspacePane, WorkspaceTab } from "./workspace-types";

	const CHAT_TAB_ID = "omp-chat";
	const DEFAULT_BROWSER_URL = "https://omp.sh";
	const MAX_BROWSER_PANES = 4;

	function id(prefix: string): string {
		return `${prefix}-${crypto.randomUUID()}`;
	}

	let browserTabs: WorkspaceTab[] = [];
	let activeTabId = CHAT_TAB_ID;
	let activeWorkspaceId = "";
	let browserStates = new Map<string, BrowserViewState>();
	let appSettings: BranchlightSettings | undefined;
	let notice = "";
	let errorMessage = "";
	let hydrated = false;
	let maximized = false;
	let migrationRunning = false;
	let retiredTerminalTabs = new Set<string>();
	let unsubscribeWorkspace: (() => void) | undefined;
	let unsubscribeWorkspaceDocument: (() => void) | undefined;

	$: activeBrowserTab = browserTabs.find(tab => tab.id === activeTabId);
	$: activeBrowserPane = activeBrowserTab?.panes.find(pane => pane.id === activeBrowserTab.activePaneId)
		?? activeBrowserTab?.panes[0];
	$: activeTitle = activeTabId === CHAT_TAB_ID
		? "OMP Chat"
		: activeBrowserTab?.title || activeBrowserPane?.title || "Browser";
	$: documentTitle = `${activeTitle} · Mars Kommander`;

	onMount(() => {
		unsubscribeWorkspace = window.branchlight.onWorkspaceEvent(handleWorkspaceEvent);
		unsubscribeWorkspaceDocument = window.branchlight.onWorkspaceDocument(document => {
			void applyWorkspaceDocument(document);
		});

		const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
		const handleMediaChange = (): void => {
			if (appSettings?.theme === "system") applyTheme("system");
		};
		mediaQuery?.addEventListener?.("change", handleMediaChange);

		void (async () => {
			try {
				const [settings, document] = await Promise.all([
					window.branchlight.getAppSettings(),
					window.branchlight.getWorkspaceDocument(),
				]);
				appSettings = settings;
				applyTheme(settings.theme);
				if (!document) throw new Error("Workspace runtime returned no document");
				await applyWorkspaceDocument(document);
			} catch (error) {
				showError(error);
			}
		})();

		return () => {
			unsubscribeWorkspace?.();
			unsubscribeWorkspaceDocument?.();
			mediaQuery?.removeEventListener?.("change", handleMediaChange);
		};
	});

	function applyTheme(theme: BranchlightSettings["theme"]): void {
		const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
		document.documentElement.dataset.theme = theme === "system" ? systemTheme : theme;
	}

	async function applyWorkspaceDocument(document: WorkspaceDocumentV1): Promise<void> {
		const projection = projectWorkspaceTabs(document, activeWorkspaceId || undefined, activeTabId);
		activeWorkspaceId = projection.workspaceId;
		browserTabs = projection.tabs.filter(tab => tab.kind === "browser");
		hydrated = true;

		if (activeTabId !== CHAT_TAB_ID && !browserTabs.some(tab => tab.id === activeTabId)) {
			activeTabId = CHAT_TAB_ID;
		}

		await retireLegacyTerminalTabs(document);
		await syncVisibleBrowsers();
	}

	async function retireLegacyTerminalTabs(document: WorkspaceDocumentV1): Promise<void> {
		if (migrationRunning) return;
		const legacyTabs = document.tabs.filter(
			tab => tab.paneKind === "terminal" && !retiredTerminalTabs.has(tab.id),
		);
		if (legacyTabs.length === 0) return;

		migrationRunning = true;
		try {
			for (const tab of legacyTabs) {
				retiredTerminalTabs.add(tab.id);
				await window.branchlight.closeTab(tab.id);
			}
			showNotice(
				legacyTabs.length === 1
					? "The legacy terminal tab was retired. OMP Chat is now the coding surface."
					: `${legacyTabs.length} legacy terminal tabs were retired. OMP Chat is now the coding surface.`,
			);
		} catch (error) {
			for (const tab of legacyTabs) retiredTerminalTabs.delete(tab.id);
			showError(error);
		} finally {
			migrationRunning = false;
		}
	}

	function activateChat(): void {
		activeTabId = CHAT_TAB_ID;
		void syncVisibleBrowsers();
	}

	function activateBrowser(tabId: string): void {
		if (!browserTabs.some(tab => tab.id === tabId)) return;
		activeTabId = tabId;
		void syncVisibleBrowsers();
	}

	async function addBrowserTab(url?: string): Promise<void> {
		if (!hydrated || !activeWorkspaceId) {
			showNotice("Workspace is still loading");
			return;
		}
		const tabId = id("tab-browser");
		const paneId = id("browser");
		activeTabId = tabId;
		try {
			await window.branchlight.createBrowser({
				id: paneId,
				tabId,
				workspaceId: activeWorkspaceId,
				url: url ?? appSettings?.browser.defaultUrl ?? DEFAULT_BROWSER_URL,
			});
		} catch (error) {
			activeTabId = CHAT_TAB_ID;
			showError(error);
		}
	}

	async function splitBrowser(tab: WorkspaceTab, sourcePaneId: string, layout: WorkspaceLayout): Promise<void> {
		if (!activeWorkspaceId || tab.panes.length >= MAX_BROWSER_PANES) return;
		if (!tab.panes.some(pane => pane.id === sourcePaneId)) return;
		const paneId = id("browser");
		const requestedLayout = tab.panes.length + 1 > 2 ? "grid" : layout;
		try {
			await window.branchlight.createBrowser({
				id: paneId,
				tabId: tab.id,
				workspaceId: activeWorkspaceId,
				url: appSettings?.browser.defaultUrl ?? DEFAULT_BROWSER_URL,
				layout: requestedLayout,
			});
		} catch (error) {
			showError(error);
		}
	}

	async function closeBrowserTab(tabId: string): Promise<void> {
		const tab = browserTabs.find(item => item.id === tabId);
		if (!tab) return;
		if (appSettings?.confirmCloseTab && !window.confirm(`Close tab “${tab.title || "Browser"}”?`)) return;
		try {
			await window.branchlight.closeTab(tabId);
			for (const pane of tab.panes) browserStates.delete(pane.id);
			browserStates = new Map(browserStates);
			if (activeTabId === tabId) activeTabId = CHAT_TAB_ID;
			await syncVisibleBrowsers();
		} catch (error) {
			showError(error);
		}
	}

	async function closeBrowserPane(tab: WorkspaceTab, paneId: string): Promise<void> {
		if (tab.panes.length === 1) {
			await closeBrowserTab(tab.id);
			return;
		}
		try {
			await window.branchlight.closePane(paneId);
			browserStates.delete(paneId);
			browserStates = new Map(browserStates);
		} catch (error) {
			showError(error);
		}
	}

	function activatePane(tab: WorkspaceTab, paneId: string): void {
		activeTabId = tab.id;
		void window.branchlight.updateTab(tab.id, { activePaneId: paneId }).catch(showError);
		void syncVisibleBrowsers();
	}

	function browserCreated(pane: WorkspacePane, state: BrowserViewState): void {
		browserStates.set(pane.id, state);
		browserStates = new Map(browserStates);
	}

	function updateBrowserState(paneId: string, state: BrowserViewState): void {
		browserStates.set(paneId, state);
		browserStates = new Map(browserStates);
	}

	async function navigateBrowser(paneId: string, address: string): Promise<void> {
		try {
			updateBrowserState(paneId, await window.branchlight.navigateBrowser(paneId, address));
		} catch (error) {
			showError(error);
		}
	}

	function controlBrowser(paneId: string, action: BrowserNavigationAction): void {
		void window.branchlight.controlBrowser(paneId, action).catch(showError);
	}

	async function syncVisibleBrowsers(): Promise<void> {
		await tick();
		const tab = browserTabs.find(item => item.id === activeTabId);
		await window.branchlight.setVisibleBrowsers(tab?.panes.map(pane => pane.id) ?? []);
	}

	function handleWorkspaceEvent(event: WorkspaceEvent): void {
		if (event.type === "browser-state") updateBrowserState(event.paneId, event.state);
		else if (event.type === "browser-focus") {
			const tab = browserTabs.find(item => item.panes.some(pane => pane.id === event.paneId));
			if (tab) activatePane(tab, event.paneId);
		} else if (event.type === "browser-new-window") {
			void addBrowserTab(event.url);
		} else if (event.type === "connection-state" && event.state !== "connected") {
			showNotice(event.state === "reconnecting" ? "Reconnecting to the workspace runtime…" : "Workspace runtime disconnected");
		}
	}

	function layoutClass(tab: WorkspaceTab): string {
		if (tab.panes.length <= 1) return "single";
		if (tab.panes.length >= 3 || tab.layout === "grid") return "grid";
		return tab.layout;
	}

	function showNotice(message: string): void {
		notice = message;
		window.setTimeout(() => {
			if (notice === message) notice = "";
		}, 5_000);
	}

	function showError(error: unknown): void {
		errorMessage = error instanceof Error ? error.message : String(error);
		window.setTimeout(() => {
			if (errorMessage === (error instanceof Error ? error.message : String(error))) errorMessage = "";
		}, 7_000);
	}

	function minimizeWindow(): void {
		void window.branchlight.minimizeWindow().catch(showError);
	}

	async function toggleMaximizeWindow(): Promise<void> {
		try {
			maximized = await window.branchlight.toggleMaximizeWindow();
		} catch (error) {
			showError(error);
		}
	}

	function closeWindow(): void {
		void window.branchlight.closeWindow().catch(showError);
	}

	function handleKeyboard(event: KeyboardEvent): void {
		if (!event.ctrlKey || event.altKey || event.metaKey) return;
		if (event.key.toLowerCase() === "t") {
			event.preventDefault();
			void addBrowserTab();
		} else if (event.key.toLowerCase() === "w" && activeBrowserTab) {
			event.preventDefault();
			void closeBrowserTab(activeBrowserTab.id);
		}
	}
</script>

<svelte:head><title>{documentTitle}</title></svelte:head>
<svelte:window onkeydown={handleKeyboard} />

<div class="workspace-app">
	<header class="shell-titlebar" aria-label="Window bar">
		<div class="shell-brand window-drag" aria-label="Mars Kommander">
			<BranchMark size={21} />
			<strong>Mars Kommander</strong>
			<span>OMP workspace</span>
		</div>
		<div class="window-controls">
			<button type="button" aria-label="Minimize" title="Minimize" onclick={minimizeWindow}><Minimize size={15} /></button>
			<button type="button" aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"} onclick={() => void toggleMaximizeWindow()}><MaximizeSquare size={15} /></button>
			<button type="button" class="close-window" aria-label="Close" title="Close" onclick={closeWindow}><CloseCircle size={16} /></button>
		</div>
	</header>

	<div class="tab-strip">
		<nav class="workspace-tabs" role="tablist" aria-label="Workspace tabs">
			<button
				type="button"
				class="workspace-tab chat-tab-button"
				class:is-active={activeTabId === CHAT_TAB_ID}
				role="tab"
				aria-selected={activeTabId === CHAT_TAB_ID}
				onclick={activateChat}
			>
				<span class="chat-glyph" aria-hidden="true">✦</span>
				<span>OMP Chat</span>
				<span class="runtime-pill">native</span>
			</button>
			{#each browserTabs as tab (tab.id)}
				<div
					class="workspace-tab browser-tab"
					class:is-active={activeTabId === tab.id}
					role="tab"
					tabindex="0"
					aria-selected={activeTabId === tab.id}
					onclick={() => activateBrowser(tab.id)}
					onkeydown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							activateBrowser(tab.id);
						}
					}}
				>
					<Global size={15} aria-hidden="true" />
					<span class="tab-title">{tab.title || tab.panes[0]?.title || "Browser"}</span>
					<button
						type="button"
						class="tab-close"
						aria-label={`Close ${tab.title || "browser"}`}
						onclick={(event) => { event.stopPropagation(); void closeBrowserTab(tab.id); }}
					>×</button>
				</div>
			{/each}
		</nav>
		<button type="button" class="new-browser" aria-label="Open browser tab" title="Open browser tab (Ctrl+T)" disabled={!hydrated} onclick={() => void addBrowserTab()}>
			<AddSquare size={18} aria-hidden="true" />
		</button>
	</div>

	<main class="workspace-stage">
		<section class="chat-stage" class:is-active={activeTabId === CHAT_TAB_ID} aria-hidden={activeTabId !== CHAT_TAB_ID}>
			<OmpChat />
		</section>

		{#each browserTabs as tab (tab.id)}
			<section
				class="browser-tab-stage"
				class:is-active={activeTabId === tab.id}
				aria-hidden={activeTabId !== tab.id}
			>
				<div class={`browser-pane-grid ${layoutClass(tab)}`} style={tab.panes.length === 2 && tab.layout === "columns" ? `grid-template-columns: ${tab.ratio}% ${100 - tab.ratio}%` : tab.panes.length === 2 && tab.layout === "rows" ? `grid-template-rows: ${tab.ratio}% ${100 - tab.ratio}%` : ""}>
					{#each tab.panes as pane (pane.id)}
						{@const state = browserStates.get(pane.id)}
						<div class="browser-pane" class:is-focused={tab.activePaneId === pane.id} role="group" aria-label="Browser pane" onpointerdown={() => activatePane(tab, pane.id)}>
							<header class="browser-toolbar">
								<div class="browser-controls">
									<button type="button" aria-label="Back" disabled={!state?.canGoBack} onclick={() => controlBrowser(pane.id, "back")}><AltArrowLeft size={16} /></button>
									<button type="button" aria-label="Forward" disabled={!state?.canGoForward} onclick={() => controlBrowser(pane.id, "forward")}><AltArrowRight size={16} /></button>
									<button type="button" aria-label={state?.loading ? "Stop loading" : "Reload"} onclick={() => controlBrowser(pane.id, state?.loading ? "stop" : "reload")}>{#if state?.loading}<Stop size={14} />{:else}<Refresh size={15} />{/if}</button>
								</div>
								<form class="address-form" onsubmit={(event) => {
									event.preventDefault();
									const data = new FormData(event.currentTarget as HTMLFormElement);
									void navigateBrowser(pane.id, String(data.get("address") ?? ""));
								}}>
									<Global size={14} aria-hidden="true" />
									<input name="address" aria-label="Address" value={state?.url ?? pane.url ?? DEFAULT_BROWSER_URL} autocomplete="off" spellcheck="false" />
								</form>
								<div class="browser-pane-actions">
									<button type="button" title="Split right" aria-label="Split browser right" disabled={tab.panes.length >= MAX_BROWSER_PANES} onclick={() => void splitBrowser(tab, pane.id, "columns")}>↔</button>
									<button type="button" title="Split below" aria-label="Split browser below" disabled={tab.panes.length >= MAX_BROWSER_PANES} onclick={() => void splitBrowser(tab, pane.id, "rows")}>↕</button>
									<button type="button" title="Close pane" aria-label="Close browser pane" onclick={() => void closeBrowserPane(tab, pane.id)}>×</button>
								</div>
							</header>
							<div class="browser-surface-host">
								<BrowserSurface
									paneId={pane.id}
									url={pane.url ?? DEFAULT_BROWSER_URL}
									workspaceId={activeWorkspaceId}
									tabId={tab.id}
									active={activeTabId === tab.id}
									onCreated={(browserState) => browserCreated(pane, browserState)}
									onError={(message) => showError(message)}
								/>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/each}

		{#if !hydrated}
			<div class="workspace-loading" role="status"><span></span>Connecting to the workspace runtime…</div>
		{/if}
	</main>

	{#if notice}<div class="toast notice" role="status">{notice}</div>{/if}
	{#if errorMessage}<div class="toast error" role="alert">{errorMessage}</div>{/if}
</div>

<style>
	.workspace-app {
		display: grid;
		grid-template-rows: 34px 46px minmax(0, 1fr);
		height: 100vh;
		min-width: 0;
		min-height: 0;
		background: var(--surface-base, #1c1b1a);
		color: var(--text-primary, #f7f1e7);
		overflow: hidden;
	}

	.shell-titlebar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid color-mix(in oklab, currentColor 10%, transparent);
		background: color-mix(in oklab, var(--surface-base, #1c1b1a) 94%, black);
		user-select: none;
	}

	.window-drag { -webkit-app-region: drag; }
	.shell-brand {
		display: flex;
		align-items: center;
		gap: 9px;
		padding-left: 12px;
		min-width: 0;
	}
	.shell-brand strong { font: 650 12px/1.1 "Sora Variable", sans-serif; letter-spacing: .01em; }
	.shell-brand span { color: var(--text-muted, #a49d93); font-size: 11px; }

	.window-controls { display: flex; align-self: stretch; -webkit-app-region: no-drag; }
	.window-controls button {
		width: 42px;
		border: 0;
		border-left: 1px solid color-mix(in oklab, currentColor 8%, transparent);
		background: transparent;
		color: inherit;
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.window-controls button:hover { background: color-mix(in oklab, currentColor 8%, transparent); }
	.window-controls .close-window:hover { background: #b93434; color: white; }

	.tab-strip {
		display: flex;
		align-items: stretch;
		gap: 8px;
		padding: 6px 10px 0;
		border-bottom: 1px solid color-mix(in oklab, currentColor 11%, transparent);
		background: var(--surface-raised, #242321);
		min-width: 0;
	}
	.workspace-tabs { display: flex; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
	.workspace-tabs::-webkit-scrollbar { display: none; }
	.workspace-tab {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		max-width: 230px;
		min-width: 116px;
		height: 39px;
		padding: 0 11px;
		border: 1px solid transparent;
		border-bottom: 0;
		border-radius: 8px 8px 0 0;
		background: transparent;
		color: var(--text-muted, #a49d93);
		font: 600 12px/1 "Nunito Sans Variable", sans-serif;
		cursor: pointer;
	}
	.workspace-tab .tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.workspace-tab:hover { color: inherit; background: color-mix(in oklab, currentColor 5%, transparent); }
	.workspace-tab.is-active {
		color: var(--text-primary, #f7f1e7);
		background: var(--surface-base, #1c1b1a);
		border-color: color-mix(in oklab, currentColor 12%, transparent);
	}
	.chat-tab-button { min-width: 172px; }
	.chat-glyph { color: var(--accent, #e66f51); font-size: 15px; }
	.runtime-pill {
		margin-left: auto;
		padding: 3px 6px;
		border-radius: 999px;
		background: color-mix(in oklab, var(--accent, #e66f51) 18%, transparent);
		color: var(--accent, #e66f51);
		font-size: 9px;
		letter-spacing: .06em;
		text-transform: uppercase;
	}
	.tab-close {
		margin-left: auto;
		width: 20px;
		height: 20px;
		padding: 0;
		border: 0;
		display: grid;
		place-items: center;
		border-radius: 5px;
		background: transparent;
		color: inherit;
		font-size: 14px;
		cursor: pointer;
	}
	.tab-close:hover { background: color-mix(in oklab, currentColor 10%, transparent); }
	.new-browser {
		flex: 0 0 36px;
		height: 34px;
		margin-top: 2px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-muted, #a49d93);
		cursor: pointer;
	}
	.new-browser:hover:not(:disabled) { background: color-mix(in oklab, currentColor 8%, transparent); color: inherit; }

	.workspace-stage { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
	.chat-stage,
	.browser-tab-stage {
		position: absolute;
		inset: 0;
		visibility: hidden;
		pointer-events: none;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
	.chat-stage.is-active,
	.browser-tab-stage.is-active { visibility: visible; pointer-events: auto; }
	.chat-stage :global(.app-shell) {
		height: 100%;
		min-height: 0;
		grid-template-rows: auto minmax(0, 1fr);
	}
	.chat-stage :global(.window-bar) { display: none; }
	.chat-stage :global(.workspace-grid),
	.chat-stage :global(.settings-page) { min-height: 0; }

	.browser-pane-grid { display: grid; height: 100%; min-width: 0; min-height: 0; gap: 1px; background: color-mix(in oklab, currentColor 12%, transparent); }
	.browser-pane-grid.single { grid-template-columns: minmax(0, 1fr); }
	.browser-pane-grid.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); }
	.browser-pane-grid.columns { grid-template-rows: minmax(0, 1fr); }
	.browser-pane-grid.rows { grid-template-columns: minmax(0, 1fr); }
	.browser-pane { display: grid; grid-template-rows: 42px minmax(0, 1fr); min-width: 0; min-height: 0; background: var(--surface-base, #1c1b1a); outline: 1px solid transparent; outline-offset: -1px; }
	.browser-pane.is-focused { outline-color: color-mix(in oklab, var(--accent, #e66f51) 50%, transparent); }
	.browser-toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid color-mix(in oklab, currentColor 10%, transparent); background: var(--surface-raised, #242321); }
	.browser-controls, .browser-pane-actions { display: flex; gap: 3px; }
	.browser-toolbar button {
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted, #a49d93);
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.browser-toolbar button:hover:not(:disabled) { background: color-mix(in oklab, currentColor 8%, transparent); color: inherit; }
	.browser-toolbar button:disabled { opacity: .35; cursor: default; }
	.address-form { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; height: 30px; padding: 0 9px; border: 1px solid color-mix(in oklab, currentColor 12%, transparent); border-radius: 7px; background: color-mix(in oklab, var(--surface-base, #1c1b1a) 82%, transparent); color: var(--text-muted, #a49d93); }
	.address-form input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text-primary, #f7f1e7); font: 500 12px/1 "Nunito Sans Variable", sans-serif; }
	.browser-surface-host { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
	.browser-surface-host :global(.browser-surface) { position: absolute; inset: 0; }

	.workspace-loading { position: absolute; inset: 0; display: grid; place-content: center; gap: 12px; text-align: center; color: var(--text-muted, #a49d93); background: var(--surface-base, #1c1b1a); font-size: 13px; }
	.workspace-loading span { width: 24px; height: 24px; margin: 0 auto; border: 2px solid color-mix(in oklab, currentColor 20%, transparent); border-top-color: var(--accent, #e66f51); border-radius: 50%; animation: spin .8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.toast { position: fixed; right: 18px; bottom: 18px; z-index: 100; max-width: min(460px, calc(100vw - 36px)); padding: 11px 14px; border: 1px solid color-mix(in oklab, currentColor 14%, transparent); border-radius: 8px; background: color-mix(in oklab, var(--surface-raised, #242321) 96%, black); box-shadow: 0 14px 40px rgba(0,0,0,.28); font-size: 12px; }
	.toast.error { border-color: color-mix(in oklab, #d84b4b 50%, transparent); color: #ffb3b3; }

	@media (max-width: 980px) {
		.shell-brand span, .runtime-pill { display: none; }
		.workspace-tab { min-width: 96px; }
		.chat-tab-button { min-width: 130px; }
	}
</style>
