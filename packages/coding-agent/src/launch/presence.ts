import * as fs from "node:fs/promises";
import * as path from "node:path";
import { captureProcessIdentity, inspectProcessIdentity, isEisdir, isEnoent, postmortem } from "@oh-my-pi/pi-utils";
import { daemonRuntimeDir } from "./paths";

const CLIENTS_DIR = "clients";

/** Handle keeping one omp process registered in a project daemon scope. */
export interface DaemonProjectPresence {
	close(): Promise<void>;
}

async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error)) return resolved;
		throw error;
	}
}

/** Register this omp process so project daemons survive while it remains alive. */
export async function registerDaemonProjectPresence(
	projectDir: string,
	runtimeOverride?: string,
): Promise<DaemonProjectPresence> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir = runtimeOverride ?? daemonRuntimeDir(canonical);
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	await fs.mkdir(clientsDir, { recursive: true, mode: 0o700 });
	const captured = await captureProcessIdentity(process.pid);
	if (!captured.identity || captured.status !== "matched") {
		throw new Error(`Unable to establish verified daemon presence identity (${captured.status})`);
	}
	const id = `${process.pid}-${crypto.randomUUID()}`;
	const presencePath = path.join(clientsDir, `${id}.json`);
	await Bun.write(
		presencePath,
		JSON.stringify({
			pid: captured.identity.pid,
			startToken: captured.identity.startToken,
			id,
			projectDir: canonical,
		}),
	);
	await fs.chmod(presencePath, 0o600);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		cancelCleanup();
		await fs.rm(presencePath, { force: true });
	};
	const cancelCleanup = postmortem.register(`daemon-presence:${id}`, () => close());
	return { close };
}

/** Return whether a registered omp process in this runtime directory is still alive. */
export async function hasLiveDaemonProjectPresence(runtimeDir: string): Promise<boolean> {
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(clientsDir);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	let live = false;
	for (const entry of entries) {
		const presencePath = path.join(clientsDir, entry);
		try {
			const decoded: unknown = await Bun.file(presencePath).json();
			if (
				typeof decoded !== "object" ||
				decoded === null ||
				!("pid" in decoded) ||
				typeof decoded.pid !== "number" ||
				!("startToken" in decoded) ||
				typeof decoded.startToken !== "string"
			) {
				live = true;
				continue;
			}
			const inspection = await inspectProcessIdentity({ pid: decoded.pid, startToken: decoded.startToken });
			if (inspection.status === "matched") {
				live = true;
			} else if (inspection.status === "dead") {
				await fs.rm(presencePath, { force: true });
			} else {
				live = true;
			}
		} catch (error) {
			if (!isEnoent(error)) live = true;
		}
	}
	return live;
}
