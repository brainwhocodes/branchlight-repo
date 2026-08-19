import { Database } from "bun:sqlite";
import { afterEach, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const authStorages: AuthStorage[] = [];
const tempDirs: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const authStorage of authStorages.splice(0)) await authStorage.close();
	for (const tempDir of tempDirs.splice(0)) tempDir[Symbol.dispose]();
});

async function createOAuthStorage(): Promise<AuthStorage> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	store.saveOAuth("anthropic", {
		access: "access-a",
		refresh: "refresh-a",
		expires: Date.now() + 3_600_000,
		accountId: "account-a",
		email: "a@example.com",
	});
	store.saveOAuth("anthropic", {
		access: "access-b",
		refresh: "refresh-b",
		expires: Date.now() + 3_600_000,
		accountId: "account-b",
		email: "b@example.com",
	});
	const authStorage = new AuthStorage(store);
	await authStorage.reload();
	authStorages.push(authStorage);
	return authStorage;
}

function executorOptions(tempDir: TempDir, authStorage: AuthStorage, settings: Settings) {
	return {
		cwd: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" as const },
		task: "test",
		index: 0,
		id: "task-launch-policy",
		authStorage,
		settings,
		enableLsp: false,
		enableIrc: false,
	};
}

it("installs the complete locked-account policy before refreshing an owned registry", async () => {
	const tempDir = TempDir.createSync("@pi-task-launch-policy-");
	tempDirs.push(tempDir);
	const authStorage = await createOAuthStorage();
	const selectedHash = credentialPinHash("anthropic", {
		accountId: "account-b",
		email: "b@example.com",
	});
	if (!selectedHash) throw new Error("Expected account B to have a durable identity");
	const selectedAccount = authStorage
		.listStoredOAuthAccounts("anthropic")
		.find(account => account.accountId === "account-b");
	if (!selectedAccount) throw new Error("Expected account B to be stored");
	const settings = Settings.isolated({
		"providers.oauthAccountLocks": { anthropic: selectedHash },
		"providers.oauthAccountFailover": true,
	});

	let refreshObserved = false;
	const refreshSpy = vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(async () => {
		expect(authStorage.getOAuthAccountSelection("anthropic")).toEqual({
			identityHash: selectedHash,
			credentialId: selectedAccount.credentialId,
			available: true,
			allowSiblingFailover: true,
		});
		refreshObserved = true;
	});
	const stop = new Error("stop executor owned-registry policy startup");
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("Expected executor session options");
		expect(refreshObserved).toBe(true);
		if (!options.authStorage) throw new Error("Expected executor to pass its owned auth storage");
		expect(options.authStorage.getOAuthAccountSelection("anthropic")).toEqual({
			identityHash: selectedHash,
			credentialId: selectedAccount.credentialId,
			available: true,
			allowSiblingFailover: true,
		});
		const access = await options.authStorage.getOAuthAccess("anthropic", "owned-registry-startup");
		expect(access).toMatchObject({
			accessToken: "access-b",
			credentialId: selectedAccount.credentialId,
		});
		throw stop;
	});

	const result = await runSubprocess(executorOptions(tempDir, authStorage, settings));

	expect(refreshSpy).toHaveBeenCalledTimes(1);
	expect(result.exitCode).toBe(1);
	expect(result.error).toContain(stop.message);
});

it("preserves a supplied parent registry policy without reinstalling or refreshing it", async () => {
	const tempDir = TempDir.createSync("@pi-task-parent-policy-");
	tempDirs.push(tempDir);
	const authStorage = await createOAuthStorage();
	const parentHash = credentialPinHash("anthropic", {
		accountId: "account-a",
		email: "a@example.com",
	});
	const childHash = credentialPinHash("anthropic", {
		accountId: "account-b",
		email: "b@example.com",
	});
	if (!parentHash || !childHash) throw new Error("Expected both accounts to have durable identities");
	const parentAccount = authStorage
		.listStoredOAuthAccounts("anthropic")
		.find(account => account.accountId === "account-a");
	if (!parentAccount) throw new Error("Expected account A to be stored");
	authStorage.setOAuthAccountSelectionPolicy({
		selections: {
			anthropic: {
				identityHash: parentHash,
				credentialId: parentAccount.credentialId,
			},
		},
		allowSiblingFailover: false,
	});
	const modelRegistry = new ModelRegistry(authStorage);
	const refreshSpy = vi.spyOn(modelRegistry, "refresh");
	const backgroundRefreshSpy = vi.spyOn(modelRegistry, "refreshInBackground");
	const settings = Settings.isolated({
		"providers.oauthAccountLocks": { anthropic: childHash },
		"providers.oauthAccountFailover": true,
	});
	const stop = new Error("stop executor inherited-registry policy startup");
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("Expected executor session options");
		expect(options.modelRegistry).toBe(modelRegistry);
		if (!options.authStorage) throw new Error("Expected executor to pass its inherited auth storage");
		expect(options.authStorage.getOAuthAccountSelection("anthropic")).toEqual({
			identityHash: parentHash,
			credentialId: parentAccount.credentialId,
			available: true,
			allowSiblingFailover: false,
		});
		const access = await options.authStorage.getOAuthAccess("anthropic", "parent-registry-startup");
		expect(access).toMatchObject({
			accessToken: "access-a",
			credentialId: parentAccount.credentialId,
		});
		throw stop;
	});

	const result = await runSubprocess({
		...executorOptions(tempDir, authStorage, settings),
		modelRegistry,
	});

	expect(refreshSpy).not.toHaveBeenCalled();
	expect(backgroundRefreshSpy).not.toHaveBeenCalled();
	expect(result.exitCode).toBe(1);
	expect(result.error).toContain(stop.message);
});

it("overlaps registry refresh with session-file opening and session setup", async () => {
	const tempDir = TempDir.createSync("@pi-task-launch-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);

	const refreshGate = Promise.withResolvers<void>();
	vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(() => refreshGate.promise);

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const openGate = Promise.withResolvers<SessionManager>();
	const openStarted = Promise.withResolvers<void>();
	const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
		openStarted.resolve();
		return openGate.promise;
	});

	const sessionCreationStarted = Promise.withResolvers<void>();
	let sessionCreated = false;
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield",
					toolName: "yield",
					result: { content: [], details: { status: "success", data: { ok: true } } },
					isError: false,
				} as AgentSessionEvent);
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	} as unknown as AgentSession;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
		sessionCreationStarted.resolve();
		sessionCreated = true;
		const result: CreateAgentSessionResult = {
			session,
			extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		};
		return result;
	});

	const run = runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-launch-overlap",
		authStorage,
		enableLsp: false,
		enableIrc: false,
	});
	await openStarted.promise;

	expect(openSpy).toHaveBeenCalledTimes(1);
	expect(sessionCreated).toBe(false);

	openGate.resolve(sessionManager);
	await sessionCreationStarted.promise;
	expect(sessionCreated).toBe(true);

	refreshGate.resolve();
	expect((await run).exitCode).toBe(0);
});
