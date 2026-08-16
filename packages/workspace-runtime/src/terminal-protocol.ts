export type { TerminalOutputChunk } from "./terminal";
export const TERMINAL_MAX_INPUT_BYTES = 512 * 1024;
export const TERMINAL_MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;
export const TERMINAL_MIN_DIMENSION = 2;
export const TERMINAL_MAX_DIMENSION = 500;

export interface TerminalSubscribeFrame {
	type: "terminal.subscribe";
	requestId: string;
	terminalId: string;
	fromOffset: number;
}

export interface TerminalUnsubscribeFrame {
	type: "terminal.unsubscribe";
	requestId: string;
	terminalId: string;
}

export interface TerminalInputFrame {
	type: "terminal.input";
	requestId: string;
	terminalId: string;
	data: string;
}

export interface TerminalResizeFrame {
	type: "terminal.resize";
	requestId: string;
	terminalId: string;
	columns: number;
	rows: number;
}

export interface TerminalStatusFrame {
	type: "terminal.status";
	requestId: string;
	terminalId: string;
	status: "starting" | "running" | "exited" | "failed" | "closed";
	pid?: number;
	cwd?: string;
	columns?: number;
	rows?: number;
	totalBytesProduced: number;
}

export interface TerminalOutputFrame {
	type: "terminal.output";
	terminalId: string;
	offset: number;
	data: string;
	timestamp: number;
}

export interface TerminalRequestResultFrame {
	type: "terminal.result";
	requestId: string;
	terminalId: string;
	ok: boolean;
	message?: string;
}

export type TerminalTransientFrame =
	| TerminalSubscribeFrame
	| TerminalUnsubscribeFrame
	| TerminalInputFrame
	| TerminalResizeFrame
	| TerminalStatusFrame
	| TerminalOutputFrame
	| TerminalRequestResultFrame;
