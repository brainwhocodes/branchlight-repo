import { describe, expect, test, vi } from "bun:test";
import type {
	AuthStorage,
	OAuthAccountIdentity,
	OAuthAccountSelectionState,
	OAuthAccountSummary,
	StoredAuthCredential,
	UsageLimit,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import {
	formatActiveAccountLabel,
	limitMatchesActiveAccount,
	reportMatchesActiveAccount,
} from "../src/slash-commands/helpers/active-oauth-account";
import { toLogoutAccounts } from "../src/slash-commands/helpers/logout";
import {
	buildOAuthAccountRoutingDisplay,
	formatOAuthAccountSelectionLine,
} from "../src/slash-commands/helpers/oauth-account-routing-display";

function makeLimit(scope: Partial<UsageLimit["scope"]> = {}): UsageLimit {
	return {
		id: "limit-1",
		label: "Requests",
		scope: { provider: "anthropic", ...scope },
		amount: { usedFraction: 0.5, unit: "percent" },
	};
}

function makeReport(overrides: Partial<UsageReport> = {}): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [makeLimit()],
		...overrides,
	};
}

type RoutingStorage = Pick<
	AuthStorage,
	"getOAuthAccountSelection" | "listStoredOAuthAccounts" | "getOAuthAccountIdentity"
>;

function makeAccount(credentialId: number, overrides: Partial<OAuthAccountSummary> = {}): OAuthAccountSummary {
	return {
		position: credentialId - 1,
		credentialId,
		active: false,
		...overrides,
	};
}

function createRoutingStorage(options: {
	selection?: OAuthAccountSelectionState;
	accounts?: OAuthAccountSummary[];
	actualAccount?: OAuthAccountIdentity;
}) {
	const getOAuthAccountSelection = vi.fn((_provider: string) => options.selection);
	const listStoredOAuthAccounts = vi.fn((_provider: string, _sessionId?: string) => options.accounts ?? []);
	const getOAuthAccountIdentity = vi.fn((_provider: string, _sessionId?: string) => options.actualAccount);
	const authStorage = {
		getOAuthAccountSelection,
		listStoredOAuthAccounts,
		getOAuthAccountIdentity,
	} as RoutingStorage;
	return { authStorage, getOAuthAccountSelection, listStoredOAuthAccounts, getOAuthAccountIdentity };
}

describe("buildOAuthAccountRoutingDisplay", () => {
	test("resolves a strict selected account and formats its org-qualified label", () => {
		const actualAccount = {
			email: "shared@example.com",
			accountId: "account-team",
			orgId: "org-team",
			orgName: "Team Workspace",
		};
		const harness = createRoutingStorage({
			selection: {
				identityHash: "a".repeat(64),
				credentialId: 22,
				available: true,
				allowSiblingFailover: false,
			},
			accounts: [
				makeAccount(11, { position: 0, email: "other@example.com" }),
				makeAccount(22, { position: 1, active: true, ...actualAccount }),
			],
			actualAccount,
		});
		const display = buildOAuthAccountRoutingDisplay(harness.authStorage, "anthropic", "session-strict");

		expect(display).toEqual({
			automaticRouting: false,
			selectedAccountLabel: "shared@example.com (Team Workspace)",
			selectionUnavailable: false,
			allowSiblingFailover: false,
			actualAccount,
			actualAccountIsFailover: false,
		});
		expect(formatOAuthAccountSelectionLine(display)).toBe(
			"Locked account: shared@example.com (Team Workspace) (strict)",
		);
	});

	test("uses durable credential ids for selected and failover accounts with same-email orgs", () => {
		const actualAccount = {
			email: "shared@example.com",
			accountId: "account-personal",
			orgId: "org-personal",
			orgName: "Personal Max",
		};
		const harness = createRoutingStorage({
			selection: {
				identityHash: "b".repeat(64),
				credentialId: 101,
				available: true,
				allowSiblingFailover: true,
			},
			accounts: [
				makeAccount(101, {
					position: 7,
					email: "shared@example.com",
					accountId: "account-team",
					orgId: "org-team",
					orgName: "Team Workspace",
				}),
				makeAccount(202, { position: 101, active: true, ...actualAccount }),
			],
			actualAccount,
		});
		const display = buildOAuthAccountRoutingDisplay(harness.authStorage, "anthropic", "session-failover");

		expect(display.selectedAccountLabel).toBe("shared@example.com (Team Workspace)");
		expect(display.automaticRouting).toBe(false);
		expect(display.actualAccount).toBe(actualAccount);
		expect(display.actualAccountIsFailover).toBe(true);
		expect(formatOAuthAccountSelectionLine(display)).toBe(
			"Locked account: shared@example.com (Team Workspace) (failover enabled)",
		);
	});

	test("does not infer failover from matching identities, labels, or array positions", () => {
		const sharedIdentity = { email: "same@example.com", orgId: "org-same", orgName: "Same Org" };
		const selectedHarness = createRoutingStorage({
			selection: {
				identityHash: "c".repeat(64),
				credentialId: 42,
				available: true,
				allowSiblingFailover: true,
			},
			accounts: [
				makeAccount(7, { position: 42, ...sharedIdentity }),
				makeAccount(42, { position: 7, active: true, ...sharedIdentity }),
			],
			actualAccount: sharedIdentity,
		});
		expect(
			buildOAuthAccountRoutingDisplay(selectedHarness.authStorage, "anthropic", "session-selected")
				.actualAccountIsFailover,
		).toBe(false);

		const siblingHarness = createRoutingStorage({
			selection: {
				identityHash: "c".repeat(64),
				credentialId: 42,
				available: true,
				allowSiblingFailover: true,
			},
			accounts: [
				makeAccount(7, { position: 42, active: true, ...sharedIdentity }),
				makeAccount(42, { position: 7, ...sharedIdentity }),
			],
			actualAccount: sharedIdentity,
		});
		expect(
			buildOAuthAccountRoutingDisplay(siblingHarness.authStorage, "anthropic", "session-sibling")
				.actualAccountIsFailover,
		).toBe(true);
	});

	test("marks false availability and an absent durable row as unavailable", () => {
		const unavailableHarness = createRoutingStorage({
			selection: {
				identityHash: "d".repeat(64),
				credentialId: 10,
				available: false,
				allowSiblingFailover: false,
			},
			accounts: [makeAccount(10, { email: "locked@example.com" })],
		});
		const unavailable = buildOAuthAccountRoutingDisplay(
			unavailableHarness.authStorage,
			"anthropic",
			"session-unavailable",
		);
		expect(unavailable.selectedAccountLabel).toBe("locked@example.com");
		expect(unavailable.automaticRouting).toBe(false);
		expect(unavailable.selectionUnavailable).toBe(true);
		expect(formatOAuthAccountSelectionLine(unavailable)).toBe(
			"Locked account unavailable; choose another in /settings",
		);

		const actualAccount = { email: "sibling@example.com" };
		const missingHarness = createRoutingStorage({
			selection: {
				identityHash: "e".repeat(64),
				credentialId: undefined,
				available: false,
				allowSiblingFailover: true,
			},
			accounts: [makeAccount(20, { active: true, ...actualAccount })],
			actualAccount,
		});
		const missing = buildOAuthAccountRoutingDisplay(missingHarness.authStorage, "anthropic", "session-missing");
		expect(missing.automaticRouting).toBe(false);
		expect(missing.selectedAccountLabel).toBeUndefined();
		expect(missing.selectionUnavailable).toBe(true);
		expect(missing.actualAccount).toBe(actualAccount);
		expect(missing.actualAccountIsFailover).toBe(true);
		expect(formatOAuthAccountSelectionLine(missing)).toBe("Locked account unavailable; choose another in /settings");
	});

	test("preserves automatic-routing actual identity and calls each API once with exact arguments", () => {
		const actualAccount = { email: "automatic@example.com", accountId: "automatic-account" };
		const harness = createRoutingStorage({
			accounts: [makeAccount(1, { active: true, ...actualAccount })],
			actualAccount,
		});
		const display = buildOAuthAccountRoutingDisplay(harness.authStorage, "openai-codex", "session-automatic");

		expect(display).toEqual({
			automaticRouting: true,
			selectedAccountLabel: undefined,
			selectionUnavailable: false,
			allowSiblingFailover: false,
			actualAccount,
			actualAccountIsFailover: false,
		});
		expect(formatOAuthAccountSelectionLine(display)).toBeUndefined();
		expect(harness.getOAuthAccountSelection).toHaveBeenCalledTimes(1);
		expect(harness.getOAuthAccountSelection).toHaveBeenCalledWith("openai-codex");
		expect(harness.listStoredOAuthAccounts).toHaveBeenCalledTimes(1);
		expect(harness.listStoredOAuthAccounts).toHaveBeenCalledWith("openai-codex", "session-automatic");
		expect(harness.getOAuthAccountIdentity).toHaveBeenCalledTimes(1);
		expect(harness.getOAuthAccountIdentity).toHaveBeenCalledWith("openai-codex", "session-automatic");
	});

	test("uses the existing enterprise and anonymous selected-account label fallbacks", () => {
		const enterpriseHarness = createRoutingStorage({
			selection: {
				identityHash: "f".repeat(64),
				credentialId: 3,
				available: true,
				allowSiblingFailover: false,
			},
			accounts: [makeAccount(3, { enterpriseUrl: " https://enterprise.example.com " })],
		});
		expect(
			buildOAuthAccountRoutingDisplay(enterpriseHarness.authStorage, "github-copilot", "session-enterprise")
				.selectedAccountLabel,
		).toBe("https://enterprise.example.com");

		const anonymousHarness = createRoutingStorage({
			selection: {
				identityHash: "0".repeat(64),
				credentialId: 8,
				available: true,
				allowSiblingFailover: false,
			},
			accounts: [makeAccount(8)],
		});
		expect(
			buildOAuthAccountRoutingDisplay(anonymousHarness.authStorage, "unknown-oauth", "session-anonymous")
				.selectedAccountLabel,
		).toBe("OAuth credential #8");
	});

	test("requires enabled failover and a different active durable row", () => {
		const actualAccount = { email: "sibling@example.com" };
		const strictHarness = createRoutingStorage({
			selection: {
				identityHash: "1".repeat(64),
				credentialId: 1,
				available: true,
				allowSiblingFailover: false,
			},
			accounts: [makeAccount(1), makeAccount(2, { active: true, ...actualAccount })],
			actualAccount,
		});
		expect(
			buildOAuthAccountRoutingDisplay(strictHarness.authStorage, "anthropic", "session-strict-sibling")
				.actualAccountIsFailover,
		).toBe(false);

		const noActiveRowHarness = createRoutingStorage({
			selection: {
				identityHash: "2".repeat(64),
				credentialId: 1,
				available: true,
				allowSiblingFailover: true,
			},
			accounts: [makeAccount(1)],
			actualAccount,
		});
		expect(
			buildOAuthAccountRoutingDisplay(noActiveRowHarness.authStorage, "anthropic", "session-no-active-row")
				.actualAccountIsFailover,
		).toBe(false);
	});
});

describe("formatActiveAccountLabel", () => {
	test("falls back to organization name or id for an org-only actual identity", () => {
		expect(formatActiveAccountLabel({ orgName: "Team Workspace", orgId: "org-team" })).toBe("Team Workspace");
		expect(formatActiveAccountLabel({ orgId: "org-only" })).toBe("org-only");
	});

	test("sanitizes persisted identity text into one display line", () => {
		const unsafeEmail = "\x1b[31maccount@example.test\x1b[0m\n";
		const unsafeOrg = "Team\tOrg";
		expect(formatActiveAccountLabel({ email: unsafeEmail, orgName: unsafeOrg })).toBe(
			"account@example.test (Team   Org)",
		);
		expect(
			formatOAuthAccountSelectionLine({
				automaticRouting: false,
				selectedAccountLabel: `${unsafeEmail}${unsafeOrg}`,
				selectionUnavailable: false,
				allowSiblingFailover: false,
				actualAccountIsFailover: false,
			}),
		).toBe("Locked account: account@example.test Team   Org (strict)");
	});
});

describe("limitMatchesActiveAccount", () => {
	test("matches accountId against report metadata (camel and snake case) and limit scope", () => {
		const identity = { accountId: "ACC-1" };
		expect(limitMatchesActiveAccount(makeReport({ metadata: { accountId: "acc-1" } }), makeLimit(), identity)).toBe(
			true,
		);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { account_id: "acc-1" } }), makeLimit(), identity)).toBe(
			true,
		);
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ accountId: "acc-1" }), identity)).toBe(true);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { accountId: "acc-2" } }), makeLimit(), identity)).toBe(
			false,
		);
	});

	test("matches email against report metadata only — never against scope accountId", () => {
		const identity = { email: "user@example.com" };
		expect(
			limitMatchesActiveAccount(makeReport({ metadata: { email: "User@Example.com" } }), makeLimit(), identity),
		).toBe(true);
		// An email must not match an opaque account-id slot that happens to hold the same string.
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ accountId: "user@example.com" }), identity)).toBe(
			false,
		);
	});

	test("matches projectId for Google-style providers via scope or metadata", () => {
		const identity = { projectId: "gcp-proj-1" };
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ projectId: "gcp-proj-1" }), identity)).toBe(true);
		expect(
			limitMatchesActiveAccount(makeReport({ metadata: { projectId: "gcp-proj-1" } }), makeLimit(), identity),
		).toBe(true);
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ projectId: "gcp-proj-2" }), identity)).toBe(false);
	});

	test("returns false without an identity or with an empty identity", () => {
		expect(limitMatchesActiveAccount(makeReport({ metadata: { email: "a@b.c" } }), makeLimit(), undefined)).toBe(
			false,
		);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { email: "a@b.c" } }), makeLimit(), {})).toBe(false);
	});

	test("org-scoped identity matches only its own org — not the shared email, not org-less reports", () => {
		const identity = { email: "shared@example.com", orgId: "org-team" };
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "shared@example.com", orgId: "org-team" } }),
				makeLimit(),
				identity,
			),
		).toBe(true);
		// Same email, other org: must NOT be flagged as this session's account.
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "shared@example.com", orgId: "org-max" } }),
				makeLimit(),
				identity,
			),
		).toBe(false);
		// Org-less report (pre-upgrade cache leftover): shared email must not attach the marker.
		expect(
			limitMatchesActiveAccount(makeReport({ metadata: { email: "shared@example.com" } }), makeLimit(), identity),
		).toBe(false);
	});

	test("org-less identity never claims an org-attributed report via the shared email", () => {
		// Reverse direction: the active session runs on a legacy bare-email row
		// while reports are org-attributed — the marker must not appear on
		// another registration's report.
		const identity = { email: "shared@example.com", accountId: "account-shared" };
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "shared@example.com", orgId: "org-team" } }),
				makeLimit(),
				identity,
			),
		).toBe(false);
		// Both sides org-less: providers without orgs keep the email fallback.
		expect(
			limitMatchesActiveAccount(makeReport({ metadata: { email: "shared@example.com" } }), makeLimit(), identity),
		).toBe(true);
	});

	test("same org, different member: the base identity is still required — two Team seats never share the marker", () => {
		const identity = { email: "alice@example.com", accountId: "account-alice", orgId: "org-team" };
		// Anthropic Team seats have per-user pools but share the org id in
		// report metadata — the other member's report must not be flagged.
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "bob@example.com", accountId: "account-bob", orgId: "org-team" } }),
				makeLimit(),
				identity,
			),
		).toBe(false);
		// The member's own same-org report still matches through the base identity.
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "alice@example.com", orgId: "org-team" } }),
				makeLimit(),
				identity,
			),
		).toBe(true);
	});

	test("org-only active identity matches same-org reports on the org alone", () => {
		// Login recovered neither email nor account: the org is all the session
		// knows about itself.
		const identity = { orgId: "org-team" };
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "bob@example.com", orgId: "org-team" } }),
				makeLimit(),
				identity,
			),
		).toBe(true);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { orgId: "org-max" } }), makeLimit(), identity)).toBe(
			false,
		);
	});
});

describe("reportMatchesActiveAccount", () => {
	test("matches when any limit column belongs to the identity", () => {
		const report = makeReport({
			limits: [makeLimit({ accountId: "other" }), makeLimit({ accountId: "acc-1" })],
		});
		expect(reportMatchesActiveAccount(report, { accountId: "acc-1" })).toBe(true);
		expect(reportMatchesActiveAccount(report, { accountId: "acc-3" })).toBe(false);
	});

	test("does not match a report with no limits", () => {
		const report = makeReport({ limits: [], metadata: { email: "user@example.com" } });
		expect(reportMatchesActiveAccount(report, { email: "user@example.com" })).toBe(false);
	});
});

describe("toLogoutAccounts org scoping", () => {
	function oauthRow(
		id: number,
		orgId?: string,
		orgName?: string,
		identity?: { email?: string; accountId?: string },
	): StoredAuthCredential {
		return {
			id,
			provider: "anthropic",
			credential: {
				type: "oauth",
				access: `access-${id}`,
				refresh: `refresh-${id}`,
				expires: Date.now() + 60_000,
				accountId: identity?.accountId ?? "account-shared",
				email: identity?.email ?? "shared@example.com",
				orgId,
				orgName,
			},
			disabledCause: null,
		};
	}

	test("org-scoped active session marks only its own org's row active — never the legacy bare-email row", () => {
		const accounts = toLogoutAccounts(
			"anthropic",
			[oauthRow(1, "org-team", "Team Workspace"), oauthRow(2, "org-max", "Personal Max"), oauthRow(3)],
			{ activeIdentity: { email: "shared@example.com", accountId: "account-shared", orgId: "org-max" } },
		);
		const activeIds = accounts.filter(account => account.active).map(account => account.credentialId);
		expect(activeIds).toEqual([2]);
	});

	test("bare-email active row marks only itself active — never org-scoped siblings", () => {
		const accounts = toLogoutAccounts(
			"anthropic",
			[oauthRow(1, "org-team", "Team Workspace"), oauthRow(2, "org-max", "Personal Max"), oauthRow(3)],
			{ activeIdentity: { email: "shared@example.com", accountId: "account-shared" } },
		);
		const activeIds = accounts.filter(account => account.active).map(account => account.credentialId);
		expect(activeIds).toEqual([3]);
	});

	test("same org, different member: only the active user's own row is marked active", () => {
		// Two Team seats in one org pool — same orgId, distinct email/account.
		const accounts = toLogoutAccounts(
			"anthropic",
			[
				oauthRow(1, "org-team", "Team Workspace", { email: "alice@example.com", accountId: "account-alice" }),
				oauthRow(2, "org-team", "Team Workspace", { email: "bob@example.com", accountId: "account-bob" }),
			],
			{ activeIdentity: { email: "alice@example.com", accountId: "account-alice", orgId: "org-team" } },
		);
		const activeIds = accounts.filter(account => account.active).map(account => account.credentialId);
		expect(activeIds).toEqual([1]);
	});

	test("org-only active identity marks same-org rows active on the org alone", () => {
		const accounts = toLogoutAccounts(
			"anthropic",
			[oauthRow(1, "org-team", "Team Workspace"), oauthRow(2, "org-max", "Personal Max")],
			{ activeIdentity: { orgId: "org-team" } },
		);
		const activeIds = accounts.filter(account => account.active).map(account => account.credentialId);
		expect(activeIds).toEqual([1]);
	});

	test("labels distinguish the two orgs and the legacy row", () => {
		const accounts = toLogoutAccounts("anthropic", [
			oauthRow(1, "org-team", "Team Workspace"),
			oauthRow(2, "org-max", "Personal Max"),
			oauthRow(3),
		]);
		const labels = accounts.map(account => account.label).sort();
		expect(labels).toEqual([
			"shared@example.com",
			"shared@example.com (Personal Max)",
			"shared@example.com (Team Workspace)",
		]);
	});
});
