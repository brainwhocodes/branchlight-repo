import { describe, expect, it, spyOn } from "bun:test";
import * as attach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";

function ownedHeadlessHandle(pid: number): BrowserHandle {
	return {
		key: "headless:1",
		kind: { kind: "headless", headless: true },
		refCount: 1,
		cdpEndpoint: "http://127.0.0.1:9222",
		ownedProcess: { pid },
	} as unknown as BrowserHandle;
}

describe("browser process ownership", () => {
	it("terminates only the registry-owned headless process", async () => {
		const killSpy = spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		try {
			await releaseBrowser(ownedHeadlessHandle(4242), { kill: false, timeoutMs: 100 });
			expect(killSpy).toHaveBeenCalledTimes(1);
			expect(killSpy.mock.calls[0]?.[0]).toBe(4242);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("never terminates an attached shared browser, even when kill is requested", async () => {
		const killSpy = spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const attached = {
			key: "connected:http://127.0.0.1:9222",
			kind: { kind: "connected", cdpUrl: "http://127.0.0.1:9222" },
			refCount: 1,
			cdpEndpoint: "http://127.0.0.1:9222",
			pid: 9999,
		} as BrowserHandle;
		try {
			await releaseBrowser(attached, { kill: true, timeoutMs: 100 });
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
		}
	});
});
