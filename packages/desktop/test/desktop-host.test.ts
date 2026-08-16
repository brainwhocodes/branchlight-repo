import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BranchlightEvent, ProcessState, SessionRecordV1 } from "../src/shared/contracts";

const processHarness = vi.hoisted(() => ({
	instances: [] as Array<{
		sessionFile?: string;
		startCalls: number;
		stopCalls: number;
		state: ProcessState;
	}>,
	promptResolvers: new Map<string, () => void>(),
}));

vi.mock("electron", () => ({
	dialog: { showOpenDialog: vi.fn() },
	shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock("../src/main/rpc-process", () => ({
	RpcProcess: class {
		readonly options: { onState: (state: ProcessState, error?: string) => void };
		sessionFile?: string;
		startCalls = 0;
		stopCalls = 0;
		state: ProcessState = "stopped";
		client:
			| {
					request: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
					prompt: (text: string) => Promise<void>;
					sendExtensionResponse: () => void;
			  }
			| undefined;

		constructor(options: { onState: (state: ProcessState, error?: string) => void }) {
			this.options = options;
			processHarness.instances.push(this);
		}

		async start(sessionFile?: string) {
			this.startCalls++;
			this.sessionFile = sessionFile;
			this.state = "starting";
			this.options.onState("starting");
			this.client = {
				request: async request => {
					switch (request.type) {
						case "get_state":
							return {
								success: true,
								command: "get_state",
								data: {
									sessionId: `omp-${this.sessionFile ?? "new"}`,
									sessionFile: this.sessionFile ?? "new-session.jsonl",
									fastModeEnabled: false,
									steeringMode: "all",
									followUpMode: "all",
									interruptMode: "immediate",
									autoCompactionEnabled: true,
									autoRetryEnabled: true,
									tokensPerSecond: null,
									queuedMessageCount: 0,
									todoPhases: [],
								},
							};
						case "get_messages_page":
							return { success: true, command: "get_messages_page", data: { messages: [] } };
						case "get_subagents":
							return { success: true, command: "get_subagents", data: { subagents: [] } };
						default:
							return { success: true, command: request.type, data: {} };
					}
				},
				prompt: text => {
					if (text !== "hold") return Promise.resolve();
					const pending = Promise.withResolvers<void>();
					processHarness.promptResolvers.set(this.sessionFile ?? "", pending.resolve);
					return pending.promise;
				},
				sendExtensionResponse: () => {},
			};
			this.state = "ready";
			this.options.onState("ready");
			return this.client;
		}

		async sample() {
			return { pid: 100 + processHarness.instances.indexOf(this), residentMemoryBytes: 1024 };
		}

		async stop() {
			this.stopCalls++;
			this.state = "stopping";
			this.options.onState("stopping");
			this.client = undefined;
			this.state = "stopped";
			this.options.onState("stopped");
		}
	},
}));

import { DesktopHost } from "../src/main/desktop-host";

const tempDirectories: string[] = [];
const hosts: DesktopHost[] = [];

afterEach(async () => {
	for (const resolve of processHarness.promptResolvers.values()) resolve();
	processHarness.promptResolvers.clear();
	await Promise.all(hosts.splice(0).map(host => host.close()));
	await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
	processHarness.instances.length = 0;
	vi.clearAllMocks();
});

function sessionRecord(id: string): SessionRecordV1 {
	return {
		id,
		kind: "code",
		cwd: `/workspace/${id}`,
		ompSessionId: `omp-${id}`,
		sessionFile: `${id}.jsonl`,
		title: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		lastOpenedAt: "2026-01-01T00:00:00.000Z",
	};
}

async function createHost(ids: string[]): Promise<DesktopHost> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "branchlight-desktop-host-"));
	tempDirectories.push(directory);
	await writeFile(
		path.join(directory, "sessions-v1.json"),
		`${JSON.stringify({
			version: 1,
			sessions: ids.map(sessionRecord),
			activeByKind: { work: null, code: null },
		})}\n`,
		"utf8",
	);
	const host = new DesktopHost(directory);
	hosts.push(host);
	await host.load();
	return host;
}

describe("DesktopHost runtime supervision", () => {
	it("registers restored sessions without starting their processes", async () => {
		await createHost(["one", "two"]);

		expect(processHarness.instances).toHaveLength(2);
		expect(processHarness.instances.map(instance => instance.startCalls)).toEqual([0, 0]);
		expect(processHarness.instances.map(instance => instance.state)).toEqual(["stopped", "stopped"]);
	});

	it("emits state-only runtime reports and includes the report in snapshots", async () => {
		const host = await createHost(["one"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);

		const snapshot = await host.openSession("one");
		const events = send.mock.calls
			.filter(([channel]) => channel === "branchlight:event")
			.map(([, event]) => event as BranchlightEvent);
		expect(processHarness.instances[0]?.sessionFile).toBe("one.jsonl");
		const stateOnly = events.find(event => event.type === "session" && event.runtime?.phase === "resident");

		expect(snapshot.runtime).toMatchObject({ id: "one", phase: "resident", processState: "ready" });
		expect(stateOnly).toMatchObject({
			sessionId: "one",
			type: "session",
			state: "ready",
			runtime: { id: "one", phase: "resident", processState: "ready" },
		});
		expect(stateOnly).not.toHaveProperty("record");
	});

	it("holds admission for each complete client command", async () => {
		const host = await createHost(["one", "two", "three", "four"]);
		const held = [host.prompt("one", "hold"), host.prompt("two", "hold"), host.prompt("three", "hold")];
		await vi.waitFor(() => expect(processHarness.promptResolvers.size).toBe(3));

		const fourth = host.prompt("four", "quick");
		await Promise.resolve();
		expect(processHarness.instances[3]?.startCalls).toBe(0);
		expect(processHarness.instances.slice(0, 3).map(instance => instance.stopCalls)).toEqual([0, 0, 0]);

		processHarness.promptResolvers.get("one.jsonl")?.();
		await held[0];
		await fourth;
		expect(processHarness.instances[3]?.startCalls).toBe(1);
		expect(processHarness.instances[0]?.stopCalls).toBe(1);

		processHarness.promptResolvers.get("two.jsonl")?.();
		processHarness.promptResolvers.get("three.jsonl")?.();
		await Promise.all(held.slice(1));
	});
});
