<script lang="ts">
	import AddSquare from "@solar-icons/svelte/linear/add-square";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import Code from "@solar-icons/svelte/linear/code";
	import Global from "@solar-icons/svelte/linear/global";
	import InfoCircle from "@solar-icons/svelte/linear/info-circle";
	import MaximizeSquare from "@solar-icons/svelte/linear/maximize-square";
	import Minimize from "@solar-icons/svelte/linear/minimize";
	import Sidebar from "@solar-icons/svelte/linear/sidebar";
	import Target from "@solar-icons/svelte/linear/target";
	import UsersGroupRounded from "@solar-icons/svelte/linear/users-group-rounded";
	import { onMount, tick } from "svelte";
	import {
		MAX_WORKSPACE_PANES,
		type BranchlightEvent,
		type BranchlightSettings,
		type BrowserNavigationAction,
		type BrowserViewState,
		type ElementEditState,
		type SubagentView,
		type WorkspaceEvent,
		type WorkspacePaneKind,
	} from "../shared/contracts";
	import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
	import BranchMark from "./components/BranchMark.svelte";
	import SettingsView from "./components/SettingsView.svelte";
	import WorkspacePaneView from "./components/WorkspacePane.svelte";
	import {
		findAgentForPane,
		reconcileWorkspaceAgents,
	} from "./agent-projection";
	import { projectWorkspaceTabs } from "./workspace-projection";
	import {
		getAgentSwatch,
		type AgentProcessStatus,
		type ElementSelectionState,
		type SelectionCaptureMode,
		type WorkspaceAgent,
		type WorkspaceLayout,
		type WorkspacePane,
		type WorkspaceTab,
	} from "./workspace-types";

	const DEFAULT_BROWSER_URL = "https://omp.sh";

	interface SplitDrag {
		tabId: string;
		layout: "columns" | "rows";
		ratio: number;
		left: number;
		top: number;
		width: number;
		height: number;
	}

	interface TerminalTransientState {
		status?: "starting" | "ready" | "exited" | "error";
		cwd?: string;
		title?: string;
		error?: string;
	}

	function id(prefix: string): string {
		return `${prefix}-${crypto.randomUUID()}`;
	}

	let tabs: WorkspaceTab[] = [];
	let activeTabId = "";
	let activeWorkspaceId = "";
	let browserStates = new Map<string, BrowserViewState>();
	let selectionStates = new Map<string, ElementSelectionState>();
	let connectionState: "connected" | "reconnecting" | "disconnected" = "connected";
	let view: "workspace" | "settings" = "workspace";
	let newTabMenuOpen = false;
	let newTabMenuBusy = false;
	let renamingTabId = "";
	let renameValue = "";
	let notice = "";
	let errorMessage = "";
	let maximized = false;
	let terminalStates = new Map<string, TerminalTransientState>();
	let splitDrag: SplitDrag | undefined;
	let splitPreviewRatios = new Map<string, number>();
	let resolvedTheme: "dark" | "light" = "dark";
	let workspaceDocument: WorkspaceDocumentV1 | undefined;
	let appSettings: BranchlightSettings | undefined = undefined;
	let hydrated = false;
	let pendingActiveTabId: string | undefined;
	let unsubscribeWorkspace: (() => void) | undefined;
	let unsubscribeWorkspaceDocument: (() => void) | undefined;
	let unsubscribeEvents: (() => void) | undefined;
	let unsubscribeSelection: (() => void) | undefined;

	let agents: WorkspaceAgent[] = [];
	$: activeTab = tabs.find(item => item.id === activeTabId) ?? tabs[0];
	$: activePane = activeTab?.panes.find(item => item.id === activeTab.activePaneId) ?? activeTab?.panes[0];
	$: activeTabTitle = activeTab ? getTabDisplayTitle(activeTab, workspaceDocument, agents) : "";
	$: documentTitle = view === "settings"
		? "Settings · Mars Kommander"
		: activeTab
			? `${activeTabTitle} · Mars Kommander`
			: "Mars Kommander";
	$: terminalCount = tabs.reduce((count, item) => count + (item.kind === "terminal" ? item.panes.length : 0), 0);
	$: browserCount = tabs.reduce((count, item) => count + (item.kind === "browser" ? item.panes.length : 0), 0);

	$: deliverableAgents = agents.filter(agent => {
		const status = String(agent.status).toLowerCase();
		const isStatusActive = status !== "stopped" && status !== "error" && status !== "failed" && status !== "exited";
		const matchesWorkspace = !agent.workspaceId || agent.workspaceId === activeWorkspaceId;
		return isStatusActive && matchesWorkspace && agent.deliverable !== false;
	});

	function applyTheme(theme?: BranchlightSettings["theme"]): void {
		const configured = theme ?? appSettings?.theme ?? "dark";
		if (configured === "system") {
			const isDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
			resolvedTheme = isDark ? "dark" : "light";
		} else {
			resolvedTheme = configured;
		}
		document.documentElement.dataset.theme = resolvedTheme;
	}

	onMount(() => {
		unsubscribeWorkspace = window.branchlight.onWorkspaceEvent(handleWorkspaceEvent);
		const bootstrap = {
			settingsLoaded: false,
			bufferedDocument: undefined as WorkspaceDocumentV1 | undefined,
		};

		if (typeof window.branchlight.onWorkspaceDocument === "function") {
			unsubscribeWorkspaceDocument = window.branchlight.onWorkspaceDocument(doc => {
				if (!bootstrap.settingsLoaded) {
					bootstrap.bufferedDocument = doc;
				} else {
					handleWorkspaceDocument(doc);
				}
			});
		}
		if (typeof window.branchlight.onEvent === "function") {
			unsubscribeEvents = window.branchlight.onEvent(handleBranchlightEvent);
		}
		if (typeof window.branchlight.onSelectionStateChanged === "function") {
			unsubscribeSelection = window.branchlight.onSelectionStateChanged(handleSelectionStateChanged);
		}
		const mediaQuery = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;
		const handleMediaChange = () => {
			if (appSettings?.theme === "system") applyTheme("system");
		};
		mediaQuery?.addEventListener?.("change", handleMediaChange);

		void (async () => {
			try {
				const [settings, fetchedDocument] = await Promise.all([
					window.branchlight.getAppSettings().catch(() => undefined),
					window.branchlight.getWorkspaceDocument().catch(() => undefined),
				]);
				if (settings) {
					appSettings = settings;
					applyTheme(settings.theme);
				}
				bootstrap.settingsLoaded = true;
				const buf = bootstrap.bufferedDocument;
				const fetched = fetchedDocument ?? undefined;
				const candidateDoc = (buf && fetched)
					? (buf.revision >= fetched.revision ? buf : fetched)
					: (buf ?? fetched);
				if (!candidateDoc) throw new Error("Workspace runtime returned no document");
				handleWorkspaceDocument(candidateDoc);
			} catch (error) {
				showError(error);
			}
		})();
		return () => {
			unsubscribeWorkspace?.();
			unsubscribeWorkspaceDocument?.();
			unsubscribeEvents?.();
			unsubscribeSelection?.();
			mediaQuery?.removeEventListener?.("change", handleMediaChange);
		};
	});
	function activeWorkspace(): string {
		if (!hydrated || !activeWorkspaceId) throw new Error("Workspace is still loading");
		return activeWorkspaceId;
	}

	async function addTab(kind: WorkspacePaneKind, url?: string): Promise<{ tabId: string; paneId: string } | undefined> {
		const targetUrl = url ?? appSettings?.browser.defaultUrl ?? DEFAULT_BROWSER_URL;
		let workspaceId: string;
		try {
			workspaceId = activeWorkspace();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
			return undefined;
		}
		const tabId = id("tab");
		const paneId = id(kind);
		view = "workspace";
		newTabMenuOpen = false;
		pendingActiveTabId = tabId;
		activeTabId = tabId;
		try {
			if (kind === "browser") {
				await window.branchlight.createBrowser({ id: paneId, url: targetUrl, workspaceId, tabId });
			} else {
				await window.branchlight.createTerminal({ id: paneId, tabId, workspaceId, cols: 100, rows: 30 });
			}
			return { tabId, paneId };
		} catch (error) {
			if (pendingActiveTabId === tabId) pendingActiveTabId = undefined;
			activeTabId = tabs[0]?.id ?? "";
			showNotice(error instanceof Error ? error.message : String(error));
			await syncVisibleBrowsers().catch(() => {});
			return undefined;
		}
	}

	function activateTab(tabId: string): void {
		if (!tabs.some(item => item.id === tabId)) return;
		view = "workspace";
		activeTabId = tabId;
		pendingActiveTabId = undefined;
		newTabMenuOpen = false;
		void syncVisibleBrowsers();
	}

	function activatePane(tabId: string, paneId: string): void {
		const target = tabs.find(item => item.id === tabId);
		if (!target || !target.panes.some(item => item.id === paneId)) return;
		view = "workspace";
		activeTabId = tabId;
		pendingActiveTabId = undefined;
		void window.branchlight.updateTab(tabId, { activePaneId: paneId })
			.catch(error => showNotice(error instanceof Error ? error.message : String(error)));
		void syncVisibleBrowsers();
	}

	async function closeTab(tabId: string): Promise<void> {
		const target = tabs.find(item => item.id === tabId);
		if (!target) return;
		if (appSettings?.confirmCloseTab && target.panes.length > 0) {
			const ok = window.confirm(`Close tab "${target.title || "Tab"}"?`);
			if (!ok) return;
		}
		const index = tabs.findIndex(item => item.id === tabId);
		if (index < 0) return;
		if (activeTabId === tabId) {
			const next = tabs[index + 1] ?? tabs[index - 1];
			pendingActiveTabId = next?.id;
		}
		try {
			await window.branchlight.closeTab(tabId);
			for (const pane of target.panes) {
				browserStates.delete(pane.id);
				selectionStates.delete(pane.id);
			}
			browserStates = new Map(browserStates);
			selectionStates = new Map(selectionStates);
		} catch (error) {
			if (pendingActiveTabId && tabs.some(item => item.id === pendingActiveTabId)) {
				activeTabId = pendingActiveTabId;
			}
			pendingActiveTabId = undefined;
			showNotice(error instanceof Error ? error.message : String(error));
		}
		void syncVisibleBrowsers();
	}

	async function splitPane(tabId: string, sourcePaneId: string, layout: WorkspaceLayout): Promise<void> {
		const target = tabs.find(item => item.id === tabId);
		if (!target || target.panes.length >= MAX_WORKSPACE_PANES || !target.panes.some(item => item.id === sourcePaneId)) return;
		let workspaceId: string;
		try {
			workspaceId = activeWorkspace();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
			return;
		}
		const nextPaneId = id(target.kind);
		pendingActiveTabId = tabId;
		activeTabId = tabId;
		const requestedLayout = target.panes.length + 1 > 2 ? "grid" : layout;
		try {
			if (target.kind === "browser") {
				await window.branchlight.createBrowser({
					id: nextPaneId,
					url: appSettings?.browser.defaultUrl ?? DEFAULT_BROWSER_URL,
					workspaceId,
					tabId,
					layout: requestedLayout,
				});
			} else {
				await window.branchlight.createTerminal({
					id: nextPaneId,
					tabId,
					workspaceId,
					cols: 100,
					rows: 30,
					layout: requestedLayout,
				});
			}
		} catch (error) {
			pendingActiveTabId = undefined;
			showNotice(error instanceof Error ? error.message : String(error));
		}
		void syncVisibleBrowsers();
	}

	async function closePane(tabId: string, paneId: string): Promise<void> {
		const target = tabs.find(item => item.id === tabId);
		if (!target || !target.panes.some(item => item.id === paneId)) return;
		if (target.panes.length === 1) {
			await closeTab(tabId);
			return;
		}
		try {
			await window.branchlight.closePane(paneId);
			browserStates.delete(paneId);
			selectionStates.delete(paneId);
			browserStates = new Map(browserStates);
			selectionStates = new Map(selectionStates);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
		}
		void syncVisibleBrowsers();
	}

	async function syncVisibleBrowsers(): Promise<void> {
		await tick();
		const currentTab = tabs.find(item => item.id === activeTabId);
		const visible = hydrated && !newTabMenuOpen && view === "workspace" && currentTab?.kind === "browser"
			? currentTab.panes.map(item => item.id)
			: [];
		await window.branchlight.setVisibleBrowsers(visible);
	}

	function browserCreated(_tabItem: WorkspaceTab, paneItem: WorkspacePane, state: BrowserViewState): void {
		browserStates.set(paneItem.id, state);
		browserStates = new Map(browserStates);
	}

	function updateBrowserState(paneId: string, state: BrowserViewState): void {
		browserStates.set(paneId, state);
		browserStates = new Map(browserStates);
	}
	function browserError(paneId: string, message: string): void {
		const existing = browserStates.get(paneId);
		if (existing) {
			browserStates.set(paneId, { ...existing, loading: false, error: message });
			browserStates = new Map(browserStates);
		}
		if (message) showNotice(message);
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
		void window.branchlight.controlBrowser(paneId, action)
			.catch(error => showNotice(error instanceof Error ? error.message : String(error)));
	}
	function terminalReady(paneId: string, cwd: string): void {
		terminalStates.set(paneId, { ...terminalStates.get(paneId), cwd, status: "ready", error: undefined });
		terminalStates = new Map(terminalStates);
	}

	function terminalStatus(
		paneId: string,
		status: "starting" | "ready" | "exited" | "error",
		message?: string,
	): void {
		terminalStates.set(paneId, {
			...terminalStates.get(paneId),
			status,
			error: status === "error" ? message : undefined,
		});
		terminalStates = new Map(terminalStates);
		if (message) showNotice(message);
	}

	function terminalTitle(paneId: string, title: string): void {
		terminalStates.set(paneId, { ...terminalStates.get(paneId), title });
		terminalStates = new Map(terminalStates);
	}

	function startRename(tabItem: WorkspaceTab): void {
		renamingTabId = tabItem.id;
		renameValue = tabItem.title;
		void tick().then(() => document.querySelector<HTMLInputElement>(".tab-rename-input")?.select());
	}

	async function commitRename(tabItem: WorkspaceTab): Promise<void> {
		if (renamingTabId !== tabItem.id) return;
		const proposed = renameValue.trim().slice(0, 80);
		renamingTabId = "";
		if (!proposed) return;
		const collision = tabs.some(item =>
			item.id !== tabItem.id && item.title.toLocaleLowerCase() === proposed.toLocaleLowerCase(),
		);
		if (collision) {
			showNotice(`A tab named “${proposed}” already exists.`);
			return;
		}
		try {
			await window.branchlight.updateTab(tabItem.id, { name: proposed });
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
		}
	}
	function handleSelectionStateChanged(state: ElementEditState): void {
		if (!state.paneId) return;
		if (state.phase === "idle") {
			selectionStates.delete(state.paneId);
			selectionStates = new Map(selectionStates);
			return;
		}
		const targetAgent = state.agentId ? agents.find(a => a.id === state.agentId) : undefined;
		const errorMsg = state.error
			? typeof state.error === "string"
				? state.error
				: state.error.message
			: undefined;
		const uiCaptureMode: SelectionCaptureMode = state.captureMode === "screenshot" ? "screenshot" : "dom";
		selectionStates.set(state.paneId, {
			phase: state.phase,
			selectionId: state.selectionId,
			workspaceId: state.workspaceId,
			paneId: state.paneId,
			agentId: state.agentId,
			agentName: targetAgent?.name,
			captureMode: uiCaptureMode,
			url: state.url,
			selector: state.selector || state.selectedElement?.selector,
			tagName: state.selectedElement?.tagName,
			elementLabel: state.selectedElement?.name || state.selectedElement?.role,
			workingMessage: state.workingMessage,
			error: errorMsg,
			updatedAt: state.updatedAt || Date.now(),
		});
		selectionStates = new Map(selectionStates);
	}

	function handleBranchlightEvent(event: BranchlightEvent): void {
		if (event.type === "subagents") {
			updateSubagentsFromEvent(event.sessionId, event.subagents ?? []);
		}
	}

	function updateSubagentsFromEvent(sessionId: string, subagentViews: SubagentView[]): void {
		const docAgentIds = new Set((workspaceDocument?.agents ?? []).map(a => a.id));
		const preservedAgents = agents.filter(a => docAgentIds.has(a.id) || (a.sessionId !== undefined && a.sessionId !== sessionId));

		const newSubagentRows: WorkspaceAgent[] = [];
		for (const sub of subagentViews) {
			const status = (sub.status || "ready") as AgentProcessStatus;
			const existing = agents.find(a => a.id === sub.id);
			newSubagentRows.push({
				id: sub.id,
				name: existing?.name || (sub.agent ? `${sub.agent.charAt(0).toUpperCase() + sub.agent.slice(1)} Agent` : sub.id),
				agent: sub.agent || existing?.agent || "task",
				status,
				swatch: existing?.swatch || getAgentSwatch(sub.id),
				workspaceId: activeWorkspaceId,
				sessionId,
				deliverable: false,
				task: sub.task ?? existing?.task,
				assignment: sub.assignment ?? existing?.assignment,
				lastIntent: sub.progress?.lastIntent ?? existing?.lastIntent,
				currentTool: sub.progress?.currentTool ?? existing?.currentTool,
			});
		}

		agents = [...preservedAgents, ...newSubagentRows];
	}
	function handleWorkspaceDocument(doc: WorkspaceDocumentV1): void {
		if (!doc || (workspaceDocument && doc.revision < workspaceDocument.revision)) return;
		const projected = projectWorkspaceTabs(
			doc,
			doc.activeWorkspaceId || activeWorkspaceId || undefined,
			pendingActiveTabId ?? activeTabId,
		);
		workspaceDocument = doc;
		activeWorkspaceId = projected.workspaceId;
		tabs = projected.tabs;
		activeTabId = projected.activeTabId;
		if (pendingActiveTabId && projected.tabs.some(tabItem => tabItem.id === pendingActiveTabId)) {
			pendingActiveTabId = undefined;
		}
		const paneIds = new Set(projected.tabs.flatMap(tabItem => tabItem.panes.map(paneItem => paneItem.id)));
		const liveTabIds = new Set(projected.tabs.map(tabItem => tabItem.id));
		browserStates = new Map([...browserStates].filter(([paneId]) => paneIds.has(paneId)));
		terminalStates = new Map([...terminalStates].filter(([paneId]) => paneIds.has(paneId)));
		selectionStates = new Map([...selectionStates].filter(([paneId, s]) => paneIds.has(paneId) && s.phase !== "idle"));
		splitPreviewRatios = new Map([...splitPreviewRatios].filter(([tabId]) => liveTabIds.has(tabId)));
		if (splitDrag && !liveTabIds.has(splitDrag.tabId)) {
			splitDrag = undefined;
		}
		hydrated = true;
		agents = reconcileWorkspaceAgents(doc, agents, activeWorkspaceId);
		void syncVisibleBrowsers();
	}


	function getTabDisplayTitle(tabItem: WorkspaceTab, doc: WorkspaceDocumentV1 | undefined, agentList: WorkspaceAgent[]): string {
		if (tabItem.kind === "terminal" && tabItem.panes.length === 1) {
			const agent = findAgentForPane(tabItem.panes[0].id, doc, agentList);
			if (agent && (tabItem.title === "Terminal" || tabItem.title.startsWith("Terminal ") || tabItem.title === agent.name)) {
				return agent.name;
			}
		}
		return tabItem.title;
	}

	function getTabAgent(tabItem: WorkspaceTab, doc: WorkspaceDocumentV1 | undefined, agentList: WorkspaceAgent[]): WorkspaceAgent | undefined {
		if (tabItem.kind === "terminal" && tabItem.panes.length > 0) {
			return findAgentForPane(tabItem.activePaneId, doc, agentList) ?? findAgentForPane(tabItem.panes[0].id, doc, agentList);
		}
		return undefined;
	}

	function handleWorkspaceEvent(
		event: WorkspaceEvent | { type: "selection-state"; state: ElementEditState },
	): void {
		if (event.type === "connection-state") {
			connectionState = event.state;
			if (connectionState === "reconnecting") {
				showNotice("Reconnecting to workspace runtime…");
			}
		} else if (event.type === "browser-state") {
			updateBrowserState(event.paneId, event.state);
		} else if (event.type === "browser-focus") {
			const owner = tabs.find(item => item.panes.some(candidate => candidate.id === event.paneId));
			if (owner) activatePane(owner.id, event.paneId);
		} else if (event.type === "browser-new-window") {
			void addTab("browser", event.url);
		} else if (event.type === "pane-context-action") {
			const owner = tabs.find(item => item.panes.some(candidate => candidate.id === event.paneId));
			if (!owner) return;
			if (event.action === "split-columns") void splitPane(owner.id, event.paneId, "columns");
			else if (event.action === "split-rows") void splitPane(owner.id, event.paneId, "rows");
			else void closePane(owner.id, event.paneId);
		} else if (event.type === "selection-state" && event.state?.paneId) {
			handleSelectionStateChanged(event.state);
		}
	}

	async function toggleSelectionForPane(
		paneId: string,
		agentId?: string,
		captureMode: SelectionCaptureMode = "dom",
	): Promise<void> {
		const current = selectionStates.get(paneId);
		if (current && current.phase !== "idle") {
			await cancelSelectionForPane(paneId);
			return;
		}
		const targetAgent = agentId
			? agents.find(a => a.id === agentId && a.deliverable)
			: deliverableAgents[0];
		if (!targetAgent) {
			showNotice("No deliverable agent available in this workspace.");
			return;
		}

		const nextState: ElementSelectionState = {
			phase: "picking",
			paneId,
			workspaceId: activeWorkspaceId,
			agentId: targetAgent.id,
			agentName: targetAgent.name,
			captureMode,
			updatedAt: Date.now(),
		};
		selectionStates.set(paneId, nextState);
		selectionStates = new Map(selectionStates);

		try {
			if (typeof window.branchlight.startSelection === "function") {
				const res = await window.branchlight.startSelection(paneId, targetAgent.id, captureMode);
				if (res) {
					handleSelectionStateChanged(res);
				}
			}
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
			selectionStates.set(paneId, {
				...nextState,
				phase: "error",
				error: error instanceof Error ? error.message : String(error),
			});
			selectionStates = new Map(selectionStates);
		}
	}

	async function cancelSelectionForPane(paneId: string): Promise<void> {
		try {
			if (typeof window.branchlight.cancelSelection === "function") {
				await window.branchlight.cancelSelection(paneId);
			}
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
		} finally {
			selectionStates.delete(paneId);
			selectionStates = new Map(selectionStates);
		}
	}

	async function commitSelectionForPane(paneId: string, instruction?: string): Promise<void> {
		const current = selectionStates.get(paneId);
		if (!current) return;
		selectionStates.set(paneId, {
			...current,
			phase: "sending",
			workingMessage: "Sending selected element to agent...",
			updatedAt: Date.now(),
		});
		selectionStates = new Map(selectionStates);

		try {
			if (typeof window.branchlight.commitSelection === "function") {
				const res = await window.branchlight.commitSelection(paneId, instruction);
				if (res && res.phase !== "idle") {
					handleSelectionStateChanged(res);
				} else {
					selectionStates.delete(paneId);
					selectionStates = new Map(selectionStates);
				}
			}
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
			selectionStates.set(paneId, {
				...current,
				phase: "error",
				error: error instanceof Error ? error.message : String(error),
			});
			selectionStates = new Map(selectionStates);
		}
	}

	function resetSelectionForPane(paneId: string): void {
		selectionStates.delete(paneId);
		selectionStates = new Map(selectionStates);
	}

	async function changeCaptureModeForPane(paneId: string, mode: SelectionCaptureMode): Promise<void> {
		const current = selectionStates.get(paneId);
		if (current && current.phase === "picking") {
			await cancelSelectionForPane(paneId);
			await toggleSelectionForPane(paneId, current.agentId, mode);
		}
	}

	async function selectRecipientAgentForPane(paneId: string, agentId: string): Promise<void> {
		const current = selectionStates.get(paneId);
		const targetAgent = agents.find(a => a.id === agentId && a.deliverable);
		if (current && targetAgent && current.phase === "picking") {
			await cancelSelectionForPane(paneId);
			await toggleSelectionForPane(paneId, targetAgent.id, current.captureMode);
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
			ratio: tabItem.ratio,
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
		splitDrag = { ...splitDrag, ratio };
		splitPreviewRatios.set(splitDrag.tabId, ratio);
		splitPreviewRatios = new Map(splitPreviewRatios);
	}

	async function finishResize(): Promise<void> {
		const drag = splitDrag;
		splitDrag = undefined;
		if (!drag) return;
		splitPreviewRatios.delete(drag.tabId);
		splitPreviewRatios = new Map(splitPreviewRatios);
		const target = tabs.find(item => item.id === drag.tabId);
		if (!target || Math.abs(target.ratio - drag.ratio) < 0.01) return;
		try {
			await window.branchlight.updateTab(drag.tabId, { ratio: drag.ratio });
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
		}
	}

	function showNotice(message: string): void {
		notice = message;
		window.setTimeout(() => {
			if (notice === message) notice = "";
		}, 4_500);
	}


	function showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		errorMessage = message;
		window.setTimeout(() => {
			if (errorMessage === message) errorMessage = "";
		}, 6_000);
	}

	async function toggleNewTabMenu(): Promise<void> {
		if (newTabMenuBusy) return;
		const nextOpen = !newTabMenuOpen;
		newTabMenuOpen = nextOpen;
		newTabMenuBusy = true;
		try {
			await syncVisibleBrowsers();
		} catch (error) {
			newTabMenuOpen = !nextOpen;
			await syncVisibleBrowsers().catch(() => {});
			showError(error);
		} finally {
			newTabMenuBusy = false;
		}
	}

	function openSettings(): void {
		view = "settings";
		newTabMenuOpen = false;
		void syncVisibleBrowsers().catch(showError);
	}

	function returnToWorkspace(): void {
		view = "workspace";
		void syncVisibleBrowsers().catch(showError);
	}

	function isEditableOrTerminalTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tagName = target.tagName.toLowerCase();
		if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
		if (target.isContentEditable) return true;
		if (target.closest(".terminal-surface") || target.closest("canvas")) return true;
		if (target.closest(".dialog") || target.closest(".new-tab-menu") || target.closest(".tab-rename-input")) return true;
		return false;
	}

	function isPrimaryShortcut(event: KeyboardEvent): boolean {
		const isMac = typeof navigator !== "undefined" && (/Mac|iPhone|iPad|iPod/i.test(navigator.platform) || /Macintosh|Mac OS X/i.test(navigator.userAgent));
		return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	}

	function handleKeyboard(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			if (newTabMenuOpen) {
				event.preventDefault();
				void toggleNewTabMenu();
				newTabButtonRef?.focus();
				return;
			}
			return;
		}
		if (view !== "workspace") return;
		if (isEditableOrTerminalTarget(event.target)) return;
		if (!isPrimaryShortcut(event) || event.altKey) return;
		const key = event.key.toLowerCase();
		if (key === "t") {
			event.preventDefault();
			void addTab(event.shiftKey ? "terminal" : (activeTab?.kind ?? "terminal"));
		} else if (key === "w") {
			event.preventDefault();
			if (activeTab) void closeTab(activeTab.id);
		} else if (event.key === "\\") {
			event.preventDefault();
			if (activeTab && activePane) {
				void splitPane(activeTab.id, activePane.id, event.shiftKey ? "rows" : "columns");
			}
		}
	}

	function handleTabKeydown(event: KeyboardEvent, index: number): void {
		let nextIndex: number | undefined;
		if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
		else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
		else if (event.key === "Home") nextIndex = 0;
		else if (event.key === "End") nextIndex = tabs.length - 1;

		if (nextIndex !== undefined) {
			event.preventDefault();
			const nextTab = tabs[nextIndex];
			if (nextTab) {
				activateTab(nextTab.id);
				void tick().then(() => {
					document.getElementById(`tab-btn-${nextTab.id}`)?.focus();
				});
			}
		}
	}

	function handleNewTabMenuKeydown(event: KeyboardEvent): void {
		const buttons = Array.from(newTabMenuRef?.querySelectorAll<HTMLButtonElement>("button") ?? []);
		if (buttons.length === 0) return;
		const activeIdx = buttons.indexOf(document.activeElement as HTMLButtonElement);
		let nextIdx: number | undefined;
		if (event.key === "ArrowDown") nextIdx = activeIdx === -1 ? 0 : (activeIdx + 1) % buttons.length;
		else if (event.key === "ArrowUp") nextIdx = activeIdx === -1 ? buttons.length - 1 : (activeIdx - 1 + buttons.length) % buttons.length;
		else if (event.key === "Home") nextIdx = 0;
		else if (event.key === "End") nextIdx = buttons.length - 1;
		else if (event.key === "Escape") {
			event.preventDefault();
			void toggleNewTabMenu();
			newTabButtonRef?.focus();
			return;
		}
		if (nextIdx !== undefined) {
			event.preventDefault();
			buttons[nextIdx]?.focus();
		}
	}

	function handleWindowPointerDown(event: PointerEvent): void {
		if (newTabMenuOpen && !(event.target as HTMLElement)?.closest(".new-tab-anchor")) {
			void toggleNewTabMenu();
		}
	}

	async function handleDividerKeydown(event: KeyboardEvent, tabItem: WorkspaceTab): Promise<void> {
		const currentRatio = splitPreviewRatios.get(tabItem.id) ?? tabItem.ratio;
		let nextRatio: number | undefined;
		if (tabItem.layout === "rows") {
			if (event.key === "ArrowUp") nextRatio = Math.max(20, currentRatio - 5);
			else if (event.key === "ArrowDown") nextRatio = Math.min(80, currentRatio + 5);
		} else {
			if (event.key === "ArrowLeft") nextRatio = Math.max(20, currentRatio - 5);
			else if (event.key === "ArrowRight") nextRatio = Math.min(80, currentRatio + 5);
		}
		if (event.key === "Home") nextRatio = 20;
		else if (event.key === "End") nextRatio = 80;

		if (nextRatio !== undefined && nextRatio !== currentRatio) {
			event.preventDefault();
			try {
				await window.branchlight.updateTab(tabItem.id, { ratio: nextRatio });
			} catch (error) {
				showNotice(error instanceof Error ? error.message : String(error));
			}
		}
	}

	let newTabButtonRef: HTMLButtonElement | undefined;
	let newTabMenuRef: HTMLDivElement | undefined;

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
</script>

<svelte:head>
	<title>{documentTitle}</title>
</svelte:head>

<svelte:window
	onkeydown={handleKeyboard}
	onpointerdown={handleWindowPointerDown}
	onpointermove={resizeSplit}
	onpointerup={() => void finishResize()}
	onpointercancel={() => void finishResize()}
	onblur={() => void finishResize()}
/>

<div class="workspace-app">
	<aside class="workspace-sidebar" aria-label="Mars Kommander navigation">
		<div class="sidebar-header">
			<div class="sidebar-brand" aria-label="Mars Kommander">
				<BranchMark size={20} />
				<span class="brand-title">Mars Kommander</span>
			</div>
		</div>

		<div class="sidebar-action-wrap">
			<div class="new-tab-anchor">
				<button
					bind:this={newTabButtonRef}
					class="sidebar-new-tab-btn"
					type="button"
					aria-label="New tab"
					aria-expanded={newTabMenuOpen}
					disabled={newTabMenuBusy}
					onclick={() => void toggleNewTabMenu()}
				>
					<AddSquare size={16} />
					<span>New tab</span>
				</button>
				{#if newTabMenuOpen && !newTabMenuBusy}
					<div
						bind:this={newTabMenuRef}
						class="new-tab-menu"
						role="menu"
						tabindex="-1"
						onkeydown={handleNewTabMenuKeydown}
					>
						<button
							type="button"
							role="menuitem"
							onclick={() => { void toggleNewTabMenu(); void addTab("browser"); }}
						>
							<Global size={16} />
							<span><strong>Browser tab</strong><small>Open a web workspace</small></span>
						</button>
						<button
							type="button"
							role="menuitem"
							onclick={() => { void toggleNewTabMenu(); void addTab("terminal"); }}
						>
							<Code size={16} />
							<span><strong>Terminal tab</strong><small>Open a shell in this repository</small></span>
						</button>
					</div>
				{/if}
			</div>
		</div>

		<div class="sidebar-tabs-section">
			<div class="sidebar-section-title">
				<span>TABS</span>
				<span class="sidebar-tab-count">{tabs.length}</span>
			</div>
			<div class="workspace-tab-strip" role="tablist" aria-orientation="vertical" aria-label="Open tabs">
				{#each tabs as tabItem, index (tabItem.id)}
					{@const tabAgent = getTabAgent(tabItem, workspaceDocument, agents)}
					{@const displayTitle = getTabDisplayTitle(tabItem, workspaceDocument, agents)}
					<div class="workspace-tab" class:is-active={tabItem.id === activeTabId && view === "workspace"}>
						{#if renamingTabId === tabItem.id}
							<div class="tab-select tab-rename-wrap">
								<span class="tab-kind" aria-hidden="true">
									{#if tabItem.kind === "browser"}
										<Global size={15} />
									{:else if tabAgent}
										<span class="agent-swatch" style={`background-color: ${tabAgent.swatch}; width: 10px; height: 10px;`} aria-hidden="true"></span>
									{:else}
										<Code size={15} />
									{/if}
								</span>
								<input
									class="tab-rename-input"
									aria-label="Tab name"
									bind:value={renameValue}
									onkeydown={(event) => {
										if (event.key === "Enter") commitRename(tabItem);
										else if (event.key === "Escape") renamingTabId = "";
									}}
									onblur={() => commitRename(tabItem)}
									oncontextmenu={(e) => e.stopPropagation()}
								/>
							</div>
						{:else}
							<button
								class="tab-select"
								type="button"
								role="tab"
								id={`tab-btn-${tabItem.id}`}
								aria-controls={`stage-${tabItem.id}`}
								aria-selected={tabItem.id === activeTabId && view === "workspace"}
								tabindex={tabItem.id === activeTabId && view === "workspace" ? 0 : -1}
								title={displayTitle}
								onclick={() => activateTab(tabItem.id)}
								ondblclick={() => startRename(tabItem)}
								onkeydown={(event) => handleTabKeydown(event, index)}
							>
								<span class="tab-kind" aria-hidden="true">
									{#if tabItem.kind === "browser"}
										<Global size={15} />
									{:else if tabAgent}
										<span class="agent-swatch" style={`background-color: ${tabAgent.swatch}; width: 10px; height: 10px;`} aria-hidden="true"></span>
									{:else}
										<Code size={15} />
									{/if}
								</span>
								<span class="tab-title">{displayTitle}</span>
							</button>
						{/if}
						<button
							class="tab-close"
							type="button"
							aria-label={`Close ${displayTitle}`}
							onclick={() => closeTab(tabItem.id)}
						>
							<CloseCircle size={14} />
						</button>
					</div>
				{/each}
			</div>
		</div>

		<div class="sidebar-footer">
			<div class="workspace-tab settings-tab" class:is-active={view === "settings"}>
				<button
					class="tab-select"
					type="button"
					aria-current={view === "settings" ? "page" : undefined}
					aria-label="Open settings"
					onclick={openSettings}
				>
					<span class="tab-kind" aria-hidden="true"><InfoCircle size={15} /></span>
					<span class="tab-title">Settings</span>
				</button>
			</div>
		</div>
	</aside>

	<div class="workspace-main">
		<header class="workspace-topbar">
			<div class="header-drag-zone">
				<span class="header-title">{documentTitle}</span>
			</div>
			<div class="window-controls">
				<button type="button" aria-label="Minimize Mars Kommander" onclick={minimizeWindow}>
					<Minimize size={17} />
				</button>
				<button
					type="button"
					aria-label={maximized ? "Restore Mars Kommander" : "Maximize Mars Kommander"}
					onclick={() => void toggleMaximizeWindow()}
				>
					<MaximizeSquare size={16} />
				</button>
				<button type="button" class="close" aria-label="Close Mars Kommander" onclick={closeWindow}>
					<CloseCircle size={17} />
				</button>
			</div>
		</header>
	{#if !hydrated}
		<main class="workspace-loading" aria-live="polite">
			{#if errorMessage}
				<div class="workspace-fatal" role="alert">
					<strong>Workspace unavailable</strong>
					<span>{errorMessage}</span>
				</div>
			{:else}
				<p>Loading workspace…</p>
			{/if}
		</main>
	{:else}
		<div class="workspace-body" style={view !== "workspace" ? "display: none;" : ""}>
			<main class="workspace-stages" aria-label="Workspace">
				{#if tabs.length === 0}
					<div class="workspace-empty-stage">
						<div class="empty-stage-card">
							<BranchMark size={44} />
							<h2>Mars Kommander</h2>
							<p>Open a terminal shell or a web browser to begin.</p>
							<div class="empty-stage-actions">
								<button type="button" class="empty-action-btn primary" onclick={() => void addTab("terminal")}>
									<Code size={16} aria-hidden="true" />
									<span>Open Terminal</span>
								</button>
								<button type="button" class="empty-action-btn" onclick={() => void addTab("browser")}>
									<Global size={16} aria-hidden="true" />
									<span>Open Browser</span>
								</button>
							</div>
						</div>
					</div>
				{/if}
				{#each tabs as tabItem (tabItem.id)}
					<section
						id={`stage-${tabItem.id}`}
						class="tab-stage"
						class:is-active={tabItem.id === activeTabId}
						class:layout-columns={tabItem.panes.length === 2 && tabItem.layout === "columns"}
						class:layout-rows={tabItem.panes.length === 2 && tabItem.layout === "rows"}
						class:layout-grid={tabItem.panes.length > 2}
						style={`--split-ratio: ${splitPreviewRatios.get(tabItem.id) ?? tabItem.ratio}`}
						aria-hidden={tabItem.id !== activeTabId}
					>
						{#each tabItem.panes as paneItem, paneIndex (paneItem.id)}
							{@const attachedAgent = findAgentForPane(paneItem.id, workspaceDocument, agents)}
							{@const transientTerminal = terminalStates.get(paneItem.id)}
							{@const renderedPane = attachedAgent
								? {
										...paneItem,
										...transientTerminal,
										title: attachedAgent.name || paneItem.title,
										agentId: attachedAgent.id,
										agent: attachedAgent,
									}
								: { ...paneItem, ...transientTerminal }}
							<WorkspacePaneView
								pane={renderedPane}
								attachedAgent={attachedAgent}
								workspaceId={activeWorkspaceId}
								tabId={tabItem.id}
								browserState={browserStates.get(paneItem.id)}
								selectionState={selectionStates.get(paneItem.id)}
								deliverableAgents={deliverableAgents}
								terminalSettings={appSettings?.terminal}
								theme={resolvedTheme}
								tabActive={tabItem.id === activeTabId}
								focused={tabItem.activePaneId === paneItem.id}
								canSplit={tabItem.panes.length < MAX_WORKSPACE_PANES}
								onActivate={() => activatePane(tabItem.id, paneItem.id)}
								onBrowserCreated={(state) => browserCreated(tabItem, paneItem, state)}
								onBrowserError={(message) => browserError(paneItem.id, message)}
								onBrowserNavigate={(address) => void navigateBrowser(paneItem.id, address)}
								onBrowserControl={(action) => controlBrowser(paneItem.id, action)}
								onTerminalReady={(cwd) => terminalReady(paneItem.id, cwd)}
								onTerminalStatus={(status, message) => terminalStatus(paneItem.id, status, message)}
								onTerminalTitle={(title) => terminalTitle(paneItem.id, title)}
								onSplit={(layout) => void splitPane(tabItem.id, paneItem.id, layout)}
								onClose={() => void closePane(tabItem.id, paneItem.id)}
								onToggleSelection={() => void toggleSelectionForPane(paneItem.id)}
								onCancelSelection={() => void cancelSelectionForPane(paneItem.id)}
								onCommitSelection={() => void commitSelectionForPane(paneItem.id)}
								onResetSelection={() => resetSelectionForPane(paneItem.id)}
								onChangeCaptureMode={(mode) => changeCaptureModeForPane(paneItem.id, mode)}
								onSelectRecipientAgent={(agentId) => selectRecipientAgentForPane(paneItem.id, agentId)}
							/>
							{#if tabItem.panes.length === 2 && paneIndex === 0}
								<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
								<div
									class="split-divider"
									role="separator"
									tabindex="0"
									aria-orientation={tabItem.layout === "rows" ? "horizontal" : "vertical"}
									aria-valuenow={Math.round(splitPreviewRatios.get(tabItem.id) ?? tabItem.ratio)}
									aria-valuemin={20}
									aria-valuemax={80}
									aria-label={tabItem.layout === "rows" ? "Resize horizontal split" : "Resize vertical split"}
									onpointerdown={(event) => beginResize(event, tabItem)}
									onlostpointercapture={() => void finishResize()}
									onkeydown={(event) => handleDividerKeydown(event, tabItem)}
								>
									<span></span>
								</div>
							{/if}
						{/each}
					</section>
				{/each}
			</main>
		</div>
		{#if view === "workspace"}
			<footer class="workspace-status">
				<div class="status-left">
					<Sidebar size={14} aria-hidden="true" />
					<span>{activeTab?.panes.length ?? 0} {activeTab?.panes.length === 1 ? "pane" : "panes"}</span>
				</div>
				<div class="status-center">
					<span class="status-dot"></span>
					<span>{connectionState === "reconnecting"
						? "Reconnecting to workspace runtime…"
						: activeTab?.kind === "browser"
							? (activePane?.status === "error" || browserStates.get(activePane?.id ?? "")?.error
								? "Browser unavailable"
								: browserStates.get(activePane?.id ?? "")?.loading
									? "Loading browser…"
									: activePane?.status === "starting"
										? "Opening browser…"
										: "Browser ready")
							: activePane?.status === "error"
								? "Terminal unavailable"
								: activePane?.status === "starting"
									? "Starting terminal…"
									: activePane?.status === "exited"
										? "Terminal exited"
										: activePane?.cwd ?? "Current repository"}</span>
				</div>
				<div>
					<Global size={14} aria-hidden="true" />
					<span>{browserCount} browser</span>
					<span class="status-separator"></span>
					<Code size={14} aria-hidden="true" />
					<span>{terminalCount} terminal</span>
				</div>
			</footer>
		{/if}
		{#if notice || errorMessage}
			<div
				class="workspace-notification-strip"
				class:is-error={Boolean(errorMessage)}
				role={errorMessage ? "alert" : "status"}
				aria-live={errorMessage ? "assertive" : "polite"}
			>
				<span class="notification-text">{errorMessage || notice}</span>
				{#if errorMessage}
					<button
						type="button"
						class="notification-dismiss"
						aria-label="Dismiss message"
						onclick={() => { errorMessage = ""; }}
					>
						<CloseCircle size={14} aria-hidden="true" />
					</button>
				{/if}
			</div>
		{/if}
		{#if view === "settings"}
			<SettingsView onBack={returnToWorkspace} onSettingsChange={(updated) => { appSettings = updated; applyTheme(updated.theme); }} />
		{/if}
	{/if}
	</div>
</div>
