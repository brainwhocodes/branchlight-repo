import { describe, expect, it } from "bun:test";
import { decodeClientFrame, decodeServerFrame, encodeClientFrame, encodeServerFrame } from "../src/protobuf";
import type { OmpGrpcClientFrame, OmpGrpcServerFrame } from "../src/types";

const clientFrames: OmpGrpcClientFrame[] = [
	{
		kind: "command",
		command: {
			id: "request-1",
			command: "prompt",
			payload: { message: "hello", nested: { enabled: true }, count: 4 },
		},
	},
	{
		kind: "command",
		command: {
			command: "shutdown",
			payload: {},
		},
	},
	{
		kind: "push",
		type: "extension_ui_response",
		payload: { requestId: "ui-1", value: [1, 2, 3] },
	},
];

const serverFrames: OmpGrpcServerFrame[] = [
	{ kind: "ready", protocolVersion: 1, maxMessageBytes: 64 * 1024 * 1024 },
	{
		kind: "response",
		id: "request-1",
		command: "prompt",
		success: true,
		data: { accepted: true, value: null },
	},
	{
		kind: "response",
		command: "shutdown",
		success: false,
		error: "not allowed",
		code: "INVALID_STATE",
	},
	{ kind: "push", type: "message_update", payload: { delta: "hello" } },
];

describe("OMP protobuf codec", () => {
	it("roundtrips every client frame variant", () => {
		for (const frame of clientFrames) expect(decodeClientFrame(encodeClientFrame(frame))).toEqual(frame);
	});

	it("roundtrips every server frame variant", () => {
		for (const frame of serverFrames) expect(decodeServerFrame(encodeServerFrame(frame))).toEqual(frame);
	});

	it("preserves empty optional fields and empty oneof messages", () => {
		const command: OmpGrpcClientFrame = {
			kind: "command",
			command: { id: "", command: "query", payload: {} },
		};
		const response: OmpGrpcServerFrame = {
			kind: "response",
			id: "",
			command: "query",
			success: false,
			data: null,
			error: "",
			code: "",
		};
		const emptyResponse: OmpGrpcServerFrame = {
			kind: "response",
			command: "",
			success: false,
		};
		expect(decodeClientFrame(encodeClientFrame(command))).toEqual(command);
		expect(decodeServerFrame(encodeServerFrame(response))).toEqual(response);
		expect(decodeServerFrame(encodeServerFrame(emptyResponse))).toEqual(emptyResponse);
	});

	it("skips unknown fields including deprecated groups", () => {
		const frame = clientFrames[0]!;
		const encoded = encodeClientFrame(frame);
		const withUnknownGroup = Uint8Array.from([...encoded, 0x7b, 0x08, 0x01, 0x7c]);
		expect(decodeClientFrame(withUnknownGroup)).toEqual(frame);
	});

	it("rejects missing oneofs and invalid JSON payloads", () => {
		expect(() => decodeClientFrame(new Uint8Array())).toThrow("ClientFrame has no frame");
		expect(() => decodeClientFrame(Uint8Array.from([0x0a, 0x02, 0x1a, 0x00]))).toThrow("JSON");
	});
});
