import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import {
	generateOmpGrpcToken,
	readOmpGrpcBootstrapFile,
	waitForOmpGrpcBootstrapFile,
	writeOmpGrpcBootstrapFile,
} from "../src/bootstrap";
import type { OmpGrpcBootstrap } from "../src/types";

function bootstrap(token = generateOmpGrpcToken()): OmpGrpcBootstrap {
	return {
		protocol: "grpc",
		protocolVersion: 1,
		host: "127.0.0.1",
		port: 43123,
		token,
		maxMessageBytes: 64 * 1024 * 1024,
	};
}

describe("gRPC bootstrap files", () => {
	it("atomically writes a private file and reads it back", async () => {
		await using directory = await TempDir.create("@omp-grpc-bootstrap-");
		const path = directory.join("nested", "ready.json");
		const expected = bootstrap();
		await writeOmpGrpcBootstrapFile(path, expected);

		expect(await readOmpGrpcBootstrapFile(path)).toEqual(expected);
		if (process.platform !== "win32") expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
		expect(generateOmpGrpcToken()).not.toBe(generateOmpGrpcToken());
	});

	it("waits for an atomically published bootstrap file", async () => {
		await using directory = await TempDir.create("@omp-grpc-bootstrap-");
		const path = directory.join("ready.json");
		const expected = bootstrap();
		const waiting = waitForOmpGrpcBootstrapFile(path, { timeoutMs: 2_000 });
		await writeOmpGrpcBootstrapFile(path, expected);
		expect(await waiting).toEqual(expected);
	});

	it("supports cancellation", async () => {
		await using directory = await TempDir.create("@omp-grpc-bootstrap-");
		const controller = new AbortController();
		const waiting = waitForOmpGrpcBootstrapFile(directory.join("missing.json"), {
			timeoutMs: 2_000,
			signal: controller.signal,
		});
		controller.abort(new Error("cancelled"));
		await expect(waiting).rejects.toThrow("cancelled");
	});

	it("rejects malformed and incompatible bootstrap files", async () => {
		await using directory = await TempDir.create("@omp-grpc-bootstrap-");
		const path = directory.join("ready.json");
		await Bun.write(path, JSON.stringify({ ...bootstrap(), protocol: "http" }));
		await expect(readOmpGrpcBootstrapFile(path)).rejects.toThrow("protocol");
	});
});
