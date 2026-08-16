import * as path from "node:path";
import * as readline from "node:readline";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

/**
 * Interactive example of using coding-agent via RpcClient.
 * Usage: npx tsx test/rpc-example.ts
 */

async function main() {
	const client = new RpcClient({
		cliPath: path.join(import.meta.dir, "../src/cli.ts"),
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		args: ["--no-session"],
	});

	// Stream events to console
	client.onEvent(event => {
		if (event.type === "message_update") {
			const { assistantMessageEvent } = event;
			if (assistantMessageEvent.type === "text_delta" || assistantMessageEvent.type === "thinking_delta") {
				process.stdout.write(assistantMessageEvent.delta);
			}
		}

		if (event.type === "tool_execution_start") {
			console.log(`\n[Tool: ${event.toolName}]`);
		}

		if (event.type === "tool_execution_end") {
			console.log(`[Result: ${JSON.stringify(event.result).slice(0, 200)}...]\n`);
		}
	});

	await client.start();

	const state = await client.getState();
	console.log(`Model: ${state.model?.provider}/${state.model?.id}`);
	console.log(`Thinking: ${state.thinkingLevel ?? "off"}\n`);

	// Handle user input
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
	});

	let isWaiting = false;

	const prompt = () => {
		if (!isWaiting) process.stdout.write("You: ");
	};

	rl.on("line", async line => {
		if (isWaiting) return;
		if (line.trim() === "exit") {
			rl.close();
			await client.stop();
			return;
		}

		isWaiting = true;
		await client.promptAndWait(line);
		console.log("\n");
		isWaiting = false;
		prompt();
	});

	rl.on("SIGINT", async () => {
		if (isWaiting) {
			console.log("\n[Aborting...]");
			await client.abort();
		} else {
			rl.close();
			await client.stop();
		}
	});

	console.log("Interactive RPC example. Type 'exit' to quit.\n");
	prompt();
}

main().catch(console.error);
