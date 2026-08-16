import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveBrowserKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const previousCdpUrl = process.env.PI_BROWSER_CDP_URL;
const previousBranchlightTerminal = process.env.BRANCHLIGHT_TERMINAL;
const previousBrowserRelay = process.env.PI_BROWSER_RELAY;
const previousCmuxSocketPath = process.env.CMUX_SOCKET_PATH;

function session(options: { configured?: boolean } = {}): ToolSession {
	const configured = options.configured ?? true;
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: {
			get: (key: string) => {
				if (key === "browser.relay") return configured;
				if (key === "browser.relayUrl") return "http://127.0.0.1:1";
				if (key === "browser.cdpUrl") return configured ? "http://127.0.0.1:9223" : undefined;
				if (key === "browser.headless") return true;
				return undefined;
			},
		},
	} as unknown as ToolSession;
}

beforeEach(() => {
	delete process.env.PI_BROWSER_CDP_URL;
	delete process.env.BRANCHLIGHT_TERMINAL;
	delete process.env.PI_BROWSER_RELAY;
	delete process.env.CMUX_SOCKET_PATH;
});

afterEach(() => {
	if (previousCdpUrl === undefined) delete process.env.PI_BROWSER_CDP_URL;
	else process.env.PI_BROWSER_CDP_URL = previousCdpUrl;
	if (previousBranchlightTerminal === undefined) delete process.env.BRANCHLIGHT_TERMINAL;
	else process.env.BRANCHLIGHT_TERMINAL = previousBranchlightTerminal;
	if (previousBrowserRelay === undefined) delete process.env.PI_BROWSER_RELAY;
	else process.env.PI_BROWSER_RELAY = previousBrowserRelay;
	if (previousCmuxSocketPath === undefined) delete process.env.CMUX_SOCKET_PATH;
	else process.env.CMUX_SOCKET_PATH = previousCmuxSocketPath;
});

describe("Branchlight browser inheritance", () => {
	test("inherits Mars Kommander browser CDP endpoint when running inside terminal", () => {
		process.env.BRANCHLIGHT_TERMINAL = "1";
		process.env.PI_BROWSER_CDP_URL = "http://127.0.0.1:9222/";

		expect(resolveBrowserKind({ action: "open" }, session({ configured: false }))).toEqual({
			kind: "connected",
			cdpUrl: "http://127.0.0.1:9222",
		});
	});

	test("keeps explicit CDP and spawned-app choices above Branchlight inheritance", () => {
		process.env.BRANCHLIGHT_TERMINAL = "1";
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
		expect(resolveBrowserKind({ action: "open", app: { path: process.execPath } }, session())).toEqual({
			kind: "spawned",
			path: process.execPath,
		});
	});
	test("keeps explicit relay and cmux choices in Branchlight", () => {
		process.env.BRANCHLIGHT_TERMINAL = "1";
		expect(resolveBrowserKind({ action: "open", app: { relay: true } }, session())).toEqual({
			kind: "relay",
			cdpUrl: "http://127.0.0.1:1",
		});

		process.env.CMUX_SOCKET_PATH = "/tmp/branchlight-cmux.sock";
		expect(resolveBrowserKind({ action: "open" }, session({ configured: false }))).toEqual({
			kind: "cmux",
			socketPath: "/tmp/branchlight-cmux.sock",
		});
	});

	test("keeps explicit relay above generic inherited CDP outside Branchlight", () => {
		process.env.PI_BROWSER_CDP_URL = "http://127.0.0.1:55321";
		process.env.PI_BROWSER_RELAY = "1";

		expect(resolveBrowserKind({ action: "open", app: { relay: true } }, session())).toEqual({
			kind: "relay",
			cdpUrl: "http://127.0.0.1:1",
		});
	});
});
