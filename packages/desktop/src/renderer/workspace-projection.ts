import type { WorkspaceDocumentV1, WorkspaceLocationV1, WorkspacePaneV1 } from "@oh-my-pi/pi-wire";
import type { WorkspacePane, WorkspaceTab } from "./workspace-types";

export interface ProjectedWorkspace {
	tabs: WorkspaceTab[];
	activeTabId: string;
	workspaceId: string;
}

export function projectWorkspaceTabs(
	document: WorkspaceDocumentV1 | undefined | null,
	preferredWorkspaceId?: string,
	currentActiveTabId?: string,
): ProjectedWorkspace {
	if (!document || !Array.isArray(document.workspaces) || document.workspaces.length === 0) {
		return { tabs: [], activeTabId: "", workspaceId: "" };
	}

	const targetWorkspace =
		document.workspaces.find(w => w.id === preferredWorkspaceId) ??
		document.workspaces.find(w => w.id === document.activeWorkspaceId) ??
		document.workspaces[0];

	if (!targetWorkspace) {
		return { tabs: [], activeTabId: "", workspaceId: "" };
	}

	const workspaceId = targetWorkspace.id;
	const locationsById = new Map<string, WorkspaceLocationV1>(document.locations.map(l => [l.id, l]));
	const panesById = new Map<string, WorkspacePaneV1>(document.panes.map(p => [p.id, p]));
	const terminalsById = new Map(document.terminals.map(t => [t.id, t]));
	const browsersById = new Map(document.browsers.map(b => [b.id, b]));

	const projectedTabs: WorkspaceTab[] = [];

	for (const durableTab of document.tabs) {
		if (durableTab.workspaceId !== workspaceId) continue;
		if (durableTab.paneKind !== "terminal" && durableTab.paneKind !== "browser") continue;

		const location = locationsById.get(durableTab.locationId);
		if (!location || location.lifecycle.generation !== durableTab.generation) continue;

		const projectedPanes: WorkspacePane[] = [];
		for (const paneId of durableTab.paneIds) {
			const durablePane = panesById.get(paneId);
			if (!durablePane || durablePane.tabId !== durableTab.id) continue;
			if (durablePane.kind !== "terminal" && durablePane.kind !== "browser") continue;

			let title = durablePane.title;
			let url: string | undefined;
			let cwd: string | undefined;
			let status: WorkspacePane["status"] = "starting";
			let error: string | undefined;

			if (durablePane.kind === "terminal") {
				const terminal = terminalsById.get(durablePane.entityId);
				if (!terminal || terminal.generation !== durableTab.generation) continue;
				if (!title) title = terminal.label || "Terminal";
				cwd = terminal.cwd;
				if (terminal.status === "running") status = "ready";
				else if (terminal.status === "failed") {
					status = "error";
					error = terminal.error || "Terminal failed";
				} else if (terminal.status === "exited" || terminal.status === "closed") {
					status = "exited";
				}
			} else {
				const browser = browsersById.get(durablePane.entityId);
				if (!browser || browser.generation !== durableTab.generation) continue;
				if (!title) title = browser.title || "New browser";
				url = browser.url || "https://omp.sh";
				if (browser.status === "open") status = "ready";
				else if (browser.status === "failed") {
					status = "error";
					error = (browser as { error?: string }).error || "Browser failed";
				} else if (browser.status === "closed") {
					status = "exited";
				}
			}

			projectedPanes.push({
				id: durablePane.id,
				kind: durablePane.kind,
				title: title || "Pane",
				url,
				cwd,
				status,
				error,
				tabId: durableTab.id,
				workspaceId,
			});
		}

		if (projectedPanes.length === 0) continue;

		const activePaneId = projectedPanes.some(p => p.id === durableTab.activePaneId)
			? durableTab.activePaneId
			: projectedPanes[0].id;

		projectedTabs.push({
			id: durableTab.id,
			kind: durableTab.paneKind,
			title: durableTab.name || "Tab",
			panes: projectedPanes,
			layout: durableTab.layout,
			ratio: durableTab.ratio,
			activePaneId,
			workspaceId,
		});
	}

	let activeTabId = "";
	if (currentActiveTabId && projectedTabs.some(t => t.id === currentActiveTabId)) {
		activeTabId = currentActiveTabId;
	} else if (projectedTabs.length > 0) {
		const firstTerminalTab = projectedTabs.find(t => t.kind === "terminal");
		activeTabId = firstTerminalTab ? firstTerminalTab.id : projectedTabs[0].id;
	}

	return {
		tabs: projectedTabs,
		activeTabId,
		workspaceId,
	};
}
