import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	OAUTH_ACCOUNT_STREAMING_MESSAGE,
	type OAuthAccountLoginDialogPort,
	type OAuthAccountLoginResult,
	type OAuthAccountManagerActions,
	OAuthAccountManagerComponent,
	type OAuthAccountRemovalResult,
} from "@oh-my-pi/pi-coding-agent/modes/components/oauth-account-manager";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	AuthStorage,
	type OAuthAccountSummary,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	credentialPinHash,
	installOAuthAccountSelectionFromSettings,
} from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import type { SgrMouseEvent, TUI } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

const openStorages = new Set<AuthStorage>();

afterEach(() => {
	for (const storage of openStorages) storage.close();
	openStorages.clear();
});

interface StoredAccountInput {
	provider: string;
	credential: OAuthCredential;
}

interface HarnessOptions {
	accounts?: readonly StoredAccountInput[];
	locks?: Readonly<Record<string, string>>;
	failover?: boolean;
	methods?: readonly OAuthProviderInfo[];
	streaming?: boolean;
	login?: OAuthAccountManagerActions["login"];
	remove?: OAuthAccountManagerActions["remove"];
}

interface ManagerHarness {
	component: OAuthAccountManagerComponent;
	settings: Settings;
	authStorage: AuthStorage;
	store: SqliteAuthCredentialStore;
	installPolicy: Mock<() => void>;
	invalidate: Mock<() => void>;
	onChange: Mock<(locks: Readonly<Record<string, string>>) => void>;
	onClose: Mock<() => void>;
	login: OAuthAccountManagerActions["login"];
	remove: OAuthAccountManagerActions["remove"];
	setStreaming(value: boolean): void;
}

function oauthCredential(suffix: string, overrides: Partial<OAuthCredential> = {}): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: 4_102_444_800_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
		...overrides,
	};
}

function loginMethod(id: OAuthProviderInfo["id"], name: string, storeCredentialsAs?: string): OAuthProviderInfo {
	return { id, name, available: true, storeCredentialsAs };
}

function hashFor(provider: string, credential: OAuthCredential): string {
	const hash = credentialPinHash(provider, credential);
	if (!hash) throw new Error(`Expected ${provider} credential to have a persistent identity`);
	return hash;
}

async function createHarness(options: HarnessOptions = {}): Promise<ManagerHarness> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const accountsByProvider = new Map<string, OAuthCredential[]>();
	for (const account of options.accounts ?? []) {
		const credentials = accountsByProvider.get(account.provider) ?? [];
		credentials.push(account.credential);
		accountsByProvider.set(account.provider, credentials);
	}
	for (const [provider, credentials] of accountsByProvider) {
		store.replaceAuthCredentialsForProvider(provider, credentials);
	}
	const authStorage = new AuthStorage(store);
	openStorages.add(authStorage);
	await authStorage.reload();
	const settings = Settings.isolated();
	settings.set("providers.oauthAccountLocks", { ...options.locks });
	settings.set("providers.oauthAccountFailover", options.failover ?? false);
	const installPolicy = vi.fn(() => installOAuthAccountSelectionFromSettings(settings, authStorage));
	installPolicy();
	const invalidate = vi.fn((): void => {});
	const onChange = vi.fn((_locks: Readonly<Record<string, string>>): void => {});
	const onClose = vi.fn((): void => {});
	let streaming = options.streaming ?? false;
	const login = options.login ?? (async (): Promise<OAuthAccountLoginResult> => ({ status: "cancelled" }));
	const remove = options.remove ?? (async (): Promise<OAuthAccountRemovalResult> => ({ status: "missing" }));
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const component = new OAuthAccountManagerComponent(
		{
			settings,
			authStorage,
			tui,
			sessionId: "manager-session",
			getLoginMethods: () => options.methods ?? [],
			isStreaming: () => streaming,
			installPolicy,
			invalidate,
			actions: { login, remove },
		},
		{ onChange, onClose },
	);
	return {
		component,
		settings,
		authStorage,
		store,
		installPolicy,
		invalidate,
		onChange,
		onClose,
		login,
		remove,
		setStreaming(value: boolean) {
			streaming = value;
		},
	};
}

function rendered(component: OAuthAccountManagerComponent): string {
	return component
		.render(110)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

function renderedLines(component: OAuthAccountManagerComponent): string[] {
	return component.render(110).map(line => Bun.stripANSI(line));
}

function pressDown(component: OAuthAccountManagerComponent, count = 1): void {
	for (let index = 0; index < count; index++) component.handleInput("\x1b[B");
}

function pressUp(component: OAuthAccountManagerComponent, count = 1): void {
	for (let index = 0; index < count; index++) component.handleInput("\x1b[A");
}

function enter(component: OAuthAccountManagerComponent): void {
	component.handleInput("\n");
}

function pressEscape(component: OAuthAccountManagerComponent): void {
	component.handleInput("\x1b");
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function leftClick(line: number): SgrMouseEvent {
	return { button: 0, col: 0, row: line, release: false, wheel: null, motion: false, leftClick: true };
}

const anthropicMethod = loginMethod("anthropic", "Anthropic");

const accountA = oauthCredential("a");
const accountB = oauthCredential("b");
const hashA = hashFor("anthropic", accountA);

function anthropicAccounts(...credentials: OAuthCredential[]): StoredAccountInput[] {
	return credentials.map(credential => ({ provider: "anthropic", credential }));
}

function openAnthropicDetail(harness: ManagerHarness): void {
	enter(harness.component);
	expect(rendered(harness.component)).toContain("Automatic routing");
}

function openAddFromAutomatic(harness: ManagerHarness, rowCount: number): void {
	openAnthropicDetail(harness);
	pressDown(harness.component, rowCount + 1);
	enter(harness.component);
}

function openRemoveFromFirstConfigured(harness: ManagerHarness, rowCount: number): void {
	openAnthropicDetail(harness);
	pressDown(harness.component, rowCount + 1);
	enter(harness.component);
}

describe("OAuthAccountManagerComponent routing state", () => {
	it("opens the provider and detail screens without creating a lock", async () => {
		const harness = await createHarness({ accounts: anthropicAccounts(accountA), methods: [anthropicMethod] });

		expect(rendered(harness.component)).toContain("Anthropic");
		expect(rendered(harness.component)).toContain("Automatic");
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({});
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")).toBeUndefined();
		const installsAfterOpen = harness.installPolicy.mock.calls.length;

		openAnthropicDetail(harness);

		expect(rendered(harness.component)).toContain("Automatic routing");
		expect(rendered(harness.component)).toContain("a@example.com");
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({});
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")).toBeUndefined();
		expect(harness.installPolicy).toHaveBeenCalledTimes(installsAfterOpen);
		expect(harness.onChange).not.toHaveBeenCalled();
	});

	it.each([
		[false, "Locked: a@example.com (strict)"],
		[true, "Locked: a@example.com (failover on)"],
	] as const)("renders the exact configured provider label when failover is %s", async (failover, label) => {
		const harness = await createHarness({
			accounts: anthropicAccounts(accountA),
			locks: { anthropic: hashA },
			failover,
			methods: [anthropicMethod],
		});

		expect(rendered(harness.component)).toContain(label);
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")).toMatchObject({
			identityHash: hashA,
			available: true,
			allowSiblingFailover: failover,
		});
	});

	it("renders a stale provider lock with the exact unavailable label", async () => {
		const staleHash = "f".repeat(64);
		const harness = await createHarness({
			locks: { anthropic: staleHash },
			methods: [anthropicMethod],
		});

		expect(rendered(harness.component)).toContain("Anthropic");
		expect(rendered(harness.component)).toContain("Locked account unavailable");
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")).toEqual({
			identityHash: staleHash,
			credentialId: undefined,
			available: false,
			allowSiblingFailover: false,
		});
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: staleHash });
	});

	it("makes selecting one unique row the sole opt-in and persists only its hash", async () => {
		const harness = await createHarness({
			accounts: anthropicAccounts(accountA, accountB),
			failover: true,
			methods: [anthropicMethod],
		});
		openAnthropicDetail(harness);
		pressDown(harness.component);
		enter(harness.component);

		const locks = harness.settings.get("providers.oauthAccountLocks");
		expect(locks).toEqual({ anthropic: hashA });
		expect(locks.anthropic).toMatch(/^[0-9a-f]{64}$/);
		expect(locks.anthropic).not.toContain("account-a");
		expect(harness.onChange.mock.calls).toEqual([[{ anthropic: hashA }]]);
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")).toMatchObject({
			identityHash: hashA,
			available: true,
			allowSiblingFailover: true,
		});
		expect(rendered(harness.component)).toContain("configured");
	});

	it("preselects the configured row and distinguishes it from the active failover row", async () => {
		const harness = await createHarness({
			accounts: anthropicAccounts(accountA, accountB),
			locks: { anthropic: hashA },
			failover: true,
			methods: [anthropicMethod],
		});
		const rows = harness.authStorage.listStoredOAuthAccounts("anthropic");
		const rowB = rows.find(row => row.accountId === "account-b");
		if (!rowB) throw new Error("Expected account B");
		expect(harness.authStorage.pinSessionOAuthAccount("anthropic", "manager-session", rowB.credentialId)).toBe(true);

		openAnthropicDetail(harness);
		const detail = rendered(harness.component);
		expect(detail).toMatch(/a@example\.com\s+configured/);
		expect(detail).toMatch(/b@example\.com\s+active/);
		expect(detail).not.toMatch(/a@example\.com\s+[^\n]*active/);

		enter(harness.component);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: hashA });
	});

	it("Automatic deletes only this provider lock, reinstalls policy, and restores session pinning", async () => {
		const google = oauthCredential("google", { projectId: "project-google" });
		const googleHash = hashFor("google-gemini-cli", google);
		const harness = await createHarness({
			accounts: [...anthropicAccounts(accountA, accountB), { provider: "google-gemini-cli", credential: google }],
			locks: { anthropic: hashA, "google-gemini-cli": googleHash },
			methods: [anthropicMethod, loginMethod("google-gemini-cli", "Gemini CLI")],
		});
		openAnthropicDetail(harness);
		pressUp(harness.component);
		enter(harness.component);

		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ "google-gemini-cli": googleHash });
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")).toBeUndefined();
		expect(harness.authStorage.getOAuthAccountSelection("google-gemini-cli")?.identityHash).toBe(googleHash);
		expect(harness.onChange.mock.calls).toEqual([[{ "google-gemini-cli": googleHash }]]);
		const rowB = harness.authStorage.listStoredOAuthAccounts("anthropic").find(row => row.accountId === "account-b");
		if (!rowB) throw new Error("Expected account B");
		expect(harness.authStorage.pinSessionOAuthAccount("anthropic", "manager-session", rowB.credentialId)).toBe(true);
		expect(harness.authStorage.getOAuthAccountIdentity("anthropic", "manager-session")?.accountId).toBe("account-b");
	});
});

describe("OAuthAccountManagerComponent identity eligibility", () => {
	it("disables missing and duplicate hashes with the exact reason while keeping every row removable", async () => {
		const missing = oauthCredential("missing", { accountId: undefined, email: undefined });
		const duplicateOne = oauthCredential("duplicate-one", { accountId: "same-account", email: "same@example.com" });
		let visibleRows: OAuthAccountSummary[] = [];
		let harness: ManagerHarness | undefined;
		const remove = vi.fn(
			async (
				provider: string,
				credentialId: number,
				_refreshProviderId: string,
				_blockedReason: (() => string | undefined) | undefined,
				afterRemoved: (() => void) | undefined,
			): Promise<OAuthAccountRemovalResult> => {
				if (!harness) throw new Error("Harness not ready");
				expect(provider).toBe("anthropic");
				const remaining = visibleRows.filter(row => row.credentialId !== credentialId);
				if (remaining.length === visibleRows.length) return { status: "missing" };
				visibleRows = remaining;
				afterRemoved?.();
				return { status: "removed" };
			},
		);
		harness = await createHarness({
			accounts: anthropicAccounts(missing, duplicateOne),
			methods: [anthropicMethod],
			remove,
		});
		const storedRows = harness.authStorage.listStoredOAuthAccounts("anthropic");
		const storedDuplicate = storedRows.find(row => row.accountId === "same-account");
		if (!storedDuplicate) throw new Error("Expected stored duplicate-identity row");
		visibleRows = [...storedRows, { ...storedDuplicate, credentialId: storedDuplicate.credentialId + 1 }];
		vi.spyOn(harness.authStorage, "listStoredOAuthAccounts").mockImplementation(provider =>
			provider === "anthropic" ? visibleRows : [],
		);
		openAnthropicDetail(harness);
		const detail = rendered(harness.component);
		expect(detail.match(/Identity unavailable for persistent lock/g)).toHaveLength(3);
		expect(detail).toContain("OAuth credential #");

		pressDown(harness.component);
		enter(harness.component);
		expect(rendered(harness.component)).toContain("Identity unavailable for persistent lock");
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({});

		pressEscape(harness.component);
		enter(harness.component);
		pressDown(harness.component, 5);
		enter(harness.component);
		const removeScreen = rendered(harness.component);
		expect(removeScreen).toContain("Credential #");
		expect(removeScreen).toContain("same@example.com");
		const missingRow = harness.authStorage
			.listStoredOAuthAccounts("anthropic")
			.find(row => row.accountId === undefined && row.email === undefined);
		if (!missingRow) throw new Error("Expected identity-free row");
		enter(harness.component);
		expect(rendered(harness.component)).toContain(
			`Press Enter again to remove OAuth credential #${missingRow.credentialId}; Esc to cancel`,
		);
		enter(harness.component);
		await settle();
		expect(remove.mock.calls[0]?.[1]).toBe(missingRow.credentialId);
		expect(harness.authStorage.listStoredOAuthAccounts("anthropic")).toHaveLength(2);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({});
		const duplicateRow = harness.authStorage
			.listStoredOAuthAccounts("anthropic")
			.find(row => row.accountId === "same-account");
		if (!duplicateRow) throw new Error("Expected duplicate-identity row");
		pressDown(harness.component, 4);
		enter(harness.component);
		enter(harness.component);
		enter(harness.component);
		await settle();
		expect(remove.mock.calls[1]?.[1]).toBe(duplicateRow.credentialId);
		expect(harness.authStorage.listStoredOAuthAccounts("anthropic")).toHaveLength(1);
	});

	it("org-qualifies duplicate emails and gives different organizations different hashes", async () => {
		const personal = oauthCredential("personal", {
			accountId: "shared-account",
			email: "shared@example.com",
			orgId: "org-personal",
			orgName: "Personal",
		});
		const team = oauthCredential("team", {
			accountId: "shared-account",
			email: "shared@example.com",
			orgId: "org-team",
			orgName: "Team",
		});
		const personalHash = hashFor("anthropic", personal);
		const teamHash = hashFor("anthropic", team);
		expect(personalHash).not.toBe(teamHash);
		const harness = await createHarness({ accounts: anthropicAccounts(personal, team), methods: [anthropicMethod] });
		openAnthropicDetail(harness);
		const detail = rendered(harness.component);
		expect(detail).toContain("shared@example.com (Personal)");
		expect(detail).toContain("shared@example.com (Team)");
		expect(detail).not.toContain("Identity unavailable for persistent lock");

		pressDown(harness.component, 2);
		enter(harness.component);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: teamHash });
	});
});

describe("OAuthAccountManagerComponent adding accounts", () => {
	it("uses the only matching login method, reloads accounts, reinstalls, and never implicitly locks", async () => {
		let harness: ManagerHarness | undefined;
		const login = vi.fn(async (provider: OAuthProviderInfo): Promise<OAuthAccountLoginResult> => {
			if (!harness) throw new Error("Harness not ready");
			expect(provider.id).toBe("anthropic");
			harness.store.saveOAuth("anthropic", oauthCredential("added"));
			await harness.authStorage.reload();
			return { status: "completed", identity: { type: "oauth", email: "added@example.com" } };
		});
		harness = await createHarness({
			accounts: anthropicAccounts(accountA),
			methods: [anthropicMethod],
			login,
		});
		const installsBefore = harness.installPolicy.mock.calls.length;
		openAddFromAutomatic(harness, 1);
		await settle();

		expect(login).toHaveBeenCalledTimes(1);
		expect(rendered(harness.component)).toContain("OAuth account added.");
		expect(rendered(harness.component)).toContain("added@example.com");
		expect(harness.authStorage.listStoredOAuthAccounts("anthropic")).toHaveLength(2);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({});
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")).toBeUndefined();
		expect(harness.installPolicy).toHaveBeenCalledTimes(installsBefore + 1);
		expect(harness.onChange).not.toHaveBeenCalled();
	});

	it("offers an alias-aware method picker and supports movement and Escape", async () => {
		const login = vi.fn(
			async (
				_provider: OAuthProviderInfo,
				_dialog: OAuthAccountLoginDialogPort,
			): Promise<OAuthAccountLoginResult> => ({ status: "cancelled" }),
		);
		const harness = await createHarness({
			accounts: anthropicAccounts(accountA),
			methods: [
				loginMethod("anthropic", "Anthropic Browser"),
				loginMethod("anthropic-claude-code", "Claude Code", "anthropic"),
			],
			login,
		});
		openAddFromAutomatic(harness, 1);
		const picker = rendered(harness.component);
		expect(picker).toContain("Anthropic Browser");
		expect(picker).toContain("Claude Code");
		expect(picker).toContain("Login method: anthropic-claude-code");

		pressEscape(harness.component);
		expect(rendered(harness.component)).toContain("Automatic routing");
		expect(login).not.toHaveBeenCalled();
		enter(harness.component);
		pressDown(harness.component);
		enter(harness.component);
		await settle();
		expect(login).toHaveBeenCalledTimes(1);
		const selectedMethod = login.mock.calls[0]?.[0];
		if (!selectedMethod) throw new Error("Expected selected login method");
		expect(selectedMethod.id).toBe("anthropic-claude-code");
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({});
	});

	it.each([
		[
			"API-key login",
			{ status: "completed", identity: { type: "api_key" } },
			"Login did not add a switchable OAuth account.",
		],
		[
			"undefined identity",
			{ status: "completed", identity: undefined },
			"Login did not add a switchable OAuth account.",
		],
		["login failure", { status: "error", phase: "login", error: new Error("denied") }, "Login login failed: denied"],
		[
			"refresh failure",
			{ status: "error", phase: "refresh", error: new Error("offline"), identity: undefined },
			"Login refresh failed: offline",
		],
	] as const)("reports %s inline and preserves persisted intent", async (_name, result, message) => {
		const login = vi.fn(async (): Promise<OAuthAccountLoginResult> => result);
		const harness = await createHarness({
			accounts: anthropicAccounts(accountA),
			locks: { anthropic: hashA },
			methods: [anthropicMethod],
			login,
		});
		openAnthropicDetail(harness);
		pressDown(harness.component);
		enter(harness.component);
		await settle();

		expect(rendered(harness.component)).toContain(message);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: hashA });
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")?.identityHash).toBe(hashA);
		expect(harness.onChange).not.toHaveBeenCalled();
	});

	it("cancels the live login dialog with Escape and preserves the lock", async () => {
		const login = vi.fn((_provider: OAuthProviderInfo, dialog: OAuthAccountLoginDialogPort) => {
			const { promise, resolve } = Promise.withResolvers<OAuthAccountLoginResult>();
			dialog.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
			return promise;
		});
		const harness = await createHarness({
			accounts: anthropicAccounts(accountA),
			locks: { anthropic: hashA },
			methods: [anthropicMethod],
			login,
		});
		openAnthropicDetail(harness);
		pressDown(harness.component);
		enter(harness.component);
		expect(rendered(harness.component)).toContain("Login to");

		pressEscape(harness.component);
		await settle();
		expect(rendered(harness.component)).toContain("Login cancelled.");
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: hashA });
		expect(harness.onChange).not.toHaveBeenCalled();
	});
});

describe("OAuthAccountManagerComponent exact removal", () => {
	it("arms on the first Enter, disarms on Escape or paging, and removes the moved-to durable credential ID", async () => {
		let harness: ManagerHarness | undefined;
		const remove = vi.fn(
			async (
				provider: string,
				credentialId: number,
				refreshProviderId: string,
				_blockedReason: (() => string | undefined) | undefined,
				afterRemoved: (() => void) | undefined,
			): Promise<OAuthAccountRemovalResult> => {
				if (!harness) throw new Error("Harness not ready");
				expect(provider).toBe("anthropic");
				expect(refreshProviderId).toBe("anthropic");
				expect(await harness.authStorage.removeCredential(provider, credentialId)).toBe(true);
				afterRemoved?.();
				return { status: "removed" };
			},
		);
		harness = await createHarness({
			accounts: anthropicAccounts(accountA, accountB),
			locks: { anthropic: hashA },
			methods: [anthropicMethod],
			remove,
		});
		const rowB = harness.authStorage.listStoredOAuthAccounts("anthropic").find(row => row.accountId === "account-b");
		if (!rowB) throw new Error("Expected account B");
		openRemoveFromFirstConfigured(harness, 2);
		pressDown(harness.component);
		enter(harness.component);
		expect(rendered(harness.component)).toContain("Press Enter again to remove b@example.com; Esc to cancel");
		expect(remove).not.toHaveBeenCalled();

		pressEscape(harness.component);
		expect(rendered(harness.component)).not.toContain("Press Enter again");
		pressEscape(harness.component);
		expect(rendered(harness.component)).toContain("Automatic routing");
		enter(harness.component);
		enter(harness.component);
		harness.component.handleInput("\x1b[6~");
		enter(harness.component);
		enter(harness.component);
		await settle();

		expect(remove).toHaveBeenCalledTimes(1);
		expect(remove.mock.calls[0]?.[1]).toBe(rowB.credentialId);
		expect(harness.authStorage.listStoredOAuthAccounts("anthropic").map(row => row.accountId)).toEqual(["account-a"]);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: hashA });
		expect(rendered(harness.component)).toContain("OAuth account removed.");
	});

	it("refreshes the login provider ID after removing an aliased stored account", async () => {
		const storageProvider = "zai";
		const account = oauthCredential("alias");
		const hash = hashFor(storageProvider, account);
		let harness: ManagerHarness | undefined;
		const remove = vi.fn(
			async (
				provider: string,
				credentialId: number,
				refreshProviderId: string,
				_blockedReason: (() => string | undefined) | undefined,
				afterRemoved: (() => void) | undefined,
			): Promise<OAuthAccountRemovalResult> => {
				if (!harness) throw new Error("Harness not ready");
				expect(provider).toBe(storageProvider);
				expect(refreshProviderId).toBe("zai-coding-plan");
				expect(await harness.authStorage.removeCredential(provider, credentialId)).toBe(true);
				afterRemoved?.();
				return { status: "removed" };
			},
		);
		harness = await createHarness({
			accounts: [{ provider: storageProvider, credential: account }],
			locks: { [storageProvider]: hash },
			methods: [loginMethod("zai-coding-plan", "Z.AI Coding Plan", storageProvider)],
			remove,
		});
		openRemoveFromFirstConfigured(harness, 1);
		enter(harness.component);
		enter(harness.component);
		await settle();

		expect(remove).toHaveBeenCalledTimes(1);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({});
	});

	it("clears a selected lock only after confirmed removal succeeds", async () => {
		let harness: ManagerHarness | undefined;
		const remove = vi.fn(
			async (
				provider: string,
				credentialId: number,
				_refreshProviderId: string,
				_blockedReason: (() => string | undefined) | undefined,
				afterRemoved: (() => void) | undefined,
			): Promise<OAuthAccountRemovalResult> => {
				if (!harness) throw new Error("Harness not ready");
				expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: hashA });
				expect(await harness.authStorage.removeCredential(provider, credentialId)).toBe(true);
				expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: hashA });
				afterRemoved?.();
				return { status: "removed" };
			},
		);
		harness = await createHarness({
			accounts: anthropicAccounts(accountA, accountB),
			locks: { anthropic: hashA },
			methods: [anthropicMethod],
			remove,
		});
		const rowA = harness.authStorage.listStoredOAuthAccounts("anthropic").find(row => row.accountId === "account-a");
		if (!rowA) throw new Error("Expected account A");
		openRemoveFromFirstConfigured(harness, 2);
		enter(harness.component);
		expect(rendered(harness.component)).toContain("Press Enter again to remove a@example.com; Esc to cancel");
		enter(harness.component);
		await settle();

		expect(remove.mock.calls[0]?.[1]).toBe(rowA.credentialId);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({});
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")).toBeUndefined();
		expect(harness.onChange.mock.calls).toEqual([[{}]]);
	});

	it.each([
		["missing", { status: "missing" }, "That OAuth account is no longer stored."],
		[
			"remove",
			{ status: "error", phase: "remove", error: new Error("database busy") },
			"Account remove failed: database busy",
		],
	] as const)("keeps the selected hash when removal is %s", async (_name, result, message) => {
		const remove = vi.fn(async (): Promise<OAuthAccountRemovalResult> => result);
		const harness = await createHarness({
			accounts: anthropicAccounts(accountA),
			locks: { anthropic: hashA },
			methods: [anthropicMethod],
			remove,
		});
		openRemoveFromFirstConfigured(harness, 1);
		enter(harness.component);
		enter(harness.component);
		await settle();

		expect(rendered(harness.component)).toContain(message);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: hashA });
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")?.identityHash).toBe(hashA);
		expect(harness.onChange).not.toHaveBeenCalled();
	});

	it("restores the prior selected hash as stale when refresh fails after durable removal", async () => {
		let harness: ManagerHarness | undefined;
		const remove = vi.fn(
			async (
				provider: string,
				credentialId: number,
				_refreshProviderId: string,
				_blockedReason: (() => string | undefined) | undefined,
				afterRemoved: (() => void) | undefined,
			): Promise<OAuthAccountRemovalResult> => {
				if (!harness) throw new Error("Harness not ready");
				expect(await harness.authStorage.removeCredential(provider, credentialId)).toBe(true);
				afterRemoved?.();
				return { status: "error", phase: "refresh", error: new Error("refresh offline") };
			},
		);
		harness = await createHarness({
			accounts: anthropicAccounts(accountA),
			locks: { anthropic: hashA },
			methods: [anthropicMethod],
			remove,
		});
		openRemoveFromFirstConfigured(harness, 1);
		enter(harness.component);
		enter(harness.component);
		await settle();

		expect(rendered(harness.component)).toContain("Account refresh failed: refresh offline");
		expect(harness.authStorage.listStoredOAuthAccounts("anthropic")).toHaveLength(0);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: hashA });
		expect(harness.authStorage.getOAuthAccountSelection("anthropic")).toEqual({
			identityHash: hashA,
			credentialId: undefined,
			available: false,
			allowSiblingFailover: false,
		});
		pressEscape(harness.component);
		pressEscape(harness.component);
		expect(rendered(harness.component)).toContain("Locked account unavailable");
	});

	it("retains a stale lock when the configured row disappears externally", async () => {
		const harness = await createHarness({
			accounts: anthropicAccounts(accountA),
			locks: { anthropic: hashA },
			methods: [anthropicMethod],
		});
		const rowA = harness.authStorage.listStoredOAuthAccounts("anthropic")[0];
		if (!rowA) throw new Error("Expected account A");
		expect(await harness.authStorage.removeCredential("anthropic", rowA.credentialId)).toBe(true);
		harness.installPolicy();
		const reopened = new OAuthAccountManagerComponent(
			{
				settings: harness.settings,
				authStorage: harness.authStorage,
				tui: { requestRender: vi.fn() } as unknown as TUI,
				sessionId: "manager-session",
				getLoginMethods: () => [anthropicMethod],
				isStreaming: () => false,
				installPolicy: harness.installPolicy,
				invalidate: harness.invalidate,
				actions: { login: harness.login, remove: harness.remove },
			},
			{ onChange: harness.onChange, onClose: harness.onClose },
		);

		expect(rendered(reopened)).toContain("Locked account unavailable");
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: hashA });
	});
});

describe("OAuthAccountManagerComponent input and streaming guards", () => {
	it("supports render-first mouse opening and keyboard back/close navigation", async () => {
		const harness = await createHarness({ accounts: anthropicAccounts(accountA), methods: [anthropicMethod] });
		const lines = renderedLines(harness.component);
		const providerLine = lines.findIndex(line => line.includes("Anthropic"));
		expect(providerLine).toBeGreaterThanOrEqual(0);
		harness.component.routeMouse(leftClick(providerLine), providerLine, 0);
		expect(rendered(harness.component)).toContain("Automatic routing");

		pressEscape(harness.component);
		expect(rendered(harness.component)).toContain("Choose a provider to configure");
		pressEscape(harness.component);
		expect(harness.onClose).toHaveBeenCalledTimes(1);
	});

	it.each(["select", "automatic", "add", "remove"] as const)(
		"blocks the %s mutation while streaming with exact copy and no mutation",
		async action => {
			const locks: Record<string, string> = action === "automatic" ? { anthropic: hashA } : {};
			const login = vi.fn(
				async (): Promise<OAuthAccountLoginResult> => ({
					status: "completed",
					identity: { type: "oauth" },
				}),
			);
			const remove = vi.fn(async (): Promise<OAuthAccountRemovalResult> => ({ status: "removed" }));
			const harness = await createHarness({
				accounts: anthropicAccounts(accountA),
				locks,
				methods: [anthropicMethod],
				streaming: true,
				login,
				remove,
			});
			openAnthropicDetail(harness);
			if (action === "select") pressDown(harness.component);
			if (action === "automatic") pressUp(harness.component);
			if (action === "add") pressDown(harness.component, 2);
			if (action === "remove") pressDown(harness.component, 3);
			enter(harness.component);
			await settle();

			expect(rendered(harness.component)).toContain(OAUTH_ACCOUNT_STREAMING_MESSAGE);
			expect(harness.settings.get("providers.oauthAccountLocks")).toEqual(locks);
			expect(harness.onChange).not.toHaveBeenCalled();
			expect(login).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
		},
	);

	it("rechecks streaming after removal is armed and performs zero mutation in the race", async () => {
		const remove = vi.fn(async (): Promise<OAuthAccountRemovalResult> => ({ status: "removed" }));
		const harness = await createHarness({
			accounts: anthropicAccounts(accountA),
			locks: { anthropic: hashA },
			methods: [anthropicMethod],
			remove,
		});
		openRemoveFromFirstConfigured(harness, 1);
		enter(harness.component);
		expect(rendered(harness.component)).toContain("Press Enter again to remove a@example.com; Esc to cancel");
		harness.setStreaming(true);
		enter(harness.component);
		await settle();

		expect(rendered(harness.component)).toContain(OAUTH_ACCOUNT_STREAMING_MESSAGE);
		expect(remove).not.toHaveBeenCalled();
		expect(harness.authStorage.listStoredOAuthAccounts("anthropic")).toHaveLength(1);
		expect(harness.settings.get("providers.oauthAccountLocks")).toEqual({ anthropic: hashA });
		expect(harness.onChange).not.toHaveBeenCalled();
	});
});
