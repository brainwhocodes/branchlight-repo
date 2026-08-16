import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";

const paneName = process.argv[2];
const probeValue = process.argv[3];
if (!paneName || !probeValue) {
	throw new Error("Usage: branchlight-browser-probe.ts <pane-name> <probe-value>");
}

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		"browser.cdpUrl": "http://127.0.0.1:2",
		"browser.headless": true,
		"browser.relay": true,
		"browser.relayUrl": "http://127.0.0.1:1",
	}),
};
const tool = new BrowserTool(session);
let browser: string | undefined;
try {
	const opened = await tool.execute("branchlight-probe-open", {
		action: "open",
		name: paneName,
		app: { relay: true },
	});
	browser = opened.details?.browser;
	if (browser !== "connected") {
		throw new Error(`Expected connected Branchlight browser, received ${browser ?? "unknown"}`);
	}
	await tool.execute("branchlight-probe-run", {
		action: "run",
		name: paneName,
		code: `
			const probeValue = ${JSON.stringify(probeValue)};
			return await tab.evaluate(value => {
				const output = document.querySelector("#fixture-output");
				if (!output) throw new Error("Browser fixture output is missing");
				output.textContent = value;
				return output.textContent;
			}, probeValue);
		`,
	});
} finally {
	await tool.execute("branchlight-probe-close", { action: "close", name: paneName });
}

process.stdout.write(`${JSON.stringify({ browser, name: paneName, probeValue })}\n`);
