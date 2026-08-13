const readline = require("node:readline");

const active = new Set();

function send(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

send({ type: "ready" });

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", line => {
	let request;
	try {
		request = JSON.parse(line);
	} catch (error) {
		send({ type: "error", message: error instanceof Error ? error.message : String(error) });
		return;
	}
	switch (request.type) {
		case "start": {
			if (request.env?.BRANCHLIGHT_TERMINAL !== "1" || !request.env?.PI_BROWSER_CDP_URL?.startsWith("http://127.0.0.1:")) {
				send({ type: "error", id: request.id, message: "Branchlight browser connection environment is missing" });
				break;
			}
			active.add(request.id);
			send({ type: "started", id: request.id, cwd: request.cwd });
			send({
				type: "data",
				id: request.id,
				data: "\u001b[2J\u001b[H\u001b[38;2;220;132;80mBranchlight\u001b[0m terminal bridge ready\r\nfixture> ",
			});
			break;
		}
		case "input":
			if (active.has(request.id)) {
				send({ type: "data", id: request.id, data: request.data === "\r" ? "\r\nfixture> " : request.data });
			}
			break;
		case "resize":
			break;
		case "close":
			active.delete(request.id);
			break;
		case "shutdown":
			input.close();
			process.exit(0);
			break;
	}
});
