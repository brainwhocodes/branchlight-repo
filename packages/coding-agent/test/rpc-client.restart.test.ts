import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { TempDir } from "@oh-my-pi/pi-utils";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("RpcClient lifecycle (issue #4079 B)", () => {
	test("transports a response larger than one MiB", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LARGE_RESPONSE: "1" },
		});

		await client.start();
		const state = (await client.getState()) as unknown as { payload: string };
		expect(state.payload).toBe("😀".repeat(400_000));
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 },
		]);
	}, 20_000);

	test("normalizes state fields omitted by the RPC server", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT });

		await client.start();
		const state = await client.getState();
		expect(state.fastModeEnabled).toBe(false);
		expect(state.fastModeActive).toBe(false);
		expect(state.tokensPerSecond).toBeNull();
	}, 20_000);

	test("rejects a request when its response command mismatches", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_MISMATCHED_RESPONSE: "1" },
		});

		await client.start();

		await expect(client.getState()).rejects.toThrow(
			"OMP gRPC response command mismatch for req_1: expected get_state, received get_messages",
		);
	}, 20_000);

	test("normalizes a runtime-invalid tokensPerSecond from the RPC server", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_INVALID_TPS: "1" },
		});

		await client.start();
		const state = await client.getState();
		expect(state.tokensPerSecond).toBeNull();
	}, 20_000);

	test("preserves getMessages snapshot behavior while a page walk is unavailable", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_PAGE_BUSY: "1" },
		});

		await client.start();
		await expect(client.getMessagesPage()).rejects.toThrow("Cannot page messages while the session is changing");
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
		]);
	}, 20_000);

	test("discards partial pages and falls back to get_messages when a cursor goes stale mid-walk", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_PAGE_STALE: "1" },
		});

		await client.start();
		const firstPage = await client.getMessagesPage();
		expect(firstPage.nextCursor).toBe("second-page");
		await expect(client.getMessagesPage({ cursor: firstPage.nextCursor })).rejects.toThrow(
			"RPC message cursor is stale",
		);
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
		]);
	}, 20_000);

	test("start() succeeds a second time after stop() on the same instance", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT });

		await client.start();
		await client.stop();
		await client.start();
		await client.stop();
	}, 20_000);

	test("stop() half-closes the request stream so the worker can clean up", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-graceful-stop-");
		const closedFile = tempDir.join("closed");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_CLOSED_FILE: closedFile },
		});

		await client.start();
		await client.stop();

		expect(await Bun.file(closedFile).text()).toBe("closed");
	}, 20_000);

	test("start() waits for the previous worker to be reaped after stop()", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-stop-restart-");
		const pidFile = tempDir.join("pid");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_PID_FILE: pidFile,
				MOCK_RPC_IGNORE_SIGTERM: process.platform === "win32" ? "0" : "1",
			},
		});

		await client.start();
		const firstPid = Number(await Bun.file(pidFile).text());

		const stopped = client.stop();
		const restarted = client.start();
		await Promise.all([stopped, restarted]);

		const secondPid = Number(await Bun.file(pidFile).text());
		expect(secondPid).not.toBe(firstPid);
		expect(isProcessAlive(firstPid)).toBe(false);
		await client.stop();
	}, 20_000);

	test("start() may be retried after a failed start", async () => {
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			provider: "__missing_provider__",
			model: "claude-sonnet-4-5",
			env: { PI_NO_TITLE: "1" },
		});

		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
	}, 30_000);

	test("stop() rejects active requests instead of leaving them to time out", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_IGNORE_COMMANDS: "1" },
		});
		await client.start();

		const pending = client.getState();
		void client.stop();

		await expect(pending).rejects.toThrow("Client stopped");
	});

	test("reports exit code and stderr when a ready worker exits", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_EXIT_ON_COMMAND: "23",
				MOCK_RPC_EXIT_STDERR: "fixture worker failed",
			},
		});
		await client.start();

		await expect(client.getState()).rejects.toThrow(
			"Agent process exited with code 23. Stderr: fixture worker failed",
		);
	});
});
