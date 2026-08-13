import { readJsonl } from "@oh-my-pi/pi-utils/stream";
import type { DesktopTerminalEvent, DesktopTerminalRequest, DesktopTerminalStartRequest } from "@oh-my-pi/pi-wire";

interface TerminalProcess {
	terminal: Bun.Terminal;
	process: Bun.Subprocess;
	decoder: TextDecoder;
	closed: boolean;
}

const terminals = new Map<string, TerminalProcess>();

function send(event: DesktopTerminalEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fail(message: string, id?: string): void {
	send({ type: "error", ...(id ? { id } : {}), message });
}

function closeTerminal(id: string): void {
	const entry = terminals.get(id);
	if (!entry) return;
	terminals.delete(id);
	entry.closed = true;
	try {
		entry.terminal.close();
	} catch {}
	try {
		entry.process.kill();
	} catch {}
}

function startTerminal(request: DesktopTerminalStartRequest): void {
	if (terminals.has(request.id)) {
		fail("Terminal already exists", request.id);
		return;
	}
	const decoder = new TextDecoder();
	try {
		const terminal = new Bun.Terminal({
			cols: request.cols,
			rows: request.rows,
			name: "xterm-256color",
			data: (_terminal, data) => {
				const text = decoder.decode(data, { stream: true });
				if (text.length > 0) send({ type: "data", id: request.id, data: text });
			},
		});
		const subprocess = Bun.spawn([request.shell, ...request.args], {
			cwd: request.cwd,
			env: request.env,
			terminal,
		});
		const entry: TerminalProcess = { terminal, process: subprocess, decoder, closed: false };
		terminals.set(request.id, entry);
		send({ type: "started", id: request.id, cwd: request.cwd });
		void subprocess.exited.then(
			exitCode => {
				const tail = decoder.decode();
				if (tail.length > 0) send({ type: "data", id: request.id, data: tail });
				if (!entry.closed) {
					terminals.delete(request.id);
					entry.closed = true;
					try {
						terminal.close();
					} catch {}
				}
				send({ type: "exit", id: request.id, exitCode });
			},
			error => {
				terminals.delete(request.id);
				fail(error instanceof Error ? error.message : String(error), request.id);
			},
		);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), request.id);
	}
}

function handleRequest(request: DesktopTerminalRequest): boolean {
	switch (request.type) {
		case "start":
			startTerminal(request);
			return true;
		case "input": {
			const entry = terminals.get(request.id);
			if (!entry) fail("Terminal is unavailable", request.id);
			else entry.terminal.write(request.data);
			return true;
		}
		case "resize": {
			const entry = terminals.get(request.id);
			if (!entry) fail("Terminal is unavailable", request.id);
			else entry.terminal.resize(request.cols, request.rows);
			return true;
		}
		case "close":
			closeTerminal(request.id);
			return true;
		case "shutdown":
			for (const id of terminals.keys()) closeTerminal(id);
			return false;
	}
}

export async function startDesktopTerminalWorker(): Promise<void> {
	send({ type: "ready" });
	try {
		for await (const request of readJsonl<DesktopTerminalRequest>(Bun.stdin.stream())) {
			if (!handleRequest(request)) return;
		}
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	} finally {
		for (const id of terminals.keys()) closeTerminal(id);
	}
}
