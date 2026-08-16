import { describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { type Api, type Model, type OAuthAccess, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type DryBalanceModelRegistry, runDryBalanceCommand } from "@oh-my-pi/pi-coding-agent/cli/dry-balance-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { getAgentDbPath, getProjectAgentDir, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.com/v1",
		maxTokens: 4096,
		contextWindow: 128_000,
	} as unknown as Model<Api>;
}

test("dry-balance resolves configured bare role names", async () => {
	const model = fakeModel("acme", "balance-model");
	const registry: DryBalanceModelRegistry = {
		authStorage: {
			getOAuthAccess: async () =>
				({ accessToken: "test-token", email: "test@example.com" }) as unknown as OAuthAccess,
		},
		getAll: () => [model],
		getAvailable: () => [model],
		getApiKey: async () => "test-token",
	};
	const settings = Settings.isolated({ modelRoles: { task: "acme/balance-model" } });

	const summary = await runDryBalanceCommand(
		{
			flags: { model: "task", count: 1, concurrency: 1, json: true },
		},
		{
			createRuntime: async () => ({ modelRegistry: registry, settings }),
			randomSessionId: () => "session-1",
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
		},
	);

	expect(summary.model).toBe("acme/balance-model");
	expect(summary.success.total).toBe(1);
});

describe.serial("dry-balance default runtime OAuth routing startup", () => {
	test("installs persisted OAuth policy before the first runtime-provider refresh", async () => {
		const settingsState = beginSettingsTest();
		const projectTmp = await TempDir.create("@dry-balance-oauth-startup-");
		const agentTmp = await TempDir.create("@dry-balance-oauth-startup-agent-");
		setProjectDir(projectTmp.path());
		setAgentDir(agentTmp.path());
		const provider = "anthropic";
		const selectedCredential = {
			type: "oauth" as const,
			access: "dry-balance-selected-access",
			refresh: "dry-balance-selected-refresh",
			expires: Date.now() + 3_600_000,
			accountId: "dry-balance-selected-account",
			email: "dry-balance-selected@example.com",
		};
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		let expectedCredentialId: number;
		let identityHash: string;
		try {
			store.saveOAuth(provider, {
				access: "dry-balance-sibling-access",
				refresh: "dry-balance-sibling-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "dry-balance-sibling-account",
				email: "dry-balance-sibling@example.com",
			});
			store.saveOAuth(provider, selectedCredential);
			const selectedRow = store
				.listAuthCredentials(provider)
				.find(row => row.credential.type === "oauth" && row.credential.email === selectedCredential.email);
			if (!selectedRow) throw new Error("Selected OAuth fixture row was not persisted");
			expectedCredentialId = selectedRow.id;
			const hash = credentialPinHash(provider, selectedCredential);
			if (!hash) throw new Error("Selected OAuth fixture identity was not hashable");
			identityHash = hash;
		} finally {
			store.close();
		}
		await Bun.write(
			path.join(getProjectAgentDir(projectTmp.path()), "settings.json"),
			JSON.stringify({
				providers: {
					oauthAccountLocks: { [provider]: identityHash },
					oauthAccountFailover: true,
				},
			}),
		);

		const sentinel = new Error("dry-balance-runtime-provider-refresh-policy");
		const refreshSpy = vi
			.spyOn(ModelRegistry.prototype, "refreshRuntimeProviders")
			.mockImplementation(async function (this: ModelRegistry): Promise<void> {
				expect(this.authStorage.listStoredOAuthAccounts(provider)).toHaveLength(2);
				expect(this.authStorage.getOAuthAccountSelection(provider)).toEqual({
					identityHash,
					credentialId: expectedCredentialId,
					available: true,
					allowSiblingFailover: true,
				});
				const access = await this.authStorage.getOAuthAccess(provider, "dry-balance-startup-policy");
				expect(access).toMatchObject({
					accessToken: "dry-balance-selected-access",
					credentialId: expectedCredentialId,
				});
				throw sentinel;
			});
		try {
			await expect(
				runDryBalanceCommand(
					{
						flags: {
							model: "anthropic/claude-sonnet-4-6",
							count: 1,
							concurrency: 1,
							json: true,
						},
					},
					{
						randomSessionId: () => "dry-balance-startup-session",
						writeStdout: () => {},
						writeStderr: () => {},
						setExitCode: () => {},
					},
				),
			).rejects.toBe(sentinel);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		} finally {
			refreshSpy.mockRestore();
			restoreSettingsTestState(settingsState);
			await projectTmp.remove();
			await agentTmp.remove();
		}
	});
});
