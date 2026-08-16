import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { findAgentForPane, reconcileWorkspaceAgents } from "../src/renderer/agent-projection";
import type { WorkspaceAgent } from "../src/renderer/workspace-types";

function createMockDocument(agents: WorkspaceDocumentV1["agents"] = []): WorkspaceDocumentV1 {
	return {
		version: 1,
		revision: 1,
		activeWorkspaceId: "ws-1",
		workspaces: [{ id: "ws-1", name: "Main Workspace", locationId: "loc-1", generation: 1 }],
		locations: [
			{
				id: "loc-1",
				name: "Local",
				address: { kind: "local", path: "/tmp" },
				lifecycle: { status: "active", generation: 1, updatedAt: 0 },
			},
		],
		tabs: [
			{
				id: "tab-1",
				locationId: "loc-1",
				generation: 1,
				name: "Terminal",
				paneKind: "terminal",
				layout: "columns",
				ratio: 50,
				paneIds: ["pane-1"],
				activePaneId: "pane-1",
			},
		],
		panes: [{ id: "pane-1", tabId: "tab-1", generation: 1, kind: "terminal", entityId: "term-1" }],
		terminals: [
			{ id: "term-1", locationId: "loc-1", paneId: "pane-1", generation: 1, label: "Terminal", status: "running" },
		],
		browsers: [],
		previews: [],
		agentProfiles: [{ id: "profile-omp", name: "Oh My Pi", protocol: "omp", config: {}, capabilityIds: [] }],
		agents,
		capabilities: [],
		sessions: [
			{
				id: "sess-1",
				locationId: "loc-1",
				actorId: "agent-1",
				kind: "agent",
				status: "active",
				capabilityIds: [],
				startedAt: 0,
				lastSeenAt: 0,
			},
		],
		sessionEvents: [],
		deliveryReceipts: [],
		services: [],
		worktrees: [],
		elementEdits: [],
		notifications: [],
		pendingCleanup: [],
		createdAt: 0,
		updatedAt: 0,
	};
}

describe("Agent pane projection and plain pane restoration", () => {
	it("projects attached running agent onto terminal pane and restores plain pane on detach", () => {
		// 1. Initial running document
		const runningDoc = createMockDocument([
			{
				id: "agent-1",
				profileId: "profile-omp",
				sessionId: "sess-1",
				terminalId: "term-1",
				paneId: "pane-1",
				status: "running",
			},
		]);

		let currentAgents: WorkspaceAgent[] = [];
		currentAgents = reconcileWorkspaceAgents(runningDoc, currentAgents, "ws-1");

		expect(currentAgents).toHaveLength(1);
		expect(currentAgents[0]).toMatchObject({
			id: "agent-1",
			name: "Oh My Pi",
			status: "running",
			terminalId: "term-1",
			paneId: "pane-1",
			deliverable: true,
		});

		const activeAgentOnPane = findAgentForPane("pane-1", runningDoc, currentAgents);
		expect(activeAgentOnPane).toBeDefined();
		expect(activeAgentOnPane?.id).toBe("agent-1");

		// 2. Stopped/detached document
		const stoppedDoc = createMockDocument([
			{
				id: "agent-1",
				profileId: "profile-omp",
				sessionId: "sess-1",
				status: "stopped",
			},
		]);

		currentAgents = reconcileWorkspaceAgents(stoppedDoc, currentAgents, "ws-1");

		// The stopped agent must not be preserved as a running pane agent
		expect(currentAgents.some(a => a.id === "agent-1" && a.status === "running")).toBe(false);

		// Pane immediately restores to plain terminal
		const plainPaneResult = findAgentForPane("pane-1", stoppedDoc, currentAgents);
		expect(plainPaneResult).toBeUndefined();
	});

	it("preserves non-runtime subagents while unbinding detached runtime agents", () => {
		const subagent: WorkspaceAgent = {
			id: "subagent-task-1",
			name: "Scout Subagent",
			agent: "scout",
			status: "running",
			swatch: "oklch(0.65 0.18 25)",
			workspaceId: "ws-1",
			deliverable: true,
		};

		let currentAgents: WorkspaceAgent[] = [subagent];

		const runningDoc = createMockDocument([
			{
				id: "agent-1",
				profileId: "profile-omp",
				sessionId: "sess-1",
				terminalId: "term-1",
				paneId: "pane-1",
				status: "running",
			},
		]);

		currentAgents = reconcileWorkspaceAgents(runningDoc, currentAgents, "ws-1");
		expect(currentAgents).toHaveLength(2);
		expect(currentAgents.some(a => a.id === "subagent-task-1")).toBe(true);

		// On detach
		const stoppedDoc = createMockDocument([
			{
				id: "agent-1",
				profileId: "profile-omp",
				sessionId: "sess-1",
				status: "stopped",
			},
		]);

		currentAgents = reconcileWorkspaceAgents(stoppedDoc, currentAgents, "ws-1");
		// Subagent is preserved as deliverable: false, but detached agent-1 is gone/unbound
		expect(currentAgents).toHaveLength(1);
		expect(currentAgents[0]?.id).toBe("subagent-task-1");
		expect(currentAgents[0]?.deliverable).toBe(false);
		expect(findAgentForPane("pane-1", stoppedDoc, currentAgents)).toBeUndefined();
	});

	it("projects multiple concurrent panes in one window with distinct Claude Code, Codex, and OMP agents", () => {
		const multiPaneDoc: WorkspaceDocumentV1 = {
			version: 1,
			revision: 1,
			activeWorkspaceId: "ws-1",
			workspaces: [{ id: "ws-1", name: "Main Workspace", locationId: "loc-1", generation: 1 }],
			locations: [
				{
					id: "loc-1",
					name: "Local",
					address: { kind: "local", path: "/tmp" },
					lifecycle: { status: "active", generation: 1, updatedAt: 0 },
				},
			],
			tabs: [
				{
					id: "tab-multi",
					locationId: "loc-1",
					generation: 1,
					name: "Workspace",
					paneKind: "terminal",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-term-claude", "pane-term-omp", "pane-browser-1"],
					activePaneId: "pane-term-claude",
				},
			],
			panes: [
				{ id: "pane-term-claude", tabId: "tab-multi", generation: 1, kind: "terminal", entityId: "term-claude" },
				{ id: "pane-term-omp", tabId: "tab-multi", generation: 1, kind: "terminal", entityId: "term-omp" },
				{ id: "pane-browser-1", tabId: "tab-multi", generation: 1, kind: "browser", entityId: "browser-1" },
			],
			terminals: [
				{
					id: "term-claude",
					locationId: "loc-1",
					paneId: "pane-term-claude",
					generation: 1,
					label: "Claude Shell",
					status: "running",
				},
				{
					id: "term-omp",
					locationId: "loc-1",
					paneId: "pane-term-omp",
					generation: 1,
					label: "OMP Shell",
					status: "running",
				},
			],
			browsers: [
				{
					id: "browser-1",
					locationId: "loc-1",
					paneId: "pane-browser-1",
					generation: 1,
					url: "https://omp.sh",
					status: "open",
				},
			],
			previews: [],
			agentProfiles: [
				{ id: "profile-claude", name: "Claude Code", protocol: "terminal", config: {}, capabilityIds: [] },
				{ id: "profile-omp", name: "Oh My Pi", protocol: "omp", config: {}, capabilityIds: [] },
				{ id: "profile-codex", name: "Codex", protocol: "acp", config: {}, capabilityIds: [] },
			],
			agents: [
				{
					id: "agent-claude-1",
					profileId: "profile-claude",
					sessionId: "sess-claude",
					terminalId: "term-claude",
					paneId: "pane-term-claude",
					status: "running",
				},
				{
					id: "agent-omp-1",
					profileId: "profile-omp",
					sessionId: "sess-omp",
					terminalId: "term-omp",
					paneId: "pane-term-omp",
					status: "running",
				},
			],
			capabilities: [],
			sessions: [],
			sessionEvents: [],
			deliveryReceipts: [],
			services: [],
			worktrees: [],
			elementEdits: [],
			notifications: [],
			pendingCleanup: [],
			createdAt: 0,
			updatedAt: 0,
		};

		const reconciled = reconcileWorkspaceAgents(multiPaneDoc, [], "ws-1");
		expect(reconciled).toHaveLength(2);

		const claudeAgent = findAgentForPane("pane-term-claude", multiPaneDoc, reconciled);
		expect(claudeAgent).toBeDefined();
		expect(claudeAgent?.name).toBe("Claude Code");
		expect(claudeAgent?.agent).toBe("terminal");
		expect(claudeAgent?.paneId).toBe("pane-term-claude");

		const ompAgent = findAgentForPane("pane-term-omp", multiPaneDoc, reconciled);
		expect(ompAgent).toBeDefined();
		expect(ompAgent?.name).toBe("Oh My Pi");
		expect(ompAgent?.agent).toBe("omp");
		expect(ompAgent?.paneId).toBe("pane-term-omp");

		const browserAgent = findAgentForPane("pane-browser-1", multiPaneDoc, reconciled);
		expect(browserAgent).toBeUndefined();
	});

	it("updates agent name and protocol when authoritative profile changes, without cached values overriding", () => {
		const initialDoc = createMockDocument([
			{
				id: "agent-1",
				locationId: "loc-1",
				profileId: "profile-omp",
				terminalId: "term-1",
				paneId: "pane-1",
				generation: 1,
				status: "running",
				createdAt: 0,
				updatedAt: 0,
			},
		]);

		const initialAgents = reconcileWorkspaceAgents(initialDoc, [], "ws-1");
		expect(initialAgents[0].name).toBe("Oh My Pi");
		expect(initialAgents[0].agent).toBe("omp");

		// Profile is renamed in authoritative document
		const renamedDoc: WorkspaceDocumentV1 = {
			...initialDoc,
			agentProfiles: [
				{ id: "profile-omp", name: "Renamed Assistant", protocol: "custom-proto", config: {}, capabilityIds: [] },
			],
		};

		const updatedAgents = reconcileWorkspaceAgents(renamedDoc, initialAgents, "ws-1");
		expect(updatedAgents[0].name).toBe("Renamed Assistant");
		expect(updatedAgents[0].agent).toBe("custom-proto");
	});

	it("derives agent workspace from pane -> tab ownership rather than default active workspace", () => {
		const multiWsDoc: WorkspaceDocumentV1 = {
			...createMockDocument(),
			activeWorkspaceId: "ws-active",
			workspaces: [
				{ id: "ws-active", name: "Active WS", locationId: "loc-1", generation: 1 },
				{ id: "ws-other", name: "Other WS", locationId: "loc-1", generation: 1 },
			],
			tabs: [
				{
					id: "tab-other",
					workspaceId: "ws-other",
					locationId: "loc-1",
					generation: 1,
					name: "Other Tab",
					paneKind: "terminal",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-other"],
					activePaneId: "pane-other",
				},
			],
			panes: [{ id: "pane-other", tabId: "tab-other", generation: 1, kind: "terminal", entityId: "term-other" }],
			terminals: [
				{
					id: "term-other",
					locationId: "loc-1",
					paneId: "pane-other",
					generation: 1,
					label: "Terminal",
					status: "running",
				},
			],
			agents: [
				{
					id: "agent-other",
					locationId: "loc-1",
					profileId: "profile-omp",
					paneId: "pane-other",
					terminalId: "term-other",
					generation: 1,
					status: "running",
					createdAt: 0,
					updatedAt: 0,
				},
			],
		};

		const reconciled = reconcileWorkspaceAgents(multiWsDoc, [], "ws-active");
		expect(reconciled).toHaveLength(1);
		expect(reconciled[0].workspaceId).toBe("ws-other");
	});
});
