import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { OAuthAuthInfo, OAuthController, OAuthPrompt, OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LoginDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/login-dialog";
import { loginOAuthAccount } from "@oh-my-pi/pi-coding-agent/modes/components/oauth-account-manager";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AuthStorage, OAuthAccountSummary } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { TUI } from "@oh-my-pi/pi-tui";

interface RenderableBlock {
	render(width: number): string[];
}

interface LoginControls extends OAuthController {
	onAuth(info: OAuthAuthInfo): void;
	onPrompt(prompt: OAuthPrompt): Promise<string>;
}
function renderPresented(blocks: unknown[]): string {
	return blocks
		.flatMap(block => {
			const maybeRenderable = block as Partial<RenderableBlock>;
			return maybeRenderable.render ? maybeRenderable.render(120) : [String(block)];
		})
		.join("\n");
}

function createLoginDialog(signal: AbortSignal) {
	const showAuth = vi.fn();
	const showPrompt = vi.fn(async () => "prompt response");
	const showProgress = vi.fn();
	const showManualInput = vi.fn(async () => "manual response");
	return {
		dialog: { signal, showAuth, showPrompt, showProgress, showManualInput },
		showAuth,
		showPrompt,
		showProgress,
		showManualInput,
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("SelectorController login", () => {
	it("awaits a provider-scoped online refresh, then presents OAuth success", async () => {
		const loginSaved = Promise.withResolvers<void>();
		const presentedBlocks: unknown[] = [];
		const authStorage = {
			login: vi.fn(async () => {
				loginSaved.resolve();
			}),
		} as unknown as AuthStorage;
		const refresh = vi.fn(() => new Promise<void>(() => {}));
		const refreshProvider = vi.fn(async () => {});
		const ctx = {
			oauthManualInput: {
				waitForInput: vi.fn(),
				clear: vi.fn(),
			},
			session: {
				modelRegistry: {
					authStorage,
					refresh,
					refreshProvider,
				},
			},
			// The login flow swaps the editor slot for the cancellable dialog
			// and restores it when the flow settles.
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn((block: unknown) => {
				presentedBlocks.push(block);
			}),
			openInBrowser: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		void controller.showOAuthSelector("login", "xai-oauth");
		await loginSaved.promise;
		// Let the awaited refreshProvider settle before the success block is presented.
		await Promise.resolve();
		await Promise.resolve();

		expect(renderPresented(presentedBlocks)).toContain("Successfully logged in to xai-oauth");
		// Post-login refresh is scoped to the just-authenticated provider with the
		// `online` strategy (#5780) — not the all-provider default refresh.
		expect(refreshProvider).toHaveBeenCalledTimes(1);
		expect(refreshProvider).toHaveBeenCalledWith("xai-oauth", "online");
		expect(refresh).not.toHaveBeenCalled();
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("shares alias-aware OAuth dialog wiring and preserves the stored OAuth identity", async () => {
		const provider: OAuthProviderInfo = {
			id: "zai-coding-plan",
			name: "Z.AI OAuth",
			available: true,
			storeCredentialsAs: "zai",
		};
		const abortController = new AbortController();
		const { dialog, showAuth, showPrompt, showProgress, showManualInput } = createLoginDialog(abortController.signal);
		const login = vi.fn(async (providerId: string, controls: LoginControls) => {
			expect(providerId).toBe("zai-coding-plan");
			expect(controls.signal).toBe(abortController.signal);
			controls.onAuth({
				url: "https://auth.example.test",
				instructions: "Sign in",
				launchUrl: "https://launch.example.test",
			});
			controls.onProgress?.("Waiting for provider");
			await controls.onPrompt({ message: "Paste code", placeholder: "code" });
			await controls.onManualCodeInput?.();
			return {
				type: "oauth" as const,
				email: "oauth@example.com",
				accountId: "acct-oauth",
				orgId: "org-1",
				orgName: "Team One",
			};
		});
		const refreshProvider = vi.fn(async () => undefined);
		const result = await loginOAuthAccount(
			{
				authStorage: { login } as unknown as AuthStorage,
				refreshProvider,
			},
			provider,
			dialog,
		);

		expect(showAuth).toHaveBeenCalledWith("https://auth.example.test", "Sign in", "https://launch.example.test");
		expect(showProgress).toHaveBeenCalledWith("Waiting for provider");
		expect(showPrompt).toHaveBeenCalledWith("Paste code", "code");
		expect(showManualInput).toHaveBeenCalledWith(
			"Paste the authorization code (or full redirect URL), then press Enter:",
		);
		expect(refreshProvider).toHaveBeenCalledWith("zai-coding-plan", "online");
		expect(result).toEqual({
			status: "completed",
			identity: {
				type: "oauth",
				email: "oauth@example.com",
				accountId: "acct-oauth",
				orgId: "org-1",
				orgName: "Team One",
			},
		});
	});

	it("returns cancellation and phase-specific failures without hiding refresh identity", async () => {
		const provider: OAuthProviderInfo = { id: "xai-oauth", name: "xAI", available: true };
		const cancelled = new AbortController();
		cancelled.abort();
		const cancelledDialog = createLoginDialog(cancelled.signal).dialog;
		const cancelledRefresh = vi.fn(async () => undefined);
		const cancelledResult = await loginOAuthAccount(
			{
				authStorage: {
					login: vi.fn(async () => {
						throw new Error("aborted");
					}),
				} as unknown as AuthStorage,
				refreshProvider: cancelledRefresh,
			},
			provider,
			cancelledDialog,
		);
		expect(cancelledResult).toEqual({ status: "cancelled" });
		expect(cancelledRefresh).not.toHaveBeenCalled();

		const loginFailure = new Error("login unavailable");
		const activeDialog = createLoginDialog(new AbortController().signal).dialog;
		const loginFailureResult = await loginOAuthAccount(
			{
				authStorage: {
					login: vi.fn(async () => {
						throw loginFailure;
					}),
				} as unknown as AuthStorage,
				refreshProvider: vi.fn(async () => undefined),
			},
			provider,
			activeDialog,
		);
		expect(loginFailureResult).toEqual({ status: "error", phase: "login", error: loginFailure });

		const refreshFailure = new Error("refresh unavailable");
		const apiKeyIdentity = { type: "api_key" as const };
		const refreshFailureResult = await loginOAuthAccount(
			{
				authStorage: {
					login: vi.fn(async () => apiKeyIdentity),
				} as unknown as AuthStorage,
				refreshProvider: vi.fn(async () => {
					throw refreshFailure;
				}),
			},
			provider,
			activeDialog,
		);
		expect(refreshFailureResult).toEqual({
			status: "error",
			phase: "refresh",
			error: refreshFailure,
			identity: apiKeyIdentity,
		});
	});

	it("retains the legacy login and refresh failure transcript copy", async () => {
		const loginError = new Error("login unavailable");
		const loginRefresh = vi.fn(async () => undefined);
		const loginContext = {
			oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
			session: {
				modelRegistry: {
					authStorage: {
						login: vi.fn(async () => {
							throw loginError;
						}),
					} as unknown as AuthStorage,
					refreshProvider: loginRefresh,
				},
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn(),
			openInBrowser: vi.fn(),
		} as unknown as InteractiveModeContext;
		await new SelectorController(loginContext).showOAuthSelector("login", "xai-oauth");
		expect(loginContext.showError).toHaveBeenCalledWith("Login failed: login unavailable");
		expect(loginRefresh).not.toHaveBeenCalled();
		expect(loginContext.present).not.toHaveBeenCalled();

		const refreshError = new Error("refresh unavailable");
		const refreshContext = {
			oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
			session: {
				modelRegistry: {
					authStorage: {
						login: vi.fn(async () => ({
							type: "oauth" as const,
							email: "refresh@example.com",
						})),
					} as unknown as AuthStorage,
					refreshProvider: vi.fn(async () => {
						throw refreshError;
					}),
				},
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn(),
			openInBrowser: vi.fn(),
		} as unknown as InteractiveModeContext;
		await new SelectorController(refreshContext).showOAuthSelector("login", "xai-oauth");
		expect(refreshContext.showError).toHaveBeenCalledWith("Login failed: refresh unavailable");
		expect(refreshContext.present).not.toHaveBeenCalled();
	});

	it("injects the shared login action into Settings and rejects a raw API-key login as switchable", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		try {
			const account: OAuthAccountSummary = {
				position: 0,
				credentialId: 71,
				accountId: "acct-zai",
				email: "stored@example.com",
				active: false,
			};
			const loginStarted = Promise.withResolvers<void>();
			const refreshFinished = Promise.withResolvers<void>();
			const login = vi.fn(async (providerId: string, controls: LoginControls) => {
				expect(providerId).toBe("zai");
				expect(controls.signal).toBeInstanceOf(AbortSignal);
				loginStarted.resolve();
				return { type: "api_key" as const };
			});
			const authStorage = {
				list: () => ["zai"],
				listStoredOAuthAccounts: (provider: string) => (provider === "zai" ? [account] : []),
				getOAuthAccountSelection: () => undefined,
				getOAuthAccountIdentity: () => undefined,
				setOAuthAccountSelectionPolicy: vi.fn(),
				login,
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
					sessionId: "settings-login",
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
			expect(selector.render(120).join("\n")).toContain("OAuth Accounts");
			selector.handleInput("\n");
			selector.handleInput("\n");
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");
			selector.handleInput("\n");
			expect(selector.render(120).join("\n")).toContain("Choose a login method");
			selector.handleInput("\n");
			await loginStarted.promise;
			await refreshFinished.promise;
			await Promise.resolve();

			expect(login).toHaveBeenCalledTimes(1);
			expect(refreshProvider).toHaveBeenCalledWith("zai", "online");
			expect(selector.render(120).join("\n")).toContain("Login did not add a switchable OAuth account.");
			expect(settings.get("providers.oauthAccountLocks")).toEqual({});
		} finally {
			resetSettingsForTest();
		}
	});

	it("Esc during a pending login aborts the flow and restores the editor", async () => {
		const login = vi.fn(
			(_provider: string, ctrl: { signal?: AbortSignal }) =>
				new Promise<void>((_resolve, reject) => {
					ctrl.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const authStorage = { login } as unknown as AuthStorage;
		const editorSlot: unknown[] = [];
		const editor = {};
		const presentedBlocks: unknown[] = [];
		const ctx = {
			oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
			session: { modelRegistry: { authStorage, refreshProvider: vi.fn(async () => {}) } },
			editorContainer: {
				clear: vi.fn(() => editorSlot.splice(0)),
				addChild: vi.fn((child: unknown) => editorSlot.push(child)),
				children: editorSlot,
			},
			editor,
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn((block: unknown) => {
				presentedBlocks.push(block);
			}),
			openInBrowser: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		const loginDone = controller.showOAuthSelector("login", "xai-oauth");
		const dialog = editorSlot[0] as { handleInput(data: string): void };
		expect(dialog).toBeDefined();
		expect(dialog).not.toBe(editor);

		dialog.handleInput("\x1b"); // Esc cancels the pairing wait
		await loginDone;

		// The abort is user-driven: no error surfaced, the cancellation is
		// announced, and the editor owns the slot again.
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("Login cancelled");
		expect(editorSlot).toEqual([editor]);
		expect(renderPresented(presentedBlocks)).not.toContain("Successfully logged in");
	});
	it("routes enhanced paste into a direct API-key prompt", async () => {
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "openrouter", vi.fn());
		const prompt = dialog.showPrompt("Paste your OpenRouter API key");

		dialog.pasteText("OMP_PASTE_TEST_123");
		dialog.handleInput("\n");

		await expect(prompt).resolves.toBe("OMP_PASTE_TEST_123");
	});
});
