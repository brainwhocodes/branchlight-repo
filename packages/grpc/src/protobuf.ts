import type { OmpGrpcClientFrame, OmpGrpcServerFrame } from "./types";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

type WireType = 0 | 1 | 2 | 3 | 4 | 5;

class ProtobufWriter {
	#parts: Uint8Array[] = [];
	#length = 0;

	uint32(field: number, value: number): void {
		if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
			throw new RangeError("uint32 value is out of range");
		if (value === 0) return;
		this.#tag(field, 0);
		this.#varint(BigInt(value));
	}

	uint64(field: number, value: number): void {
		if (value === 0) return;
		if (!Number.isSafeInteger(value) || value < 0)
			throw new RangeError("uint64 value is outside JavaScript's safe integer range");
		this.#tag(field, 0);
		this.#varint(BigInt(value));
	}

	bool(field: number, value: boolean): void {
		if (!value) return;
		this.#tag(field, 0);
		this.#varint(1n);
	}

	string(field: number, value: string): void {
		if (value.length === 0) return;
		this.bytes(field, textEncoder.encode(value));
	}

	bytes(field: number, value: Uint8Array): void {
		if (value.byteLength === 0) return;
		this.#tag(field, 2);
		this.#varint(BigInt(value.byteLength));
		this.#append(value);
	}

	message(field: number, write: (writer: ProtobufWriter) => void): void {
		const nested = new ProtobufWriter();
		write(nested);
		const bytes = nested.finish();
		this.#tag(field, 2);
		this.#varint(BigInt(bytes.byteLength));
		if (bytes.byteLength > 0) this.#append(bytes);
	}

	finish(): Uint8Array {
		if (this.#parts.length === 1) return this.#parts[0]!;
		const output = new Uint8Array(this.#length);
		let offset = 0;
		for (const part of this.#parts) {
			output.set(part, offset);
			offset += part.byteLength;
		}
		return output;
	}

	#tag(field: number, wireType: WireType): void {
		if (!Number.isInteger(field) || field <= 0 || field > 0x1fffffff)
			throw new RangeError("invalid protobuf field number");
		this.#varint(BigInt(field * 8 + wireType));
	}

	#varint(value: bigint): void {
		const bytes: number[] = [];
		do {
			let byte = Number(value & 0x7fn);
			value >>= 7n;
			if (value !== 0n) byte |= 0x80;
			bytes.push(byte);
		} while (value !== 0n);
		this.#append(Uint8Array.from(bytes));
	}

	#append(bytes: Uint8Array): void {
		this.#parts.push(bytes);
		this.#length += bytes.byteLength;
	}
}

class ProtobufReader {
	#offset = 0;

	constructor(private readonly bytes: Uint8Array) {}

	get done(): boolean {
		return this.#offset === this.bytes.byteLength;
	}

	tag(): { field: number; wireType: WireType } {
		const tag = this.varint();
		const field = Number(tag >> 3n);
		const wireType = Number(tag & 7n);
		if (field <= 0 || field > 0x1fffffff) throw new Error("invalid protobuf field number");
		if (wireType < 0 || wireType > 5) throw new Error(`unsupported protobuf wire type ${wireType}`);
		return { field, wireType: wireType as WireType };
	}

	varint(): bigint {
		let value = 0n;
		for (let shift = 0n; shift < 70n; shift += 7n) {
			if (this.#offset >= this.bytes.byteLength) throw new Error("truncated protobuf varint");
			const byte = this.bytes[this.#offset++]!;
			value |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) {
				if (shift === 63n && byte > 1) throw new Error("protobuf varint exceeds 64 bits");
				return value;
			}
		}
		throw new Error("protobuf varint exceeds 64 bits");
	}

	bool(wireType: WireType): boolean {
		this.#expect(wireType, 0);
		return this.varint() !== 0n;
	}

	uint32(wireType: WireType): number {
		this.#expect(wireType, 0);
		const value = this.varint();
		if (value > 0xffffffffn) throw new Error("protobuf uint32 is out of range");
		return Number(value);
	}

	uint64(wireType: WireType): number {
		this.#expect(wireType, 0);
		const value = this.varint();
		if (value > MAX_SAFE_BIGINT) throw new Error("protobuf uint64 exceeds JavaScript's safe integer range");
		return Number(value);
	}

	string(wireType: WireType): string {
		return textDecoder.decode(this.byteString(wireType));
	}

	byteString(wireType: WireType): Uint8Array {
		this.#expect(wireType, 2);
		const length = this.varint();
		if (length > MAX_SAFE_BIGINT) throw new Error("protobuf byte string is too large");
		const end = this.#offset + Number(length);
		if (end > this.bytes.byteLength) throw new Error("truncated protobuf byte string");
		const value = this.bytes.subarray(this.#offset, end);
		this.#offset = end;
		return value;
	}

	skip(field: number, wireType: WireType): void {
		switch (wireType) {
			case 0:
				this.varint();
				return;
			case 1:
				this.#advance(8);
				return;
			case 2: {
				const length = this.varint();
				if (length > MAX_SAFE_BIGINT) throw new Error("protobuf field is too large");
				this.#advance(Number(length));
				return;
			}
			case 3:
				while (!this.done) {
					const nested = this.tag();
					if (nested.wireType === 4) {
						if (nested.field !== field) throw new Error("mismatched protobuf end-group field");
						return;
					}
					this.skip(nested.field, nested.wireType);
				}
				throw new Error("truncated protobuf group");
			case 4:
				throw new Error("unexpected protobuf end-group field");
			case 5:
				this.#advance(4);
				return;
		}
	}

	#expect(actual: WireType, expected: WireType): void {
		if (actual !== expected) throw new Error(`unexpected protobuf wire type ${actual}; expected ${expected}`);
	}

	#advance(length: number): void {
		const end = this.#offset + length;
		if (end > this.bytes.byteLength) throw new Error("truncated protobuf field");
		this.#offset = end;
	}
}

function encodeJson(value: unknown): Uint8Array {
	const json = JSON.stringify(value);
	if (json === undefined) throw new TypeError("value is not JSON-serializable");
	return textEncoder.encode(json);
}

function decodeJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(textDecoder.decode(bytes));
	} catch (error) {
		throw new Error("invalid JSON protobuf payload", { cause: error });
	}
}

function decodeRecord(bytes: Uint8Array): Record<string, unknown> {
	const value = decodeJson(bytes);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("JSON payload must be an object");
	return value as Record<string, unknown>;
}

export function encodeClientFrame(frame: OmpGrpcClientFrame): Uint8Array {
	const writer = new ProtobufWriter();
	if (frame.kind === "command") {
		writer.message(1, command => {
			if (frame.command.id !== undefined) {
				command.string(1, frame.command.id);
				command.bool(4, true);
			}
			command.string(2, frame.command.command);
			command.bytes(3, encodeJson(frame.command.payload));
		});
	} else {
		writer.message(2, push => {
			push.string(1, frame.type);
			push.bytes(2, encodeJson(frame.payload));
		});
	}
	return writer.finish();
}

export function decodeClientFrame(bytes: Uint8Array): OmpGrpcClientFrame {
	const reader = new ProtobufReader(bytes);
	let frame: OmpGrpcClientFrame | undefined;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1) frame = decodeCommand(reader.byteString(wireType));
		else if (field === 2) frame = decodePush(reader.byteString(wireType));
		else reader.skip(field, wireType);
	}
	if (!frame) throw new Error("ClientFrame has no frame");
	return frame;
}

function decodeCommand(bytes: Uint8Array): OmpGrpcClientFrame {
	const reader = new ProtobufReader(bytes);
	let id = "";
	let hasId = false;
	let command = "";
	let payload: Record<string, unknown> = {};
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1) {
			id = reader.string(wireType);
			hasId = true;
		} else if (field === 2) command = reader.string(wireType);
		else if (field === 3) payload = decodeRecord(reader.byteString(wireType));
		else if (field === 4) hasId = reader.bool(wireType) || hasId;
		else reader.skip(field, wireType);
	}
	return { kind: "command", command: { ...(hasId ? { id } : {}), command, payload } };
}

function decodePush(bytes: Uint8Array): OmpGrpcClientFrame {
	const { type, payload } = decodePushBody(bytes);
	return { kind: "push", type, payload };
}

function decodePushBody(bytes: Uint8Array): { type: string; payload: Record<string, unknown> } {
	const reader = new ProtobufReader(bytes);
	let type = "";
	let payload: Record<string, unknown> = {};
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1) type = reader.string(wireType);
		else if (field === 2) payload = decodeRecord(reader.byteString(wireType));
		else reader.skip(field, wireType);
	}
	return { type, payload };
}

export function encodeServerFrame(frame: OmpGrpcServerFrame): Uint8Array {
	const writer = new ProtobufWriter();
	if (frame.kind === "ready") {
		writer.message(1, ready => {
			ready.uint32(1, frame.protocolVersion);
			ready.uint64(2, frame.maxMessageBytes);
		});
	} else if (frame.kind === "response") {
		writer.message(2, response => {
			if (frame.id !== undefined) response.string(1, frame.id);
			response.bool(2, frame.id !== undefined);
			response.string(3, frame.command);
			response.bool(4, frame.success);
			if (frame.data !== undefined) response.bytes(5, encodeJson(frame.data));
			response.bool(6, frame.data !== undefined);
			if (frame.error !== undefined) response.string(7, frame.error);
			if (frame.code !== undefined) response.string(8, frame.code);
			response.bool(9, frame.error !== undefined);
			response.bool(10, frame.code !== undefined);
		});
	} else {
		writer.message(3, push => {
			push.string(1, frame.type);
			push.bytes(2, encodeJson(frame.payload));
		});
	}
	return writer.finish();
}

export function decodeServerFrame(bytes: Uint8Array): OmpGrpcServerFrame {
	const reader = new ProtobufReader(bytes);
	let frame: OmpGrpcServerFrame | undefined;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1) frame = decodeReady(reader.byteString(wireType));
		else if (field === 2) frame = decodeResponse(reader.byteString(wireType));
		else if (field === 3) {
			const { type, payload } = decodePushBody(reader.byteString(wireType));
			frame = { kind: "push", type, payload };
		} else reader.skip(field, wireType);
	}
	if (!frame) throw new Error("ServerFrame has no frame");
	return frame;
}

function decodeReady(bytes: Uint8Array): OmpGrpcServerFrame {
	const reader = new ProtobufReader(bytes);
	let protocolVersion = 0;
	let maxMessageBytes = 0;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1) protocolVersion = reader.uint32(wireType);
		else if (field === 2) maxMessageBytes = reader.uint64(wireType);
		else reader.skip(field, wireType);
	}
	return { kind: "ready", protocolVersion, maxMessageBytes };
}

function decodeResponse(bytes: Uint8Array): OmpGrpcServerFrame {
	const reader = new ProtobufReader(bytes);
	let id = "";
	let hasId = false;
	let command = "";
	let success = false;
	let data: unknown;
	let hasData = false;
	let error = "";
	let hasError = false;
	let code = "";
	let hasCode = false;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1) {
			id = reader.string(wireType);
			hasId = true;
		} else if (field === 2) hasId = reader.bool(wireType) || hasId;
		else if (field === 3) command = reader.string(wireType);
		else if (field === 4) success = reader.bool(wireType);
		else if (field === 5) {
			data = decodeJson(reader.byteString(wireType));
			hasData = true;
		} else if (field === 6) hasData = reader.bool(wireType) || hasData;
		else if (field === 7) {
			error = reader.string(wireType);
			hasError = true;
		} else if (field === 8) {
			code = reader.string(wireType);
			hasCode = true;
		} else if (field === 9) hasError = reader.bool(wireType) || hasError;
		else if (field === 10) hasCode = reader.bool(wireType) || hasCode;
		else reader.skip(field, wireType);
	}
	return {
		kind: "response",
		...(hasId ? { id } : {}),
		command,
		success,
		...(hasData ? { data } : {}),
		...(hasError ? { error } : {}),
		...(hasCode ? { code } : {}),
	};
}
