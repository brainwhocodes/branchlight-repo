import { describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import type * as net from "node:net";
import {
	connectOmpGrpc,
	generateOmpGrpcToken,
	listenOmpGrpc,
	OMP_GRPC_MAX_MESSAGE_BYTES,
	OMP_GRPC_SERVICE_PATH,
} from "../src";
import { encodeGrpcMessage } from "../src/framing";
import { encodeClientFrame } from "../src/protobuf";
import type { OmpGrpcBootstrap } from "../src/types";

interface RawStream {
	session: http2.ClientHttp2Session;
	stream: http2.ClientHttp2Stream;
	trailers: Promise<http2.IncomingHttpHeaders>;
}

async function openRawStream(
	bootstrap: OmpGrpcBootstrap,
	options: { token?: string; contentType?: string; path?: string } = {},
): Promise<RawStream> {
	const session = http2.connect(`http://${bootstrap.host}:${bootstrap.port}`);
	const connected = Promise.withResolvers<void>();
	session.once("connect", connected.resolve);
	session.once("error", connected.reject);
	await connected.promise;
	const stream = session.request(
		{
			":method": "POST",
			":path": options.path ?? OMP_GRPC_SERVICE_PATH,
			"content-type": options.contentType ?? "application/grpc+proto",
			te: "trailers",
			authorization: `Bearer ${options.token ?? bootstrap.token}`,
		},
		{ endStream: false },
	);
	const trailerResult = Promise.withResolvers<http2.IncomingHttpHeaders>();
	stream.once("trailers", trailerResult.resolve);
	stream.once("error", trailerResult.reject);
	stream.resume();
	return { session, stream, trailers: trailerResult.promise };
}

async function closeRawStream(raw: RawStream): Promise<void> {
	if (!raw.stream.destroyed && !raw.stream.writableEnded) raw.stream.end();
	if (!raw.stream.destroyed) {
		const closed = Promise.withResolvers<void>();
		raw.stream.once("close", closed.resolve);
		await closed.promise;
	}
	raw.session.close();
}

async function expectRejectedFrame(frame: Uint8Array, expectedStatus: string): Promise<void> {
	const server = await listenOmpGrpc({ host: "127.0.0.1", port: 0, token: generateOmpGrpcToken() });
	const accepted = server.accept();
	const raw = await openRawStream(server.bootstrap);
	const connection = await accepted;
	try {
		raw.stream.end(frame);
		const iterator = connection.frames[Symbol.asyncIterator]();
		await expect(iterator.next()).rejects.toThrow();
		expect((await raw.trailers)["grpc-status"]).toBe(expectedStatus);
	} finally {
		await closeRawStream(raw);
		await server.close();
	}
}

describe("authenticated h2c gRPC transport", () => {
	it("exchanges client and server frames over a real HTTP/2 bidirectional stream", async () => {
		const server = await listenOmpGrpc({ host: "127.0.0.1", port: 0, token: generateOmpGrpcToken() });
		const accepted = server.accept();
		const client = await connectOmpGrpc(server.bootstrap);
		const serverConnection = await accepted;
		const clientFrames = client.frames[Symbol.asyncIterator]();
		const serverFrames = serverConnection.frames[Symbol.asyncIterator]();
		try {
			await serverConnection.send({
				kind: "ready",
				protocolVersion: 1,
				maxMessageBytes: OMP_GRPC_MAX_MESSAGE_BYTES,
			});
			expect(await clientFrames.next()).toEqual({
				done: false,
				value: { kind: "ready", protocolVersion: 1, maxMessageBytes: OMP_GRPC_MAX_MESSAGE_BYTES },
			});

			await client.send({
				kind: "command",
				command: { id: "42", command: "prompt", payload: { message: "hello" } },
			});
			expect(await serverFrames.next()).toEqual({
				done: false,
				value: {
					kind: "command",
					command: { id: "42", command: "prompt", payload: { message: "hello" } },
				},
			});

			await serverConnection.send({
				kind: "response",
				id: "42",
				command: "prompt",
				success: true,
				data: { text: "world" },
			});
			expect(await clientFrames.next()).toEqual({
				done: false,
				value: {
					kind: "response",
					id: "42",
					command: "prompt",
					success: true,
					data: { text: "world" },
				},
			});
			const clientClosed = client.close();
			expect(await serverFrames.next()).toEqual({ done: true, value: undefined });
			await serverConnection.close();
			await clientClosed;
		} finally {
			await serverConnection.close();
			await client.close();
			await server.close();
		}
	});

	it("rejects invalid bearer metadata without accepting the stream", async () => {
		const server = await listenOmpGrpc({ host: "127.0.0.1", port: 0, token: generateOmpGrpcToken() });
		const raw = await openRawStream(server.bootstrap, { token: generateOmpGrpcToken() });
		try {
			raw.stream.end();
			expect((await raw.trailers)["grpc-status"]).toBe("16");
		} finally {
			await closeRawStream(raw);
			await server.close();
		}
	});

	it("accepts grpcio's canonical application/grpc content type", async () => {
		const server = await listenOmpGrpc({ host: "127.0.0.1", port: 0, token: generateOmpGrpcToken() });
		const accepted = server.accept();
		const raw = await openRawStream(server.bootstrap, { contentType: "application/grpc; charset=utf-8" });
		const connection = await accepted;
		try {
			const payload = encodeClientFrame({ kind: "push", type: "ping", payload: {} });
			raw.stream.end(encodeGrpcMessage(payload));
			expect(await connection.frames[Symbol.asyncIterator]().next()).toEqual({
				done: false,
				value: { kind: "push", type: "ping", payload: {} },
			});
			await connection.close();
			expect((await raw.trailers)["grpc-status"]).toBe("0");
		} finally {
			await closeRawStream(raw);
			await connection.close();
			await server.close();
		}
	});

	it("rejects a non-gRPC content type and an unknown path", async () => {
		const server = await listenOmpGrpc({ host: "127.0.0.1", port: 0, token: generateOmpGrpcToken() });
		const wrongType = await openRawStream(server.bootstrap, { contentType: "application/json" });
		const wrongPath = await openRawStream(server.bootstrap, { path: "/not.Agent/Connect" });
		try {
			wrongType.stream.end();
			wrongPath.stream.end();
			expect((await wrongType.trailers)["grpc-status"]).toBe("12");
			expect((await wrongPath.trailers)["grpc-status"]).toBe("12");
		} finally {
			await closeRawStream(wrongType);
			await closeRawStream(wrongPath);
			await server.close();
		}
	});

	it("rejects compressed, oversized, and truncated wire messages", async () => {
		await expectRejectedFrame(Uint8Array.from([1, 0, 0, 0, 0]), "12");

		const oversized = new Uint8Array(5);
		new DataView(oversized.buffer).setUint32(1, OMP_GRPC_MAX_MESSAGE_BYTES + 1, false);
		await expectRejectedFrame(oversized, "8");

		await expectRejectedFrame(Uint8Array.from([0, 0, 0, 0, 2, 1]), "13");
	});
	it("terminates promptly when response headers are not gRPC", async () => {
		const rawServer = http2.createServer();
		rawServer.on("stream", stream => {
			stream.respond({ ":status": 404, "content-type": "text/plain" });
			stream.end("not found");
		});
		const listening = Promise.withResolvers<void>();
		rawServer.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = rawServer.address() as net.AddressInfo;
		const bootstrap: OmpGrpcBootstrap = {
			protocol: "grpc",
			protocolVersion: 1,
			host: "127.0.0.1",
			port: address.port,
			token: generateOmpGrpcToken(),
			maxMessageBytes: OMP_GRPC_MAX_MESSAGE_BYTES,
		};
		const client = await connectOmpGrpc(bootstrap);
		try {
			await expect(client.frames[Symbol.asyncIterator]().next()).rejects.toThrow("invalid gRPC response");
			await client.close();
		} finally {
			await client.close();
			const closed = Promise.withResolvers<void>();
			rawServer.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});

	it("refuses non-loopback binds", async () => {
		await expect(listenOmpGrpc({ host: "0.0.0.0", port: 0, token: generateOmpGrpcToken() })).rejects.toThrow(
			"loopback",
		);
	});
});
