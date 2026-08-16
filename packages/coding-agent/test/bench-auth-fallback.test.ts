import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import {
	type Api,
	type ApiKeyResolver,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { type BenchModelRegistry, type BenchSummary, runBenchCommand } from "@oh-my-pi/pi-coding-agent/cli/bench-cli";
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
		maxTokens: 4096,
		contextWindow: 128_000,
	} as unknown as Model<Api>;
}

function fakeStream(): AssistantMessageEventStream {
	const message = {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: { input: 5, output: 20 },
		duration: 120,
		ttft: 30,
	} as unknown as AssistantMessage;
	const events = [
		{ type: "text_delta", delta: "hi" },
		{ type: "done", message },
	] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

function emptyStream(): AssistantMessageEventStream {
	const message = {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: { input: 5, output: 0 },
		duration: 120,
	} as unknown as AssistantMessage;
	const events = [{ type: "done", message }] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

interface FakeRegistryOptions {
	models: Model<Api>[];
	authedProviders: string[];
}

function fakeRegistry(opts: FakeRegistryOptions): BenchModelRegistry {
	const authed = new Set(opts.authedProviders);
	return {
		getAll: () => opts.models,
		getAvailable: () => opts.models.filter(model => authed.has(model.provider)),
		hasConfiguredAuth: model => authed.has(model.provider),
		getApiKey: async model => (authed.has(model.provider) ? "sk-test" : undefined),
		resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
	};
}

async function runBench(
	selector: string,
	registry: BenchModelRegistry,
	streamFactory: () => AssistantMessageEventStream = fakeStream,
	settings?: Settings,
) {
	const stderr: string[] = [];
	const summary = await runBenchCommand(
		{ models: [selector], flags: { runs: 1, maxTokens: 64, json: false } },
		{
			createRuntime: async () => ({ modelRegistry: registry, settings, close: () => {} }),
			randomSessionId: () => "sess-1",
			writeStdout: () => {},
			writeStderr: text => stderr.push(text),
			setExitCode: () => {},
			streamSimple: () => streamFactory(),
			now: () => 0,
			stdoutIsTTY: false,
		},
	);
	return { summary, stderr: stderr.join("") };
}

describe("bench credential-aware provider selection", () => {
	it("redirects an ambiguous shared-id selector to an authenticated provider", async () => {
		// Catalog order makes the unauthenticated `groq` win the default resolution.
		const registry = fakeRegistry({
			models: [fakeModel("groq", "openai/gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")],
			authedProviders: ["openrouter"],
		});

		const { summary, stderr } = await runBench("openai/gpt-oss-20b", registry);

		expect(summary.models[0].model).toBe("openrouter/openai/gpt-oss-20b");
		expect(summary.failures).toBe(0);
		expect(stderr).toContain('no credentials for "groq"');
		expect(stderr).toContain("openrouter/openai/gpt-oss-20b");
	});

	it("does not redirect across providers whose local ids differ", async () => {
		// Bare `gpt-oss-20b` resolves to fireworks (unauthed) by flat-id match.
		// The authenticated openrouter entry has a different local id, so it is
		// not considered an equivalent fallback.
		const registry = fakeRegistry({
			models: [fakeModel("fireworks", "gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")],
			authedProviders: ["openrouter"],
		});

		const { summary } = await runBench("gpt-oss-20b", registry);

		expect(summary.models[0].model).toBe("fireworks/gpt-oss-20b");
		expect(summary.failures).toBe(1);
		expect(summary.models[0].results[0]).toMatchObject({ ok: false });
	});

	it("honors an explicitly pinned provider even without credentials", async () => {
		const registry = fakeRegistry({
			models: [fakeModel("groq", "openai/gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")],
			authedProviders: ["openrouter"],
		});

		const { summary, stderr } = await runBench("groq/openai/gpt-oss-20b", registry);

		// Pinned selector is authoritative: no redirect, surfaces the no-credentials failure.
		expect(summary.models[0].model).toBe("groq/openai/gpt-oss-20b");
		expect(summary.failures).toBe(1);
		expect(summary.models[0].results[0]).toMatchObject({ ok: false });
		expect(stderr).not.toContain("benchmarking");
	});
});

describe("bench configured role selection", () => {
	it("resolves configured bare role names", async () => {
		const model = fakeModel("acme", "bench-model");
		const registry = fakeRegistry({ models: [model], authedProviders: ["acme"] });
		const settings = Settings.isolated({ modelRoles: { task: "acme/bench-model" } });

		const { summary } = await runBench("task", registry, fakeStream, settings);

		expect(summary.models[0].model).toBe("acme/bench-model");
		expect(summary.failures).toBe(0);
	});

	it("honors provider-pinned configured role targets", async () => {
		const registry = fakeRegistry({
			models: [fakeModel("groq", "openai/gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")],
			authedProviders: ["openrouter"],
		});
		const settings = Settings.isolated({
			modelRoles: { task: "groq/openai/gpt-oss-20b" },
		});

		const { summary, stderr } = await runBench("task", registry, fakeStream, settings);

		expect(summary.models[0].model).toBe("groq/openai/gpt-oss-20b");
		expect(summary.failures).toBe(1);
		expect(summary.models[0].results[0]).toMatchObject({ ok: false });
		expect(stderr).not.toContain("benchmarking");
	});
});

describe("bench empty-output guard", () => {
	it("reports a run with no streamed content and no tokens as a failure", async () => {
		const registry = fakeRegistry({ models: [fakeModel("acme", "model-x")], authedProviders: ["acme"] });

		const { summary } = await runBench("acme/model-x", registry, emptyStream);

		expect(summary.failures).toBe(1);
		const run = summary.models[0].results[0];
		expect(run.ok).toBe(false);
		if (!run.ok) expect(run.error).toContain("no output");
		expect(summary.models[0].average).toBeNull();
	});
});

function settingsStub(serviceTier: string | undefined): Settings | undefined {
	if (serviceTier === undefined) return undefined;
	return {
		get: (key: string) =>
			key === "tier.openai" ? serviceTier : key === "tier.anthropic" || key === "tier.google" ? "none" : undefined,
	} as unknown as Settings;
}

async function captureServiceTier(opts: {
	flag?: string;
	setting?: string;
}): Promise<{ wire: SimpleStreamOptions["serviceTier"]; summary: BenchSummary["serviceTierByFamily"] }> {
	const registry = fakeRegistry({ models: [fakeModel("openai-codex", "gpt-5.5")], authedProviders: ["openai-codex"] });
	let captured: SimpleStreamOptions | undefined;
	const summary = await runBenchCommand(
		{
			models: ["openai-codex/gpt-5.5"],
			flags: { runs: 1, maxTokens: 64, json: true, serviceTier: opts.flag },
		},
		{
			createRuntime: async () => ({
				modelRegistry: registry,
				settings: settingsStub(opts.setting),
				close: () => {},
			}),
			randomSessionId: () => "sess-1",
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
			streamSimple: (_model, _context, options) => {
				captured = options;
				return fakeStream();
			},
			now: () => 0,
			stdoutIsTTY: false,
		},
	);
	return { wire: captured?.serviceTier, summary: summary.serviceTierByFamily };
}

describe("bench provider session state and websocket preference", () => {
	it("sends providerSessionState and preferWebsockets to the stream", async () => {
		const registry = fakeRegistry({
			models: [fakeModel("openai-codex", "gpt-5.5")],
			authedProviders: ["openai-codex"],
		});
		let captured: SimpleStreamOptions | undefined;
		await runBenchCommand(
			{ models: ["openai-codex/gpt-5.5"], flags: { runs: 1, maxTokens: 64, json: true } },
			{
				createRuntime: async () => ({
					modelRegistry: registry,
					settings: undefined,
					close: () => {},
				}),
				randomSessionId: () => "sess-1",
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, _context, options) => {
					captured = options;
					return fakeStream();
				},
				now: () => 0,
				stdoutIsTTY: false,
			},
		);
		expect(captured?.providerSessionState).toBeInstanceOf(Map);
		expect(captured?.providerSessionState?.size).toBe(0);
		expect(captured?.preferWebsockets).toBe(true);
	});
});

describe("bench service tier", () => {
	it("sends the configured serviceTier setting when no flag is passed", async () => {
		const { wire, summary } = await captureServiceTier({ setting: "flex" });
		expect(wire).toBe("flex");
		expect(summary).toEqual({ openai: "flex" });
	});

	it("lets an explicit --service-tier override the configured setting", async () => {
		const { wire, summary } = await captureServiceTier({ flag: "priority", setting: "flex" });
		expect(wire).toBe("priority");
		expect(summary).toEqual({ openai: "priority", anthropic: "priority", google: "priority" });
	});

	it("omits service_tier when the setting is none and no flag is passed", async () => {
		const { wire, summary } = await captureServiceTier({ setting: "none" });
		expect(wire).toBeUndefined();
		expect(summary).toEqual({});
	});

	it("omits service_tier when neither flag nor settings are present", async () => {
		const { wire, summary } = await captureServiceTier({});
		expect(wire).toBeUndefined();
		expect(summary).toEqual({});
	});
});

describe.serial("bench default runtime OAuth routing startup", () => {
	it("installs persisted OAuth policy before the first runtime-provider refresh", async () => {
		const settingsState = beginSettingsTest();
		const projectTmp = await TempDir.create("@bench-oauth-startup-");
		const agentTmp = await TempDir.create("@bench-oauth-startup-agent-");
		setProjectDir(projectTmp.path());
		setAgentDir(agentTmp.path());
		const provider = "anthropic";
		const selectedCredential = {
			type: "oauth" as const,
			access: "bench-selected-access",
			refresh: "bench-selected-refresh",
			expires: Date.now() + 3_600_000,
			accountId: "bench-selected-account",
			email: "bench-selected@example.com",
		};
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		let expectedCredentialId: number;
		let identityHash: string;
		try {
			store.saveOAuth(provider, {
				access: "bench-sibling-access",
				refresh: "bench-sibling-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "bench-sibling-account",
				email: "bench-sibling@example.com",
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

		const sentinel = new Error("bench-runtime-provider-refresh-policy");
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
				const access = await this.authStorage.getOAuthAccess(provider, "bench-startup-policy");
				expect(access).toMatchObject({
					accessToken: "bench-selected-access",
					credentialId: expectedCredentialId,
				});
				throw sentinel;
			});
		try {
			await expect(
				runBenchCommand(
					{ models: ["anthropic/claude-sonnet-4-6"], flags: { runs: 1, maxTokens: 1, json: true } },
					{
						randomSessionId: () => "bench-startup-session",
						writeStdout: () => {},
						writeStderr: () => {},
						setExitCode: () => {},
						stdoutIsTTY: false,
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
