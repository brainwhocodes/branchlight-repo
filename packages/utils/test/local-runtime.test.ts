import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureProcessIdentity,
	createSecureRuntimeFile,
	encodeLocalJsonlFrame,
	ensureSecureRuntimeRoot,
	inspectProcessIdentity,
	LocalConnectionClosedError,
	LocalFrameTooLargeError,
	LocalJsonlDecoder,
	LocalRequestCorrelator,
	LocalRequestTimeoutError,
	readControlToken,
	rotateControlToken,
	secureRuntimeEndpoint,
	secureRuntimePath,
	shutdownProcessTree,
	verifyControlToken,
} from "@oh-my-pi/pi-utils/local-runtime";

async function temporaryRoot(): Promise<string> {
	const tmp = await fs.realpath(os.tmpdir());
	return fs.mkdtemp(path.join(tmp, "omp-local-runtime-"));
}

describe("local JSONL framing", () => {
	it("handles chunk boundaries and correlates bounded requests", async () => {
		const decoder = new LocalJsonlDecoder(128);
		const frame = encodeLocalJsonlFrame({ id: "one", payload: "ok" }, { maxFrameBytes: 128 });
		expect(decoder.push(frame.slice(0, 4))).toEqual([]);
		expect(decoder.push(frame.slice(4))).toEqual([{ id: "one", payload: "ok" }]);

		const correlator = new LocalRequestCorrelator<{ value: number }>();
		const request = correlator.request("r1", () => expect(correlator.size).toBe(1), { timeoutMs: 100 });
		expect(correlator.resolve("r1", { value: 42 })).toBe(true);
		expect(await request).toEqual({ value: 42 });
		const controller = new AbortController();
		controller.abort();
		const aborted = correlator.request(
			"aborted",
			() => {
				throw new Error("send must not run");
			},
			{ timeoutMs: 100, signal: controller.signal },
		);
		await expect(aborted).rejects.toBeInstanceOf(LocalConnectionClosedError);
		expect(correlator.size).toBe(0);
	});

	it("rejects oversized frames and reports timeout/close errors", async () => {
		expect(() => encodeLocalJsonlFrame({ payload: "123456" }, { maxFrameBytes: 8 })).toThrow(LocalFrameTooLargeError);
		const decoder = new LocalJsonlDecoder(8);
		expect(() => decoder.push("123456789")).toThrow(LocalFrameTooLargeError);
		const timeoutCorrelator = new LocalRequestCorrelator();
		await expect(timeoutCorrelator.request("slow", () => {}, { timeoutMs: 5 })).rejects.toBeInstanceOf(
			LocalRequestTimeoutError,
		);
		const closeCorrelator = new LocalRequestCorrelator();
		const pending = closeCorrelator.request("close", () => {}, { timeoutMs: 100 });
		closeCorrelator.close();
		await expect(pending).rejects.toBeInstanceOf(LocalConnectionClosedError);
	});
});

describe("secure local runtime", () => {
	it("enforces private root/files and rotates tokens", async () => {
		const root = await temporaryRoot();
		await ensureSecureRuntimeRoot(root);
		const first = await rotateControlToken(root);
		expect(await readControlToken(root)).toBe(first);
		expect(verifyControlToken(first, first)).toBe(true);
		expect(verifyControlToken(`${first}x`, first)).toBe(false);
		const second = await rotateControlToken(root);
		expect(second).not.toBe(first);
		expect(await readControlToken(root)).toBe(second);
		await expect(createSecureRuntimeFile(root, "../escape", "bad")).rejects.toThrow();
		expect(() => secureRuntimePath("relative", "file")).toThrow();
		const parent = await temporaryRoot();
		const parentLink = `${parent}-link`;
		await fs.symlink(parent, parentLink);
		await expect(ensureSecureRuntimeRoot(path.join(parentLink, "child"))).rejects.toThrow();
		await fs.rm(parentLink, { force: true });
		await fs.rm(parent, { recursive: true, force: true });
		await fs.rm(root, { recursive: true, force: true });
		const symlink = `${root}-link`;
		await fs.symlink(root, symlink);
		await expect(ensureSecureRuntimeRoot(symlink)).rejects.toThrow();
		await fs.rm(symlink, { force: true });
	});
	it("derives secure runtime endpoints with correct platform naming", async () => {
		const root = await temporaryRoot();
		try {
			const endpoint = secureRuntimeEndpoint(root, "control.sock");
			if (process.platform === "win32") {
				expect(endpoint).toMatch(/^\\\\\.\\pipe\\omp-[0-9a-f]{16}-control\.sock$/);
			} else {
				expect(endpoint).toBe(path.join(root, "control.sock"));
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("verified process lifecycle", () => {
	it("distinguishes a dead process and refuses mismatched identities", async () => {
		const child = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
		try {
			const captured = await captureProcessIdentity(child.pid);
			expect(captured.status).toBe("matched");
			if (!captured.identity) throw new Error("missing process identity");
			expect((await inspectProcessIdentity(captured.identity)).status).toBe("matched");
			expect(
				(await inspectProcessIdentity({ pid: child.pid, startToken: `${captured.identity.startToken}:different` }))
					.status,
			).toBe("mismatched");
			const result = await shutdownProcessTree(captured.identity, { gracefulMs: 10, forceMs: 200 });
			expect(result.forced || result.graceful || result.status === "dead").toBe(true);
		} finally {
			child.kill();
			await child.exited;
		}
	});
});
