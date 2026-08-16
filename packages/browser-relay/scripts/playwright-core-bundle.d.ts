declare module "playwright-core/lib/coreBundle" {
	interface WebSocketTransport {
		connect(progress: unknown, url: string, options?: Record<string, unknown>): Promise<unknown>;
	}

	export const server: {
		WebSocketTransport: WebSocketTransport;
	};
}
