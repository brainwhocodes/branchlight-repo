export const OMP_GRPC_SERVICE_PATH = "/omp.rpc.v1.AgentService/Connect";
export const OMP_GRPC_PROTOCOL_VERSION = 1 as const;
export const OMP_GRPC_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export interface OmpGrpcBootstrap {
	protocol: "grpc";
	protocolVersion: 1;
	host: string;
	port: number;
	token: string;
	maxMessageBytes: number;
}

export type OmpGrpcClientFrame =
	| {
			kind: "command";
			command: {
				id?: string;
				command: string;
				payload: Record<string, unknown>;
			};
	  }
	| {
			kind: "push";
			type: string;
			payload: Record<string, unknown>;
	  };

export type OmpGrpcServerFrame =
	| {
			kind: "ready";
			protocolVersion: number;
			maxMessageBytes: number;
	  }
	| {
			kind: "response";
			id?: string;
			command: string;
			success: boolean;
			data?: unknown;
			error?: string;
			code?: string;
	  }
	| {
			kind: "push";
			type: string;
			payload: Record<string, unknown>;
	  };

export interface OmpGrpcServerConnection {
	readonly frames: AsyncIterable<OmpGrpcClientFrame>;
	send(frame: OmpGrpcServerFrame): Promise<void>;
	close(): Promise<void>;
}

export interface OmpGrpcClientConnection {
	readonly frames: AsyncIterable<OmpGrpcServerFrame>;
	send(frame: OmpGrpcClientFrame): Promise<void>;
	close(): Promise<void>;
}

export interface OmpGrpcServer {
	readonly bootstrap: OmpGrpcBootstrap;
	accept(): Promise<OmpGrpcServerConnection>;
	close(): Promise<void>;
}

export interface ListenOmpGrpcOptions {
	host: string;
	port: number;
	token: string;
}

export interface WaitForOmpGrpcBootstrapOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}
