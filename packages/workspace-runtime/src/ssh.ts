import * as ssh from "@oh-my-pi/pi-utils/ssh";

export interface SshLocationAddress {
	kind: "ssh";
	host: string;
	path: string;
	user?: string;
	port?: number;
	authRef?: string;
}

export interface SshConnectionOptions {
	address: SshLocationAddress;
	knownHostsPath?: string;
	strictHostKeyChecking?: boolean;
	connectTimeoutMs?: number;
}

export class WorkspaceSshManager {
	readonly #connections = new Map<
		string,
		{ address: SshLocationAddress; connectedAt: number; status: "connected" | "disconnected" }
	>();

	async testConnection(options: SshConnectionOptions): Promise<boolean> {
		return ssh.probeSshTcpReachability(
			{
				host: options.address.host,
				port: options.address.port,
				user: options.address.user,
			},
			options.connectTimeoutMs ?? 5000,
		);
	}

	async executeRemote(options: {
		address: SshLocationAddress;
		command: readonly string[];
		timeoutMs?: number;
		knownHostsPath?: string;
	}): Promise<{ stdout: string; stderr: string }> {
		return ssh.runSsh({
			destination: {
				host: options.address.host,
				port: options.address.port,
				user: options.address.user,
			},
			command: options.command,
			timeoutMs: options.timeoutMs,
			knownHostsPath: options.knownHostsPath,
		});
	}

	registerConnection(id: string, address: SshLocationAddress): void {
		this.#connections.set(id, {
			address,
			connectedAt: Date.now(),
			status: "connected",
		});
	}

	disconnect(id: string): boolean {
		const entry = this.#connections.get(id);
		if (!entry) return false;
		entry.status = "disconnected";
		this.#connections.delete(id);
		return true;
	}

	getConnection(id: string) {
		return this.#connections.get(id);
	}
}
