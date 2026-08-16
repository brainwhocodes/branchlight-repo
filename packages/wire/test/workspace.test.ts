import { describe, expect, it } from "bun:test";
import {
	encodeWorkspaceDocumentV1,
	parseWorkspaceCommandV1,
	parseWorkspaceDocumentV1,
	parseWorkspaceEventV1,
	parseWorkspaceSnapshotV1,
	WORKSPACE_MAX_NAME_BYTES,
	WorkspaceWireValidationError,
} from "../src";

const emptyDocument = {
	version: 1,
	revision: 0,
	activeWorkspaceId: null,
	workspaces: [],
	locations: [],
	tabs: [],
	panes: [],
	terminals: [],
	browsers: [],
	previews: [],
	agentProfiles: [],
	agents: [],
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
} as const;

describe("Workspace V1 wire acceptance boundary", () => {
	it("round-trips the empty golden document and projects its snapshot", () => {
		expect(encodeWorkspaceDocumentV1(emptyDocument)).toBe(JSON.stringify(emptyDocument));
		expect(parseWorkspaceSnapshotV1(emptyDocument).activeWorkspaceId).toBeNull();
	});
	it("rejects unknown versions, malformed IDs, and broken graph links", () => {
		expect(() => parseWorkspaceDocumentV1({ ...emptyDocument, version: 2 })).toThrow(WorkspaceWireValidationError);
		expect(() => parseWorkspaceDocumentV1({ ...emptyDocument, activeWorkspaceId: "bad id" })).toThrow(
			WorkspaceWireValidationError,
		);
		expect(() =>
			parseWorkspaceDocumentV1({
				...emptyDocument,
				locations: [
					{
						id: "loc",
						name: "Local",
						address: { kind: "local", path: "/tmp" },
						lifecycle: { status: "active", generation: 1, updatedAt: 0 },
					},
				],
				workspaces: [{ id: "ws", name: "Workspace", locationId: "missing", generation: 1 }],
			}),
		).toThrow(WorkspaceWireValidationError);
	});
	it("rejects oversized names and durable process/browser identities", () => {
		expect(() =>
			parseWorkspaceDocumentV1({
				...emptyDocument,
				notifications: [
					{
						id: "n",
						severity: "info",
						title: "x".repeat(WORKSPACE_MAX_NAME_BYTES + 1),
						message: "m",
						createdAt: 0,
					},
				],
			}),
		).toThrow(WorkspaceWireValidationError);
		expect(() =>
			parseWorkspaceDocumentV1({
				...emptyDocument,
				notifications: [{ id: "n", severity: "info", title: "x", message: "m", createdAt: 0, processId: 42 }],
			}),
		).toThrow(WorkspaceWireValidationError);
		expect(() =>
			parseWorkspaceDocumentV1({
				...emptyDocument,
				notifications: [{ id: "same", severity: "info", title: "x", message: "m", createdAt: 0 }],
				pendingCleanup: [{ id: "same", kind: "session", entityId: "session", attempts: 0, nextAttemptAt: 0 }],
			}),
		).toThrow(WorkspaceWireValidationError);
	});
	it("preserves executable agent profiles, negotiated capabilities, and runtime overlays", () => {
		const capability = { id: "cap", name: "Terminal", version: "1", scope: "agent" };
		const capabilities = {
			prompt: { text: true, image: false, resource: false },
			session: { create: true, load: true, resume: true, close: true },
			cancel: true,
			modes: true,
			config: true,
			filesystem: true,
			terminal: true,
			permissions: false,
			mcp: true,
		};
		const document = {
			...emptyDocument,
			capabilities: [capability],
			agentProfiles: [
				{
					id: "profile",
					name: "OMP",
					config: {},
					capabilityIds: ["cap"],
					exec: "omp",
					args: ["--cwd", "/tmp"],
					cwd: "/tmp",
					protocol: "omp",
					capabilities,
				},
			],
		};
		const parsed = parseWorkspaceDocumentV1(document);
		expect(parsed.agentProfiles[0]?.exec).toBe("omp");
		expect(parsed.agentProfiles[0]?.capabilities?.session.resume).toBe(true);
		const snapshot = parseWorkspaceSnapshotV1({
			...emptyDocument,
			runtime: {
				terminals: [
					{
						terminalId: "term",
						state: "running",
						health: "healthy",
						earliestOutputSequence: 1,
						nextOutputSequence: 2,
					},
				],
				capabilityFreshness: [{ capabilityId: "cap", state: "fresh", checkedAt: 4 }],
			},
		});
		expect(snapshot.runtime?.terminals?.[0]?.nextOutputSequence).toBe(2);
	});
	it("rejects transient browser bounds and pane collections over the durable cap", () => {
		const browser = {
			id: "b",
			locationId: "loc",
			generation: 1,
			url: "https://example.com",
			status: "open",
			bounds: { x: 0, y: 0, width: 1, height: 1 },
		};
		expect(() => parseWorkspaceDocumentV1({ ...emptyDocument, browsers: [browser] })).toThrow(
			WorkspaceWireValidationError,
		);
		const panes = Array.from({ length: 5 }, (_, index) => ({
			id: `p${index}`,
			tabId: "tab",
			generation: 1,
			kind: "browser",
			entityId: `b${index}`,
		}));
		expect(() => parseWorkspaceDocumentV1({ ...emptyDocument, panes })).toThrow(WorkspaceWireValidationError);
	});
	it("requires clean command metadata without client transport auth and ordered event metadata", () => {
		const command = {
			version: 1,
			commandId: "cmd",
			workspaceId: "ws",
			expectedRevision: 4,
			issuedAt: 1,
			type: "terminal.open",
			payload: {},
		} as const;
		expect(parseWorkspaceCommandV1(command).expectedRevision).toBe(4);
		expect(() => parseWorkspaceCommandV1({ ...command, auth: { token: "transport" } })).toThrow(
			WorkspaceWireValidationError,
		);
		expect(() => parseWorkspaceCommandV1({ ...command, principal: { kind: "user", id: "u" } })).toThrow(
			WorkspaceWireValidationError,
		);
		expect(
			parseWorkspaceEventV1({
				version: 1,
				eventId: "evt",
				workspaceId: "ws",
				sequence: 9,
				revision: 4,
				occurredAt: 1,
				type: "future",
				payload: { extension: true },
			}).type,
		).toBe("future");
		expect(() =>
			parseWorkspaceEventV1({
				version: 1,
				eventId: "evt",
				workspaceId: "ws",
				sequence: -1,
				revision: 4,
				occurredAt: 1,
				type: "workspace.updated",
				payload: {},
			}),
		).toThrow(WorkspaceWireValidationError);
	});
	it("accepts attach, detach, and tab command envelopes without client auth", () => {
		const attach = {
			version: 1,
			commandId: "attach",
			workspaceId: "ws",
			expectedRevision: 0,
			issuedAt: 1,
			type: "agent.attach",
			payload: { id: "agent", profileId: "profile", sessionId: "session", terminalId: "terminal", paneId: "pane" },
		} as const;
		expect(parseWorkspaceCommandV1(attach).type).toBe("agent.attach");
		expect(
			parseWorkspaceCommandV1({ ...attach, type: "agent.detach", payload: { id: "agent", reason: "exit" } }).type,
		).toBe("agent.detach");
		expect(
			parseWorkspaceCommandV1({ ...attach, type: "tab.update", payload: { id: "tab", name: "New Tab" } }).type,
		).toBe("tab.update");
		expect(parseWorkspaceCommandV1({ ...attach, type: "tab.close", payload: { id: "tab" } }).type).toBe("tab.close");
	});
	it("validates tab workspace ownership and topology links", () => {
		const location = {
			id: "loc",
			name: "Local",
			address: { kind: "local" as const, path: "/tmp" },
			lifecycle: { status: "active" as const, generation: 1, updatedAt: 0 },
		};
		const workspace = { id: "ws", name: "Workspace", locationId: "loc", generation: 1 };
		const pane = { id: "p1", tabId: "t1", generation: 1, kind: "terminal" as const, entityId: "term1" };
		const terminal = {
			id: "term1",
			locationId: "loc",
			paneId: "p1",
			generation: 1,
			label: "Term",
			status: "running" as const,
		};
		const tab = {
			id: "t1",
			workspaceId: "ws",
			locationId: "loc",
			generation: 1,
			name: "Tab",
			paneKind: "terminal" as const,
			layout: "columns" as const,
			ratio: 50,
			paneIds: ["p1"],
			activePaneId: "p1",
		};

		const doc = {
			...emptyDocument,
			locations: [location],
			workspaces: [workspace],
			tabs: [tab],
			panes: [pane],
			terminals: [terminal],
		};
		expect(parseWorkspaceDocumentV1(doc).tabs[0]?.workspaceId).toBe("ws");
		expect(() => parseWorkspaceDocumentV1({ ...doc, tabs: [{ ...tab, workspaceId: "other-ws" }] })).toThrow(
			WorkspaceWireValidationError,
		);
	});
});
