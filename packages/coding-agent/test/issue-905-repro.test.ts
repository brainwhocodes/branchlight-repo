/**
 * Regression test for issue #905.
 *
 * Model listing did not include providers contributed by extensions
 * (via `pi.registerProvider(...)`), regardless of whether the extension was
 * supplied via `-e <path>` or configured under `extensions:` in the user
 * settings. The original `--list-models` short-circuit in `runRootCommand`
 * exited before extensions were loaded.
 *
 * Contract under test: the `omp models` listing entry point loads extensions
 * (CLI `-e` paths and configured `settings.extensions`) before listing, so
 * extension-registered providers/models appear in the output.
 */

import { afterAll, beforeAll, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { runModelsCommand, runModelsListing } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { getAgentDbPath, getAgentDir, getProjectDir, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";

let tmp: TempDir;
let extPath: string;
let explicitPackagePath: string;
let ambientExtPath: string;
let dbPath: string;
let shutdownExtPath: string;
let shutdownPath: string;

beforeAll(async () => {
	tmp = await TempDir.create("@issue-905-");
	extPath = tmp.join("ext.ts");
	dbPath = tmp.join("auth.db");
	shutdownExtPath = tmp.join("shutdown-ext.ts");
	shutdownPath = tmp.join("shutdown");
	await fs.writeFile(
		extPath,
		`export default function (pi) {
	pi.registerProvider("test-gw", {
		baseUrl: "https://example.com/v1",
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [{
			id: "test-model",
			name: "Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}
`,
	);
	await fs.writeFile(
		shutdownExtPath,
		`export default function (pi) {
	pi.on("session_shutdown", async () => {
		await Bun.write(${JSON.stringify(shutdownPath)}, "shutdown");
	});
}
`,
	);
	explicitPackagePath = tmp.join("explicit-package");
	ambientExtPath = tmp.join("ambient.ts");
	await fs.mkdir(tmp.join("explicit-package", "src"), { recursive: true });
	await fs.writeFile(
		tmp.join("explicit-package", "package.json"),
		JSON.stringify({ name: "explicit-package", omp: { extensions: ["./src/main.ts"] } }),
	);
	await fs.writeFile(
		tmp.join("explicit-package", "src", "main.ts"),
		`export default function (pi) {
	pi.registerProvider("explicit-gw", {
		baseUrl: "https://explicit.example.com/v1",
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [{
			id: "explicit-model",
			name: "Explicit Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}
`,
	);
	await fs.writeFile(
		ambientExtPath,
		`export default function (pi) {
	pi.registerProvider("ambient-gw", {
		baseUrl: "https://ambient.example.com/v1",
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [{
			id: "ambient-model",
			name: "Ambient Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}
`,
	);
});

afterAll(async () => {
	await Bun.sleep(0);
	await tmp.remove();
});

test("omp models surfaces extension-registered providers (issue #905)", async () => {
	const authStorage = await AuthStorage.create(dbPath);
	try {
		const modelRegistry = new ModelRegistry(authStorage);

		const captured: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;

		try {
			await runModelsListing({
				modelRegistry,
				cwd: tmp.path(),
				action: "ls",
				additionalExtensionPaths: [extPath],
				disableExtensionDiscovery: true,
			});
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = captured.join("");
		expect(output).toContain("test-gw");
		expect(output).toContain("test-model");
	} finally {
		authStorage.close();
	}
});

test("omp models installs persisted OAuth routing before its first registry refresh", async () => {
	const originalAgentDir = getAgentDir();
	const originalProjectDir = getProjectDir();
	const agentDir = tmp.join("models-policy-agent");
	const projectDir = tmp.join("models-policy-project");
	const selectedIdentityHash = credentialPinHash("anthropic", {
		accountId: "models-account-b",
		email: "models-b@example.com",
	});
	if (!selectedIdentityHash) throw new Error("expected a stable models account identity");

	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(`${agentDir}/data`, { recursive: true });
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir));
	store.saveOAuth("anthropic", {
		access: "sk-ant-oat-models-a",
		refresh: "refresh-models-a",
		expires: Date.now() + 3_600_000,
		accountId: "models-account-a",
		email: "models-a@example.com",
	});
	store.saveOAuth("anthropic", {
		access: "sk-ant-oat-models-b",
		refresh: "refresh-models-b",
		expires: Date.now() + 3_600_000,
		accountId: "models-account-b",
		email: "models-b@example.com",
	});
	const selectedRow = store
		.listAuthCredentials("anthropic")
		.find(row => row.credential.type === "oauth" && row.credential.email === "models-b@example.com");
	if (!selectedRow) throw new Error("expected the selected models OAuth row");
	store.close();
	await Bun.write(
		`${agentDir}/config.yml`,
		`providers:
  oauthAccountLocks:
    anthropic: ${selectedIdentityHash}
  oauthAccountFailover: true
`,
	);

	const stopAfterFirstRefresh = new Error("models-policy-installed-before-first-refresh");
	let observedIdentityHash: string | undefined;
	let observedCredentialId: number | undefined;
	let observedAvailable: boolean | undefined;
	let observedFailover: boolean | undefined;
	let observedAccessToken: string | undefined;
	const refreshSpy = vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(async function (
		this: ModelRegistry,
	): Promise<void> {
		const selection = this.authStorage.getOAuthAccountSelection("anthropic");
		observedIdentityHash = selection?.identityHash;
		observedCredentialId = selection?.credentialId;
		observedAvailable = selection?.available;
		observedFailover = selection?.allowSiblingFailover;
		observedAccessToken = (await this.authStorage.getOAuthAccess("anthropic"))?.accessToken;
		throw stopAfterFirstRefresh;
	});

	resetSettingsForTest();
	setAgentDir(agentDir);
	setProjectDir(projectDir);
	try {
		await expect(
			runModelsCommand({
				action: "ls",
				flags: { noExtensions: true },
			}),
		).rejects.toBe(stopAfterFirstRefresh);
		expect(observedIdentityHash).toBe(selectedIdentityHash);
		expect(observedCredentialId).toBe(selectedRow.id);
		expect(observedAvailable).toBe(true);
		expect(observedFailover).toBe(true);
		expect(observedAccessToken).toBe("sk-ant-oat-models-b");
	} finally {
		refreshSpy.mockRestore();
		resetSettingsForTest();
		setAgentDir(originalAgentDir);
		setProjectDir(originalProjectDir);
	}
});

test("omp models emits extension shutdown after listing (issue #6297)", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		await runModelsListing({
			modelRegistry,
			cwd: tmp.path(),
			action: "ls",
			pattern: "issue-6297-no-models",
			additionalExtensionPaths: [shutdownExtPath],
			disableExtensionDiscovery: true,
		});

		expect(await Bun.file(shutdownPath).text()).toBe("shutdown");
	} finally {
		authStorage.close();
	}
});

test("omp models explicit-only mode resolves a package and excludes settings providers", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		const captured: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;

		try {
			await runModelsListing({
				modelRegistry,
				cwd: tmp.path(),
				action: "ls",
				additionalExtensionPaths: [explicitPackagePath],
				settingsExtensions: [ambientExtPath],
				disableExtensionDiscovery: true,
			});
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = captured.join("");
		expect(output).toContain("explicit-gw");
		expect(output).toContain("explicit-model");
		expect(output).not.toContain("ambient-gw");
		expect(output).not.toContain("ambient-model");
	} finally {
		authStorage.close();
	}
});

test("omp models prints invalid models.yml schema errors before listing output", async () => {
	const modelsPath = tmp.join("invalid-models.yml");
	await fs.writeFile(
		modelsPath,
		`providers:
  myprovider:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    auth: none
    compat:
      thinkingFormat: deepseek
    models:
      - id: my-model
        name: My Model
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 8192
        maxTokens: 4096
`,
	);

	const authStorage = await AuthStorage.create(":memory:");
	try {
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const captured: string[] = [];
		const originalWrite = process.stdout.write;
		Reflect.set(process.stdout, "write", (chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		});

		try {
			await runModelsListing({
				modelRegistry,
				cwd: tmp.path(),
				action: "ls",
				pattern: "myprovider",
				disableExtensionDiscovery: true,
			});
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = captured.join("");
		expect(output).toContain("Warning: models.yml validation failed — custom providers disabled");
		expect(output).toContain("providers.myprovider.compat.thinkingFormat");
		expect(output).toContain("deepseek");
	} finally {
		authStorage.close();
	}
});
