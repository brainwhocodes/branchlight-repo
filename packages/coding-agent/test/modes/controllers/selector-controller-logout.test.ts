import { beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/logout-account-selector";
import { removeOAuthAccountCredential } from "@oh-my-pi/pi-coding-agent/modes/components/oauth-account-manager";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type {
	AuthStorage,
	OAuthAccountSummary,
	StoredAuthCredential,
} from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";

interface TestEditorContainer {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
}

interface RenderableBlock {
	render(width: number): string[];
}

function renderPresented(blocks: unknown[]): string {
	return blocks
		.flatMap(block => {
			const renderable = block as Partial<RenderableBlock>;
			return renderable.render ? renderable.render(120) : [String(block)];
		})
		.join("\n");
}

function createEditorContainer(): TestEditorContainer {
	return {
		children: [],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

function createStoredCredential(
	id: number,
	email: string,
	accountId: string,
	provider = "anthropic",
): StoredAuthCredential {
	return {
		id,
		provider,
		disabledCause: null,
		credential: {
			type: "oauth",
			access: `access-${id}`,
			refresh: `refresh-${id}`,
			expires: Date.now() + 60_000,
			email,
			accountId,
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("SelectorController logout", () => {
	it("opens an account picker and removes only the selected credential", async () => {
		const editorContainer = createEditorContainer();
		const credentials = [
			createStoredCredential(21, "a@example.com", "acct-a"),
			createStoredCredential(22, "b@example.com", "acct-b"),
		];
		const removeCredential = vi.fn(async (_provider: string, credentialId: number) => {
			const index = credentials.findIndex(row => row.id === credentialId);
			if (index === -1) return false;
			credentials.splice(index, 1);
			return true;
		});
		const authStorage = {
			reload: vi.fn(async () => undefined),
			listStoredCredentials: (_provider?: string) => credentials,
			getOAuthAccountIdentity: (_provider: string, _sessionId?: string) => ({ accountId: "acct-a" }),
			getCredentialOrigin: (_provider: string) => ({ kind: "oauth" }),
			describeCredentialSource: (_provider: string, _sessionId?: string) => undefined,
			removeCredential,
		} as unknown as AuthStorage;
		const refreshProvider = vi.fn(async (_providerId: string, _mode: string) => undefined);
		const presented = Promise.withResolvers<void>();
		const presentedBlocks: unknown[] = [];
		const ctx = {
			editorContainer,
			editor: {},
			ui: {
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
			session: {
				sessionId: "session-logout-test",
				modelRegistry: {
					authStorage,
					refreshProvider,
				},
			},
			showError: vi.fn(),
			present: vi.fn((block: unknown) => {
				presentedBlocks.push(block);
				presented.resolve();
			}),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		await controller.showOAuthSelector("logout", "anthropic");

		const selector = editorContainer.children[0];
		if (!(selector instanceof LogoutAccountSelectorComponent)) {
			throw new Error("Expected logout account selector");
		}
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		await presented.promise;

		expect(removeCredential).toHaveBeenCalledWith("anthropic", 22);
		expect(credentials.map(row => row.id)).toEqual([21]);
		expect(refreshProvider).toHaveBeenCalledWith("anthropic", "online");
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.present).toHaveBeenCalled();
		expect(renderPresented(presentedBlocks)).toContain("Successfully logged out b@example.com from anthropic");
	});

	it("uses separate storage and refresh IDs for an aliased /logout without clearing its global lock", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		try {
			const summary: OAuthAccountSummary = {
				position: 0,
				credentialId: 81,
				email: "alias@example.com",
				accountId: "acct-alias",
				active: true,
			};
			const hash = credentialPinHash("openai-codex", summary);
			if (!hash) throw new Error("Expected a stable account hash");
			settings.set("providers.oauthAccountLocks", { "openai-codex": hash });
			const credentials = [createStoredCredential(81, "alias@example.com", "acct-alias", "openai-codex")];
			const editorContainer = createEditorContainer();
			const removeCredential = vi.fn(async (provider: string, credentialId: number) => {
				expect(provider).toBe("openai-codex");
				expect(credentialId).toBe(81);
				credentials.splice(0);
				return true;
			});
			const refreshProvider = vi.fn(async () => undefined);
			const presented = Promise.withResolvers<void>();
			const authStorage = {
				reload: vi.fn(async () => undefined),
				listStoredCredentials: vi.fn((provider: string) => (provider === "openai-codex" ? credentials : [])),
				getOAuthAccountIdentity: () => ({ accountId: "acct-alias" }),
				getCredentialOrigin: () => ({ kind: "oauth" }),
				describeCredentialSource: () => undefined,
				removeCredential,
			} as unknown as AuthStorage;
			const ctx = {
				editorContainer,
				editor: {},
				ui: { setFocus: vi.fn(), requestRender: vi.fn() },
				session: {
					sessionId: "alias-logout",
					modelRegistry: { authStorage, refreshProvider },
				},
				showError: vi.fn(),
				present: vi.fn(() => presented.resolve()),
			} as unknown as InteractiveModeContext;

			await new SelectorController(ctx).showOAuthSelector("logout", "openai-codex-device");
			const selector = editorContainer.children[0];
			if (!(selector instanceof LogoutAccountSelectorComponent)) {
				throw new Error("Expected aliased logout account selector");
			}
			selector.handleInput("\n");
			await presented.promise;

			expect(removeCredential).toHaveBeenCalledWith("openai-codex", 81);
			expect(refreshProvider).toHaveBeenCalledWith("openai-codex-device", "online");
			expect(settings.get("providers.oauthAccountLocks")).toEqual({ "openai-codex": hash });
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			resetSettingsForTest();
		}
	});

	it("retains the legacy missing-row and refresh-failure error copy", async () => {
		const missingContainer = createEditorContainer();
		const missingAttempted = Promise.withResolvers<void>();
		const missingRefresh = vi.fn(async () => undefined);
		const missingAuthStorage = {
			reload: vi.fn(async () => undefined),
			listStoredCredentials: () => [createStoredCredential(84, "missing@example.com", "acct-missing")],
			getOAuthAccountIdentity: () => undefined,
			getCredentialOrigin: () => ({ kind: "oauth" }),
			describeCredentialSource: () => undefined,
			removeCredential: vi.fn(async () => {
				missingAttempted.resolve();
				return false;
			}),
		} as unknown as AuthStorage;
		const missingContext = {
			editorContainer: missingContainer,
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			session: {
				sessionId: "missing-logout",
				modelRegistry: { authStorage: missingAuthStorage, refreshProvider: missingRefresh },
			},
			showError: vi.fn(),
			present: vi.fn(),
		} as unknown as InteractiveModeContext;
		await new SelectorController(missingContext).showOAuthSelector("logout", "anthropic");
		const missingSelector = missingContainer.children[0];
		if (!(missingSelector instanceof LogoutAccountSelectorComponent)) {
			throw new Error("Expected missing-row logout selector");
		}
		missingSelector.handleInput("\n");
		await missingAttempted.promise;
		await Promise.resolve();
		expect(missingContext.showError).toHaveBeenCalledWith(
			"Logout skipped: missing@example.com is no longer stored for anthropic.",
		);
		expect(missingRefresh).not.toHaveBeenCalled();
		expect(missingContext.present).not.toHaveBeenCalled();

		const refreshContainer = createEditorContainer();
		const refreshAttempted = Promise.withResolvers<void>();
		const refreshAuthStorage = {
			reload: vi.fn(async () => undefined),
			listStoredCredentials: () => [createStoredCredential(85, "refresh@example.com", "acct-refresh")],
			getOAuthAccountIdentity: () => undefined,
			getCredentialOrigin: () => ({ kind: "oauth" }),
			describeCredentialSource: () => undefined,
			removeCredential: vi.fn(async () => true),
		} as unknown as AuthStorage;
		const refreshProvider = vi.fn(async () => {
			refreshAttempted.resolve();
			throw new Error("refresh unavailable");
		});
		const refreshContext = {
			editorContainer: refreshContainer,
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			session: {
				sessionId: "refresh-logout",
				modelRegistry: { authStorage: refreshAuthStorage, refreshProvider },
			},
			showError: vi.fn(),
			present: vi.fn(),
		} as unknown as InteractiveModeContext;
		await new SelectorController(refreshContext).showOAuthSelector("logout", "anthropic");
		const refreshSelector = refreshContainer.children[0];
		if (!(refreshSelector instanceof LogoutAccountSelectorComponent)) {
			throw new Error("Expected refresh-failure logout selector");
		}
		refreshSelector.handleInput("\n");
		await refreshAttempted.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(refreshContext.showError).toHaveBeenCalledWith("Logout failed: refresh unavailable");
		expect(refreshContext.present).not.toHaveBeenCalled();
	});

	it("reports exact missing and refresh failure results from the shared removal action", async () => {
		const missingHook = vi.fn();
		const missingRefresh = vi.fn(async () => undefined);
		const missing = await removeOAuthAccountCredential(
			{
				authStorage: {
					removeCredential: vi.fn(async () => false),
				} as unknown as AuthStorage,
				refreshProvider: missingRefresh,
			},
			"openai-codex",
			91,
			"openai-codex-device",
			undefined,
			missingHook,
		);
		expect(missing).toEqual({ status: "missing" });
		expect(missingHook).not.toHaveBeenCalled();
		expect(missingRefresh).not.toHaveBeenCalled();

		const refreshError = new Error("refresh unavailable");
		const afterRemoved = vi.fn();
		const refreshFailure = await removeOAuthAccountCredential(
			{
				authStorage: {
					removeCredential: vi.fn(async () => true),
				} as unknown as AuthStorage,
				refreshProvider: vi.fn(async () => {
					throw refreshError;
				}),
			},
			"openai-codex",
			92,
			"openai-codex-device",
			undefined,
			afterRemoved,
		);
		expect(afterRemoved).toHaveBeenCalledTimes(1);
		expect(refreshFailure).toEqual({ status: "error", phase: "refresh", error: refreshError });

		const removeError = new Error("storage unavailable");
		const removeFailureHook = vi.fn();
		const removeFailureRefresh = vi.fn(async () => undefined);
		const removeFailure = await removeOAuthAccountCredential(
			{
				authStorage: {
					removeCredential: vi.fn(async () => {
						throw removeError;
					}),
				} as unknown as AuthStorage,
				refreshProvider: removeFailureRefresh,
			},
			"openai-codex",
			93,
			"openai-codex-device",
			undefined,
			removeFailureHook,
		);
		expect(removeFailure).toEqual({ status: "error", phase: "remove", error: removeError });
		expect(removeFailureHook).not.toHaveBeenCalled();
		expect(removeFailureRefresh).not.toHaveBeenCalled();
	});

	it("uses the production Settings manager afterRemoved hook to clear only the confirmed selected lock", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		try {
			const rows: OAuthAccountSummary[] = [
				{
					position: 0,
					credentialId: 101,
					email: "locked@example.com",
					accountId: "acct-locked",
					active: false,
				},
			];
			const hash = credentialPinHash("openai-codex", rows[0]!);
			if (!hash) throw new Error("Expected a stable account hash");
			settings.set("providers.oauthAccountLocks", { "openai-codex": hash });
			const removalFinished = Promise.withResolvers<void>();
			const refreshFinished = Promise.withResolvers<void>();
			const removeCredential = vi.fn(async (provider: string, credentialId: number) => {
				expect(provider).toBe("openai-codex");
				expect(credentialId).toBe(101);
				rows.splice(0);
				removalFinished.resolve();
				return true;
			});
			const authStorage = {
				list: () => ["openai-codex"],
				listStoredOAuthAccounts: (provider: string) => (provider === "openai-codex" ? rows : []),
				getOAuthAccountSelection: () => ({
					identityHash: hash,
					credentialId: 101,
					available: true,
					allowSiblingFailover: false,
				}),
				getOAuthAccountIdentity: () => undefined,
				setOAuthAccountSelectionPolicy: vi.fn(),
				removeCredential,
			} as unknown as AuthStorage;
			const refreshProvider = vi.fn(async () => {
				refreshFinished.resolve();
			});
			const overlayShown = Promise.withResolvers<SettingsSelectorComponent>();
			const ui = {
				imageBudget: undefined,
				terminal: { columns: 120, rows: 40 },
				requestRender: vi.fn(),
				invalidate: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					if (component instanceof SettingsSelectorComponent) overlayShown.resolve(component);
					return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false };
				}),
			};
			const ctx = {
				ui,
				editor: { getTopBorderAvailableWidth: () => 80 },
				editorContainer: { children: [], clear: vi.fn(), addChild: vi.fn() },
				statusLine: { invalidate: vi.fn(), updateSettings: vi.fn(), getTopBorder: () => ({ content: "" }) },
				session: {
					sessionId: "settings-remove",
					isStreaming: false,
					thinkingLevel: undefined,
					model: undefined,
					getAvailableThinkingLevels: () => [],
					getAvailableModels: () => [],
					modelRegistry: { authStorage, refreshProvider },
				},
			} as unknown as InteractiveModeContext;
			const controller = new SelectorController(ctx);

			controller.showSettingsSelector();
			const selector = await overlayShown.promise;
			for (let index = 0; index < 9; index++) selector.handleInput("\x1b[C");
			selector.handleInput("\n");
			selector.handleInput("\n");
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");
			selector.handleInput("\n");
			expect(selector.render(120).join("\n")).toContain("Credential #101");
			selector.handleInput("\n");
			expect(selector.render(120).join("\n")).toContain(
				"Press Enter again to remove locked@example.com; Esc to cancel",
			);
			selector.handleInput("\n");
			await removalFinished.promise;
			await refreshFinished.promise;
			await Promise.resolve();

			expect(removeCredential).toHaveBeenCalledWith("openai-codex", 101);
			expect(refreshProvider).toHaveBeenCalledWith("openai-codex", "online");
			expect(settings.get("providers.oauthAccountLocks")).toEqual({});
			expect(selector.render(120).join("\n")).toContain("OAuth account removed.");
		} finally {
			resetSettingsForTest();
		}
	});
});
