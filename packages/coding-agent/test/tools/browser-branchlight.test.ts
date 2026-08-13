import { afterEach, describe, expect, test } from "bun:test";
import { resolveBranchlightBrowserTarget, resolveBrowserKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const previousCdpUrl = process.env.PI_BROWSER_CDP_URL;
const previousBranchlightTerminal = process.env.BRANCHLIGHT_TERMINAL;

function session(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: {
			get: (key: string) => {
				if (key === "browser.relay") return false;
				if (key === "browser.cdpUrl") return "http://127.0.0.1:9223";
				if (key === "browser.headless") return true;
				return undefined;
			},
		},
	} as unknown as ToolSession;
}

afterEach(() => {
	if (previousCdpUrl === undefined) delete process.env.PI_BROWSER_CDP_URL;
	else process.env.PI_BROWSER_CDP_URL = previousCdpUrl;
	if (previousBranchlightTerminal === undefined) delete process.env.BRANCHLIGHT_TERMINAL;
	else process.env.BRANCHLIGHT_TERMINAL = previousBranchlightTerminal;
});

describe("Branchlight browser inheritance", () => {
	test("uses the terminal's loopback CDP endpoint instead of configured browser defaults", () => {
		process.env.PI_BROWSER_CDP_URL = "http://127.0.0.1:55321/";
		expect(resolveBrowserKind({ action: "open", name: "Research Docs" }, session())).toEqual({
			kind: "connected",
			cdpUrl: "http://127.0.0.1:55321",
		});
	});

	test("keeps an explicit CDP endpoint authoritative", () => {
		process.env.PI_BROWSER_CDP_URL = "http://127.0.0.1:55321";
		expect(
			resolveBrowserKind(
				{
					action: "open",
					app: { cdp_url: "http://127.0.0.1:9444/" },
				},
				session(),
			),
		).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9444" });
	});

	test("maps non-default tool names to workspace tab names while preserving explicit targets", () => {
		process.env.BRANCHLIGHT_TERMINAL = "1";
		expect(resolveBranchlightBrowserTarget("Research Docs")).toBe("Research Docs");
		expect(resolveBranchlightBrowserTarget("main")).toBeUndefined();
		expect(resolveBranchlightBrowserTarget("Research Docs", "Docs / 2")).toBe("Docs / 2");
	});
});
