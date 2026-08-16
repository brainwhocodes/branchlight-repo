import { describe, expect, it, vi } from "bun:test";
import type { OAuthAccountSelectionState } from "@oh-my-pi/pi-ai";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

const GLOBAL_LOCK_MESSAGE =
	"This provider has a global account lock. Change it in /settings > Providers > Accounts, or choose Automatic before using /session pin.";

function createRuntimeHarness(options?: {
	handleSessionCommand?: InteractiveModeContext["handleSessionCommand"];
	handleSessionDeleteCommand?: InteractiveModeContext["handleSessionDeleteCommand"];
	showSessionPinSelector?: InteractiveModeContext["showSessionPinSelector"];
	session?: InteractiveModeContext["session"];
}) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const handleSessionCommand =
		options?.handleSessionCommand ??
		vi.fn(async () => {
			return;
		});
	const handleSessionDeleteCommand =
		options?.handleSessionDeleteCommand ??
		vi.fn(async () => {
			return;
		});
	const showSessionPinSelector =
		options?.showSessionPinSelector ??
		vi.fn(async () => {
			return;
		});

	return {
		setText,
		handleSessionCommand,
		handleSessionDeleteCommand,
		showSessionPinSelector,
		showStatus,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleSessionCommand,
				handleSessionDeleteCommand,
				showSessionPinSelector,
				session: options?.session,
				showStatus,
				statusLine: { invalidate: vi.fn() },
				ui: { requestRender: vi.fn() },
			} as unknown as InteractiveModeContext,
		},
	};
}

function selection(available: boolean): OAuthAccountSelectionState {
	return {
		identityHash: "a".repeat(64),
		credentialId: available ? 12 : undefined,
		available,
		allowSiblingFailover: false,
	};
}

function createTextPinSession(configuredSelection: OAuthAccountSelectionState | undefined, streaming = false) {
	const getOAuthAccountSelection = vi.fn(() => configuredSelection);
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
	const pinCurrentProviderOAuthAccount = vi.fn(() => true);
	const session = {
		isStreaming: streaming,
		model: { provider: "anthropic" },
		modelRegistry: { authStorage: { getOAuthAccountSelection } },
		listCurrentProviderOAuthAccounts,
		pinCurrentProviderOAuthAccount,
	} as unknown as InteractiveModeContext["session"];
	return {
		session,
		getOAuthAccountSelection,
		listCurrentProviderOAuthAccounts,
		pinCurrentProviderOAuthAccount,
	};
}

describe("/session slash command", () => {
	it("awaits session info before resolving the default command", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleSessionCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleSessionCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleSessionCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleSessionDeleteCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("awaits the session account picker", async () => {
		const deferred = Promise.withResolvers<void>();
		const showSessionPinSelector = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ showSessionPinSelector });
		let settled = false;
		const execution = executeBuiltinSlashCommand("/session pin", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();
		expect(showSessionPinSelector).toHaveBeenCalledTimes(1);
		expect(harness.setText).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		deferred.resolve();
		expect(await execution).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it.each([
		["available", selection(true)],
		["stale", selection(false)],
	] as const)("rejects an %s global account lock before resolving a text pin", async (_kind, configuredSelection) => {
		const pin = createTextPinSession(configuredSelection);
		const harness = createRuntimeHarness({ session: pin.session });

		expect(await executeBuiltinSlashCommand("/session pin second@example.com", harness.runtime)).toBe(true);

		expect(harness.showStatus).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).toHaveBeenCalledWith(GLOBAL_LOCK_MESSAGE);
		expect(pin.listCurrentProviderOAuthAccounts).not.toHaveBeenCalled();
		expect(pin.pinCurrentProviderOAuthAccount).not.toHaveBeenCalled();
	});

	it("keeps the text pin streaming rejection distinct from the global-lock rejection", async () => {
		const pin = createTextPinSession(selection(false), true);
		const harness = createRuntimeHarness({ session: pin.session });

		await executeBuiltinSlashCommand("/session pin second@example.com", harness.runtime);

		expect(harness.showStatus).toHaveBeenCalledWith("Cannot pin an account while the session is streaming.");
		expect(pin.getOAuthAccountSelection).not.toHaveBeenCalled();
		expect(pin.listCurrentProviderOAuthAccounts).not.toHaveBeenCalled();
	});

	it("preserves text pinning when the provider uses Automatic routing", async () => {
		const pin = createTextPinSession(undefined);
		const harness = createRuntimeHarness({ session: pin.session });

		await executeBuiltinSlashCommand("/session pin second@example.com", harness.runtime);

		expect(pin.getOAuthAccountSelection).toHaveBeenCalledWith("anthropic");
		expect(pin.listCurrentProviderOAuthAccounts).toHaveBeenCalledTimes(1);
		expect(pin.pinCurrentProviderOAuthAccount).toHaveBeenCalledWith(12);
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("Pinned second@example.com"));
	});

	it("propagates session info failures through executeBuiltinSlashCommand", async () => {
		const infoError = new Error("info failed");
		const handleSessionCommand = vi.fn(async () => {
			throw infoError;
		});
		const harness = createRuntimeHarness({ handleSessionCommand });

		await expect(executeBuiltinSlashCommand("/session info", harness.runtime)).rejects.toBe(infoError);
		expect(handleSessionCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleSessionDeleteCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
	});

	it("awaits session deletion before resolving the builtin command", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleSessionDeleteCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleSessionDeleteCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session delete", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleSessionDeleteCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
	});

	it("propagates session deletion failures through executeBuiltinSlashCommand", async () => {
		const deleteError = new Error("delete failed");
		const handleSessionDeleteCommand = vi.fn(async () => {
			throw deleteError;
		});
		const harness = createRuntimeHarness({ handleSessionDeleteCommand });

		await expect(executeBuiltinSlashCommand("/session delete", harness.runtime)).rejects.toBe(deleteError);
		expect(handleSessionDeleteCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
