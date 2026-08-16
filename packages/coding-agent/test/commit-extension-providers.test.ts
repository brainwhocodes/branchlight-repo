import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { type AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { runCommitCommand } from "@oh-my-pi/pi-coding-agent/commit";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { getAgentDbPath, getProjectAgentDir, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const PROVIDER = "commit-extension-fixture";
const MODEL = "deepseek-v4-flash";
const SELECTOR = `${PROVIDER}/${MODEL}:high`;
const OAUTH_PROVIDER = "anthropic";

let agentTmp: TempDir;
let tmp: TempDir;
let settingsState: SettingsTestState | undefined;

async function writeProjectSettings(oauthLockHash?: string): Promise<void> {
	await Bun.write(
		path.join(getProjectAgentDir(tmp.path()), "settings.json"),
		JSON.stringify({
			extensions: [tmp.join("provider.ts")],
			modelRoles: { commit: SELECTOR },
			...(oauthLockHash
				? {
						providers: {
							oauthAccountLocks: { [OAUTH_PROVIDER]: oauthLockHash },
							oauthAccountFailover: true,
						},
					}
				: {}),
		}),
	);
}

async function persistTwoOAuthAccounts(): Promise<{ credentialId: number; identityHash: string }> {
	const selectedCredential = {
		type: "oauth" as const,
		access: "commit-selected-access",
		refresh: "commit-selected-refresh",
		expires: Date.now() + 3_600_000,
		accountId: "commit-selected-account",
		email: "commit-selected@example.com",
	};
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		store.saveOAuth(OAUTH_PROVIDER, {
			access: "commit-sibling-access",
			refresh: "commit-sibling-refresh",
			expires: Date.now() + 3_600_000,
			accountId: "commit-sibling-account",
			email: "commit-sibling@example.com",
		});
		store.saveOAuth(OAUTH_PROVIDER, selectedCredential);
		const selectedRow = store
			.listAuthCredentials(OAUTH_PROVIDER)
			.find(row => row.credential.type === "oauth" && row.credential.email === selectedCredential.email);
		if (!selectedRow) throw new Error("Selected OAuth fixture row was not persisted");
		const identityHash = credentialPinHash(OAUTH_PROVIDER, selectedCredential);
		if (!identityHash) throw new Error("Selected OAuth fixture identity was not hashable");
		await writeProjectSettings(identityHash);
		return { credentialId: selectedRow.id, identityHash };
	} finally {
		store.close();
	}
}

async function expectCommitRefreshToSeePersistedPolicy(legacy: boolean): Promise<void> {
	const expected = await persistTwoOAuthAccounts();
	const sentinel = new Error(`commit-refresh-policy-${legacy ? "legacy" : "agentic"}`);
	let ownedAuthStorage: AuthStorage | undefined;
	const refreshSpy = vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(async function (
		this: ModelRegistry,
	): Promise<void> {
		ownedAuthStorage = this.authStorage;
		expect(this.authStorage.listStoredOAuthAccounts(OAUTH_PROVIDER)).toHaveLength(2);
		expect(this.authStorage.getOAuthAccountSelection(OAUTH_PROVIDER)).toEqual({
			identityHash: expected.identityHash,
			credentialId: expected.credentialId,
			available: true,
			allowSiblingFailover: true,
		});
		const access = await this.authStorage.getOAuthAccess(OAUTH_PROVIDER, "commit-startup-policy");
		expect(access).toMatchObject({
			accessToken: "commit-selected-access",
			credentialId: expected.credentialId,
		});
		throw sentinel;
	});
	try {
		await expect(
			runCommitCommand({
				push: false,
				dryRun: true,
				noChangelog: true,
				legacy,
			}),
		).rejects.toBe(sentinel);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	} finally {
		refreshSpy.mockRestore();
		ownedAuthStorage?.close();
	}
}

beforeEach(async () => {
	settingsState = beginSettingsTest();
	tmp = await TempDir.create("@commit-extension-provider-");
	agentTmp = await TempDir.create("@commit-extension-provider-agent-");
	setProjectDir(tmp.path());
	setAgentDir(agentTmp.path());

	const extensionPath = tmp.join("provider.ts");
	await Bun.write(
		extensionPath,
		`export default function (pi) {
	pi.registerProvider("${PROVIDER}", {
		baseUrl: "https://example.invalid/v1",
		apiKey: "fixture-key",
		api: "openai-completions",
		models: [{
			id: "${MODEL}",
			name: "DeepSeek V4 Flash",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 384000,
		}],
	});
}
`,
	);
	await writeProjectSettings();

	await $`git init --initial-branch=main`.cwd(tmp.path()).quiet();
	await $`git add -A`.cwd(tmp.path()).quiet();
	await $`git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m baseline`.cwd(tmp.path()).quiet();

	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	await tmp.remove();
	await agentTmp.remove();
});

describe.serial("commit extension provider resolution", () => {
	test("agentic pipeline resolves an explicit extension-provided model", async () => {
		await expect(
			runCommitCommand({
				push: false,
				dryRun: true,
				noChangelog: true,
				model: SELECTOR,
			}),
		).resolves.toEqual({ usedFallback: false });
	});

	test("legacy pipeline resolves the project commit role from an extension provider", async () => {
		await expect(
			runCommitCommand({
				push: false,
				dryRun: true,
				noChangelog: true,
				legacy: true,
			}),
		).resolves.toEqual({ usedFallback: false });
	});
	test("agentic default runtime installs persisted OAuth policy before its first registry refresh", async () => {
		await expectCommitRefreshToSeePersistedPolicy(false);
	});

	test("legacy default runtime installs persisted OAuth policy before its first registry refresh", async () => {
		await expectCommitRefreshToSeePersistedPolicy(true);
	});
});
