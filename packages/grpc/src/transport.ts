import * as crypto from "node:crypto";
import * as http2 from "node:http2";
import * as net from "node:net";
import { encodeGrpcMessage, GrpcMessageDecoder, GrpcProtocolError } from "./framing";
import { type PromiseResolver, withResolvers } from "./promises";
import { decodeClientFrame, decodeServerFrame, encodeClientFrame, encodeServerFrame } from "./protobuf";
import type {
	ListenOmpGrpcOptions,
	OmpGrpcBootstrap,
	OmpGrpcClientConnection,
	OmpGrpcClientFrame,
	OmpGrpcServer,
	OmpGrpcServerConnection,
	OmpGrpcServerFrame,
} from "./types";
import { OMP_GRPC_MAX_MESSAGE_BYTES, OMP_GRPC_PROTOCOL_VERSION, OMP_GRPC_SERVICE_PATH } from "./types";

const GRPC_CONTENT_TYPE = "application/grpc+proto";
const GRPC_STATUS_OK = 0;
const GRPC_STATUS_RESOURCE_EXHAUSTED = 8;
const GRPC_STATUS_UNIMPLEMENTED = 12;
const GRPC_STATUS_INTERNAL = 13;
const GRPC_STATUS_UNAUTHENTICATED = 16;

const FRAME_QUEUE_HIGH_WATER_MARK = 32;
const FRAME_QUEUE_LOW_WATER_MARK = 16;

class AsyncFrameQueue<T> implements AsyncIterableIterator<T> {
	readonly #values: T[] = [];
	readonly #waiters: PromiseResolver<IteratorResult<T>>[] = [];
	#ended = false;
	#failed = false;
	#error: unknown;
	#pause: (() => void) | undefined;
	#paused = false;
	#resume: (() => void) | undefined;

	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		return this;
	}

	setFlowControl(pause: () => void, resume: () => void): void {
		this.#pause = pause;
		this.#resume = resume;
	}

	releaseFlowControl(): void {
		this.#resumeFlow();
		this.#pause = undefined;
		this.#resume = undefined;
	}

	next(): Promise<IteratorResult<T>> {
		if (this.#values.length > 0) {
			const value = this.#values.shift()!;
			if (this.#paused && this.#values.length <= FRAME_QUEUE_LOW_WATER_MARK) {
				this.#paused = false;
				this.#resume?.();
			}
			return Promise.resolve({ value, done: false });
		}
		if (this.#failed) return Promise.reject(this.#error);
		if (this.#ended) return Promise.resolve({ value: undefined, done: true });
		const waiter = withResolvers<IteratorResult<T>>();
		this.#waiters.push(waiter);
		return waiter.promise;
	}

	push(value: T): void {
		if (this.#ended || this.#failed) return;
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter.resolve({ value, done: false });
			return;
		}
		this.#values.push(value);
		if (!this.#paused && this.#values.length >= FRAME_QUEUE_HIGH_WATER_MARK && this.#pause) {
			this.#paused = true;
			this.#pause();
		}
	}

	end(): void {
		if (this.#ended || this.#failed) return;
		this.#ended = true;
		this.#resumeFlow();
		for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
	}

	fail(error: unknown): void {
		if (this.#ended || this.#failed) return;
		this.#failed = true;
		this.#error = error;
		this.#resumeFlow();
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}

	#resumeFlow(): void {
		if (!this.#paused) return;
		this.#paused = false;
		this.#resume?.();
	}
}

class OmpGrpcStatusError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "OmpGrpcStatusError";
	}
}

class ServerConnection implements OmpGrpcServerConnection {
	readonly #queue = new AsyncFrameQueue<OmpGrpcClientFrame>();
	readonly #decoder = new GrpcMessageDecoder();
	#closePromise: Promise<void> | null = null;
	#requestEnded = false;
	#readySent = false;
	#trailersSent = false;

	readonly frames: AsyncIterable<OmpGrpcClientFrame> = this.#queue;

	constructor(private readonly stream: http2.ServerHttp2Stream) {
		this.#queue.setFlowControl(
			() => stream.pause(),
			() => stream.resume(),
		);
		stream.on("data", (chunk: Buffer) => {
			try {
				for (const message of this.#decoder.push(chunk)) this.#queue.push(decodeClientFrame(message));
			} catch (error) {
				this.#queue.fail(error);
				this.#finishWithError(error);
			}
		});
		stream.on("end", () => {
			this.#requestEnded = true;
			try {
				this.#decoder.finish();
				this.#queue.end();
			} catch (error) {
				this.#queue.fail(error);
				this.#finishWithError(error);
			}
		});
		stream.on("aborted", () => this.#queue.fail(new Error("gRPC stream was aborted")));
		stream.on("error", error => this.#queue.fail(error));
		stream.on("close", () => {
			if (!this.#requestEnded) this.#queue.fail(new Error("gRPC stream closed before request EOF"));
		});
		stream.on("wantTrailers", () => {
			if (this.#trailersSent || stream.destroyed) return;
			this.#trailersSent = true;
			sendGrpcTrailers(stream, { "grpc-status": String(GRPC_STATUS_OK) }, this.#queue);
		});
	}

	async send(frame: OmpGrpcServerFrame): Promise<void> {
		if (this.stream.destroyed || this.stream.writableEnded) throw new Error("gRPC connection is closed");
		if (this.#readySent) {
			if (frame.kind === "ready") throw new Error("gRPC Ready frame was already sent");
		} else if (frame.kind !== "ready") {
			throw new Error("first gRPC server frame must be Ready");
		}
		const message = encodeGrpcMessage(encodeServerFrame(frame));
		if (frame.kind === "ready") this.#readySent = true;
		await writeGrpcMessage(this.stream, message);
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		this.#queue.releaseFlowControl();
		if (this.stream.destroyed || this.stream.writableEnded) return;
		const flushed = withResolvers<void>();
		const onFinish = (): void => flushed.resolve();
		const onClose = (): void => flushed.resolve();
		const onError = (error: Error): void => flushed.reject(error);
		this.stream.once("finish", onFinish);
		this.stream.once("close", onClose);
		this.stream.once("error", onError);
		try {
			this.stream.end();
			await flushed.promise;
		} finally {
			this.stream.off("finish", onFinish);
			this.stream.off("close", onClose);
			this.stream.off("error", onError);
		}
	}

	#finishWithError(error: unknown): void {
		if (this.stream.destroyed || this.stream.writableEnded) return;
		const status = error instanceof GrpcProtocolError ? error.status : GRPC_STATUS_INTERNAL;
		this.#trailersSent = true;
		this.stream.once("wantTrailers", () => {
			if (this.stream.destroyed) return;
			sendGrpcTrailers(
				this.stream,
				{
					"grpc-status": String(status),
					"grpc-message": encodeURIComponent(error instanceof Error ? error.message : "invalid gRPC message"),
				},
				this.#queue,
			);
		});
		this.stream.end();
	}
}

class ClientConnection implements OmpGrpcClientConnection {
	readonly #queue = new AsyncFrameQueue<OmpGrpcServerFrame>();
	readonly #decoder: GrpcMessageDecoder;
	readonly #maxMessageBytes: number;
	readonly #streamClosed = withResolvers<void>();
	readonly #sessionClosed = withResolvers<void>();
	#closePromise: Promise<void> | null = null;
	#grpcStatus: number | undefined;
	#grpcMessage = "";
	#failed = false;
	#readyReceived = false;
	#responseEnded = false;
	#responseReceived = false;

	readonly frames: AsyncIterable<OmpGrpcServerFrame> = this.#queue;

	constructor(
		private readonly session: http2.ClientHttp2Session,
		private readonly stream: http2.ClientHttp2Stream,
		maxMessageBytes: number,
	) {
		this.#queue.setFlowControl(
			() => stream.pause(),
			() => stream.resume(),
		);
		this.#decoder = new GrpcMessageDecoder(maxMessageBytes);
		this.#maxMessageBytes = maxMessageBytes;
		stream.on("response", (headers, flags) => {
			this.#responseReceived = true;
			try {
				const status = headers[":status"];
				const contentType = firstHeader(headers, "content-type");
				if (status !== 200 || !isGrpcContentType(contentType)) {
					throw new Error(`invalid gRPC response (${status ?? "no status"}, ${contentType ?? "no content type"})`);
				}
				if (firstHeader(headers, "grpc-status") !== undefined) {
					if ((flags & http2.constants.NGHTTP2_FLAG_END_STREAM) === 0) {
						throw new Error("gRPC response has grpc-status in non-terminal initial headers");
					}
					this.#readStatus(headers);
				}
			} catch (error) {
				this.#failAndDestroy(error);
			}
		});
		stream.on("trailers", headers => {
			try {
				if (this.#grpcStatus !== undefined) throw new Error("gRPC response contains grpc-status more than once");
				this.#readStatus(headers);
			} catch (error) {
				this.#failAndDestroy(error);
			}
		});
		stream.on("data", (chunk: Buffer) => {
			if (this.#failed) return;
			try {
				for (const message of this.#decoder.push(chunk)) {
					const frame = decodeServerFrame(message);
					if (this.#readyReceived) {
						if (frame.kind === "ready") throw new Error("gRPC response contains more than one Ready frame");
					} else if (frame.kind !== "ready") {
						throw new Error("first gRPC server frame must be Ready");
					} else {
						this.#readyReceived = true;
					}
					this.#queue.push(frame);
				}
			} catch (error) {
				this.#failAndDestroy(error);
			}
		});
		stream.on("end", () => {
			this.#responseEnded = true;
			if (this.#failed) return;
			try {
				this.#decoder.finish();
				if (!this.#responseReceived) throw new Error("gRPC response ended before response headers");
				if (this.#grpcStatus === undefined) throw new Error("gRPC response is missing grpc-status trailers");
				if (this.#grpcStatus !== GRPC_STATUS_OK) {
					throw new OmpGrpcStatusError(
						this.#grpcMessage || `gRPC request failed with status ${this.#grpcStatus}`,
						this.#grpcStatus,
					);
				}
				if (!this.#readyReceived && this.#grpcStatus === GRPC_STATUS_OK) {
					throw new Error("gRPC response completed without a Ready frame");
				}
				this.#queue.end();
			} catch (error) {
				this.#fail(error);
			}
		});
		stream.on("aborted", () => this.#fail(new Error("gRPC stream was aborted")));
		stream.on("error", error => this.#fail(error));
		stream.on("close", () => {
			if (!this.#responseEnded && !this.#failed) this.#fail(new Error("gRPC stream closed before response EOF"));
			this.#streamClosed.resolve();
			if (!session.destroyed && !session.closed) session.close();
		});
		session.on("error", error => this.#fail(error));
		session.on("close", () => {
			if (!this.#responseEnded && !this.#failed) this.#fail(new Error("gRPC session closed before response EOF"));
			this.#streamClosed.resolve();
			this.#sessionClosed.resolve();
		});
	}

	async send(frame: OmpGrpcClientFrame): Promise<void> {
		if (this.stream.destroyed || this.stream.writableEnded) throw new Error("gRPC connection is closed");
		await writeGrpcMessage(this.stream, encodeGrpcMessage(encodeClientFrame(frame), this.#maxMessageBytes));
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		if (!this.stream.destroyed && !this.stream.writableEnded) this.stream.end();
		this.#queue.releaseFlowControl();
		await this.#streamClosed.promise;
		if (!this.session.destroyed && !this.session.closed) this.session.close();
		await this.#sessionClosed.promise;
	}

	#readStatus(headers: http2.IncomingHttpHeaders): void {
		const statusText = firstHeader(headers, "grpc-status");
		if (statusText === undefined) throw new Error("gRPC response is missing grpc-status trailers");
		if (!/^(0|[1-9][0-9]*)$/.test(statusText))
			throw new Error(`invalid grpc-status value ${JSON.stringify(statusText)}`);
		const status = Number(statusText);
		if (!Number.isSafeInteger(status)) throw new Error(`invalid grpc-status value ${JSON.stringify(statusText)}`);
		this.#grpcStatus = status;
		this.#grpcMessage = decodeGrpcMessage(firstHeader(headers, "grpc-message") ?? "");
	}

	#fail(error: unknown): void {
		this.#failed = true;
		this.#queue.fail(error);
	}

	#failAndDestroy(error: unknown): void {
		this.#fail(error);
		const streamError = error instanceof Error ? error : new Error("invalid gRPC response", { cause: error });
		if (!this.stream.destroyed) this.stream.destroy(streamError);
		if (!this.session.destroyed) this.session.destroy(streamError);
	}
}

interface FailureSink {
	fail(error: unknown): void;
}

async function writeGrpcMessage(
	stream: http2.ServerHttp2Stream | http2.ClientHttp2Stream,
	message: Uint8Array,
): Promise<void> {
	if (stream.write(Buffer.from(message.buffer, message.byteOffset, message.byteLength))) return;
	const drained = withResolvers<void>();
	const onDrain = (): void => drained.resolve();
	const onClose = (): void => drained.reject(new Error("gRPC stream closed before pending data drained"));
	const onAborted = (): void => drained.reject(new Error("gRPC stream was aborted before pending data drained"));
	const onError = (error: Error): void => drained.reject(error);
	stream.once("drain", onDrain);
	stream.once("close", onClose);
	stream.once("aborted", onAborted);
	stream.once("error", onError);
	if (stream.destroyed) onClose();
	try {
		await drained.promise;
	} finally {
		stream.off("drain", onDrain);
		stream.off("close", onClose);
		stream.off("aborted", onAborted);
		stream.off("error", onError);
	}
}

function sendGrpcTrailers(
	stream: http2.ServerHttp2Stream,
	headers: http2.OutgoingHttpHeaders,
	failures: FailureSink,
): void {
	try {
		stream.sendTrailers(headers);
	} catch (error) {
		failures.fail(error);
		if (!stream.destroyed)
			stream.destroy(error instanceof Error ? error : new Error("failed to send gRPC trailers", { cause: error }));
	}
}

class GrpcServer implements OmpGrpcServer {
	readonly #connections = new Set<ServerConnection>();
	readonly #sessions = new Set<http2.ServerHttp2Session>();
	readonly #accepted = new AsyncFrameQueue<OmpGrpcServerConnection>();
	#hasAccepted = false;
	#closePromise: Promise<void> | null = null;

	constructor(
		private readonly server: http2.Http2Server,
		readonly bootstrap: OmpGrpcBootstrap,
		private readonly token: string,
	) {
		server.on("stream", (stream, headers) => this.#onStream(stream, headers));
		server.on("session", session => {
			this.#sessions.add(session);
			session.on("error", () => undefined);
			session.once("close", () => this.#sessions.delete(session));
		});
		server.on("close", () => this.#accepted.end());
		server.on("error", error => this.#accepted.fail(error));
	}

	async accept(): Promise<OmpGrpcServerConnection> {
		const result = await this.#accepted.next();
		if (result.done) throw new Error("gRPC server closed before a connection was accepted");
		return result.value;
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		this.#accepted.end();
		const serverClosed = withResolvers<void>();
		if (this.server.listening) {
			this.server.close(error => (error ? serverClosed.reject(error) : serverClosed.resolve()));
		} else {
			serverClosed.resolve();
		}
		const connectionsClosed = Promise.all([...this.#connections].map(connection => connection.close()));
		for (const session of this.#sessions) {
			if (!session.destroyed && !session.closed) session.close();
		}
		let closeError: unknown;
		try {
			await connectionsClosed;
		} catch (error) {
			closeError = error;
		}
		try {
			await serverClosed.promise;
		} catch (error) {
			closeError ??= error;
		}
		if (closeError !== undefined) throw closeError;
	}

	#onStream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
		const path = headers[":path"];
		const method = headers[":method"];
		if (path !== OMP_GRPC_SERVICE_PATH || method !== "POST") {
			rejectStream(stream, GRPC_STATUS_UNIMPLEMENTED, "unknown gRPC method");
			return;
		}
		if (!isGrpcContentType(firstHeader(headers, "content-type"))) {
			rejectStream(
				stream,
				GRPC_STATUS_UNIMPLEMENTED,
				"content-type must be application/grpc or application/grpc+proto",
			);
			return;
		}
		if (!hasValidBearerToken(firstHeader(headers, "authorization"), this.token)) {
			rejectStream(stream, GRPC_STATUS_UNAUTHENTICATED, "invalid bearer token");
			return;
		}
		if (this.#hasAccepted) {
			rejectStream(stream, GRPC_STATUS_RESOURCE_EXHAUSTED, "agent gRPC stream already connected");
			return;
		}
		this.#hasAccepted = true;
		stream.respond(
			{
				":status": 200,
				"content-type": GRPC_CONTENT_TYPE,
				"grpc-accept-encoding": "identity",
			},
			{ waitForTrailers: true },
		);
		const connection = new ServerConnection(stream);
		this.#connections.add(connection);
		stream.once("close", () => this.#connections.delete(connection));
		this.#accepted.push(connection);
	}
}

export async function listenOmpGrpc(options: ListenOmpGrpcOptions): Promise<OmpGrpcServer> {
	if (!isLoopbackHost(options.host)) throw new Error(`gRPC server must bind to a loopback host, not ${options.host}`);
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
		throw new RangeError("port must be an integer from 0 to 65535");
	if (options.token.length < 32) throw new Error("gRPC bearer token must contain at least 32 characters");
	const server = http2.createServer({
		settings: {
			enablePush: false,
			maxConcurrentStreams: 1,
			maxHeaderListSize: 16 * 1024,
		},
	});
	const listening = withResolvers<void>();
	const onError = (error: Error): void => listening.reject(error);
	server.once("error", onError);
	server.listen(options.port, options.host, listening.resolve);
	try {
		await listening.promise;
	} catch (error) {
		server.close();
		throw error;
	} finally {
		server.off("error", onError);
	}
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("gRPC server did not bind to a TCP address");
	}
	const tcpAddress = address as net.AddressInfo;
	if (!isLoopbackHost(tcpAddress.address)) {
		server.close();
		throw new Error(`gRPC server resolved to a non-loopback address: ${tcpAddress.address}`);
	}
	const bootstrap: OmpGrpcBootstrap = {
		protocol: "grpc",
		protocolVersion: OMP_GRPC_PROTOCOL_VERSION,
		host: tcpAddress.address,
		port: tcpAddress.port,
		token: options.token,
		maxMessageBytes: OMP_GRPC_MAX_MESSAGE_BYTES,
	};
	return new GrpcServer(server, bootstrap, options.token);
}

export async function connectOmpGrpc(bootstrap: OmpGrpcBootstrap): Promise<OmpGrpcClientConnection> {
	if (bootstrap.protocol !== "grpc" || bootstrap.protocolVersion !== OMP_GRPC_PROTOCOL_VERSION) {
		throw new Error("unsupported gRPC bootstrap protocol");
	}
	if (!isLoopbackHost(bootstrap.host)) throw new Error(`gRPC client refuses non-loopback host ${bootstrap.host}`);
	if (!Number.isInteger(bootstrap.port) || bootstrap.port < 1 || bootstrap.port > 65535)
		throw new Error("invalid gRPC bootstrap port");
	if (bootstrap.token.length < 32) throw new Error("invalid gRPC bootstrap bearer token");
	if (
		!Number.isSafeInteger(bootstrap.maxMessageBytes) ||
		bootstrap.maxMessageBytes < 1 ||
		bootstrap.maxMessageBytes > OMP_GRPC_MAX_MESSAGE_BYTES
	) {
		throw new Error("invalid gRPC bootstrap message limit");
	}
	const session = http2.connect(`http://${formatAuthorityHost(bootstrap.host)}:${bootstrap.port}`);
	const connected = withResolvers<void>();
	const onConnect = (): void => connected.resolve();
	const onError = (error: Error): void => connected.reject(error);
	session.once("connect", onConnect);
	session.once("error", onError);
	try {
		await connected.promise;
		const remoteAddress = session.socket.remoteAddress;
		if (!remoteAddress || !isLoopbackHost(remoteAddress)) {
			throw new Error(`gRPC client connected to a non-loopback address: ${remoteAddress ?? "unknown"}`);
		}
	} catch (error) {
		session.destroy();
		throw error;
	} finally {
		session.off("connect", onConnect);
		session.off("error", onError);
	}
	try {
		const stream = session.request(
			{
				":method": "POST",
				":path": OMP_GRPC_SERVICE_PATH,
				"content-type": GRPC_CONTENT_TYPE,
				te: "trailers",
				authorization: `Bearer ${bootstrap.token}`,
			},
			{ endStream: false },
		);
		return new ClientConnection(session, stream, bootstrap.maxMessageBytes);
	} catch (error) {
		session.destroy();
		throw error;
	}
}

function rejectStream(stream: http2.ServerHttp2Stream, status: number, message: string): void {
	stream.respond(
		{
			":status": 200,
			"content-type": GRPC_CONTENT_TYPE,
		},
		{ waitForTrailers: true },
	);
	stream.once("wantTrailers", () => {
		if (stream.destroyed) return;
		try {
			stream.sendTrailers({
				"grpc-status": String(status),
				"grpc-message": encodeURIComponent(message),
			});
		} catch (error) {
			if (!stream.destroyed)
				stream.destroy(
					error instanceof Error ? error : new Error("failed to reject gRPC stream", { cause: error }),
				);
		}
	});
	stream.end();
}

function firstHeader(headers: http2.IncomingHttpHeaders, name: string): string | undefined {
	const value = headers[name];
	if (Array.isArray(value)) return value[0];
	return value;
}

function isGrpcContentType(contentType: string | undefined): boolean {
	if (!contentType) return false;
	const semicolon = contentType.indexOf(";");
	const mediaType = (semicolon === -1 ? contentType : contentType.slice(0, semicolon)).trim().toLowerCase();
	return mediaType === "application/grpc" || mediaType === GRPC_CONTENT_TYPE;
}

function hasValidBearerToken(authorization: string | undefined, token: string): boolean {
	const match = authorization?.match(/^Bearer (.+)$/i);
	if (!match) return false;
	const supplied = crypto.createHash("sha256").update(match[1]!, "utf8").digest();
	const expected = crypto.createHash("sha256").update(token, "utf8").digest();
	return crypto.timingSafeEqual(supplied, expected);
}

function decodeGrpcMessage(message: string): string {
	if (message.length === 0) return "";
	try {
		return decodeURIComponent(message);
	} catch {
		return message;
	}
}

function isLoopbackHost(host: string): boolean {
	let normalized = host.toLowerCase();
	if (normalized.startsWith("[") || normalized.endsWith("]")) {
		if (!normalized.startsWith("[") || !normalized.endsWith("]")) return false;
		normalized = normalized.slice(1, -1);
	}
	if (normalized === "localhost") return true;
	const family = net.isIP(normalized);
	if (family === 4) return normalized.startsWith("127.");
	if (family === 6) return new URL(`http://[${normalized}]`).hostname === "[::1]";
	return false;
}

function formatAuthorityHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
