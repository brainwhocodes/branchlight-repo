import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { OAuthAccountSelectionState } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionAccountSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-account-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { toSessionPinAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";

beforeAll(async () => {
	await initTheme();
});

const accounts = toSessionPinAccounts([
	{ position: 0, credentialId: 11, email: "first@example.com", active: false },
	{ position: 1, credentialId: 12, email: "second@example.com", active: true },
]);

const GLOBAL_LOCK_MESSAGE =
	"This provider has a global account lock. Change it in /settings > Providers > Accounts, or choose Automatic before using /session pin.";

function selection(available: boolean) {
	return {
		identityHash: "a".repeat(64),
		credentialId: available ? 12 : undefined,
		available,
		allowSiblingFailover: false,
	};
}
function createPinSelectorHarness(options: { selection: OAuthAccountSelectionState | undefined; streaming?: boolean }) {
	const getOAuthAccountSelection = vi.fn(() => options.selection);
	const listCurrentProviderOAuthAccounts = vi.fn(async () => ({
		provider: "anthropic",
		accounts: [
			{
				position: 0,
				credentialId: 12,
				email: "second@example.com",
				active: false,
			},
		],
	}));
	const showStatus = vi.fn();
	const editor = { id: "editor" };
	const editorContainer = {
		children: [editor] as unknown[],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	const ctx = {
		editor,
		editorContainer,
		session: {
			isStreaming: options.streaming ?? false,
			model: { provider: "anthropic" },
			modelRegistry: {
				authStorage: {
					getOAuthAccountSelection,
					describeCredentialSource: vi.fn(),
				},
			},
			listCurrentProviderOAuthAccounts,
		},
		showStatus,
		showError: vi.fn(),
		showWarning: vi.fn(),
		statusLine: { invalidate: vi.fn() },
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		},
	} as unknown as InteractiveModeContext;
	return {
		controller: new SelectorController(ctx),
		ctx,
		editorContainer,
		getOAuthAccountSelection,
		listCurrentProviderOAuthAccounts,
		showStatus,
	};
}

describe("SessionAccountSelectorComponent", () => {
	it("handles navigation, selection, Escape, and Ctrl+C while focused", () => {
		const selected: number[] = [];
		let cancellations = 0;
		const component = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			account => selected.push(account.credentialId),
			() => {
				cancellations += 1;
			},
		);

		component.handleInput("\x1b[A");
		component.handleInput("\n");
		expect(selected).toEqual([11]);

		const escapeComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			() => {},
			() => {
				cancellations += 1;
			},
		);
		escapeComponent.handleInput("\x1b");

		const ctrlCComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			() => {},
			() => {
				cancellations += 1;
			},
		);
		ctrlCComponent.handleInput("\x03");
		expect(cancellations).toBe(2);
	});
});

describe("SelectorController.showSessionPinSelector", () => {
	it.each([
		["available", selection(true)],
		["stale", selection(false)],
	] as const)("rejects an %s global account lock before loading accounts", async (_kind, configuredSelection) => {
		const harness = createPinSelectorHarness({ selection: configuredSelection });

		await harness.controller.showSessionPinSelector();

		expect(harness.showStatus).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).toHaveBeenCalledWith(GLOBAL_LOCK_MESSAGE);
		expect(harness.listCurrentProviderOAuthAccounts).not.toHaveBeenCalled();
		expect(harness.editorContainer.children).toEqual([{ id: "editor" }]);
	});

	it("keeps the streaming rejection distinct and checks it before global selection", async () => {
		const harness = createPinSelectorHarness({ selection: selection(false), streaming: true });

		await harness.controller.showSessionPinSelector();

		expect(harness.showStatus).toHaveBeenCalledWith("Cannot pin an account while the session is streaming.");
		expect(harness.getOAuthAccountSelection).not.toHaveBeenCalled();
		expect(harness.listCurrentProviderOAuthAccounts).not.toHaveBeenCalled();
	});

	it("opens the existing account selector for Automatic routing", async () => {
		const harness = createPinSelectorHarness({ selection: undefined });

		await harness.controller.showSessionPinSelector();

		expect(harness.getOAuthAccountSelection).toHaveBeenCalledWith("anthropic");
		expect(harness.listCurrentProviderOAuthAccounts).toHaveBeenCalledTimes(1);
		expect(harness.editorContainer.children[0]).toBeInstanceOf(SessionAccountSelectorComponent);
	});

	it("rechecks the global lock in AgentSession when it appears after the selector opens", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		let configuredSelection: OAuthAccountSelectionState | undefined;
		const pinSessionOAuthAccount = vi.fn(() => true);
		const authStorage = {
			getOAuthAccountSelection: vi.fn(() => configuredSelection),
			pinSessionOAuthAccount,
		};
		const modelRegistry = { authStorage } as unknown as ModelRegistry;
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		vi.spyOn(session, "listCurrentProviderOAuthAccounts").mockResolvedValue({
			provider: "anthropic",
			accounts: [{ position: 0, credentialId: 12, email: "second@example.com", active: false }],
		});
		const showWarning = vi.fn();
		const showStatus = vi.fn();
		const editor = { id: "editor" };
		const editorContainer = {
			children: [editor] as unknown[],
			clear() {
				this.children = [];
			},
			addChild(child: unknown) {
				this.children.push(child);
			},
		};
		const ctx = {
			editor,
			editorContainer,
			session,
			showStatus,
			showError: vi.fn(),
			showWarning,
			statusLine: { invalidate: vi.fn() },
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		} as unknown as InteractiveModeContext;

		try {
			await new SelectorController(ctx).showSessionPinSelector();
			expect(editorContainer.children[0]).toBeInstanceOf(SessionAccountSelectorComponent);

			configuredSelection = selection(false);
			(editorContainer.children[0] as SessionAccountSelectorComponent).handleInput("\n");

			expect(pinSessionOAuthAccount).not.toHaveBeenCalled();
			expect(showWarning).toHaveBeenCalledWith("second@example.com is no longer available to pin.");
			expect(showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Pinned "));
		} finally {
			await session.dispose();
		}
	});
});
