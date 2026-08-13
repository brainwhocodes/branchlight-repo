import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	DESKTOP_TERMINAL_WORKER_ARG,
	type DesktopTerminalEvent,
	type DesktopTerminalRequest,
	type DesktopTerminalStartRequest,
} from "@oh-my-pi/pi-wire";
import type { WorkspaceEvent } from "../shared/contracts";
import { ompExecutablePath } from "./backend-path";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const START_TIMEOUT_MS = 15_000;

interface PendingStart {
	resolve(value: { id: string; cwd: string }): void;
	reject(error: Error): void;
	timeout: NodeJS.Timeout;
}

export class TerminalBridge {
	#child: ChildProcessWithoutNullStreams | undefined;
	#buffer = Buffer.alloc(0);
	#stderr = "";
	#pending = new Map<string, PendingStart>();
	#active = new Set<string>();
	#onEvent: (event: WorkspaceEvent) => void;

	constructor(onEvent: (event: WorkspaceEvent) => void) {
		this.#onEvent = onEvent;
	}

	async create(request: DesktopTerminalStartRequest): Promise<{ id: string; cwd: string }> {
		if (this.#active.has(request.id) || this.#pending.has(request.id)) throw new Error("Terminal already exists");
		const child = this.#ensureProcess();
		const started = Promise.withResolvers<{ id: string; cwd: string }>();
		const timeout = setTimeout(() => {
			this.#pending.delete(request.id);
			started.reject(new Error("Terminal start timed out"));
		}, START_TIMEOUT_MS);
		this.#pending.set(request.id, { resolve: started.resolve, reject: started.reject, timeout });
		this.#send(child, request);
		return started.promise;
	}

	write(id: string, data: string): void {
		if (!this.#active.has(id)) throw new Error("Terminal is unavailable");
		this.#send(this.#requireProcess(), { type: "input", id, data });
	}

	resize(id: string, cols: number, rows: number): void {
		if (!this.#active.has(id)) return;
		this.#send(this.#requireProcess(), { type: "resize", id, cols, rows });
	}

	close(id: string): void {
		const pending = this.#pending.get(id);
		if (pending) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Terminal closed before it started"));
			this.#pending.delete(id);
		}
		const active = this.#active.delete(id);
		if (!pending && !active) return;
		this.#send(this.#requireProcess(), { type: "close", id });
	}

	async shutdown(): Promise<void> {
		const child = this.#child;
		this.#child = undefined;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Terminal bridge stopped"));
		}
		this.#pending.clear();
		this.#active.clear();
		if (!child) return;
		try {
			this.#send(child, { type: "shutdown" });
		} catch {}
		const exited = Promise.withResolvers<void>();
		const onExit = (): void => exited.resolve();
		child.once("exit", onExit);
		const timeout = setTimeout(() => exited.resolve(), 1_500);
		await exited.promise;
		clearTimeout(timeout);
		child.removeListener("exit", onExit);
		if (child.exitCode === null && !child.killed) child.kill();
	}

	#ensureProcess(): ChildProcessWithoutNullStreams {
		if (this.#child && this.#child.exitCode === null) return this.#child;
		const fixture = process.env.BRANCHLIGHT_TERMINAL_FIXTURE;
		const child = spawn(
			fixture ? (process.env.BRANCHLIGHT_NODE ?? "node") : ompExecutablePath(),
			fixture ? [fixture] : [DESKTOP_TERMINAL_WORKER_ARG],
			{
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.#child = child;
		this.#buffer = Buffer.alloc(0);
		this.#stderr = "";
		child.stdout.on("data", chunk => this.#acceptData(Buffer.from(chunk)));
		child.stderr.on("data", chunk => {
			this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-16 * 1024);
		});
		child.once("error", error => this.#failProcess(error));
		child.once("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#child = undefined;
			const detail = this.#stderr.trim();
			this.#failProcess(
				new Error(`Terminal bridge exited (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`),
			);
		});
		return child;
	}

	#requireProcess(): ChildProcessWithoutNullStreams {
		const child = this.#child;
		if (!child || child.exitCode !== null) throw new Error("Terminal bridge is unavailable");
		return child;
	}

	#send(child: ChildProcessWithoutNullStreams, request: DesktopTerminalRequest): void {
		if (!child.stdin.writable) throw new Error("Terminal bridge input is closed");
		child.stdin.write(`${JSON.stringify(request)}\n`);
	}

	#acceptData(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		if (this.#buffer.byteLength > MAX_FRAME_BYTES) {
			this.#failProcess(new Error("Terminal bridge frame exceeded 8 MiB"));
			this.#child?.kill();
			return;
		}
		let newline = this.#buffer.indexOf(0x0a);
		while (newline >= 0) {
			const line = this.#buffer.subarray(0, newline);
			this.#buffer = this.#buffer.subarray(newline + 1);
			if (line.byteLength > 0) {
				try {
					this.#dispatch(JSON.parse(line.toString("utf8")) as DesktopTerminalEvent);
				} catch (error) {
					this.#failProcess(error instanceof Error ? error : new Error(String(error)));
				}
			}
			newline = this.#buffer.indexOf(0x0a);
		}
	}

	#dispatch(event: DesktopTerminalEvent): void {
		switch (event.type) {
			case "ready":
				return;
			case "started": {
				const pending = this.#pending.get(event.id);
				if (!pending) return;
				clearTimeout(pending.timeout);
				this.#pending.delete(event.id);
				this.#active.add(event.id);
				pending.resolve({ id: event.id, cwd: event.cwd });
				return;
			}
			case "data":
				if (this.#active.has(event.id) || this.#pending.has(event.id))
					this.#onEvent({ type: "terminal-data", paneId: event.id, data: event.data });
				return;
			case "exit":
				this.#active.delete(event.id);
				this.#onEvent({ type: "terminal-exit", paneId: event.id, exitCode: event.exitCode });
				return;
			case "error": {
				if (event.id) {
					const pending = this.#pending.get(event.id);
					if (pending) {
						clearTimeout(pending.timeout);
						this.#pending.delete(event.id);
						pending.reject(new Error(event.message));
					}
					this.#onEvent({ type: "terminal-error", paneId: event.id, message: event.message });
				} else {
					this.#failProcess(new Error(event.message));
				}
			}
		}
	}

	#failProcess(error: Error): void {
		logger.error("Desktop terminal bridge failed", { error: error.message });
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.#onEvent({ type: "terminal-error", paneId: id, message: error.message });
		}
		this.#pending.clear();
		for (const id of this.#active) this.#onEvent({ type: "terminal-error", paneId: id, message: error.message });
		this.#active.clear();
	}
}
