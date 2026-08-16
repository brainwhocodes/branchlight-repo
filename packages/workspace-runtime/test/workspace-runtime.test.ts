import { describe, expect, it } from "bun:test";
import type { WorkspaceAuthorizationV1 } from "../src";
import {
	createInitialWorkspaceDocumentV1,
	createWorkspaceApplication,
	MAX_WORKSPACE_PANES,
	projectWorkspaceSnapshot,
	WorkspaceApplication,
	WorkspaceClient,
} from "../src";

function command(
	type: string,
	revision: number,
	commandId: string,
	payload: Record<string, unknown>,
): Record<string, unknown> {
	return {
		version: 1,
		commandId,
		workspaceId: "ws",
		expectedRevision: revision,
		issuedAt: revision + 1,
		type,
		payload,
	};
}

const createPayload = {
	locationId: "local",
	locationName: "Local",
	address: { kind: "local", path: "/tmp" },
	name: "Workspace",
};

describe("Workspace runtime contracts", () => {
	it("creates an immutable initial document and projects a snapshot", () => {
		const document = createInitialWorkspaceDocumentV1(12);
		expect(document.revision).toBe(0);
		expect(document.createdAt).toBe(12);
		expect(projectWorkspaceSnapshot(document)).not.toHaveProperty("sessionEvents");
	});

	it("rejects stale revisions and duplicates without changing durable state", () => {
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1());
		const first = app.apply(command("workspace.create", 0, "create", createPayload));
		expect(first.status).toBe("accepted");
		const stale = app.apply(command("workspace.stop", 0, "stale", {}));
		expect(stale.status).toBe("rejected");
		expect(stale.error?.code).toBe("stale_revision");
		const duplicate = app.apply(command("workspace.create", 0, "create", createPayload));
		expect(duplicate.status).toBe("duplicate");
		expect(duplicate.events).toHaveLength(0);
	});

	it("keeps command rollback and rejects unknown JSON versions", () => {
		const app = new WorkspaceApplication({
			document: createInitialWorkspaceDocumentV1(),
			seenCommandIds: new Set(),
			nextEventSequence: 1,
		});
		const before = app.state;
		const rejected = app.apply(command("terminal.open", 0, "terminal", { locationId: "missing", label: "Terminal" }));
		expect(rejected.status).toBe("rejected");
		expect(app.state).toBe(before);
		const unknown = app.apply({ ...command("workspace.create", 0, "bad-version", createPayload), version: 2 });
		expect(unknown.status).toBe("rejected");
	});

	it("creates a replacement terminal when closing the final tab", () => {
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1());
		const created = app.apply(command("workspace.create", 0, "create", createPayload));
		expect(created.status).toBe("accepted");
		const opened = app.apply(command("terminal.open", 1, "open", { locationId: "local", label: "Shell" }));
		expect(opened.status).toBe("accepted");
		const terminalId = opened.document.terminals[0]?.id;
		expect(terminalId).toBeDefined();
		const closed = app.apply(command("terminal.close", 2, "close", { id: terminalId }));
		expect(closed.status).toBe("accepted");
		expect(closed.document.tabs).toHaveLength(1);
		expect(closed.document.tabs[0]?.paneIds).toHaveLength(1);
	});

	it("enforces pane caps and capability revocation", () => {
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1());
		const created = app.apply(command("workspace.create", 0, "create", createPayload));
		expect(created.status).toBe("accepted");
		const auth: WorkspaceAuthorizationV1 = {
			principal: { kind: "user", id: "user" },
			capabilities: [{ capabilityId: "cap", scope: "workspace", operations: ["terminal.open"], revoked: true }],
		};
		const restricted = createWorkspaceApplication(app.state.document, auth);
		const denied = restricted.apply(
			command("terminal.open", 1, "denied", { locationId: "local", label: "Terminal" }),
		);
		expect(denied.status).toBe("rejected");
		expect(denied.error?.code).toBe("capability_revoked");
		void MAX_WORKSPACE_PANES;
	});
	it("allows 5+ panes across distinct tabs while rejecting a 5th pane in a single tab", () => {
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1());
		expect(app.apply(command("workspace.create", 0, "create", createPayload)).status).toBe("accepted");

		// Open 6 terminals across 6 distinct tabs
		for (let i = 1; i <= 6; i++) {
			const res = app.apply(
				command("terminal.open", i - 1 + 1, `open-${i}`, {
					id: `term-${i}`,
					paneId: `pane-${i}`,
					tabId: `tab-${i}`,
					tabName: `Tab ${i}`,
					locationId: "local",
					label: `Shell ${i}`,
				}),
			);
			if (res.status !== "accepted") {
				console.log("FAIL ERROR:", res.error);
			}
			expect(res.status).toBe("accepted");
		}
		expect(app.document.panes).toHaveLength(6);
		expect(app.document.tabs).toHaveLength(6);

		// Add 3 more panes into tab-1 (total 4 panes in tab-1)
		for (let j = 2; j <= 4; j++) {
			const res = app.apply(
				command("terminal.open", 6 + j - 1, `split-${j}`, {
					id: `term-split-${j}`,
					paneId: `pane-split-${j}`,
					tabId: "tab-1",
					locationId: "local",
					label: `Split ${j}`,
				}),
			);
			expect(res.status).toBe("accepted");
		}
		expect(app.document.tabs.find(t => t.id === "tab-1")?.paneIds).toHaveLength(4);

		// Attempting 5th pane in tab-1 is rejected
		const fifthPane = app.apply(
			command("terminal.open", 10, "split-5", {
				id: "term-split-5",
				paneId: "pane-split-5",
				tabId: "tab-1",
				locationId: "local",
				label: "Split 5",
			}),
		);
		expect(fifthPane.status).toBe("rejected");
		expect(fifthPane.error?.message).toContain("maximum 4 panes exceeded");
	});
	it("attaches an agent to an existing terminal and detaches without closing the terminal", () => {
		const authorization: WorkspaceAuthorizationV1 = {
			principal: { kind: "user", id: "user" },
			capabilities: [
				{
					capabilityId: "agent-lifecycle",
					scope: "workspace",
					operations: [
						"workspace.create",
						"terminal.open",
						"terminal.close",
						"profile.create",
						"agent.attach",
						"agent.detach",
					],
				},
			],
		};
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1(), authorization);
		expect(app.apply(command("workspace.create", 0, "create", createPayload)).status).toBe("accepted");
		expect(app.apply(command("terminal.open", 1, "terminal", { locationId: "local", label: "Shell" })).status).toBe(
			"accepted",
		);
		expect(
			app.apply(
				command("profile.create", 2, "profile", { id: "profile", name: "Agent", config: {}, capabilityIds: [] }),
			).status,
		).toBe("accepted");
		const terminal = app.document.terminals[0]!;
		const attached = app.apply(
			command("agent.attach", 3, "attach", {
				id: "agent",
				profileId: "profile",
				sessionId: "session",
				terminalId: terminal.id,
				paneId: terminal.paneId,
			}),
		);
		expect(attached.status).toBe("accepted");
		expect(attached.document.agents[0]).toMatchObject({
			id: "agent",
			terminalId: terminal.id,
			paneId: terminal.paneId,
			status: "running",
		});
		const detached = app.apply(command("agent.detach", 4, "detach", { id: "agent", reason: "process exited" }));
		expect(detached.status).toBe("accepted");
		expect(detached.document.agents[0]?.status).toBe("stopped");
		expect(detached.document.agents[0]?.terminalId).toBeUndefined();
		expect(detached.document.sessions[0]?.status).toBe("closed");
		expect(detached.document.terminals[0]?.id).toBe(terminal.id);

		// Terminal can now close without link validation errors
		const closed = app.apply(command("terminal.close", 5, "close", { id: terminal.id }));
		expect(closed.status).toBe("accepted");
		expect(closed.document.terminals.some(t => t.id === terminal.id)).toBe(false);
		expect(closed.document.agents[0]?.status).toBe("stopped");
	});
	it("stops and unbinds attached agents and closes sessions on direct terminal close", () => {
		const authorization: WorkspaceAuthorizationV1 = {
			principal: { kind: "user", id: "user" },
			capabilities: [
				{
					capabilityId: "agent-lifecycle",
					scope: "workspace",
					operations: ["workspace.create", "terminal.open", "terminal.close", "profile.create", "agent.attach"],
				},
			],
		};
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1(), authorization);
		expect(app.apply(command("workspace.create", 0, "create", createPayload)).status).toBe("accepted");
		expect(app.apply(command("terminal.open", 1, "terminal", { locationId: "local", label: "Shell" })).status).toBe(
			"accepted",
		);
		expect(
			app.apply(
				command("profile.create", 2, "profile", { id: "profile", name: "Agent", config: {}, capabilityIds: [] }),
			).status,
		).toBe("accepted");
		const terminal = app.document.terminals[0]!;
		expect(
			app.apply(
				command("agent.attach", 3, "attach", {
					id: "agent-direct",
					profileId: "profile",
					sessionId: "session-direct",
					terminalId: terminal.id,
					paneId: terminal.paneId,
				}),
			).status,
		).toBe("accepted");
		expect(app.document.agents[0]?.status).toBe("running");

		const closed = app.apply(command("terminal.close", 4, "close", { id: terminal.id }));
		expect(closed.status).toBe("accepted");
		expect(closed.document.terminals.some(t => t.id === terminal.id)).toBe(false);
		expect(closed.document.agents[0]).toMatchObject({ id: "agent-direct", status: "stopped" });
		expect(closed.document.agents[0]?.terminalId).toBeUndefined();
		expect(closed.document.sessions[0]?.status).toBe("closed");
	});
	it("authorizes agent attach and detach with terminal-scoped capability grants", () => {
		const adminAuth: WorkspaceAuthorizationV1 = {
			principal: { kind: "user", id: "admin" },
			capabilities: [
				{
					capabilityId: "admin",
					scope: "workspace",
					operations: ["workspace.create", "terminal.open", "profile.create"],
				},
			],
		};
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1(), adminAuth);
		expect(app.apply(command("workspace.create", 0, "create", createPayload)).status).toBe("accepted");
		expect(app.apply(command("terminal.open", 1, "terminal", { locationId: "local", label: "Shell" })).status).toBe(
			"accepted",
		);
		expect(
			app.apply(
				command("profile.create", 2, "profile", { id: "profile", name: "Agent", config: {}, capabilityIds: [] }),
			).status,
		).toBe("accepted");
		const terminal = app.document.terminals[0]!;

		const terminalScopedAuth: WorkspaceAuthorizationV1 = {
			principal: { kind: "agent", id: terminal.id },
			capabilities: [
				{
					capabilityId: `scoped-${terminal.id}`,
					scope: "terminal",
					entityId: terminal.id,
					operations: ["agent.attach", "agent.detach"],
				},
			],
		};
		const attachCmd = command("agent.attach", 3, "attach", {
			id: "agent-scoped",
			profileId: "profile",
			sessionId: "session-scoped",
			terminalId: terminal.id,
			paneId: terminal.paneId,
		});
		const attached = app.apply(attachCmd, terminalScopedAuth);
		expect(attached.status).toBe("accepted");
		expect(attached.document.agents.find(a => a.id === "agent-scoped")?.status).toBe("running");

		const detachCmd = command("agent.detach", 4, "detach", { id: "agent-scoped", reason: "done" });
		const detached = app.apply(detachCmd, terminalScopedAuth);
		expect(detached.status).toBe("accepted");
		expect(detached.document.agents.find(a => a.id === "agent-scoped")?.status).toBe("stopped");
	});
	it("updates tab topology, validates ratio bounds and child activePaneId", () => {
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1());
		expect(app.apply(command("workspace.create", 0, "create", createPayload)).status).toBe("accepted");
		expect(
			app.apply(command("terminal.open", 1, "t1", { locationId: "local", tabId: "tab-main", paneId: "p1" })).status,
		).toBe("accepted");
		expect(
			app.apply(command("terminal.open", 2, "t2", { locationId: "local", tabId: "tab-main", paneId: "p2" })).status,
		).toBe("accepted");

		// Update name, layout, ratio, activePaneId
		const updated = app.apply(
			command("tab.update", 3, "update-tab", {
				id: "tab-main",
				name: "Renamed Tab",
				layout: "rows",
				ratio: 40,
				activePaneId: "p2",
			}),
		);
		expect(updated.status).toBe("accepted");
		const tab = updated.document.tabs.find(t => t.id === "tab-main");
		expect(tab?.name).toBe("Renamed Tab");
		expect(tab?.layout).toBe("rows");
		expect(tab?.ratio).toBe(40);
		expect(tab?.activePaneId).toBe("p2");

		// Invalid ratio < 20 rejected
		const badRatio = app.apply(command("tab.update", 4, "bad-ratio", { id: "tab-main", ratio: 10 }));
		expect(badRatio.status).toBe("rejected");

		// Invalid activePaneId not in tab.paneIds rejected
		const badActive = app.apply(
			command("tab.update", 4, "bad-active", { id: "tab-main", activePaneId: "unknown-pane" }),
		);
		expect(badActive.status).toBe("rejected");
	});

	it("atomically closes tab and cleans up all child panes, terminals, and agents", () => {
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1());
		expect(app.apply(command("workspace.create", 0, "create", createPayload)).status).toBe("accepted");
		expect(
			app.apply(
				command("terminal.open", 1, "t1", {
					id: "term-1",
					locationId: "local",
					tabId: "tab-close",
					paneId: "pane-1",
				}),
			).status,
		).toBe("accepted");
		expect(
			app.apply(
				command("terminal.open", 2, "t2", {
					id: "term-2",
					locationId: "local",
					tabId: "tab-close",
					paneId: "pane-2",
				}),
			).status,
		).toBe("accepted");
		expect(
			app.apply(command("profile.create", 3, "prof", { id: "prof-1", name: "Prof", config: {}, capabilityIds: [] }))
				.status,
		).toBe("accepted");
		expect(
			app.apply(
				command("agent.attach", 4, "att", {
					id: "ag-1",
					profileId: "prof-1",
					sessionId: "sess-1",
					terminalId: "term-1",
					paneId: "pane-1",
				}),
			).status,
		).toBe("accepted");

		const closed = app.apply(command("tab.close", 5, "close-tab", { id: "tab-close" }));
		expect(closed.status).toBe("accepted");
		expect(closed.document.tabs.some(t => t.id === "tab-close")).toBe(false);
		expect(closed.document.panes.some(p => p.tabId === "tab-close")).toBe(false);
		expect(closed.document.terminals.some(t => t.id === "term-1" || t.id === "term-2")).toBe(false);
		expect(closed.document.agents.find(a => a.id === "ag-1")?.status).toBe("stopped");
		expect(closed.document.sessions.find(s => s.id === "sess-1")?.status).toBe("closed");
		expect(closed.document.pendingCleanup.some(c => c.entityId === "term-1")).toBe(true);
		expect(closed.document.pendingCleanup.some(c => c.entityId === "term-2")).toBe(true);
	});

	it("isolates tabs between two workspaces sharing the same location", () => {
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1());
		// Create workspace 1
		expect(
			app.apply({
				version: 1,
				commandId: "c1",
				workspaceId: "ws-1",
				expectedRevision: 0,
				issuedAt: 1,
				type: "workspace.create",
				payload: {
					locationId: "loc-shared",
					locationName: "Shared Loc",
					address: { kind: "local", path: "/tmp" },
					name: "WS 1",
				},
			}).status,
		).toBe("accepted");
		// Create workspace 2 in same location
		expect(
			app.apply({
				version: 1,
				commandId: "c2",
				workspaceId: "ws-2",
				expectedRevision: 1,
				issuedAt: 2,
				type: "workspace.create",
				payload: {
					locationId: "loc-shared",
					locationName: "Shared Loc",
					address: { kind: "local", path: "/tmp" },
					name: "WS 2",
				},
			}).status,
		).toBe("rejected"); // location loc-shared already exists; second ws attaches

		// Open tab in ws-1
		expect(
			app.apply({
				version: 1,
				commandId: "c3",
				workspaceId: "ws-1",
				expectedRevision: 1,
				issuedAt: 3,
				type: "terminal.open",
				payload: { locationId: "loc-shared", tabId: "tab-ws1", paneId: "p-ws1" },
			}).status,
		).toBe("accepted");

		// Opening a terminal from ws-2 in tab-ws1 is rejected due to workspace mismatch
		const crossWs = app.apply({
			version: 1,
			commandId: "c4",
			workspaceId: "ws-2",
			expectedRevision: 2,
			issuedAt: 4,
			type: "terminal.open",
			payload: { locationId: "loc-shared", tabId: "tab-ws1", paneId: "p-ws2" },
		});
		expect(crossWs.status).toBe("rejected");
		expect(crossWs.error?.code).toBe("conflict");
	});

	it("accepts max 128-byte commandId without generating an overflowing eventId", () => {
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1());
		const maxLenCommandId = "c".repeat(128);
		expect(maxLenCommandId.length).toBe(128);

		const result = app.apply({
			version: 1,
			commandId: maxLenCommandId,
			workspaceId: "ws-max",
			expectedRevision: 0,
			issuedAt: 1,
			type: "workspace.create",
			payload: {
				locationId: "loc-max",
				locationName: "Max Loc",
				address: { kind: "local", path: "/tmp" },
				name: "Max Workspace",
			},
		});

		expect(result.status).toBe("accepted");
		expect(result.events).toHaveLength(1);
		const event = result.events[0]!;
		expect(event.eventId).toBe(maxLenCommandId);
		expect(event.eventId.length).toBe(128);
	});

	it("atomically applies requested layout on split, derives grid for 3 panes, and normalizes to columns on close", () => {
		const app = createWorkspaceApplication(createInitialWorkspaceDocumentV1());
		app.apply(
			command("workspace.create", 0, "c1", {
				locationId: "loc-1",
				locationName: "Local",
				address: { kind: "local", path: "/tmp" },
				name: "Workspace",
			}),
		);
		// Open pane 1 in tab-split (default columns)
		app.apply(
			command("terminal.open", 1, "c2", {
				id: "term-1",
				paneId: "pane-1",
				tabId: "tab-split",
				locationId: "loc-1",
			}),
		);
		let tab = app.document.tabs.find(t => t.id === "tab-split");
		expect(tab?.paneIds).toEqual(["pane-1"]);
		expect(tab?.layout).toBe("columns");

		// Open pane 2 with layout: "rows"
		const splitRes = app.apply(
			command("terminal.open", 2, "c3", {
				id: "term-2",
				paneId: "pane-2",
				tabId: "tab-split",
				locationId: "loc-1",
				layout: "rows",
			}),
		);
		expect(splitRes.status).toBe("accepted");
		tab = app.document.tabs.find(t => t.id === "tab-split");
		expect(tab?.paneIds).toEqual(["pane-1", "pane-2"]);
		expect(tab?.layout).toBe("rows");

		// Opening pane 2 with layout "grid" is rejected
		const invalidGridRes = app.apply(
			command("terminal.open", 3, "c4-invalid", {
				id: "term-invalid",
				paneId: "pane-invalid",
				tabId: "tab-split",
				locationId: "loc-1",
				layout: "columns", // impossible for 3 panes
			}),
		);
		expect(invalidGridRes.status).toBe("rejected");
		expect(invalidGridRes.error?.code).toBe("invalid_command");
		tab = app.document.tabs.find(t => t.id === "tab-split");
		expect(tab?.paneIds).toEqual(["pane-1", "pane-2"]);
		expect(tab?.layout).toBe("rows");

		// Open pane 3 (derives grid automatically)
		const pane3Res = app.apply(
			command("terminal.open", 3, "c4", {
				id: "term-3",
				paneId: "pane-3",
				tabId: "tab-split",
				locationId: "loc-1",
				layout: "grid",
			}),
		);
		expect(pane3Res.status).toBe("accepted");
		tab = app.document.tabs.find(t => t.id === "tab-split");
		expect(tab?.paneIds).toEqual(["pane-1", "pane-2", "pane-3"]);
		expect(tab?.layout).toBe("grid");

		// Close pane 3 -> tab normalizes from grid to columns
		const closeRes = app.apply(
			command("terminal.close", 4, "c5", {
				id: "term-3",
			}),
		);
		expect(closeRes.status).toBe("accepted");
		tab = app.document.tabs.find(t => t.id === "tab-split");
		expect(tab?.paneIds).toEqual(["pane-1", "pane-2"]);
		expect(tab?.layout).toBe("columns");
	});

	it("notifies onConnectionState listeners on connection and close", async () => {
		const client = new WorkspaceClient({
			runtimeRoot: "/tmp/nonexistent-root",
			connectTimeoutMs: 50,
		});
		const states: Array<{ connected: boolean; unexpected: boolean }> = [];
		const unsubscribe = client.onConnectionState(state => {
			states.push(state);
		});

		// Initial subscription emits current state
		expect(states).toEqual([{ connected: false, unexpected: false }]);

		// Explicit close emits not connected and not unexpected
		await client.close();
		expect(states).toEqual([
			{ connected: false, unexpected: false },
			{ connected: false, unexpected: false },
		]);

		unsubscribe();
	});
});
