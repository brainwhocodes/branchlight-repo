import { type OAuthLoginIdentity, PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import {
	Container,
	matchesKey,
	routeSelectListMouse,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	Spacer,
	Text,
	type TUI,
} from "@oh-my-pi/pi-tui";
import type { Settings } from "../../config/settings";
import type { AuthStorage } from "../../session/auth-storage";
import { credentialPinHash } from "../../session/credential-pin";
import { type SessionPinAccount, toSessionPinAccounts } from "../../slash-commands/helpers/session-pin";
import { getSelectListTheme, theme } from "../theme/theme";
import { matchesSelectCancel } from "../utils/keybinding-matchers";
import { LoginDialogComponent } from "./login-dialog";

export const OAUTH_ACCOUNT_STREAMING_MESSAGE = "Cannot change accounts while the session is streaming.";
export const OAUTH_MANUAL_LOGIN_PROMPT = "Paste the authorization code (or full redirect URL), then press Enter:";

export interface OAuthAccountLoginDialogPort {
	readonly signal: AbortSignal;
	showAuth(url: string, instructions?: string, launchUrl?: string): void;
	showPrompt(message: string, placeholder?: string): Promise<string>;
	showProgress(message: string): void;
	showManualInput(prompt: string): Promise<string>;
}

export type OAuthAccountBlockedReason = () => string | undefined;

export interface OAuthAccountActionHost {
	authStorage: AuthStorage;
	refreshProvider(providerId: string, strategy: "online"): Promise<void>;
}

export type OAuthAccountLoginResult =
	| { status: "completed"; identity: OAuthLoginIdentity | undefined }
	| { status: "blocked"; reason: string }
	| { status: "cancelled" }
	| { status: "error"; phase: "login"; error: unknown }
	| { status: "error"; phase: "refresh"; error: unknown; identity: OAuthLoginIdentity | undefined };

export type OAuthAccountRemovalResult =
	| { status: "removed" }
	| { status: "missing" }
	| { status: "blocked"; reason: string }
	| { status: "error"; phase: "remove" | "refresh"; error: unknown };

export interface OAuthAccountManagerActions {
	login(
		provider: OAuthProviderInfo,
		dialog: OAuthAccountLoginDialogPort,
		blockedReason?: OAuthAccountBlockedReason,
	): Promise<OAuthAccountLoginResult>;
	remove(
		storageProvider: string,
		credentialId: number,
		refreshProviderId: string,
		blockedReason?: OAuthAccountBlockedReason,
		afterRemoved?: () => void,
	): Promise<OAuthAccountRemovalResult>;
}

export interface OAuthAccountManagerOptions {
	settings: Settings;
	authStorage: AuthStorage;
	tui: TUI;
	sessionId: string;
	getLoginMethods(): readonly OAuthProviderInfo[];
	isStreaming(): boolean;
	installPolicy(): void;
	invalidate(): void;
	actions: OAuthAccountManagerActions;
}

export interface OAuthAccountManagerCallbacks {
	onChange(locks: Readonly<Record<string, string>>): void;
	onClose(): void;
}

export async function loginOAuthAccount(
	host: OAuthAccountActionHost,
	provider: OAuthProviderInfo,
	dialog: OAuthAccountLoginDialogPort,
	blockedReason?: OAuthAccountBlockedReason,
): Promise<OAuthAccountLoginResult> {
	const blocked = blockedReason?.();
	if (blocked) return { status: "blocked", reason: blocked };

	let identity: OAuthLoginIdentity | undefined;
	try {
		identity = await host.authStorage.login(provider.id, {
			signal: dialog.signal,
			onAuth: info => dialog.showAuth(info.url, info.instructions, info.launchUrl),
			onPrompt: prompt => dialog.showPrompt(prompt.message, prompt.placeholder),
			onProgress: message => dialog.showProgress(message),
			onManualCodeInput: PASTE_CODE_LOGIN_PROVIDERS.has(provider.id)
				? () => dialog.showManualInput(OAUTH_MANUAL_LOGIN_PROMPT)
				: undefined,
		});
	} catch (error: unknown) {
		return dialog.signal.aborted ? { status: "cancelled" } : { status: "error", phase: "login", error };
	}

	try {
		await host.refreshProvider(provider.id, "online");
	} catch (error: unknown) {
		return { status: "error", phase: "refresh", error, identity };
	}
	return { status: "completed", identity };
}

export async function removeOAuthAccountCredential(
	host: OAuthAccountActionHost,
	storageProvider: string,
	credentialId: number,
	refreshProviderId: string,
	blockedReason?: OAuthAccountBlockedReason,
	afterRemoved?: () => void,
): Promise<OAuthAccountRemovalResult> {
	const blocked = blockedReason?.();
	if (blocked) return { status: "blocked", reason: blocked };

	let removed: boolean;
	try {
		removed = await host.authStorage.removeCredential(storageProvider, credentialId);
		if (!removed) return { status: "missing" };
		afterRemoved?.();
	} catch (error: unknown) {
		return { status: "error", phase: "remove", error };
	}

	try {
		await host.refreshProvider(refreshProviderId, "online");
	} catch (error: unknown) {
		return { status: "error", phase: "refresh", error };
	}
	return { status: "removed" };
}

type ManagerScreen = "providers" | "detail" | "loginMethods" | "loginDialog" | "remove";

interface AccountRow extends SessionPinAccount {
	hash?: string;
	lockable: boolean;
}

interface PendingRemoval {
	provider: string;
	credentialId: number;
}

const MAX_VISIBLE = 12;

function readLockMap(value: unknown): Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const locks: Record<string, string> = {};
	for (const [provider, hash] of Object.entries(value as Record<string, unknown>)) {
		if (typeof hash === "string") locks[provider] = hash;
	}
	return locks;
}

/** Nested Settings state machine for stored OAuth account routing. */
export class OAuthAccountManagerComponent extends Container {
	#screen: ManagerScreen = "providers";
	#provider: string | undefined;
	#selectList: SelectList | undefined;
	#loginDialog: LoginDialogComponent | undefined;
	#statusText: Text | undefined;
	#hintText: Text | undefined;
	#pendingRemoval: PendingRemoval | undefined;
	#selectListLineOffset = 0;

	constructor(
		private readonly options: OAuthAccountManagerOptions,
		private readonly callbacks: OAuthAccountManagerCallbacks,
	) {
		super();
		this.#showProviders();
	}

	#locks(): Record<string, string> {
		return readLockMap(this.options.settings.get("providers.oauthAccountLocks"));
	}

	#loginMethods(provider?: string): OAuthProviderInfo[] {
		return this.options
			.getLoginMethods()
			.filter(method => method.available && (!provider || (method.storeCredentialsAs ?? method.id) === provider));
	}

	#providerIds(): string[] {
		const ids = new Set<string>();
		for (const provider of this.options.authStorage.list()) {
			if (this.options.authStorage.listStoredOAuthAccounts(provider).length > 0) ids.add(provider);
		}
		for (const provider of Object.keys(this.#locks())) {
			if (this.options.authStorage.getOAuthAccountSelection(provider)) ids.add(provider);
		}
		return [...ids].sort((a, b) => a.localeCompare(b));
	}

	#providerName(provider: string): string {
		return this.#loginMethods(provider)[0]?.name ?? provider;
	}

	#refreshProviderId(provider: string): string {
		return (
			this.options.getLoginMethods().find(method => (method.storeCredentialsAs ?? method.id) === provider)?.id ??
			provider
		);
	}

	#accountRows(provider: string): AccountRow[] {
		const accounts = toSessionPinAccounts(
			this.options.authStorage.listStoredOAuthAccounts(provider, this.options.sessionId),
		);
		const hashes = accounts.map(account => credentialPinHash(provider, account));
		const counts = new Map<string, number>();
		for (const hash of hashes) {
			if (hash) counts.set(hash, (counts.get(hash) ?? 0) + 1);
		}
		return accounts.map((account, index) => {
			const hash = hashes[index];
			return { ...account, hash, lockable: hash !== undefined && counts.get(hash) === 1 };
		});
	}

	#configuredAccount(provider: string, rows = this.#accountRows(provider)): AccountRow | undefined {
		const hash = this.#locks()[provider];
		if (!hash) return undefined;
		const matches = rows.filter(row => row.hash === hash);
		return matches.length === 1 ? matches[0] : undefined;
	}

	#providerStatus(provider: string): string {
		const lockedHash = this.#locks()[provider];
		if (!lockedHash) return "Automatic";
		const configured = this.#configuredAccount(provider);
		if (!configured) return "Locked account unavailable";
		return `Locked: ${configured.label} (${this.options.settings.get("providers.oauthAccountFailover") ? "failover on" : "strict"})`;
	}

	#blockedReason(): string | undefined {
		return this.options.isStreaming() ? OAUTH_ACCOUNT_STREAMING_MESSAGE : undefined;
	}

	#guardMutation(): boolean {
		const blocked = this.#blockedReason();
		if (!blocked) return true;
		this.#setStatus(blocked, true);
		return false;
	}

	#setStatus(message?: string, error = false): void {
		this.#statusText?.setText(message ? theme.fg(error ? "error" : "success", `  ${message}`) : "");
		this.options.invalidate();
	}

	#beginScreen(screen: ManagerScreen, title: string, description?: string): void {
		this.#screen = screen;
		this.#selectList = undefined;
		this.#loginDialog = undefined;
		this.#statusText = undefined;
		this.#hintText = undefined;
		this.#selectListLineOffset = 0;
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));
	}

	#mountList(items: readonly SelectItem[], selectedValue: string | undefined, hint: string): SelectList {
		const list = new SelectList([...items], Math.min(Math.max(items.length, 1), MAX_VISIBLE), getSelectListTheme());
		const selectedIndex = selectedValue === undefined ? -1 : items.findIndex(item => item.value === selectedValue);
		if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		list.onSelectionChange = () => {
			if (this.#screen === "remove") {
				this.#pendingRemoval = undefined;
				this.#updateRemovalHint();
			}
		};
		this.#selectList = list;
		this.addChild(list);
		this.addChild(new Spacer(1));
		this.#hintText = new Text(theme.fg("dim", hint), 0, 0);
		this.addChild(this.#hintText);
		this.#statusText = new Text("", 0, 0);
		this.addChild(this.#statusText);
		return list;
	}

	#showProviders(selectedProvider?: string): void {
		this.#provider = undefined;
		this.#pendingRemoval = undefined;
		this.#beginScreen(
			"providers",
			"OAuth Accounts",
			"Choose a provider to configure automatic routing, add accounts, or remove stored credentials.",
		);
		const providers = this.#providerIds();
		const items = providers.map(
			(provider): SelectItem => ({
				value: provider,
				label: this.#providerName(provider),
				description: this.#providerStatus(provider),
			}),
		);
		const list = this.#mountList(items, selectedProvider, "  Enter to manage provider · Esc to go back");
		list.onSelect = item => this.#showDetail(item.value);
		list.onCancel = this.callbacks.onClose;
		if (providers.length === 0) this.#setStatus("No stored OAuth accounts. Use /login to add the first account.");
	}

	#showDetail(provider: string, selectedValue?: string): void {
		this.#provider = provider;
		this.#pendingRemoval = undefined;
		const rows = this.#accountRows(provider);
		const configured = this.#configuredAccount(provider, rows);
		const active = rows.find(row => row.active);
		const description = active
			? `Current session: ${active.label}`
			: "Choose Automatic routing or one stored OAuth account.";
		this.#beginScreen("detail", this.#providerName(provider), description);
		const lockedHash = this.#locks()[provider];
		const items: SelectItem[] = [
			{
				value: "automatic",
				label: "Automatic routing",
				description: lockedHash ? "Remove this provider's global account lock" : "Current routing mode",
			},
			...rows.map(row => {
				const markers = [
					row.credentialId === configured?.credentialId ? "configured" : undefined,
					row.active ? "active" : undefined,
				]
					.filter((marker): marker is string => marker !== undefined)
					.join(", ");
				const identity = row.lockable ? undefined : "Identity unavailable for persistent lock";
				return {
					value: `account:${row.credentialId}`,
					label: row.label,
					description: [markers, identity].filter(Boolean).join(" · ") || undefined,
				};
			}),
			{ value: "add", label: "Add account", description: "Store another OAuth account without changing the lock" },
			{ value: "remove", label: "Remove account", description: "Remove one exact stored credential" },
		];
		const preferred = selectedValue ?? (configured ? `account:${configured.credentialId}` : "automatic");
		const list = this.#mountList(items, preferred, "  Enter to select · Esc to go back");
		list.onSelect = item => this.#selectDetail(item.value);
		list.onCancel = () => this.#showProviders(provider);
	}

	#selectDetail(value: string): void {
		const provider = this.#provider;
		if (!provider) return;
		if (value === "automatic") {
			if (!this.#guardMutation()) return;
			const locks = this.#locks();
			if (!(provider in locks)) return;
			delete locks[provider];
			this.#writeLocks(locks);
			this.#showDetail(provider, "automatic");
			return;
		}
		if (value === "add") {
			if (!this.#guardMutation()) return;
			this.#showAdd(provider);
			return;
		}
		if (value === "remove") {
			if (!this.#guardMutation()) return;
			this.#showRemove(provider);
			return;
		}
		if (!value.startsWith("account:")) return;
		if (!this.#guardMutation()) return;
		const credentialId = Number(value.slice("account:".length));
		const row = this.#accountRows(provider).find(account => account.credentialId === credentialId);
		if (!row) {
			this.#setStatus("That OAuth account is no longer stored.", true);
			return;
		}
		if (!row.lockable || !row.hash) {
			this.#setStatus("Identity unavailable for persistent lock", true);
			return;
		}
		const locks = this.#locks();
		locks[provider] = row.hash;
		this.#writeLocks(locks);
		this.#showDetail(provider, value);
	}

	#showAdd(provider: string): void {
		const methods = this.#loginMethods(provider);
		if (methods.length === 0) {
			this.#setStatus("No OAuth login method is available for this provider.", true);
			return;
		}
		if (methods.length === 1) {
			void this.#startLogin(methods[0]!);
			return;
		}
		this.#beginScreen("loginMethods", `Add account to ${this.#providerName(provider)}`, "Choose a login method.");
		const items = methods.map(
			(method): SelectItem => ({ value: method.id, label: method.name, description: `Login method: ${method.id}` }),
		);
		const list = this.#mountList(items, undefined, "  Enter to continue · Esc to go back");
		list.onSelect = item => {
			const method = methods.find(candidate => candidate.id === item.value);
			if (method) void this.#startLogin(method);
		};
		list.onCancel = () => this.#showDetail(provider, "add");
	}

	async #startLogin(method: OAuthProviderInfo): Promise<void> {
		const provider = this.#provider;
		if (!provider || !this.#guardMutation()) return;
		this.#beginScreen("loginDialog", `Add account to ${this.#providerName(provider)}`);
		const dialog = new LoginDialogComponent(this.options.tui, method.id, () => this.options.invalidate());
		this.#loginDialog = dialog;
		this.addChild(dialog);
		this.options.invalidate();

		const result = await this.options.actions.login(method, dialog, () => this.#blockedReason());
		if (result.status === "blocked") {
			this.#showDetail(provider, "add");
			this.#setStatus(result.reason, true);
			return;
		}
		if (result.status === "cancelled") {
			this.#showDetail(provider, "add");
			this.#setStatus("Login cancelled.");
			return;
		}
		if (result.status === "error") {
			if (result.phase === "refresh" && result.identity?.type === "oauth") {
				try {
					await this.options.authStorage.reload();
					this.options.installPolicy();
				} catch (reloadError: unknown) {
					const message = reloadError instanceof Error ? reloadError.message : String(reloadError);
					this.#showDetail(provider, "add");
					this.#setStatus(`Account reload failed: ${message}`, true);
					return;
				}
			}
			const message = result.error instanceof Error ? result.error.message : String(result.error);
			this.#showDetail(provider, "add");
			this.#setStatus(`Login ${result.phase} failed: ${message}`, true);
			return;
		}
		if (result.identity?.type !== "oauth") {
			this.#showDetail(provider, "add");
			this.#setStatus("Login did not add a switchable OAuth account.", true);
			return;
		}
		try {
			await this.options.authStorage.reload();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.#showDetail(provider, "add");
			this.#setStatus(`Account reload failed: ${message}`, true);
			return;
		}
		this.options.installPolicy();
		this.#showDetail(provider);
		this.#setStatus("OAuth account added.");
	}

	#showRemove(provider: string): void {
		const rows = this.#accountRows(provider);
		this.#pendingRemoval = undefined;
		this.#beginScreen(
			"remove",
			`Remove account from ${this.#providerName(provider)}`,
			"Choose the exact stored OAuth credential to remove.",
		);
		const items = rows.map(
			(row): SelectItem => ({
				value: `remove:${row.credentialId}`,
				label: row.label,
				description: `Credential #${row.credentialId}`,
			}),
		);
		const configured = this.#configuredAccount(provider, rows);
		const preferred = configured ? `remove:${configured.credentialId}` : undefined;
		const list = this.#mountList(items, preferred, "  Enter to arm removal · Esc to go back");
		list.onSelect = item => this.#selectRemoval(item.value);
		list.onCancel = () => this.#showDetail(provider, "remove");
	}

	#selectRemoval(value: string): void {
		const provider = this.#provider;
		if (!provider || !value.startsWith("remove:") || !this.#guardMutation()) return;
		const credentialId = Number(value.slice("remove:".length));
		const row = this.#accountRows(provider).find(account => account.credentialId === credentialId);
		if (!row) {
			this.#setStatus("That OAuth account is no longer stored.", true);
			return;
		}
		if (this.#pendingRemoval?.provider === provider && this.#pendingRemoval.credentialId === credentialId) {
			void this.#confirmRemoval(provider, row);
			return;
		}
		this.#pendingRemoval = { provider, credentialId };
		this.#setStatus();
		this.#updateRemovalHint();
	}

	#updateRemovalHint(): void {
		if (!this.#hintText) return;
		const pending = this.#pendingRemoval;
		if (!pending) {
			this.#hintText.setText(theme.fg("dim", "  Enter to arm removal · Esc to go back"));
			return;
		}
		const row = this.#accountRows(pending.provider).find(account => account.credentialId === pending.credentialId);
		const label = row?.label ?? `OAuth credential #${pending.credentialId}`;
		this.#hintText.setText(theme.fg("warning", `  Press Enter again to remove ${label}; Esc to cancel`));
	}

	async #confirmRemoval(provider: string, row: AccountRow): Promise<void> {
		if (!this.#guardMutation()) return;
		const priorLocks = this.#locks();
		const configured = this.#configuredAccount(provider);
		const clearsSelected = configured?.credentialId === row.credentialId;
		const result = await this.options.actions.remove(
			provider,
			row.credentialId,
			this.#refreshProviderId(provider),
			() => this.#blockedReason(),
			() => {
				if (clearsSelected) {
					const next = { ...priorLocks };
					delete next[provider];
					this.#writeLocks(next);
				} else {
					this.options.installPolicy();
					this.options.invalidate();
				}
			},
		);
		if (result.status === "blocked") {
			this.#setStatus(result.reason, true);
			return;
		}
		if (result.status === "missing") {
			this.#pendingRemoval = undefined;
			this.#showRemove(provider);
			this.#setStatus("That OAuth account is no longer stored.", true);
			return;
		}
		if (result.status === "error") {
			if (result.phase === "refresh" && clearsSelected) this.#writeLocks(priorLocks);
			const message = result.error instanceof Error ? result.error.message : String(result.error);
			this.#pendingRemoval = undefined;
			this.#showRemove(provider);
			this.#setStatus(`Account ${result.phase} failed: ${message}`, true);
			return;
		}
		this.#pendingRemoval = undefined;
		this.#showDetail(provider);
		this.#setStatus("OAuth account removed.");
	}

	#writeLocks(locks: Readonly<Record<string, string>>): void {
		const copy = { ...locks };
		this.options.settings.set("providers.oauthAccountLocks", copy);
		this.options.installPolicy();
		this.callbacks.onChange(copy);
		this.options.invalidate();
	}

	override render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(Math.max(1, width));
			if (child === this.#selectList) this.#selectListLineOffset = lines.length;
			lines.push(...childLines);
		}
		return lines;
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (this.#selectList) routeSelectListMouse(this.#selectList, event, line - this.#selectListLineOffset);
	}

	pasteText(text: string): void {
		this.#loginDialog?.pasteText(text);
	}

	handleInput(data: string): void {
		if (this.#loginDialog) {
			this.#loginDialog.handleInput(data);
			return;
		}
		if (this.#screen === "remove" && matchesSelectCancel(data) && this.#pendingRemoval) {
			this.#pendingRemoval = undefined;
			this.#setStatus();
			this.#updateRemovalHint();
			return;
		}
		if ((matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) && this.#pendingRemoval) {
			this.#pendingRemoval = undefined;
			this.#updateRemovalHint();
		}
		this.#selectList?.handleInput(data);
	}
}
