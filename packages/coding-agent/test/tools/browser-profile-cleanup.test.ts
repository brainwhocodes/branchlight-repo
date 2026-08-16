/**
 * OMP owns temporary Chromium profiles and removes them with lock-tolerant
 * retries only after the matching owned process has stopped.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeUserDataDir } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as piUtils from "@oh-my-pi/pi-utils";

async function makeProfileDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
	await Bun.write(path.join(dir, "SingletonLock"), "lock");
	await Bun.write(path.join(dir, "Default", "Preferences"), "{}");
	return dir;
}

describe("headless Chromium profile cleanup (issue #7058)", () => {
	afterEach(() => {
		spyOn(piUtils, "removeWithRetries").mockRestore();
		spyOn(piUtils.logger, "warn").mockRestore();
	});

	it("removes an owned profile directory", async () => {
		const dir = await makeProfileDir();
		await removeUserDataDir(dir);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("warns and leaves the directory instead of throwing when it stays locked (EBUSY)", async () => {
		const dir = await makeProfileDir();
		const ebusy = Object.assign(new Error(`EBUSY: resource busy or locked, rm '${dir}'`), { code: "EBUSY" });
		const removeSpy = spyOn(piUtils, "removeWithRetries").mockRejectedValue(ebusy);
		const warnSpy = spyOn(piUtils.logger, "warn");
		try {
			// Must resolve — a cleanup failure never propagates as a crash.
			await expect(removeUserDataDir(dir)).resolves.toBeUndefined();
			expect(removeSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			removeSpy.mockRestore();
			// Real removal so the fixture does not leak.
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("removes the handle's profile directory when the headless browser is disposed", async () => {
		const dir = await makeProfileDir();
		const handle = {
			key: "headless:1",
			kind: { kind: "headless", headless: true },
			refCount: 1,
			cdpEndpoint: "http://127.0.0.1:9222",
			userDataDir: dir,
			ownsUserDataDir: true,
			ownedProcess: { pid: 4242 },
		} as unknown as BrowserHandle;

		await releaseBrowser(handle, { kill: false });

		expect(fs.existsSync(dir)).toBe(false);
	});

	it("never removes a caller-owned browser profile", async () => {
		const dir = await makeProfileDir();
		const handle = {
			key: "spawned:/fixture/chrome",
			kind: { kind: "spawned", path: "/fixture/chrome" },
			refCount: 1,
			cdpEndpoint: "http://127.0.0.1:9222",
			userDataDir: dir,
			ownsUserDataDir: false,
			ownedProcess: { pid: 4242 },
		} as unknown as BrowserHandle;
		try {
			await releaseBrowser(handle, { kill: true });
			expect(fs.existsSync(dir)).toBe(true);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
