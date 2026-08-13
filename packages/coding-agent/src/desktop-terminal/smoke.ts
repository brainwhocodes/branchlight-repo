import { readJsonl } from "@oh-my-pi/pi-utils/stream";
import { DESKTOP_TERMINAL_WORKER_ARG, type DesktopTerminalEvent, type DesktopTerminalRequest } from "@oh-my-pi/pi-wire";
import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";

const PROBE_ID = "desktop-terminal-smoke";
const PROBE_TEXT = "terminal-bridge-ok";

function send(child: Bun.WritableSubprocess, request: DesktopTerminalRequest): void {
	child.stdin.write(`${JSON.stringify(request)}\n`);
	child.stdin.flush();
}

export async function smokeTestDesktopTerminalWorker(): Promise<void> {
	const spawnCommand = resolveWorkerSpawnCmd(DESKTOP_TERMINAL_WORKER_ARG);
	const child = Bun.spawn(spawnCommand.cmd, {
		cwd: spawnCommand.cwd,
		env: workerEnvFromParent(),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const result = Promise.withResolvers<void>();
	const abort = new AbortController();
	const timeout = setTimeout(
		() => result.reject(new Error("desktop terminal worker smoke timed out")),
		SMOKE_TEST_TIMEOUT_MS,
	);
	let output = "";
	void (async () => {
		try {
			for await (const event of readJsonl<DesktopTerminalEvent>(child.stdout, abort.signal)) {
				if (event.type === "ready") {
					const windows = process.platform === "win32";
					send(child, {
						type: "start",
						id: PROBE_ID,
						shell: windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
						args: windows ? ["/d", "/s", "/c", `echo ${PROBE_TEXT}`] : ["-lc", `printf ${PROBE_TEXT}`],
						cwd: process.cwd(),
						cols: 80,
						rows: 24,
						env: workerEnvFromParent({ TERM: "xterm-256color" }),
					});
				} else if (event.type === "data" && event.id === PROBE_ID) {
					output += event.data;
					if (output.includes(PROBE_TEXT)) result.resolve();
				} else if (event.type === "error") {
					result.reject(new Error(`desktop terminal worker smoke failed: ${event.message}`));
				} else if (event.type === "exit" && event.id === PROBE_ID && !output.includes(PROBE_TEXT)) {
					result.reject(new Error(`desktop terminal worker exited before output (${event.exitCode})`));
				}
			}
		} catch (error) {
			if (!abort.signal.aborted) result.reject(error);
		}
	})();
	try {
		await result.promise;
	} finally {
		clearTimeout(timeout);
		abort.abort();
		try {
			send(child, { type: "shutdown" });
		} catch {}
		child.kill();
		await child.exited;
	}
}
