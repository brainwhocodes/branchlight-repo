/**
 * Process-local sudo credential broker shared by all agent sessions.
 *
 * Credentials never leave memory, are never persisted, and are only returned to
 * the privileged runner that immediately writes them to sudo's stdin.
 */

export const DEFAULT_SUDO_CREDENTIAL_TTL_MS = 15 * 60 * 1000;

export type SudoCredentialPrompt = (scope: string) => Promise<string | undefined>;

interface CachedCredential {
	value: string;
	expiresAt: number;
}

export class SudoCredentialBroker {
	#credentials = new Map<string, CachedCredential>();
	#pending = new Map<string, Promise<string | undefined>>();

	get(scope: string, now = Date.now()): string | undefined {
		const cached = this.#credentials.get(scope);
		if (!cached) return undefined;
		if (cached.expiresAt <= now) {
			this.#credentials.delete(scope);
			return undefined;
		}
		return cached.value;
	}

	remember(scope: string, value: string, ttlMs = DEFAULT_SUDO_CREDENTIAL_TTL_MS, now = Date.now()): void {
		this.#credentials.set(scope, { value, expiresAt: now + Math.max(1, ttlMs) });
	}

	clear(scope: string): void {
		this.#credentials.delete(scope);
	}

	clearAll(): void {
		this.#credentials.clear();
	}

	async request(
		scope: string,
		prompt: SudoCredentialPrompt,
		ttlMs = DEFAULT_SUDO_CREDENTIAL_TTL_MS,
	): Promise<string | undefined> {
		const cached = this.get(scope);
		if (cached !== undefined) return cached;

		const existing = this.#pending.get(scope);
		if (existing) return existing;

		const pending = this.#requestAndRemember(scope, prompt, ttlMs);
		this.#pending.set(scope, pending);
		try {
			return await pending;
		} finally {
			if (this.#pending.get(scope) === pending) this.#pending.delete(scope);
		}
	}

	async #requestAndRemember(scope: string, prompt: SudoCredentialPrompt, ttlMs: number): Promise<string | undefined> {
		const value = await prompt(scope);
		if (value !== undefined) this.remember(scope, value, ttlMs);
		return value;
	}
}

export const sudoCredentialBroker = new SudoCredentialBroker();
