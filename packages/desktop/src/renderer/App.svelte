<script lang="ts">
	import AddSquare from "@solar-icons/svelte/linear/add-square";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import Code from "@solar-icons/svelte/linear/code";
	import Global from "@solar-icons/svelte/linear/global";
	import MaximizeSquare from "@solar-icons/svelte/linear/maximize-square";
	import Minimize from "@solar-icons/svelte/linear/minimize";
	import Sidebar from "@solar-icons/svelte/linear/sidebar";
	import { onMount, tick } from "svelte";
	import type {
		BrowserNavigationAction,
		BrowserViewState,
		WorkspaceEvent,
		WorkspacePaneKind,
	} from "../shared/contracts";
	import BranchMark from "./components/BranchMark.svelte";
	import WorkspacePaneView from "./components/WorkspacePane.svelte";
	import type { WorkspaceLayout, WorkspacePane, WorkspaceTab } from "./workspace-types";

	const MAX_PANES = 4;
	const DEFAULT_BROWSER_URL = "https://omp.sh";

	interface SplitDrag {
		tabId: string;
		layout: "columns" | "rows";
		left: number;
		top: number;
		width: number;
		height: number;
	}

	function id(prefix: string): string {
		return `${prefix}-${crypto.randomUUID()}`;
	}

	function pane(kind: WorkspacePaneKind, url = DEFAULT_BROWSER_URL): WorkspacePane {
		return kind === "browser"
			? { id: id("browser"), kind, title: "New browser", url }
			: { id: id("terminal"), kind, title: "Terminal", status: "starting" };
	}

	function tab(kind: WorkspacePaneKind, title: string, url = DEFAULT_BROWSER_URL): WorkspaceTab {
		const firstPane = pane(kind, url);
		return {
			id: id("tab"),
			kind,
			title,
			panes: [firstPane],
			layout: "columns",
			ratio: 50,
			activePaneId: firstPane.id,
		};
	}

	const browserTab = tab("browser", "OMP Browser");
	const terminalTab = tab("terminal", "Terminal");
	let tabs: WorkspaceTab[] = [browserTab, terminalTab];
	let activeTabId = terminalTab.id;
	let browserStates = new Map<string, BrowserViewState>();
	let newTabMenuOpen = false;
	let renamingTabId = "";
	let renameValue = "";
	let notice = "";
	let maximized = false;
	let splitDrag: SplitDrag | undefined;
	let unsubscribeWorkspace: (() => void) | undefined;

	$: activeTab = tabs.find(item => item.id === activeTabId) ?? tabs[0];
	$: activePane = activeTab?.panes.find(item => item.id === activeTab.activePaneId) ?? activeTab?.panes[0];
	$: documentTitle = activeTab ? `${activeTab.title} · Branchlight` : "Branchlight";
	$: terminalCount = tabs.reduce((count, item) => count + (item.kind === "terminal" ? item.panes.length : 0), 0);
	$: browserCount = tabs.reduce((count, item) => count + (item.kind === "browser" ? item.panes.length : 0), 0);

	function replaceTab(tabId: string, replacement: WorkspaceTab): void {
		tabs = tabs.map(item => item.id === tabId ? replacement : item);
	}

	function uniqueTitle(kind: WorkspacePaneKind): string {
		const base = kind === "browser" ? "Browser" : "Terminal";
		const used = new Set(tabs.map(item => item.title.toLocaleLowerCase()));
		if (!used.has(base.toLocaleLowerCase())) return base;
		let index = 2;
		while (used.has(`${base} ${index}`.toLocaleLowerCase())) index += 1;
		return `${base} ${index}`;
	}

	function addTab(kind: WorkspacePaneKind, url = DEFAULT_BROWSER_URL, requestedTitle?: string): WorkspaceTab {
		const next = tab(kind, requestedTitle ?? uniqueTitle(kind), url);
		tabs = [...tabs, next];
		activeTabId = next.id;
		newTabMenuOpen = false;
		void syncVisibleBrowsers();
		return next;
	}

	function activateTab(tabId: string): void {
		activeTabId = tabId;
		newTabMenuOpen = false;
		void syncVisibleBrowsers();
	}

	function activatePane(tabId: string, paneId: string): void {
		const target = tabs.find(item => item.id === tabId);
		if (!target) return;
		if (activeTabId !== tabId) activeTabId = tabId;
		replaceTab(tabId, { ...target, activePaneId: paneId });
		void syncVisibleBrowsers();
	}

	function closeTab(tabId: string): void {
		const index = tabs.findIndex(item => item.id === tabId);
		if (index < 0) return;
		const closing = tabs[index];
		tabs = tabs.filter(item => item.id !== tabId);
		if (tabs.length === 0) {
			const replacement = tab("terminal", "Terminal");
			tabs = [replacement];
			activeTabId = replacement.id;
		} else if (activeTabId === tabId) {
			activeTabId = tabs[Math.min(index, tabs.length - 1)].id;
		}
		for (const browser of closing.panes) browserStates.delete(browser.id);
		browserStates = new Map(browserStates);
		void syncVisibleBrowsers();
	}

	function splitPane(tabId: string, sourcePaneId: string, layout: WorkspaceLayout): void {
		const target = tabs.find(item => item.id === tabId);
		if (!target || target.panes.length >= MAX_PANES) return;
		const sourceIndex = target.panes.findIndex(item => item.id === sourcePaneId);
		if (sourceIndex < 0) return;
		const nextPane = pane(target.kind, target.kind === "browser" ? DEFAULT_BROWSER_URL : undefined);
		const panes = [...target.panes];
		panes.splice(sourceIndex + 1, 0, nextPane);
		replaceTab(tabId, {
			...target,
			panes,
			layout: panes.length > 2 ? "grid" : layout,
			ratio: 50,
			activePaneId: nextPane.id,
		});
		void syncVisibleBrowsers();
	}

	function closePane(tabId: string, paneId: string): void {
		const target = tabs.find(item => item.id === tabId);
		if (!target) return;
		if (target.panes.length === 1) {
			closeTab(tabId);
			return;
		}
		const panes = target.panes.filter(item => item.id !== paneId);
		browserStates.delete(paneId);
		browserStates = new Map(browserStates);
		replaceTab(tabId, {
			...target,
			panes,
			layout: panes.length > 2 ? "grid" : target.layout === "grid" ? "columns" : target.layout,
			activePaneId: target.activePaneId === paneId ? panes[0].id : target.activePaneId,
		});
		void syncVisibleBrowsers();
	}

	async function syncVisibleBrowsers(): Promise<void> {
		await tick();
		const current = tabs.find(item => item.id === activeTabId);
		const visible = current?.kind === "browser" ? current.panes.map(item => item.id) : [];
		await window.branchlight.setVisibleBrowsers(visible);
	}

	function browserCreated(tabItem: WorkspaceTab, paneItem: WorkspacePane, state: BrowserViewState): void {
		browserStates.set(paneItem.id, state);
		browserStates = new Map(browserStates);
		void nameBrowserPanes(tabItem);
	}

	function updateBrowserState(paneId: string, state: BrowserViewState): void {
		browserStates.set(paneId, state);
		browserStates = new Map(browserStates);
		const owner = tabs.find(item => item.panes.some(candidate => candidate.id === paneId));
		if (!owner) return;
		const panes = owner.panes.map(candidate => candidate.id === paneId ? { ...candidate, title: state.title, url: state.url } : candidate);
		replaceTab(owner.id, { ...owner, panes });
	}

	async function navigateBrowser(paneId: string, address: string): Promise<void> {
		try {
			const state = await window.branchlight.navigateBrowser(paneId, address);
			updateBrowserState(paneId, state);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
		}
	}

	function controlBrowser(paneId: string, action: BrowserNavigationAction): void {
		void window.branchlight.controlBrowser(paneId, action).catch(error => showNotice(error instanceof Error ? error.message : String(error)));
	}

	function browserError(paneId: string, message: string): void {
		const state = browserStates.get(paneId);
		if (state) updateBrowserState(paneId, { ...state, loading: false, error: message });
		showNotice(message);
	}

	function terminalReady(tabId: string, paneId: string, cwd: string): void {
		updatePane(tabId, paneId, current => ({ ...current, cwd, status: "ready" }));
	}

	function terminalStatus(
		tabId: string,
		paneId: string,
		status: "starting" | "ready" | "exited" | "error",
		message?: string,
	): void {
		updatePane(tabId, paneId, current => ({ ...current, status, error: status === "error" ? message : undefined }));
		if (message) showNotice(message);
	}

	function terminalTitle(tabId: string, paneId: string, title: string): void {
		updatePane(tabId, paneId, current => ({ ...current, title }));
	}

	function updatePane(tabId: string, paneId: string, update: (pane: WorkspacePane) => WorkspacePane): void {
		const target = tabs.find(item => item.id === tabId);
		if (!target) return;
		replaceTab(tabId, { ...target, panes: target.panes.map(item => item.id === paneId ? update(item) : item) });
	}

	function startRename(tabItem: WorkspaceTab): void {
		renamingTabId = tabItem.id;
		renameValue = tabItem.title;
		void tick().then(() => document.querySelector<HTMLInputElement>(".tab-rename-input")?.select());
	}

	function commitRename(tabItem: WorkspaceTab): void {
		if (renamingTabId !== tabItem.id) return;
		const proposed = renameValue.trim();
		renamingTabId = "";
		if (!proposed) return;
		const collision = tabs.some(item => item.id !== tabItem.id && item.title.toLocaleLowerCase() === proposed.toLocaleLowerCase());
		if (collision) {
			showNotice(`A tab named “${proposed}” already exists.`);
			return;
		}
		const renamed = { ...tabItem, title: proposed.slice(0, 80) };
		replaceTab(tabItem.id, renamed);
		void nameBrowserPanes(renamed);
	}

	async function nameBrowserPanes(tabItem: WorkspaceTab): Promise<void> {
		if (tabItem.kind !== "browser") return;
		try {
			await Promise.all(tabItem.panes.map((item, index) =>
				window.branchlight.nameBrowser(item.id, tabItem.panes.length === 1 ? tabItem.title : `${tabItem.title} / ${index + 1}`),
			));
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
		}
	}

	function handleWorkspaceEvent(event: WorkspaceEvent): void {
		if (event.type === "browser-state") updateBrowserState(event.paneId, event.state);
		else if (event.type === "browser-focus") {
			const owner = tabs.find(item => item.panes.some(candidate => candidate.id === event.paneId));
			if (owner) activatePane(owner.id, event.paneId);
		} else if (event.type === "browser-new-window") {
			addTab("browser", event.url);
		}
	}

	function beginResize(event: PointerEvent, tabItem: WorkspaceTab): void {
		if (tabItem.panes.length !== 2 || (tabItem.layout !== "columns" && tabItem.layout !== "rows")) return;
		const stage = (event.currentTarget as HTMLElement).parentElement;
		if (!stage) return;
		const rect = stage.getBoundingClientRect();
		splitDrag = {
			tabId: tabItem.id,
			layout: tabItem.layout,
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
		};
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function resizeSplit(event: PointerEvent): void {
		if (!splitDrag) return;
		const coordinate = splitDrag.layout === "columns"
			? (event.clientX - splitDrag.left) / splitDrag.width
			: (event.clientY - splitDrag.top) / splitDrag.height;
		const ratio = Math.min(80, Math.max(20, coordinate * 100));
		const target = tabs.find(item => item.id === splitDrag?.tabId);
		if (target) replaceTab(target.id, { ...target, ratio });
	}

	function showNotice(message: string): void {
		notice = message;
		window.setTimeout(() => {
			if (notice === message) notice = "";
		}, 4_500);
	}

	function toggleNewTabMenu(): void {
		newTabMenuOpen = !newTabMenuOpen;
		if (newTabMenuOpen) void window.branchlight.setVisibleBrowsers([]);
		else void syncVisibleBrowsers();
	}

	function handleKeyboard(event: KeyboardEvent): void {
		if (!event.ctrlKey || event.altKey || event.metaKey) return;
		if (event.key.toLocaleLowerCase() === "t") {
			event.preventDefault();
			addTab(event.shiftKey ? "terminal" : (activeTab?.kind ?? "terminal"));
		} else if (event.key.toLocaleLowerCase() === "w") {
			event.preventDefault();
			if (activeTab) closeTab(activeTab.id);
		} else if (event.key === "\\") {
			event.preventDefault();
			if (activeTab && activePane) splitPane(activeTab.id, activePane.id, event.shiftKey ? "rows" : "columns");
		}
	}

	onMount(() => {
		unsubscribeWorkspace = window.branchlight.onWorkspaceEvent(handleWorkspaceEvent);
		void syncVisibleBrowsers();
		return () => unsubscribeWorkspace?.();
	});
</script>

<svelte:head><title>{documentTitle}</title></svelte:head>
<svelte:window
	onkeydown={handleKeyboard}
	onpointermove={resizeSplit}
	onpointerup={() => { splitDrag = undefined; }}
	onpointercancel={() => { splitDrag = undefined; }}
/>

<div class="workspace-app">
	<header class="workspace-topbar">
		<div class="window-brand" aria-label="Branchlight"><BranchMark size={22} /><span>Branchlight</span></div>
		<nav class="workspace-tabs" aria-label="Workspace tabs">
			{#each tabs as tabItem (tabItem.id)}
				<div class="workspace-tab" class:is-active={tabItem.id === activeTabId}>
					{#if renamingTabId === tabItem.id}
						<div class="tab-select tab-rename-wrap">
							<span class="tab-kind" aria-hidden="true">{#if tabItem.kind === "browser"}<Global size={15} />{:else}<Code size={15} />{/if}</span>
							<input
								class="tab-rename-input"
								aria-label="Tab name"
								bind:value={renameValue}
								onkeydown={(event) => {
									if (event.key === "Enter") commitRename(tabItem);
									else if (event.key === "Escape") renamingTabId = "";
								}}
								onblur={() => commitRename(tabItem)}
							/>
						</div>
					{:else}
						<button
							class="tab-select"
							type="button"
							aria-current={tabItem.id === activeTabId ? "page" : undefined}
							aria-controls={`stage-${tabItem.id}`}
							onclick={() => activateTab(tabItem.id)}
							ondblclick={() => startRename(tabItem)}
						>
							<span class="tab-kind" aria-hidden="true">{#if tabItem.kind === "browser"}<Global size={15} />{:else}<Code size={15} />{/if}</span>
							<span class="tab-title">{tabItem.title}</span>
						</button>
					{/if}
					<button class="tab-close" type="button" aria-label={`Close ${tabItem.title}`} onclick={() => closeTab(tabItem.id)}><CloseCircle size={14} /></button>
				</div>
			{/each}
			<div class="new-tab-anchor">
				<button class="new-tab-button" type="button" aria-label="New tab" aria-expanded={newTabMenuOpen} onclick={toggleNewTabMenu}><AddSquare size={17} /></button>
				{#if newTabMenuOpen}
					<div class="new-tab-menu" role="menu">
						<button type="button" role="menuitem" onclick={() => addTab("browser")}><Global size={16} /><span><strong>Browser tab</strong><small>Browse and connect OMP</small></span></button>
						<button type="button" role="menuitem" onclick={() => addTab("terminal")}><Code size={16} /><span><strong>Terminal tab</strong><small>Shell in this repository</small></span></button>
					</div>
				{/if}
			</div>
		</nav>
		<div class="window-controls">
			<button type="button" aria-label="Minimize Branchlight" onclick={() => void window.branchlight.minimizeWindow()}><Minimize size={17} /></button>
			<button type="button" aria-label={maximized ? "Restore Branchlight" : "Maximize Branchlight"} onclick={async () => { maximized = await window.branchlight.toggleMaximizeWindow(); }}><MaximizeSquare size={16} /></button>
			<button class="close-window" type="button" aria-label="Close Branchlight" onclick={() => void window.branchlight.closeWindow()}><CloseCircle size={17} /></button>
		</div>
	</header>

	<main class="workspace-stages" aria-label="Workspace">
		{#each tabs as tabItem (tabItem.id)}
			<section
				id={`stage-${tabItem.id}`}
				class="tab-stage"
				class:is-active={tabItem.id === activeTabId}
				class:layout-columns={tabItem.panes.length === 2 && tabItem.layout === "columns"}
				class:layout-rows={tabItem.panes.length === 2 && tabItem.layout === "rows"}
				class:layout-grid={tabItem.panes.length > 2}
				style={`--split-ratio: ${tabItem.ratio}`}
				aria-hidden={tabItem.id !== activeTabId}
			>
				{#each tabItem.panes as paneItem, paneIndex (paneItem.id)}
					<WorkspacePaneView
						pane={paneItem}
						browserState={browserStates.get(paneItem.id)}
						tabActive={tabItem.id === activeTabId}
						focused={tabItem.activePaneId === paneItem.id}
						canSplit={tabItem.panes.length < MAX_PANES}
						onActivate={() => activatePane(tabItem.id, paneItem.id)}
						onBrowserCreated={(state) => browserCreated(tabItem, paneItem, state)}
						onBrowserError={(message) => browserError(paneItem.id, message)}
						onBrowserNavigate={(address) => void navigateBrowser(paneItem.id, address)}
						onBrowserControl={(action) => controlBrowser(paneItem.id, action)}
						onTerminalReady={(cwd) => terminalReady(tabItem.id, paneItem.id, cwd)}
						onTerminalStatus={(status, message) => terminalStatus(tabItem.id, paneItem.id, status, message)}
						onTerminalTitle={(title) => terminalTitle(tabItem.id, paneItem.id, title)}
						onSplit={(layout) => splitPane(tabItem.id, paneItem.id, layout)}
						onClose={() => closePane(tabItem.id, paneItem.id)}
					/>
					{#if tabItem.panes.length === 2 && paneIndex === 0}
						<button
							class="split-divider"
							type="button"
							aria-label={tabItem.layout === "rows" ? "Resize horizontal split" : "Resize vertical split"}
							onpointerdown={(event) => beginResize(event, tabItem)}
						><span></span></button>
					{/if}
				{/each}
			</section>
		{/each}
	</main>

	<footer class="workspace-status">
		<div><Sidebar size={14} aria-hidden="true" /><span>{activeTab?.panes.length ?? 0} {activeTab?.panes.length === 1 ? "pane" : "panes"}</span></div>
		<div class="status-center"><span class="status-dot"></span><span>{activeTab?.kind === "browser" ? "OMP browser target ready" : activePane?.cwd ?? "Current repository"}</span></div>
		<div><Global size={14} aria-hidden="true" /><span>{browserCount} browser</span><span class="status-separator"></span><Code size={14} aria-hidden="true" /><span>{terminalCount} WASM VT</span></div>
	</footer>

	{#if notice}<div class="workspace-toast" role="alert">{notice}</div>{/if}
</div>
