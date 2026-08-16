import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withOAuthAccess } from "@oh-my-pi/pi-ai/auth-retry";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { isOAuthAccountSelectionError, OAuthAccountSelectionError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { withEnv } from "./helpers";

const PROVIDER = "unit-oauth-select";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function selectionTarget(storage: AuthStorage, suffix: string) {
	const account = storage.listStoredOAuthAccounts(PROVIDER).find(candidate => candidate.accountId === `acc-${suffix}`);
	if (!account) throw new Error(`expected stored OAuth account ${suffix}`);
	return { identityHash: `identity-${suffix}`, credentialId: account.credentialId };
}

async function expectSelectionError(
	promise: Promise<unknown>,
	provider: string,
	identityHash: string,
): Promise<OAuthAccountSelectionError> {
	try {
		await promise;
		throw new Error("expected OAuth account selection error");
	} catch (error) {
		expect(error).toBeInstanceOf(OAuthAccountSelectionError);
		expect(isOAuthAccountSelectionError(error)).toBe(true);
		expect(error).toMatchObject({ provider, identityHash });
		expect((error as Error).message).toBe(
			`Locked OAuth account for "${provider}" is unavailable. Choose another account in /settings > Providers > Accounts.`,
		);
		return error as OAuthAccountSelectionError;
	}
}

describe("AuthStorage OAuth account selection", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-select-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("listOAuthAccounts reports stored order, positions, and identity without refreshing", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const refreshSpy = vi.spyOn(oauthUtils, "getOAuthApiKey");
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const accounts = storage.listOAuthAccounts(PROVIDER);

		expect(accounts.map(a => a.position)).toEqual([0, 1, 2]);
		expect(accounts.map(a => a.accountId)).toEqual(["acc-a", "acc-b", "acc-c"]);
		expect(accounts.map(a => a.email)).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
		// Read-only: listing must not refresh any token.
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	test("pinSessionOAuthAccount selects and restores the exact stored account", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const accounts = storage.listOAuthAccounts(PROVIDER, "session-pin");
		const target = accounts[1];
		if (!target) throw new Error("expected second OAuth account");

		expect(accounts.some(account => account.active)).toBe(false);
		expect(storage.pinSessionOAuthAccount(PROVIDER, "session-pin", -1)).toBe(false);
		expect(storage.pinSessionOAuthAccount(PROVIDER, "session-pin", target.credentialId)).toBe(true);
		expect(storage.getOAuthAccountIdentity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(
			storage
				.listOAuthAccounts(PROVIDER, "session-pin")
				.filter(account => account.active)
				.map(account => account.email),
		).toEqual(["b@example.com"]);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "session-pin",
			}),
		).toBe("b@example.com");

		const restored = new AuthStorage(credentialStore);
		await restored.reload();
		expect(restored.getOAuthAccountIdentity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(restored.listOAuthAccounts(PROVIDER, "session-pin").find(account => account.active)?.credentialId).toBe(
			target.credentialId,
		);
	});

	test("getOAuthAccessAt resolves the credential at the requested position and touches only that one", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		for (const [position, suffix] of [
			[0, "a"],
			[1, "b"],
			[2, "c"],
		] as const) {
			seen.length = 0;
			const result = await storage.getOAuthAccessAt(PROVIDER, position);
			expect(result?.ok).toBe(true);
			if (!result?.ok) throw new Error("expected ok resolution");
			expect(result.accountId).toBe(`acc-${suffix}`);
			expect(result.accessToken).toBe(`access-${suffix}`);
			// Only the targeted credential is resolved — no sibling is touched.
			expect(seen).toEqual([`access-${suffix}`]);
		}
	});

	test("getOAuthAccessByCredentialId refreshes only the durable requested row", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const target = storage.listOAuthAccounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.getOAuthAccessByCredentialId(PROVIDER, target.credentialId, { forceRefresh: true });

		expect(result?.ok).toBe(true);
		if (!result?.ok) throw new Error("expected ok resolution");
		expect(result.credentialId).toBe(target.credentialId);
		expect(result.accountId).toBe("acc-b");
		expect(result.accessToken).toBe("access-b");
		expect(seen).toEqual(["access-b"]);
	});

	test("getOAuthAccessByCredentialId does not substitute a sibling on failure", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.accountId === "acc-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const target = storage.listOAuthAccounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.getOAuthAccessByCredentialId(PROVIDER, target.credentialId);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		expect(result.credentialId).toBe(target.credentialId);
		expect(result.accountId).toBe("acc-b");
		expect(seen).toEqual(["access-b"]);
	});

	test("getOAuthAccessAt returns undefined for an out-of-range position", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		expect(await storage.getOAuthAccessAt(PROVIDER, 2)).toBeUndefined();
		expect(await storage.getOAuthAccessAt(PROVIDER, -1)).toBeUndefined();
	});

	test("getOAuthAccessAt fails the requested account without touching siblings", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		// The targeted account (acc-b) fails definitively; siblings would refresh fine.
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.access === "access-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const result = await storage.getOAuthAccessAt(PROVIDER, 1);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		// Reports the requested account, never a sibling's token.
		expect(result.accountId).toBe("acc-b");
		expect("accessToken" in result).toBe(false);
		// Target-only: no sibling credential was refreshed/rotated on the failure path.
		expect(seen).toEqual(["access-b"]);
	});

	test("an empty policy leaves automatic routing and session stickiness unchanged", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);

		const before = await storage.getApiKey(PROVIDER, "automatic-session");
		if (!before) throw new Error("expected automatic OAuth selection");
		expect(["access-a", "access-b"]).toContain(before);

		storage.setOAuthAccountSelectionPolicy({ selections: {}, allowSiblingFailover: true });

		expect(storage.getOAuthAccountSelection(PROVIDER)).toBeUndefined();
		expect(await storage.getApiKey(PROVIDER, "automatic-session")).toBe(before);
		const another = await storage.getApiKey(PROVIDER, "another-automatic-session");
		if (!another) throw new Error("expected another automatic OAuth selection");
		expect(["access-a", "access-b"]).toContain(another);
	});

	test("strict selection overrides stale stickiness across sessions, switches immediately, and clears to Automatic", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const targetA = selectionTarget(storage, "a");
		const targetB = selectionTarget(storage, "b");

		expect(storage.pinSessionOAuthAccount(PROVIDER, "stale-sticky", targetA.credentialId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, "stale-sticky")).toBe("access-a");

		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: false,
		});
		for (const sessionId of ["stale-sticky", "fresh-session", undefined] as const) {
			expect(await storage.getApiKey(PROVIDER, sessionId)).toBe("access-b");
		}
		expect(storage.getOAuthAccountSelection(PROVIDER)).toEqual({
			...targetB,
			available: true,
			allowSiblingFailover: false,
		});

		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetA },
			allowSiblingFailover: false,
		});
		expect(await storage.getApiKey(PROVIDER, "stale-sticky")).toBe("access-a");
		expect(await storage.getApiKey(PROVIDER, "fresh-session")).toBe("access-a");

		storage.setOAuthAccountSelectionPolicy({ selections: {}, allowSiblingFailover: false });
		expect(storage.getOAuthAccountSelection(PROVIDER)).toBeUndefined();
		expect(storage.pinSessionOAuthAccount(PROVIDER, "stale-sticky", targetB.credentialId)).toBe(true);
		expect(await storage.getApiKey(PROVIDER, "stale-sticky")).toBe("access-b");
	});

	test("a stale strict target remains explicit auth intent and throws an actionable typed error", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const provider = "unit-oauth-select-missing";
		const identityHash = "missing-identity";
		storage.setOAuthAccountSelectionPolicy({
			selections: { [provider]: { identityHash, credentialId: 999_999 } },
			allowSiblingFailover: false,
		});

		expect(storage.hasAuth(provider)).toBe(true);
		expect(storage.hasNonEnvCredential(provider)).toBe(true);
		expect(storage.getOAuthAccountSelection(provider)).toEqual({
			identityHash,
			credentialId: 999_999,
			available: false,
			allowSiblingFailover: false,
		});
		await expectSelectionError(storage.peekApiKey(provider), provider, identityHash);
		await expectSelectionError(storage.getApiKey(provider, "missing-session"), provider, identityHash);
		await expectSelectionError(storage.getOAuthAccess(provider, "missing-session"), provider, identityHash);
	});

	test("runtime and config keys outrank policy while stored-account diagnostics remain policy-neutral", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const staleTarget = { identityHash: "stale-override", credentialId: 999_999 };
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: staleTarget },
			allowSiblingFailover: false,
		});

		expect(storage.listStoredOAuthAccounts(PROVIDER).map(account => account.accountId)).toEqual(["acc-a", "acc-b"]);
		storage.setRuntimeApiKey(PROVIDER, "runtime-key");
		expect(await storage.getApiKey(PROVIDER)).toBe("runtime-key");
		expect(await storage.peekApiKey(PROVIDER)).toBe("runtime-key");
		expect(await storage.getOAuthAccess(PROVIDER)).toBeUndefined();
		expect(storage.getOAuthAccountIdentity(PROVIDER)).toBeUndefined();
		expect(storage.listOAuthAccounts(PROVIDER)).toEqual([]);
		expect(storage.listStoredOAuthAccounts(PROVIDER).map(account => account.accountId)).toEqual(["acc-a", "acc-b"]);

		storage.removeRuntimeApiKey(PROVIDER);
		storage.setConfigApiKey(PROVIDER, "config-key");
		expect(await storage.getApiKey(PROVIDER)).toBe("config-key");
		expect(await storage.peekApiKey(PROVIDER)).toBe("config-key");
		expect(storage.listStoredOAuthAccounts(PROVIDER)).toHaveLength(2);

		storage.removeConfigApiKey(PROVIDER);
		await expectSelectionError(
			storage.getApiKey(PROVIDER, "selected-after-overrides"),
			PROVIDER,
			staleTarget.identityHash,
		);
	});

	test("strict unavailability cannot fall through to login, env, stored, or fallback keys", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		const provider = "anthropic";
		await storage.set(provider, [
			{ ...oauthCredential("a"), accountId: "anthropic-a" },
			{ type: "api_key", key: "login-key", source: "login" },
			{ type: "api_key", key: "stored-key" },
		]);
		const resolveConfigValue = vi.fn(async (value: string) => value);
		const guarded = new AuthStorage(credentialStore, { configValueResolver: resolveConfigValue });
		await guarded.reload();
		const fallback = vi.fn(() => "fallback-key");
		guarded.setFallbackResolver(fallback);
		guarded.setOAuthAccountSelectionPolicy({
			selections: { [provider]: { identityHash: "stale-anthropic" } },
			allowSiblingFailover: false,
		});

		await withEnv({ ANTHROPIC_API_KEY: "env-key", ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
			await expectSelectionError(guarded.getApiKey(provider, "lower-precedence"), provider, "stale-anthropic");
			await expectSelectionError(guarded.peekApiKey(provider), provider, "stale-anthropic");
		});
		expect(resolveConfigValue).not.toHaveBeenCalled();
		expect(fallback).not.toHaveBeenCalled();
	});

	test("peek and identity use the selected account before any session has served", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const targetB = selectionTarget(storage, "b");
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: false,
		});

		expect(storage.hasAuth(PROVIDER)).toBe(true);
		expect(storage.hasNonEnvCredential(PROVIDER)).toBe(true);
		expect(await storage.peekApiKey(PROVIDER)).toBe("access-b");
		expect(storage.getOAuthAccountId(PROVIDER, "not-served")).toBe("acc-b");
		expect(storage.getOAuthAccountIdentity(PROVIDER, "not-served")).toMatchObject({
			accountId: "acc-b",
			email: "b@example.com",
		});
	});

	test("strict attempts only the selected row while failover tries it before ranked siblings", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.accountId === "acc-b") return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const targetB = selectionTarget(storage, "b");
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: false,
		});

		await expectSelectionError(storage.getApiKey(PROVIDER, "strict-only"), PROVIDER, targetB.identityHash);
		expect(seen[0]).toBe("access-b");
		expect(seen).not.toContain("access-a");

		seen.length = 0;
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: true,
		});
		expect(await storage.getApiKey(PROVIDER, "failover-session")).toBe("access-a");
		expect(seen[0]).toBe("access-b");
		expect(seen).toContain("access-a");
		expect(storage.getOAuthAccountIdentity(PROVIDER, "failover-session")?.accountId).toBe("acc-a");
		expect(storage.getOAuthAccountSelection(PROVIDER)?.available).toBe(true);
	});

	test("a definitively disabled selected row never leaks to a sibling in strict mode", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.accountId === "acc-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const targetB = selectionTarget(storage, "b");
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: false,
		});

		await expectSelectionError(storage.getApiKey(PROVIDER, "disable-selected"), PROVIDER, targetB.identityHash);
		expect(seen).toEqual(["access-b"]);
		expect(storage.listStoredOAuthAccounts(PROVIDER).map(account => account.accountId)).toEqual(["acc-a"]);
		expect(storage.getOAuthAccountSelection(PROVIDER)?.available).toBe(false);

		seen.length = 0;
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: true,
		});
		expect(await storage.getApiKey(PROVIDER, "disable-selected")).toBe("access-a");
		expect(seen).toEqual(["access-a"]);
	});

	test("a selected-row refresh failure blocks strict fallback but permits an existing sibling in failover mode", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const refreshSeen: string[] = [];
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			refreshSeen.push(credential.accountId ?? "unknown");
			if (credential.accountId === "acc-b") throw new Error("temporary refresh service failure");
			return { ...credential, expires: Date.now() + 60 * 60_000 };
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		const expiredB = { ...oauthCredential("b"), expires: 0 };
		await storage.set(PROVIDER, [oauthCredential("a"), expiredB]);
		const targetB = selectionTarget(storage, "b");
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: false,
		});

		await expectSelectionError(storage.getApiKey(PROVIDER, "refresh-failure"), PROVIDER, targetB.identityHash);
		expect(refreshSeen.length).toBeGreaterThan(0);
		expect(refreshSeen.every(accountId => accountId === "acc-b")).toBe(true);

		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: true,
		});
		expect(await storage.getApiKey(PROVIDER, "refresh-failure")).toBe("access-a");
	});
});
