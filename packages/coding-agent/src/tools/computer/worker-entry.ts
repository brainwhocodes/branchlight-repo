import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import type { ComputerWorkerInbound, ComputerWorkerTransport } from "./protocol";

let started = false;

/** Starts the computer worker once while keeping lightweight health checks addon-free. */
export function startComputerWorker(): void {
	if (started || !parentPort) return;
	started = true;
	const port = parentPort;
	const inbox = consumeWorkerInbox();
	const transport: ComputerWorkerTransport = {
		send(message, transfer) {
			port.postMessage(message, transfer ?? []);
		},
		onMessage(handler) {
			if (inbox) return inbox.bind(message => handler(message as ComputerWorkerInbound));
			const listener = (message: unknown): void => handler(message as ComputerWorkerInbound);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
		close() {
			port.close();
		},
	};

	const pending: ComputerWorkerInbound[] = [];
	let coreLoading: Promise<void> | undefined;
	let unsubscribeBootstrap: (() => void) | undefined;

	const loadCore = (): void => {
		coreLoading ??= import("./worker")
			.then(({ ComputerWorkerCore }) => {
				unsubscribeBootstrap?.();
				unsubscribeBootstrap = undefined;
				const core = new ComputerWorkerCore(transport);
				for (const message of pending.splice(0)) core.handle(message);
			})
			.catch(error => {
				queueMicrotask(() => {
					throw error;
				});
			});
	};

	unsubscribeBootstrap = transport.onMessage(message => {
		if (!coreLoading && message.type === "ping") {
			transport.send({ type: "pong", id: message.id });
			return;
		}
		if (!coreLoading && message.type === "close") {
			unsubscribeBootstrap?.();
			unsubscribeBootstrap = undefined;
			transport.send({ type: "closed" });
			transport.close();
			return;
		}
		pending.push(message);
		loadCore();
	});

	// The supervisor waits for readiness before sending its first run. The native
	// desktop implementation is loaded only after that first substantive message.
	transport.send({ type: "ready" });
}

// Direct-source fallback: loaded as a worker's entry module outside a CLI
// host there is no selector argv, so start immediately. When any CLI-host
// worker re-enters cli.ts, the selector guard defers to the host's dispatch.
if (!Bun.argv.some(isWorkerHostSelector)) {
	startComputerWorker();
}
