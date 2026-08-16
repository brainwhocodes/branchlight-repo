import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { runSearchCommand } from "@oh-my-pi/pi-coding-agent/cli/web-search-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import {
	SEARCH_PROVIDER_ORDER,
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { __resetDirsFromEnvForTests, getAgentDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const WEB_SEARCH_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_SEARCH_API_KEY",
	"ANTHROPIC_SEARCH_BASE_URL",
	"BRAVE_API_KEY",
	"EXA_API_KEY",
	"FIRECRAWL_API_KEY",
	"JINA_API_KEY",
	"KAGI_API_KEY",
	"MOONSHOT_API_KEY",
	"MOONSHOT_SEARCH_API_KEY",
	"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_AUTH_BROKER_URL",
	"PARALLEL_API_KEY",
	"PERPLEXITY_API_KEY",
	"SEARXNG_ENDPOINT",
	"SYNTHETIC_API_KEY",
	"TAVILY_API_KEY",
	"TINYFISH_API_KEY",
	"XAI_API_KEY",
] as const;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOmpProfile = process.env.OMP_PROFILE;
const originalPiProfile = process.env.PI_PROFILE;

let tempAgentDir: TempDir | undefined;
let originalEnv: Partial<Record<(typeof WEB_SEARCH_ENV_KEYS)[number], string | undefined>> = {};
let originalExitCode: typeof process.exitCode;

function responseUrl(input: string | Request | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function makeFetchMock(): typeof fetch {
	return Object.assign(
		async (input: string | Request | URL, _init?: RequestInit): Promise<Response> => {
			const url = responseUrl(input);
			if (url.startsWith("https://s.jina.ai/")) {
				return new Response(
					JSON.stringify({ data: [{ title: "Jina result", url: "https://jina.example", content: "jina" }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://api.tavily.com/search") {
				return new Response(
					JSON.stringify({
						answer: "Tavily answer",
						results: [{ title: "Tavily result", url: "https://tavily.example", content: "tavily" }],
						request_id: "req-test",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(`unexpected URL: ${url}`, { status: 500 });
		},
		{ preconnect: fetch.preconnect },
	);
}

beforeEach(async () => {
	originalEnv = Object.fromEntries(WEB_SEARCH_ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of WEB_SEARCH_ENV_KEYS) delete process.env[key];
	process.env.JINA_API_KEY = "test-jina-key";
	process.env.TAVILY_API_KEY = "test-tavily-key";
	originalExitCode = process.exitCode;
	process.exitCode = undefined;

	resetSettingsForTest();
	setSearchProviderOrder([]);
	setExcludedSearchProviders([]);
	tempAgentDir = TempDir.createSync("@omp-search-cli-");
	setAgentDir(tempAgentDir.path());
	await Settings.init({
		inMemory: true,
		cwd: tempAgentDir.path(),
		overrides: {
			"providers.webSearchOrder": ["tavily"],
			"providers.webSearchExclude": ["jina"],
		},
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	setSearchProviderOrder([]);
	setExcludedSearchProviders([]);
	process.exitCode = originalExitCode;
	for (const key of WEB_SEARCH_ENV_KEYS) {
		restoreEnv(key, originalEnv[key]);
	}
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("OMP_PROFILE", originalOmpProfile);
	restoreEnv("PI_PROFILE", originalPiProfile);
	__resetDirsFromEnvForTests();
	if (tempAgentDir) {
		await tempAgentDir.remove();
		tempAgentDir = undefined;
	}
});

describe("runSearchCommand provider settings", () => {
	it("applies the configured web-search order and exclusions before resolving the implicit chain", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());

		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "provider selection smoke test", limit: 1, expanded: false });

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("Provider: Tavily (API)");
		expect(plain).not.toContain("Provider: Jina");
	});

	it("treats an explicit --provider as a one-shot override of the configured order", async () => {
		// Tavily heads the configured order, but an explicit `--provider jina`
		// forces Jina for this invocation without touching the configured chain.
		const currentTempDir = tempAgentDir;
		if (!currentTempDir) throw new Error("tempAgentDir missing");
		const onlyJinaTavily = SEARCH_PROVIDER_ORDER.filter(id => id !== "jina" && id !== "tavily");
		resetSettingsForTest();
		setSearchProviderOrder([]);
		setExcludedSearchProviders(onlyJinaTavily);
		await Settings.init({
			inMemory: true,
			cwd: currentTempDir.path(),
			overrides: { "providers.webSearchOrder": ["tavily"], "providers.webSearchExclude": onlyJinaTavily },
		});

		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());

		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "explicit provider override", provider: "jina", limit: 1, expanded: false });

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("Provider: Jina");
		expect(plain).not.toContain("Provider: Tavily (API)");
	});

	it("threads one policy-configured OAuth storage through availability and credential resolution", async () => {
		const currentTempDir = tempAgentDir;
		if (!currentTempDir) throw new Error("tempAgentDir missing");
		const selectedIdentityHash = credentialPinHash("anthropic", {
			accountId: "search-account-b",
			email: "search-b@example.com",
		});
		if (!selectedIdentityHash) throw new Error("expected a stable search account identity");

		resetSettingsForTest();
		await fs.mkdir(currentTempDir.join("data"), { recursive: true });
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath(currentTempDir.path()));
		store.saveOAuth("anthropic", {
			access: "sk-ant-oat-search-a",
			refresh: "refresh-search-a",
			expires: Date.now() + 3_600_000,
			accountId: "search-account-a",
			email: "search-a@example.com",
		});
		store.saveOAuth("anthropic", {
			access: "sk-ant-oat-search-b",
			refresh: "refresh-search-b",
			expires: Date.now() + 3_600_000,
			accountId: "search-account-b",
			email: "search-b@example.com",
		});
		const selectedRow = store
			.listAuthCredentials("anthropic")
			.find(row => row.credential.type === "oauth" && row.credential.email === "search-b@example.com");
		if (!selectedRow) throw new Error("expected the selected search OAuth row");
		store.close();
		await Bun.write(
			currentTempDir.join("config.yml"),
			`providers:
  oauthAccountLocks:
    anthropic: ${selectedIdentityHash}
  oauthAccountFailover: false
`,
		);

		const originalHasAuth = AuthStorage.prototype.hasAuth;
		const originalGetApiKey = AuthStorage.prototype.getApiKey;
		let availabilityStorage: AuthStorage | undefined;
		let credentialStorage: AuthStorage | undefined;
		let observedIdentityHash: string | undefined;
		let observedCredentialId: number | undefined;
		let observedAvailable: boolean | undefined;
		let observedFailover: boolean | undefined;
		const hasAuthSpy = vi.spyOn(AuthStorage.prototype, "hasAuth").mockImplementation(function (
			this: AuthStorage,
			provider,
		) {
			if (provider === "anthropic" && !availabilityStorage) {
				availabilityStorage = this;
			}
			return originalHasAuth.call(this, provider);
		});
		const getApiKeySpy = vi.spyOn(AuthStorage.prototype, "getApiKey").mockImplementation(async function (
			this: AuthStorage,
			provider,
			sessionId,
			options,
		) {
			if (provider === "anthropic" && !credentialStorage) {
				credentialStorage = this;
				const selection = this.getOAuthAccountSelection(provider);
				observedIdentityHash = selection?.identityHash;
				observedCredentialId = selection?.credentialId;
				observedAvailable = selection?.available;
				observedFailover = selection?.allowSiblingFailover;
			}
			return originalGetApiKey.call(this, provider, sessionId, options);
		});

		let authorization: string | null = null;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | Request | URL, init?: RequestInit): Promise<Response> => {
					authorization = new Headers(init?.headers).get("authorization");
					return new Response(
						JSON.stringify({
							id: "msg_search_policy",
							model: "claude-haiku-4-5",
							content: [{ type: "text", text: "Configured OAuth search result" }],
							usage: { input_tokens: 1, output_tokens: 2 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				},
				{ preconnect: fetch.preconnect },
			),
		);
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		try {
			await runSearchCommand({
				query: "OAuth storage threading",
				provider: "anthropic",
				limit: 1,
				expanded: false,
			});
		} finally {
			getApiKeySpy.mockRestore();
			hasAuthSpy.mockRestore();
		}

		expect(credentialStorage).toBe(availabilityStorage);
		expect(observedIdentityHash).toBe(selectedIdentityHash);
		expect(observedCredentialId).toBe(selectedRow.id);
		expect(observedAvailable).toBe(true);
		expect(observedFailover).toBe(false);
		expect(authorization ?? "").toBe("Bearer sk-ant-oat-search-b");
		expect(stripVTControlCharacters(stdout)).toContain("Anthropic");
	});

	it("rejects mismatched direct and registry authentication storage", async () => {
		const directStorage = await AuthStorage.create(":memory:");
		const registryStorage = await AuthStorage.create(":memory:");
		try {
			const modelRegistry = new ModelRegistry(registryStorage);
			await expect(
				runSearchQuery(
					{ query: "must not dispatch", provider: "anthropic" },
					{ authStorage: directStorage, modelRegistry },
				),
			).rejects.toThrow(
				"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
			);
		} finally {
			directStorage.close();
			registryStorage.close();
		}
	});
});
