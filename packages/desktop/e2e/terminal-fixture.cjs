const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const active = new Map();

function send(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function envValue(env, name) {
	const key = Object.keys(env ?? {}).find(candidate => candidate.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

function resolveOmpBinary(envPath) {
	const delimiter = path.delimiter;
	const entries = (envPath || "").split(delimiter).filter(Boolean);
	const exeName = process.platform === "win32" ? "omp.exe" : "omp";
	for (const entry of entries) {
		const candidate = path.join(entry, exeName);
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {}
	}
	return undefined;
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
			const expectedPath = envValue(process.env, "PATH");
			const actualPath = envValue(request.env, "PATH");
			if (
				!actualPath ||
				(actualPath !== expectedPath && !actualPath.includes(expectedPath)) ||
				request.env?.BRANCHLIGHT_TERMINAL !== "1"
			) {
				send({ type: "error", id: request.id, message: "Regular shell environment is missing or modified" });
				break;
			}
			active.set(request.id, { env: request.env, cwd: request.cwd, child: null });
			send({ type: "started", id: request.id, cwd: request.cwd });
			send({
				type: "data",
				id: request.id,
				data: "\u001b[2J\u001b[H\u001b[38;2;220;132;80mBranchlight\u001b[0m terminal bridge ready\r\nfixture> ",
			});
			break;
		}
		case "input": {
			const session = active.get(request.id);
			if (session) {
				const trimmed = (request.data || "").trim();
				if (trimmed === "run-omp" || trimmed === "omp" || trimmed.startsWith("omp ")) {
					const ompPath = resolveOmpBinary(session.env?.PATH);
					if (ompPath) {
						try {
							const child = spawn(ompPath, ["--mode", "rpc"], {
								env: {
									...session.env,
									OMP_GRPC_TOKEN: `fixture-grpc-token-${Date.now()}`,
									OMP_GRPC_PORT: "0",
								},
								cwd: session.cwd,
								stdio: ["pipe", "pipe", "pipe"],
							});
							session.child = child;
							child.stdout.on("data", () => {});
							child.stderr.on("data", chunk => {
								const text = String(chunk);
								if (text.includes("Error") || text.includes("error")) {
									process.stderr.write(`[omp fixture stderr]: ${text}\n`);
								}
							});
							child.on("exit", () => {
								session.child = null;
							});
							send({
								type: "data",
								id: request.id,
								data: `\r\n[spawned omp rpc pid ${child.pid}]\r\nfixture> `,
							});
						} catch (err) {
							send({
								type: "data",
								id: request.id,
								data: `\r\n[failed to spawn omp: ${err.message}]\r\nfixture> `,
							});
						}
					} else {
						send({
							type: "data",
							id: request.id,
							data: "\r\n[omp not found in PATH]\r\nfixture> ",
						});
					}
				} else if (trimmed === "stop-omp" || trimmed === "exit") {
					if (session.child) {
						try {
							session.child.kill("SIGTERM");
						} catch {}
						session.child = null;
						send({
							type: "data",
							id: request.id,
							data: "\r\n[stopped omp]\r\nfixture> ",
						});
					} else {
						send({ type: "data", id: request.id, data: request.data === "\r" ? "\r\nfixture> " : request.data });
					}
				} else {
					send({ type: "data", id: request.id, data: request.data === "\r" ? "\r\nfixture> " : request.data });
				}
			}
			break;
		}
		case "resize":
			break;
		case "close": {
			const session = active.get(request.id);
			if (session && session.child) {
				try {
					session.child.kill("SIGTERM");
				} catch {}
				session.child = null;
			}
			active.delete(request.id);
			break;
		}
		case "shutdown":
			for (const session of active.values()) {
				if (session.child) {
					try {
						session.child.kill("SIGTERM");
					} catch {}
				}
			}
			active.clear();
			input.close();
			process.exit(0);
			break;
	}
});
