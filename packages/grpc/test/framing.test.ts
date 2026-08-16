import { describe, expect, it } from "bun:test";
import { encodeGrpcMessage, GrpcMessageDecoder, GrpcProtocolError } from "../src/framing";

describe("standard gRPC message framing", () => {
	it("decodes multiple messages split at every boundary", () => {
		const first = encodeGrpcMessage(Uint8Array.from([1, 2, 3]));
		const second = encodeGrpcMessage(Uint8Array.from([4, 5]));
		const bytes = new Uint8Array(first.byteLength + second.byteLength);
		bytes.set(first);
		bytes.set(second, first.byteLength);

		for (let split = 0; split <= bytes.byteLength; split++) {
			const decoder = new GrpcMessageDecoder();
			const messages = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];
			decoder.finish();
			expect(messages).toEqual([Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])]);
		}
	});

	it("rejects compressed frames", () => {
		const decoder = new GrpcMessageDecoder();
		expect(() => decoder.push(Uint8Array.from([1, 0, 0, 0, 0]))).toThrow(GrpcProtocolError);
		try {
			new GrpcMessageDecoder().push(Uint8Array.from([1, 0, 0, 0, 0]));
		} catch (error) {
			expect(error).toMatchObject({ status: 12 });
		}
	});

	it("distinguishes malformed compression flags from unsupported compression", () => {
		expect(() => new GrpcMessageDecoder().push(Uint8Array.from([2, 0, 0, 0, 0]))).toThrow(GrpcProtocolError);
		try {
			new GrpcMessageDecoder().push(Uint8Array.from([2, 0, 0, 0, 0]));
		} catch (error) {
			expect(error).toMatchObject({ status: 13 });
		}
	});

	it("rejects an oversized declared length before allocating the body", () => {
		const decoder = new GrpcMessageDecoder(16);
		expect(() => decoder.push(Uint8Array.from([0, 0, 0, 0, 17]))).toThrow("exceeds limit");
		try {
			decoder.push(Uint8Array.from([0, 0, 0, 0, 17]));
		} catch (error) {
			expect(error).toMatchObject({ status: 8 });
		}
	});

	it("rejects truncated headers and bodies", () => {
		const headerDecoder = new GrpcMessageDecoder();
		headerDecoder.push(Uint8Array.from([0, 0]));
		expect(() => headerDecoder.finish()).toThrow("truncated");

		const bodyDecoder = new GrpcMessageDecoder();
		bodyDecoder.push(Uint8Array.from([0, 0, 0, 0, 2, 1]));
		expect(() => bodyDecoder.finish()).toThrow("truncated");
	});
});
