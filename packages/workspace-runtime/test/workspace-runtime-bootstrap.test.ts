import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureWorkspaceRuntime, WorkspaceClient, WorkspaceServer } from "../src";

describe("WorkspaceRuntime bootstrap & daemon lifecycle", () => {
	let testRoot: string;

	beforeEach(async () => {
		const tmp = await fsp.realpath(os.tmpdir());
		testRoot = await fsp.mkdtemp(path.join(tmp, "omp-test-bootstrap-"));
	});

	afterEach(async () => {
		try {
			await fsp.rm(testRoot, { recursive: true, force: true });
		} catch {}
	});

	it("launches daemon via ensureWorkspaceRuntime and re-attaches second client", async () => {
		const desc1 = await ensureWorkspaceRuntime({
			runtimeDir: testRoot,
			startupTimeoutMs: 10000,
		});

		expect(desc1.runtimeDir).toBe(testRoot);
		expect(desc1.token.length).toBeGreaterThan(0);
		expect(desc1.client.isConnected).toBe(true);

		const doc1 = await desc1.client.getDocument();
		expect(doc1.version).toBe(1);

		// Second ensureWorkspaceRuntime attaches to existing running daemon
		const desc2 = await ensureWorkspaceRuntime({
			runtimeDir: testRoot,
			startupTimeoutMs: 5000,
		});

		expect(desc2.token).toBe(desc1.token);
		expect(desc2.endpointPath).toBe(desc1.endpointPath);
		expect(desc2.client.isConnected).toBe(true);

		// Closing client 2 does NOT kill daemon
		await desc2.close();
		expect(desc2.client.isConnected).toBe(false);
		expect(desc1.client.isConnected).toBe(true);
		const pingAfterClose2 = await desc1.client.ping();
		expect(typeof pingAfterClose2).toBe("number");

		// Explicit operator shutdown stops daemon
		await desc1.shutdownRuntime();
		expect(desc1.client.isConnected).toBe(false);
	});

	it("concurrent ensureWorkspaceRuntime calls resolve to the same daemon", async () => {
		const [d1, d2] = await Promise.all([
			ensureWorkspaceRuntime({ runtimeDir: testRoot, startupTimeoutMs: 10000 }),
			ensureWorkspaceRuntime({ runtimeDir: testRoot, startupTimeoutMs: 10000 }),
		]);

		expect(d1.token).toBe(d2.token);
		expect(d1.endpointPath).toBe(d2.endpointPath);
		expect(d1.client.isConnected).toBe(true);
		expect(d2.client.isConnected).toBe(true);

		await d2.close();
		await d1.shutdownRuntime();
	});
	it("preserves live server endpoint and token integrity against failed contenders", async () => {
		const server = new WorkspaceServer({ runtimeRoot: testRoot });
		await server.start();
		const originalToken = server.controlToken;
		const originalEndpoint = server.endpointPath;

		const client = new WorkspaceClient({ runtimeRoot: testRoot });
		await client.connect();
		expect(await client.ping()).toBeGreaterThan(0);

		const competingServer = new WorkspaceServer({ runtimeRoot: testRoot });
		await expect(competingServer.start()).rejects.toThrow(/authority lock already held/i);

		expect(server.controlToken).toBe(originalToken);
		expect(server.endpointPath).toBe(originalEndpoint);
		expect(await client.ping()).toBeGreaterThan(0);

		await client.close();
		await server.stop();
	});
});
