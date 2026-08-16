import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import { WorkspaceServiceManager, WorkspaceServiceRunner, WorkspaceSupervisor } from "../src";

describe("WorkspaceServiceRunner & Manager", () => {
	let supervisor: WorkspaceSupervisor;

	beforeEach(() => {
		supervisor = new WorkspaceSupervisor();
	});

	afterEach(async () => {
		await supervisor.stopAll();
	});

	it("manages service process lifecycle and manager registry", async () => {
		const manager = new WorkspaceServiceManager({ supervisor });
		const server = net.createServer();
		const freePort = await new Promise<number>(resolve => {
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as net.AddressInfo;
				const port = addr.port;
				server.close(() => resolve(port));
			});
		});

		const service = manager.declareService({
			id: "svc-mgr-1",
			name: "Manager HTTP Service",
			command: `${process.execPath} -e "Bun.serve({ port: ${freePort}, fetch: () => new Response('ok') })"`,
			port: freePort,
			readyTimeoutMs: 5000,
		});

		expect(service.status).toBe("declared");
		expect(manager.serviceCount).toBe(1);
		expect(manager.getService("svc-mgr-1")).toBe(service);

		await manager.startService("svc-mgr-1");
		expect(service.status).toBe("running");
		expect(service.pid).toBeDefined();

		// Verify socket connects directly
		const socket = new net.Socket();
		const connected = await new Promise<boolean>(resolve => {
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
			socket.connect(freePort, "127.0.0.1");
		});
		expect(connected).toBe(true);

		await manager.stopService("svc-mgr-1");
		expect(service.status).toBe("stopped");

		manager.removeService("svc-mgr-1");
		expect(manager.serviceCount).toBe(0);
	});

	it("detects port readiness when configured", async () => {
		const server = net.createServer();
		const freePort = await new Promise<number>(resolve => {
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as net.AddressInfo;
				const port = addr.port;
				server.close(() => resolve(port));
			});
		});

		const runner = new WorkspaceServiceRunner({
			id: "svc-http-1",
			name: "HTTP Server",
			command: `${process.execPath} -e "Bun.serve({ port: ${freePort}, fetch: () => new Response('ok') })"`,
			port: freePort,
			supervisor,
			readyTimeoutMs: 5000,
		});

		await runner.start();
		expect(runner.status).toBe("running");
		expect(runner.pid).toBeDefined();

		const socket = new net.Socket();
		const connected = await new Promise<boolean>(resolve => {
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
			socket.connect(freePort, "127.0.0.1");
		});
		expect(connected).toBe(true);

		await runner.stop();
		expect(runner.status).toBe("stopped");
	});

	it("auto-restarts failed services when restartPolicy is on-failure", async () => {
		let restarts = 0;
		const restartSignal = Promise.withResolvers<number>();

		const runner = new WorkspaceServiceRunner({
			id: "svc-fail-restart",
			name: "Failing Service",
			command: `${process.execPath} -e "process.exit(1)"`,
			restartPolicy: "on-failure",
			maxRestarts: 2,
			supervisor,
			onStatusChange: (_id, status) => {
				if (status === "starting") {
					restarts++;
					if (restarts >= 2) {
						restartSignal.resolve(restarts);
					}
				}
			},
		});

		try {
			await runner.start();
		} catch {}

		const observedRestarts = await restartSignal.promise;
		expect(observedRestarts).toBeGreaterThanOrEqual(2);

		await runner.stop();
	});
});
