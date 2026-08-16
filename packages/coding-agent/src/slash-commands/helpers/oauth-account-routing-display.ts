import type { AuthStorage, OAuthAccountIdentity } from "../../session/auth-storage";
import { sanitizeOAuthAccountLabel } from "./active-oauth-account";
import { toSessionPinAccounts } from "./session-pin";

export interface OAuthAccountRoutingDisplay {
	automaticRouting: boolean;
	selectedAccountLabel?: string;
	selectionUnavailable: boolean;
	allowSiblingFailover: boolean;
	actualAccount?: OAuthAccountIdentity;
	actualAccountIsFailover: boolean;
}

export type OAuthAccountRoutingDisplayResolver = (provider: string) => OAuthAccountRoutingDisplay | undefined;

/** Resolve configured OAuth routing intent and the account that served this session. */
export function buildOAuthAccountRoutingDisplay(
	authStorage: Pick<AuthStorage, "getOAuthAccountSelection" | "listStoredOAuthAccounts" | "getOAuthAccountIdentity">,
	provider: string,
	sessionId: string,
): OAuthAccountRoutingDisplay {
	const selection = authStorage.getOAuthAccountSelection(provider);
	const storedAccounts = authStorage.listStoredOAuthAccounts(provider, sessionId);
	const actualAccount = authStorage.getOAuthAccountIdentity(provider, sessionId);
	const selectedAccount =
		selection?.credentialId === undefined
			? undefined
			: storedAccounts.find(account => account.credentialId === selection.credentialId);
	const activeAccount = storedAccounts.find(account => account.active);
	const selectionUnavailable = selection !== undefined && (!selection.available || selectedAccount === undefined);
	const allowSiblingFailover = selection?.allowSiblingFailover ?? false;
	const actualAccountIsFailover =
		selection !== undefined &&
		allowSiblingFailover &&
		actualAccount !== undefined &&
		activeAccount !== undefined &&
		activeAccount.credentialId !== selection.credentialId;

	return {
		automaticRouting: selection === undefined,
		selectedAccountLabel: selectedAccount ? toSessionPinAccounts([selectedAccount])[0]?.label : undefined,
		selectionUnavailable,
		allowSiblingFailover,
		actualAccount,
		actualAccountIsFailover,
	};
}

/** Format the configured OAuth routing policy for `/usage`. */
export function formatOAuthAccountSelectionLine(display: OAuthAccountRoutingDisplay): string | undefined {
	if (display.selectionUnavailable) return "Locked account unavailable; choose another in /settings";
	const selectedAccountLabel = display.selectedAccountLabel
		? sanitizeOAuthAccountLabel(display.selectedAccountLabel)
		: undefined;
	if (!selectedAccountLabel) return undefined;
	const mode = display.allowSiblingFailover ? "failover enabled" : "strict";
	return `Locked account: ${selectedAccountLabel} (${mode})`;
}
