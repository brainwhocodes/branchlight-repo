import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as oauth from "@oh-my-pi/pi-ai/oauth";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import {
	credentialPinHash,
	installOAuthAccountSelectionFromSettings,
	recordCredentialPin,
	seedCredentialPins,
} from "../src/session/credential-pin";
import { SessionManager } from "../src/session/session-manager";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};
const OAUTH_REGISTRATION_SOURCE = "credential-pin-policy-tests";

function mintOAuthCredential(
	suffix: string,
	extra?: { accountId?: string; email?: string; projectId?: string; orgId?: string },
) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
		...extra,
	};
}

function assistantMessage(provider: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "hi" }],
		api: "anthropic-messages",
		provider,
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

describe("credential pins", () => {
	let tempDir: TempDir;
	let storage: AuthStorage;

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = TempDir.createSync("@pi-credential-pin-");
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		store.saveOAuth("anthropic", mintOAuthCredential("b"));
		store.saveApiKey("definitely-not-a-provider", "api-key-only");
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(() => {
		oauth.unregisterOAuthProviders(OAUTH_REGISTRATION_SOURCE);
		for (const key of ANTHROPIC_ENV) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		tempDir[Symbol.dispose]();
	});

	test("legacy identity tuples retain their byte-identical persisted digests", () => {
		expect(credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" })).toBe(
			"35dfbdf1370e61a8b66e03821bed4a5c140847585da4704d25aeeaa4d1e62f60",
		);
		expect(
			credentialPinHash("openai-codex", {
				accountId: "acct-123",
				email: "person@example.com",
				orgId: "org-7",
				projectId: "project-9",
			}),
		).toBe("8744466fa2861e7bb9a45f75af2f87858bfc0e92210d743da56e3ab4ee5830f5");
	});

	test("project-only and org-only identities are eligible while missing identities are not", () => {
		expect(credentialPinHash("gemini", { projectId: "project-only" })).toBe(
			"05a8385593968ed4da10a56c9c1d7a418f30d685a16a61cc888d1474fc7f9aa2",
		);
		expect(credentialPinHash("anthropic", { orgId: "org-only" })).toBe(
			"84c9fcb60d9bf692ef02163ccbbf2290eeaa78a9bcd486e546a9acf9165e2250",
		);
		expect(credentialPinHash("anthropic", {})).toBeUndefined();
	});

	test("installer binds real rows whose only durable identity is a project or organization", async () => {
		const identityStore = new SqliteAuthCredentialStore(new Database(":memory:"));
		identityStore.saveOAuth(
			"google-gemini-cli",
			mintOAuthCredential("project", {
				accountId: undefined,
				email: undefined,
				projectId: "project-only",
			}),
		);
		identityStore.saveOAuth(
			"anthropic",
			mintOAuthCredential("org", {
				accountId: undefined,
				email: undefined,
				orgId: "org-only",
			}),
		);
		const identityStorage = new AuthStorage(identityStore);
		await identityStorage.reload();
		const projectHash = credentialPinHash("google-gemini-cli", { projectId: "project-only" })!;
		const orgHash = credentialPinHash("anthropic", { orgId: "org-only" })!;

		installOAuthAccountSelectionFromSettings(
			Settings.isolated({
				"providers.oauthAccountLocks": {
					"google-gemini-cli": projectHash,
					anthropic: orgHash,
				},
			}),
			identityStorage,
		);

		const projectAccount = identityStorage.listStoredOAuthAccounts("google-gemini-cli")[0];
		const orgAccount = identityStorage.listStoredOAuthAccounts("anthropic")[0];
		expect(identityStorage.getOAuthAccountSelection("google-gemini-cli")).toEqual({
			identityHash: projectHash,
			credentialId: projectAccount?.credentialId,
			available: true,
			allowSiblingFailover: false,
		});
		expect(identityStorage.getOAuthAccountSelection("anthropic")).toEqual({
			identityHash: orgHash,
			credentialId: orgAccount?.credentialId,
			available: true,
			allowSiblingFailover: false,
		});
		identityStorage.close();
	});
	test("installs unique built-in locks, retains registered stale locks, and filters invalid runtime entries", () => {
		oauth.registerOAuthProvider({
			id: "credential-pin-test-login",
			name: "Credential Pin Test",
			sourceId: OAUTH_REGISTRATION_SOURCE,
			storeCredentialsAs: "credential-pin-test-storage",
			async login() {
				throw new Error("not used");
			},
		});

		const anthropicHash = credentialPinHash("anthropic", {
			accountId: "account-b",
			email: "b@example.com",
		})!;
		const codexStaleHash = "c".repeat(64);
		const registeredStaleHash = "d".repeat(64);
		const configuredLocks: Record<string, unknown> = {
			anthropic: anthropicHash,
			"openai-codex": codexStaleHash,
			"credential-pin-test-storage": registeredStaleHash,
			"definitely-not-a-provider": "e".repeat(64),
			"google-gemini-cli": "F".repeat(64),
			"google-antigravity": 42,
		};
		const settings = Settings.isolated({
			"providers.oauthAccountLocks": configuredLocks,
			"providers.oauthAccountFailover": false,
		});

		installOAuthAccountSelectionFromSettings(settings, storage);

		const selectedAccount = storage
			.listStoredOAuthAccounts("anthropic")
			.find(account => account.accountId === "account-b");
		expect(storage.getOAuthAccountSelection("anthropic")).toEqual({
			identityHash: anthropicHash,
			credentialId: selectedAccount?.credentialId,
			available: true,
			allowSiblingFailover: false,
		});
		expect(storage.getOAuthAccountSelection("openai-codex")).toEqual({
			identityHash: codexStaleHash,
			credentialId: undefined,
			available: false,
			allowSiblingFailover: false,
		});
		expect(storage.getOAuthAccountSelection("credential-pin-test-storage")).toEqual({
			identityHash: registeredStaleHash,
			credentialId: undefined,
			available: false,
			allowSiblingFailover: false,
		});
		expect(storage.getOAuthAccountSelection("definitely-not-a-provider")).toBeUndefined();
		expect(storage.getOAuthAccountSelection("google-gemini-cli")).toBeUndefined();
		expect(storage.getOAuthAccountSelection("google-antigravity")).toBeUndefined();

		configuredLocks.anthropic = "f".repeat(64);
		expect(storage.getOAuthAccountSelection("anthropic")?.identityHash).toBe(anthropicHash);
	});

	test("retains an ambiguous lock without binding either duplicate row", () => {
		const identityHash = credentialPinHash("anthropic", {
			accountId: "account-b",
			email: "b@example.com",
		})!;
		const storedAccount = storage
			.listStoredOAuthAccounts("anthropic")
			.find(account => account.accountId === "account-b");
		if (!storedAccount) throw new Error("Expected stored account");
		vi.spyOn(storage, "listStoredOAuthAccounts").mockReturnValue([
			storedAccount,
			{ ...storedAccount, credentialId: storedAccount.credentialId + 1 },
		]);

		installOAuthAccountSelectionFromSettings(
			Settings.isolated({
				"providers.oauthAccountLocks": { anthropic: identityHash },
				"providers.oauthAccountFailover": false,
			}),
			storage,
		);

		expect(storage.getOAuthAccountSelection("anthropic")).toEqual({
			identityHash,
			credentialId: undefined,
			available: false,
			allowSiblingFailover: false,
		});
	});

	test("a global lock outranks a restored session pin and failover alone clears back to automatic", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accountAHash = credentialPinHash("anthropic", {
			accountId: "account-a",
			email: "a@example.com",
		})!;
		const accountBHash = credentialPinHash("anthropic", {
			accountId: "account-b",
			email: "b@example.com",
		})!;
		manager.appendCredentialPin("anthropic", accountAHash);

		const settings = Settings.isolated({
			"providers.oauthAccountLocks": { anthropic: accountBHash },
			"providers.oauthAccountFailover": false,
		});
		installOAuthAccountSelectionFromSettings(settings, storage);
		seedCredentialPins(storage, manager, sessionId);

		expect(storage.listOAuthAccounts("anthropic", sessionId).some(account => account.active)).toBe(false);
		expect(storage.getOAuthAccountIdentity("anthropic", sessionId)?.accountId).toBe("account-b");

		settings.override("providers.oauthAccountLocks", {});
		settings.override("providers.oauthAccountFailover", true);
		installOAuthAccountSelectionFromSettings(settings, storage);
		expect(storage.getOAuthAccountSelection("anthropic")).toBeUndefined();

		seedCredentialPins(storage, manager, sessionId);
		expect(storage.listOAuthAccounts("anthropic", sessionId).find(account => account.active)?.accountId).toBe(
			"account-a",
		);
	});

	test("a stale global lock still suppresses restored session pin seeding", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		manager.appendCredentialPin(
			"anthropic",
			credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" })!,
		);
		const staleHash = credentialPinHash("anthropic", { accountId: "account-gone" })!;

		installOAuthAccountSelectionFromSettings(
			Settings.isolated({
				"providers.oauthAccountLocks": { anthropic: staleHash },
				"providers.oauthAccountFailover": true,
			}),
			storage,
		);
		seedCredentialPins(storage, manager, sessionId);

		expect(storage.getOAuthAccountSelection("anthropic")).toEqual({
			identityHash: staleHash,
			credentialId: undefined,
			available: false,
			allowSiblingFailover: true,
		});
		expect(storage.listOAuthAccounts("anthropic", sessionId).some(account => account.active)).toBe(false);
	});
	test("pin entries survive a session reload and the latest pin per provider wins", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("anthropic", Date.now()));
		manager.appendCredentialPin("anthropic", "hash-old");
		manager.appendCredentialPin("openai-codex", "hash-codex");
		manager.appendCredentialPin("anthropic", "hash-new");
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");

		const reopened = await SessionManager.open(file);
		const pins = reopened.getCredentialPins();
		expect(pins.get("anthropic")?.hash).toBe("hash-new");
		expect(pins.get("openai-codex")?.hash).toBe("hash-codex");
	});

	test("later assistant turns advance the pin's effective last-use; other providers and new pins do not", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const pinId = manager.appendCredentialPin("anthropic", "hash-a");
		const pinnedAt = new Date(manager.getEntry(pinId)!.timestamp).getTime();

		// Long session on one account: no new pin entries, only assistant turns.
		const lastTurnAt = pinnedAt + 3 * 60 * 60 * 1000;
		manager.appendMessage(assistantMessage("anthropic", pinnedAt + 60_000));
		manager.appendMessage(assistantMessage("anthropic", lastTurnAt));
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(lastTurnAt);

		// A different provider's turn never advances this provider's pin.
		manager.appendMessage(assistantMessage("openai-codex", lastTurnAt + 60_000));
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(lastTurnAt);

		// An account change re-bases last-use at the new pin.
		const newPinId = manager.appendCredentialPin("anthropic", "hash-b");
		const newPinnedAt = new Date(manager.getEntry(newPinId)!.timestamp).getTime();
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(newPinnedAt);
	});

	test("seeding re-pins the recorded account in a store with no session stickiness", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		manager.appendCredentialPin("anthropic", hash);

		// Fresh process: no sticky exists yet (the broker-mode resume scenario).
		expect(storage.listOAuthAccounts("anthropic", sessionId).some(account => account.active)).toBe(false);

		seedCredentialPins(storage, manager, sessionId);

		const active = storage.listOAuthAccounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-b");
	});

	test("pins are org-scoped: the same account in two orgs re-pins the matching org credential", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-1" }));
		store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-2" }));
		const orgStorage = new AuthStorage(store);
		await orgStorage.reload();

		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const identity = { accountId: "account-x", email: "x@example.com" };
		const orgTwoHash = credentialPinHash("anthropic", { ...identity, orgId: "org-2" });
		if (!orgTwoHash) throw new Error("expected a pin hash");
		expect(orgTwoHash).not.toBe(credentialPinHash("anthropic", { ...identity, orgId: "org-1" }));
		manager.appendCredentialPin("anthropic", orgTwoHash);

		seedCredentialPins(orgStorage, manager, sessionId);

		const active = orgStorage.listOAuthAccounts("anthropic", sessionId).find(account => account.active);
		expect(active?.orgId).toBe("org-2");
	});

	test("seeding never clobbers a live sticky from the same process", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.listOAuthAccounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		expect(storage.pinSessionOAuthAccount("anthropic", sessionId, accountA!.credentialId)).toBe(true);

		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		seedCredentialPins(storage, manager, sessionId);

		const active = storage.listOAuthAccounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-a");
	});

	test("seeding is a no-op when the pinned account is no longer stored", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-gone" });
		manager.appendCredentialPin("anthropic", hash!);

		seedCredentialPins(storage, manager, sessionId);

		expect(storage.listOAuthAccounts("anthropic", sessionId).some(account => account.active)).toBe(false);
	});

	test("recording appends the serving account's hash once and dedupes repeats", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.listOAuthAccounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		storage.pinSessionOAuthAccount("anthropic", sessionId, accountA!.credentialId);

		recordCredentialPin(storage, manager, sessionId, "anthropic");
		recordCredentialPin(storage, manager, sessionId, "anthropic");

		const entries = manager.getBranch().filter(entry => entry.type === "credential_pin");
		expect(entries).toHaveLength(1);
		const identity = storage.getOAuthAccountIdentity("anthropic", sessionId);
		expect(manager.getCredentialPins().get("anthropic")?.hash).toBe(credentialPinHash("anthropic", identity!));
	});
});
