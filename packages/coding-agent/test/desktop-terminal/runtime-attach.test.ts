import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceClient } from "@oh-my-pi/pi-workspace-runtime/client";
import { WorkspaceServer } from "@oh-my-pi/pi-workspace-runtime/server";
import { createBranchlightLifecycleExtension } from "../../src/desktop-terminal/runtime-attach";
import type { ExtensionAPI, ExtensionContext } from "../../src/extensibility/extensions/types";

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

describe("Branchlight terminal automatic agent attachment", () => {
	let testDir: string;
	let server: WorkspaceServer;
	let client: WorkspaceClient;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		const rawDir = await fs.mkdtemp(path.join(os.tmpdir(), "branchlight-attach-test-"));
		testDir = await fs.realpath(rawDir);
		server = new WorkspaceServer({ runtimeRoot: testDir });
		await server.start();

		client = new WorkspaceClient({ runtimeRoot: testDir });
		await client.connect();

		// 1. Create workspace
		await client.executeCommand({
			version: 1,
			commandId: "cmd-ws-create",
			workspaceId: "ws-test",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create",
			payload: {
				name: "Test Workspace",
				locationId: "loc-test",
				locationName: "Local",
				address: { kind: "local", path: testDir },
			},
		});

		// 2. Create terminal
		await client.executeCommand({
			version: 1,
			commandId: "cmd-term-create",
			workspaceId: "ws-test",
			expectedRevision: 1,
			issuedAt: Date.now(),
			type: "terminal.open",
			payload: {
				id: "term-pane-1",
				paneId: "pane-1",
				tabId: "tab-1",
				locationId: "loc-test",
				label: "Shell",
			},
		});

		// 3. Create OMP profile
		await client.executeCommand({
			version: 1,
			commandId: "cmd-prof-create",
			workspaceId: "ws-test",
			expectedRevision: client.document?.revision ?? 2,
			issuedAt: Date.now(),
			type: "profile.create",
			payload: {
				id: "profile-omp",
				name: "Oh My Pi",
				protocol: "omp",
				config: {},
			},
		});
	});

	afterEach(async () => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
		await client.close();
		if (server.isListening) {
			await server.stop();
		}
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("attaches the logical session on startup, switches it, and detaches cleanly", async () => {
		process.env.BRANCHLIGHT_TERMINAL = "1";
		process.env.PI_RUNTIME_DIR = testDir;
		process.env.PI_RUNTIME_TOKEN = server.controlToken;
		process.env.BRANCHLIGHT_TERMINAL_ID = "term-pane-1";
		process.env.BRANCHLIGHT_PANE_ID = "pane-1";
		process.env.BRANCHLIGHT_WORKSPACE_ID = "ws-test";
		process.env.BRANCHLIGHT_PROFILE_ID = "profile-omp";

		type LifecycleHandler = (event: unknown, context: unknown) => Promise<void>;
		const handlers = new Map<string, LifecycleHandler>();
		const extension = createBranchlightLifecycleExtension();
		expect(extension).toBeDefined();
		extension!({
			on(event: string, handler: LifecycleHandler) {
				handlers.set(event, handler);
			},
			logger: { error() {} },
		} as unknown as ExtensionAPI);
		const context = (sessionId: string) => ({
			hasUI: false,
			sessionManager: { getSessionId: () => sessionId },
		});

		await handlers.get("session_start")!({ type: "session_start" }, context("session-real"));
		const started = await client.getDocument();
		const firstAgent = started.agents.find(a => a.terminalId === "term-pane-1");
		expect(firstAgent?.id).toBe("branchlight-agent-profile-omp-session-real");
		expect(firstAgent?.status).toBe("running");
		expect(firstAgent?.sessionId).toBe("session-real");
		expect(firstAgent?.paneId).toBe("pane-1");

		await handlers.get("session_switch")!({ type: "session_switch", reason: "resume" }, context("session-next"));
		const switched = await client.getDocument();
		expect(switched.agents.find(a => a.id === firstAgent?.id)?.status).toBe("stopped");
		const secondAgent = switched.agents.find(a => a.sessionId === "session-next");
		expect(secondAgent?.status).toBe("running");
		expect(secondAgent?.id).toBe("branchlight-agent-profile-omp-session-next");

		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context("session-next"));
		const stopped = await client.getDocument();
		expect(stopped.agents.find(a => a.id === secondAgent?.id)?.status).toBe("stopped");
	});
	it("reattaches the same logical session cleanly after a new process/factory startup", async () => {
		process.env.BRANCHLIGHT_TERMINAL = "1";
		process.env.PI_RUNTIME_DIR = testDir;
		process.env.PI_RUNTIME_TOKEN = server.controlToken;
		process.env.BRANCHLIGHT_TERMINAL_ID = "term-pane-1";
		process.env.BRANCHLIGHT_PANE_ID = "pane-1";
		process.env.BRANCHLIGHT_WORKSPACE_ID = "ws-test";
		process.env.BRANCHLIGHT_PROFILE_ID = "profile-omp";

		type LifecycleHandler = (event: unknown, context: unknown) => Promise<void>;
		const context = (sessionId: string) => ({
			hasUI: false,
			sessionManager: { getSessionId: () => sessionId },
		});

		// First process run: attach and shutdown
		const handlersFirst = new Map<string, LifecycleHandler>();
		const extensionFirst = createBranchlightLifecycleExtension();
		expect(extensionFirst).toBeDefined();
		extensionFirst!({
			on(event: string, handler: LifecycleHandler) {
				handlersFirst.set(event, handler);
			},
			logger: { error() {} },
		} as unknown as ExtensionAPI);

		await handlersFirst.get("session_start")!({ type: "session_start" }, context("session-resumed"));
		let doc = await client.getDocument();
		const firstAgent = doc.agents.find(a => a.sessionId === "session-resumed");
		expect(firstAgent?.status).toBe("running");

		await handlersFirst.get("session_shutdown")!({ type: "session_shutdown" }, context("session-resumed"));
		doc = await client.getDocument();
		expect(doc.agents.find(a => a.sessionId === "session-resumed")?.status).toBe("stopped");

		// Second process run (new factory, fresh sequence counter): resume same session
		const handlersSecond = new Map<string, LifecycleHandler>();
		const extensionSecond = createBranchlightLifecycleExtension();
		expect(extensionSecond).toBeDefined();
		extensionSecond!({
			on(event: string, handler: LifecycleHandler) {
				handlersSecond.set(event, handler);
			},
			logger: { error() {} },
		} as unknown as ExtensionAPI);

		await handlersSecond.get("session_start")!({ type: "session_start" }, context("session-resumed"));
		doc = await client.getDocument();
		const resumedAgent = doc.agents.find(a => a.sessionId === "session-resumed");
		expect(resumedAgent?.status).toBe("running");
		expect(resumedAgent?.id).toBe(firstAgent?.id);

		await handlersSecond.get("session_shutdown")!({ type: "session_shutdown" }, context("session-resumed"));
		doc = await client.getDocument();
		expect(doc.agents.find(a => a.sessionId === "session-resumed")?.status).toBe("stopped");
	});

	it("does not create a lifecycle extension outside a Branchlight terminal", () => {
		delete process.env.BRANCHLIGHT_TERMINAL;
		delete process.env.PI_RUNTIME_TOKEN;
		delete process.env.BRANCHLIGHT_TERMINAL_ID;

		expect(createBranchlightLifecycleExtension()).toBeUndefined();
	});

	it("does not attach or register phantom agents when executing utility commands like --version", async () => {
		const cliPath = path.resolve(__dirname, "../../src/cli.ts");
		const proc = Bun.spawn([process.execPath, cliPath, "--version"], {
			env: {
				...process.env,
				BRANCHLIGHT_TERMINAL: "1",
				PI_RUNTIME_DIR: testDir,
				PI_RUNTIME_TOKEN: server.controlToken,
				BRANCHLIGHT_TERMINAL_ID: "term-pane-1",
				BRANCHLIGHT_PANE_ID: "pane-1",
				BRANCHLIGHT_WORKSPACE_ID: "ws-test",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
		await new Response(proc.stdout).text();

		// Document must remain empty of attached agents
		const doc = await client.getDocument();
		expect(doc.agents).toHaveLength(0);
	});

	it("delivers element selection and screenshot to agent turn via api.sendUserMessage", async () => {
		process.env.BRANCHLIGHT_TERMINAL = "1";
		process.env.PI_RUNTIME_DIR = testDir;
		process.env.PI_RUNTIME_TOKEN = server.controlToken;
		process.env.BRANCHLIGHT_TERMINAL_ID = "term-pane-1";
		process.env.BRANCHLIGHT_PANE_ID = "pane-1";
		process.env.BRANCHLIGHT_WORKSPACE_ID = "ws-test";

		const delivered = Promise.withResolvers<unknown[]>();
		const handlers = new Map<string, LifecycleHandler>();
		const extension = createBranchlightLifecycleExtension();
		expect(extension).toBeDefined();
		extension!({
			on(event: string, handler: LifecycleHandler) {
				handlers.set(event, handler);
			},
			sendUserMessage(content: unknown) {
				delivered.resolve(content as unknown[]);
			},
			logger: { error() {} },
		} as unknown as ExtensionAPI);
		const ctx = {
			sessionManager: { getSessionId: () => "sess-sel-delivery" },
			hasUI: false,
		} as unknown as ExtensionContext;

		await handlers.get("session_start")!({ type: "session_start" }, ctx);

		const doc = await client.getDocument();
		const attachedAgent = doc.agents.find(a => a.sessionId === "sess-sel-delivery");
		expect(attachedAgent).toBeDefined();

		// Execute agent.message with element edit context & screenshot
		await client.executeCommand({
			version: 1,
			commandId: "cmd-send-sel",
			workspaceId: "ws-test",
			expectedRevision: doc.revision,
			issuedAt: Date.now(),
			type: "agent.message",
			payload: {
				id: attachedAgent!.id,
				message: "User targeted browser element: `#submit-btn`",
				selector: "#submit-btn",
				url: "https://example.com/checkout",
				domSnapshot: '<button id="submit-btn">Checkout</button>',
				screenshot: {
					base64:
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			},
		});
		const lastDelivered = (await delivered.promise) as Array<{ type: string; data?: string; text?: string }>;
		expect(Array.isArray(lastDelivered)).toBe(true);
		expect(lastDelivered.some(part => part.type === "image" && part.data?.length)).toBe(true);
		expect(lastDelivered.some(part => part.type === "text" && part.text?.includes("#submit-btn"))).toBe(true);

		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
	});
});
