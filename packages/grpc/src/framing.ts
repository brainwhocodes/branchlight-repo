import { OMP_GRPC_MAX_MESSAGE_BYTES } from "./types";

export class GrpcProtocolError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "GrpcProtocolError";
	}
}

export function encodeGrpcMessage(message: Uint8Array, maxMessageBytes = OMP_GRPC_MAX_MESSAGE_BYTES): Uint8Array {
	if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 0 || maxMessageBytes > 0xffffffff) {
		throw new RangeError("maxMessageBytes must be a non-negative uint32");
	}
	if (message.byteLength > maxMessageBytes) {
		throw new GrpcProtocolError(`gRPC message length ${message.byteLength} exceeds limit ${maxMessageBytes}`, 8);
	}
	const framed = new Uint8Array(5 + message.byteLength);
	new DataView(framed.buffer, framed.byteOffset, 5).setUint32(1, message.byteLength, false);
	framed.set(message, 5);
	return framed;
}

export class GrpcMessageDecoder {
	readonly #maxMessageBytes: number;
	readonly #header = new Uint8Array(5);
	#headerOffset = 0;
	#message: Uint8Array | null = null;
	#messageOffset = 0;
	#error: GrpcProtocolError | null = null;

	constructor(maxMessageBytes = OMP_GRPC_MAX_MESSAGE_BYTES) {
		if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 0 || maxMessageBytes > 0xffffffff) {
			throw new RangeError("maxMessageBytes must be a non-negative uint32");
		}
		this.#maxMessageBytes = maxMessageBytes;
	}

	push(chunk: Uint8Array): Uint8Array[] {
		if (this.#error) throw this.#error;
		const messages: Uint8Array[] = [];
		let offset = 0;
		while (offset < chunk.byteLength) {
			if (this.#message === null) {
				const headerLength = Math.min(5 - this.#headerOffset, chunk.byteLength - offset);
				this.#header.set(chunk.subarray(offset, offset + headerLength), this.#headerOffset);
				this.#headerOffset += headerLength;
				offset += headerLength;
				if (this.#headerOffset < 5) continue;
				if (this.#header[0] === 1) {
					this.#error = new GrpcProtocolError("compressed gRPC messages are not supported", 12);
					throw this.#error;
				}
				if (this.#header[0] !== 0) {
					this.#error = new GrpcProtocolError(`invalid gRPC compressed flag ${this.#header[0]}`, 13);
					throw this.#error;
				}
				const length = new DataView(this.#header.buffer, this.#header.byteOffset, 5).getUint32(1, false);
				if (length > this.#maxMessageBytes) {
					this.#error = new GrpcProtocolError(
						`gRPC message length ${length} exceeds limit ${this.#maxMessageBytes}`,
						8,
					);
					throw this.#error;
				}
				this.#headerOffset = 0;
				if (length === 0) {
					messages.push(new Uint8Array());
					continue;
				}
				this.#message = new Uint8Array(length);
				this.#messageOffset = 0;
			}

			const message = this.#message;
			if (message === null) continue;
			const messageLength = Math.min(message.byteLength - this.#messageOffset, chunk.byteLength - offset);
			message.set(chunk.subarray(offset, offset + messageLength), this.#messageOffset);
			this.#messageOffset += messageLength;
			offset += messageLength;
			if (this.#messageOffset === message.byteLength) {
				messages.push(message);
				this.#message = null;
				this.#messageOffset = 0;
			}
		}
		return messages;
	}

	finish(): void {
		if (this.#error) throw this.#error;
		if (this.#headerOffset !== 0 || this.#message !== null) {
			throw new GrpcProtocolError("truncated gRPC message", 13);
		}
	}
}
