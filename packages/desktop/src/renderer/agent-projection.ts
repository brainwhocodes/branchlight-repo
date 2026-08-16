import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import type { AgentProcessStatus, WorkspaceAgent } from "./workspace-types";
import { getAgentSwatch } from "./workspace-types";

export function formatProfileName(profileId: string): string {
	if (profileId === "profile-omp") return "Oh My Pi";
	if (profileId === "profile-codex") return "Codex";
	if (profileId === "profile-claude") return "Claude Code";
	const clean = profileId.replace(/^profile-/, "");
	return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function reconcileWorkspaceAgents(
	doc: WorkspaceDocumentV1 | undefined,
	currentAgents: WorkspaceAgent[],
	activeWorkspaceId = "workspace-default",
): WorkspaceAgent[] {
	if (!doc) return currentAgents;
	const profileMap = new Map((doc.agentProfiles ?? []).map(p => [p.id, p]));
	const paneMap = new Map((doc.panes ?? []).map(p => [p.id, p]));
	const tabMap = new Map((doc.tabs ?? []).map(t => [t.id, t]));
	const terminalMap = new Map((doc.terminals ?? []).map(t => [t.id, t]));

	const activeDocAgents = (doc.agents ?? []).filter(agent => {
		const s = String(agent.status).toLowerCase();
		return s !== "stopped" && s !== "failed" && s !== "exited" && Boolean(agent.terminalId || agent.paneId);
	});

	const existingMap = new Map(currentAgents.map(a => [a.id, a]));
	const mappedAgents: WorkspaceAgent[] = [];
	const docAgentIds = new Set((doc.agents ?? []).map(a => a.id));

	for (const docAgent of activeDocAgents) {
		const profile = profileMap.get(docAgent.profileId);
		const existing = existingMap.get(docAgent.id);
		const name = profile?.name || (docAgent.profileId ? formatProfileName(docAgent.profileId) : docAgent.id);
		const role = profile?.protocol || profile?.name || docAgent.profileId || "agent";
		const status = (docAgent.status ?? "running") as AgentProcessStatus;

		let agentWorkspaceId: string | undefined;
		if (docAgent.paneId) {
			const pane = paneMap.get(docAgent.paneId);
			if (pane) {
				const tab = tabMap.get(pane.tabId);
				if (tab) agentWorkspaceId = tab.workspaceId;
			}
		}
		if (!agentWorkspaceId && docAgent.terminalId) {
			const terminal = terminalMap.get(docAgent.terminalId);
			if (terminal) {
				const pane = terminal.paneId
					? paneMap.get(terminal.paneId)
					: (doc.panes ?? []).find(p => p.entityId === terminal.id);
				if (pane) {
					const tab = tabMap.get(pane.tabId);
					if (tab) agentWorkspaceId = tab.workspaceId;
				}
			}
		}
		if (!agentWorkspaceId) {
			agentWorkspaceId = doc.activeWorkspaceId ?? activeWorkspaceId;
		}

		mappedAgents.push({
			id: docAgent.id,
			name,
			agent: role,
			status,
			swatch: existing?.swatch || getAgentSwatch(docAgent.id),
			workspaceId: agentWorkspaceId,
			deliverable: true,
			task: existing?.task,
			assignment: existing?.assignment,
			lastIntent: existing?.lastIntent,
			currentTool: existing?.currentTool,
			terminalId: docAgent.terminalId,
			paneId: docAgent.paneId,
			profileId: docAgent.profileId,
		});
	}

	// Only retain non-runtime subagents that are not tracked in doc.agents
	for (const existing of currentAgents) {
		if (!docAgentIds.has(existing.id) && !mappedAgents.some(a => a.id === existing.id)) {
			const s = String(existing.status).toLowerCase();
			if (s !== "stopped" && s !== "failed" && s !== "exited") {
				mappedAgents.push({
					...existing,
					deliverable: false,
				});
			}
		}
	}

	return mappedAgents;
}

export function findAgentForPane(
	paneId: string,
	doc: WorkspaceDocumentV1 | undefined,
	agentList: WorkspaceAgent[],
): WorkspaceAgent | undefined {
	const isAgentActive = (a: WorkspaceAgent): boolean => {
		const s = String(a.status).toLowerCase();
		return s !== "stopped" && s !== "failed" && s !== "exited" && Boolean(a.terminalId || a.paneId);
	};

	const byDirect = agentList.find(a => isAgentActive(a) && (a.paneId === paneId || a.terminalId === paneId));
	if (byDirect) return byDirect;

	if (doc?.terminals) {
		const terminal = doc.terminals.find(t => t.paneId === paneId || t.id === paneId);
		if (terminal) {
			const byTerminal = agentList.find(
				a =>
					isAgentActive(a) && (a.terminalId === terminal.id || (terminal.paneId && a.paneId === terminal.paneId)),
			);
			if (byTerminal) return byTerminal;
		}
	}

	return undefined;
}
