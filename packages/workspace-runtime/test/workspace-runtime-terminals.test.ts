import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type TerminalOutputChunk,
	WorkspaceClient,
	WorkspaceServer,
	WorkspaceSupervisor,
	WorkspaceTerminalManager,
	WorkspaceTerminalSession,
} from "../src";

describe("WorkspaceTerminalSession & Manager", () => {
	let supervisor: WorkspaceSupervisor;

	beforeEach(() => {
		supervisor = new WorkspaceSupervisor();
	});

	afterEach(async () => {
		await supervisor.stopAll();
	});

	it("starts PTY session, streams output chunks with monotonic offsets, and tracks history", async () => {
		const chunks: TerminalOutputChunk[] = [];
		const chunkSignal = Promise.withResolvers<TerminalOutputChunk>();

		const session = new WorkspaceTerminalSession({
			id: "term-test-1",
			shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
			args: process.platform === "win32" ? ["/c", "echo test-pty-output"] : ["-c", "echo test-pty-output"],
			supervisor,
			onData: (_id, chunk) => {
				chunks.push(chunk);
				chunkSignal.resolve(chunk);
			},
		});

		const pid = await session.start();
		expect(pid).toBeGreaterThan(0);
		expect(session.status).toBe("running");

		const firstChunk = await chunkSignal.promise;
		expect(firstChunk.offset).toBe(0);
		expect(firstChunk.data.length).toBeGreaterThan(0);

		// History query with offset
		const allHistory = session.getHistory(0);
		expect(allHistory.length).toBeGreaterThan(0);

		await session.close();
		expect(session.status).toBe("exited");
	});

	it("supports resize and input writing via manager", async () => {
		const manager = new WorkspaceTerminalManager({ supervisor });
		const session = await manager.createSession({
			id: "term-mgr-1",
			shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
			args: process.platform === "win32" ? ["/c", "echo hello"] : ["-c", "echo hello"],
			columns: 100,
			rows: 30,
		});

		expect(session.columns).toBe(100);
		expect(session.rows).toBe(30);

		manager.resize("term-mgr-1", 120, 40);
		expect(session.columns).toBe(120);
		expect(session.rows).toBe(40);

		expect(() => manager.write("term-mgr-1", "echo hello\n")).not.toThrow();

		await manager.close("term-mgr-1");
		expect(manager.sessionCount).toBe(0);
	});
	it("defaults to /bin/zsh on macOS when shell is not specified and executes zsh", async () => {
		if (process.platform !== "darwin") return;
		const outputPromise = Promise.withResolvers<string>();
		const session = new WorkspaceTerminalSession({
			id: "term-default-shell",
			supervisor,
			onData: (_id, chunk) => {
				if (chunk.data.includes("shell-id:zsh")) outputPromise.resolve(chunk.data);
			},
		});
		expect(session.shell).toBe("/bin/zsh");
		const pid = await session.start();
		expect(pid).toBeGreaterThan(0);
		expect(session.status).toBe("running");
		session.write("printf 'shell-id:%s\\n' \"$ZSH_NAME\"\n");
		const output = await Promise.race([outputPromise.promise, Bun.sleep(4000).then(() => "")]);
		expect(output).toContain("shell-id:zsh");
		await session.close();
	});

	it("allows explicit shell override on all platforms", async () => {
		const explicitShell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
		const session = new WorkspaceTerminalSession({
			id: "term-explicit-shell",
			shell: explicitShell,
			supervisor,
		});
		expect(session.shell).toBe(explicitShell);
		const pid = await session.start();
		expect(pid).toBeGreaterThan(0);
		await session.close();
	});
});

describe("WorkspaceServer terminal authority", () => {
	let root: string;
	let server: WorkspaceServer;
	let client: WorkspaceClient;

	beforeEach(async () => {
		root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "omp-terminal-server-")));
		server = new WorkspaceServer({ runtimeRoot: root });
		await server.start();
		client = new WorkspaceClient({ runtimeRoot: root });
		await client.connect();
	});

	afterEach(async () => {
		await client?.close().catch(() => {});
		if (server?.isListening) await server.stop();
		await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
	});

	it("owns the PTY, replays output by offset, and accepts transient input", async () => {
		const workspace = await client.executeCommand({
			version: 1,
			commandId: "cmd-terminal-workspace",
			workspaceId: "ws-terminal",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create",
			payload: {
				name: "Terminal Workspace",
				locationId: "loc-terminal",
				locationName: "Local",
				address: { kind: "local", path: root },
			},
		});
		expect(workspace.status).toBe("accepted");

		const opened = await client.executeCommand({
			version: 1,
			commandId: "cmd-terminal-open",
			workspaceId: "ws-terminal",
			expectedRevision: workspace.document.revision,
			issuedAt: Date.now(),
			type: "terminal.open",
			payload: {
				id: "term-authoritative",
				paneId: "pane-authoritative",
				tabId: "tab-authoritative",
				locationId: "loc-terminal",
				label: "Terminal",
				columns: 80,
				rows: 24,
			},
		});
		expect(opened.status).toBe("accepted");

		const marker = Promise.withResolvers<string>();
		const removeOutput = client.onTerminalOutput("term-authoritative", frame => {
			if (frame.data.includes("runtime-terminal-marker")) marker.resolve(frame.data);
		});
		const snapshot = await client.subscribeTerminal("term-authoritative", 0);
		expect(snapshot.status).toBe("running");
		await client.sendTerminalInput("term-authoritative", "printf 'runtime-terminal-marker\\n'\\n");
		const output = await Promise.race([marker.promise, Bun.sleep(5000).then(() => "")]);
		removeOutput();
		expect(output).toContain("runtime-terminal-marker");

		const current = await client.getDocument();
		const closed = await client.executeCommand({
			version: 1,
			commandId: "cmd-terminal-close",
			workspaceId: "ws-terminal",
			expectedRevision: current.revision,
			issuedAt: Date.now(),
			type: "terminal.close",
			payload: { id: "term-authoritative" },
		});
		expect(closed.status).toBe("accepted");
		expect(closed.document.terminals.some(item => item.id === "term-authoritative")).toBe(false);
	});

	it("accepts terminal.open with custom shell and args and launches process with them", async () => {
		const workspace = await client.executeCommand({
			version: 1,
			commandId: "cmd-workspace-custom-shell",
			workspaceId: "ws-custom-shell",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create",
			payload: {
				name: "Custom Shell Workspace",
				locationId: "loc-custom-shell",
				locationName: "Local",
				address: { kind: "local", path: root },
			},
		});
		expect(workspace.status).toBe("accepted");

		const customShell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
		const customArgs =
			process.platform === "win32" ? ["/c", "echo custom-shell-active"] : ["-c", "echo custom-shell-active"];

		const opened = await client.executeCommand({
			version: 1,
			commandId: "cmd-terminal-open-custom",
			workspaceId: "ws-custom-shell",
			expectedRevision: workspace.document.revision,
			issuedAt: Date.now(),
			type: "terminal.open",
			payload: {
				id: "term-custom-shell",
				paneId: "pane-custom-shell",
				tabId: "tab-custom-shell",
				locationId: "loc-custom-shell",
				label: "Custom Terminal",
				shell: customShell,
				args: customArgs,
				columns: 80,
				rows: 24,
			},
		});
		expect(opened.status).toBe("accepted");
		expect(opened.document.terminals.some(item => item.id === "term-custom-shell")).toBe(true);

		const marker = Promise.withResolvers<string>();
		const removeOutput = client.onTerminalOutput("term-custom-shell", frame => {
			if (frame.data.includes("custom-shell-active")) marker.resolve(frame.data);
		});
		const snapshot = await client.subscribeTerminal("term-custom-shell", 0);
		expect(snapshot.status).toBe("running");
		const output = await Promise.race([marker.promise, Bun.sleep(5000).then(() => "")]);
		removeOutput();
		expect(output).toContain("custom-shell-active");

		const current = await client.getDocument();
		await client.executeCommand({
			version: 1,
			commandId: "cmd-terminal-close-custom",
			workspaceId: "ws-custom-shell",
			expectedRevision: current.revision,
			issuedAt: Date.now(),
			type: "terminal.close",
			payload: { id: "term-custom-shell" },
		});
	});
});
