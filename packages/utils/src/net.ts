import * as net from "node:net";

/** Allocates an unused loopback TCP port, releasing it before returning. */
export async function findFreeTcpPort(host = "127.0.0.1"): Promise<number> {
	const result = Promise.withResolvers<number>();
	const server = net.createServer();
	server.unref();
	server.once("error", result.reject);
	server.listen(0, host, () => {
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			result.reject(new Error("Failed to allocate a loopback TCP port"));
			return;
		}
		server.close(error => {
			if (error) result.reject(error);
			else result.resolve(address.port);
		});
	});
	return result.promise;
}
