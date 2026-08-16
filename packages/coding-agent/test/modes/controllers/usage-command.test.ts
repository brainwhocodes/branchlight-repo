import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

interface RenderableBlock {
	render(width: number): string[];
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return value !== null && typeof value === "object" && "render" in value && typeof value.render === "function";
}

function renderPresentedBlocks(value: unknown): string {
	const blocks = Array.isArray(value) ? value : [value];
	return blocks
		.filter(isRenderableBlock)
		.flatMap(block => block.render(200))
		.join("\n");
}

type UsageRoutingAuthStorage = Pick<
	AuthStorage,
	"getOAuthAccountSelection" | "listStoredOAuthAccounts" | "getOAuthAccountIdentity"
>;

function createUsageSessionDouble(authStorage?: UsageRoutingAuthStorage, sessionId = "usage-session") {
	const resolvedAuthStorage: UsageRoutingAuthStorage = authStorage ?? {
		getOAuthAccountSelection: () => undefined,
		listStoredOAuthAccounts: () => [],
		getOAuthAccountIdentity: () => undefined,
	};
	return {
		sessionId,
		modelRegistry: { authStorage: resolvedAuthStorage },
		getUsageReportingModelSelectors: () => [],
	};
}

function accountReport(
	provider: string,
	email: string,
	usedFraction: number,
	orgId?: string,
	orgName?: string,
): UsageReport {
	return {
		provider,
		fetchedAt: Date.now(),
		metadata: { email, orgId, orgName },
		limits: [
			{
				id: `${provider}:monthly`,
				label: "Monthly",
				scope: { provider, windowId: "monthly" },
				window: { id: "monthly", label: "Monthly" },
				amount: { unit: "requests", usedFraction, remainingFraction: 1 - usedFraction },
				status: usedFraction >= 1 ? "exhausted" : "ok",
			},
		],
	};
}

function findUsageGroupRows(output: string, label: string): string[] {
	const lines = output.split("\n");
	const groupIndex = lines.findIndex(line => line.includes(label));
	expect(groupIndex).toBeGreaterThanOrEqual(0);
	return lines.slice(groupIndex + 1, groupIndex + 4);
}

describe("CommandController /usage", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders saved reset expiry lines for future and expired credits", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain(`expired (${expiredIso.slice(0, 10)})`);
	});

	it("renders strict lock intent below the provider and resolves routing once with one session id", async () => {
		const present = vi.fn();
		const sessionId = "strict-routing-session";
		const provider = "openai-codex";
		const getOAuthAccountSelection = vi.fn(() => ({
			identityHash: "a".repeat(64),
			credentialId: 11,
			available: true,
			allowSiblingFailover: false,
		}));
		const listStoredOAuthAccounts = vi.fn(() => [
			{
				position: 0,
				credentialId: 11,
				email: "locked@example.test",
				orgId: "org-locked",
				orgName: "Configured Org",
				active: true,
			},
			{
				position: 1,
				credentialId: 12,
				email: "sibling@example.test",
				orgId: "org-sibling",
				orgName: "Sibling Org",
				active: false,
			},
		]);
		const getOAuthAccountIdentity = vi.fn(() => ({
			email: "locked@example.test",
			orgId: "org-locked",
			orgName: "Configured Org",
		}));
		const session = createUsageSessionDouble(
			{
				getOAuthAccountSelection,
				listStoredOAuthAccounts,
				getOAuthAccountIdentity,
			} as UsageRoutingAuthStorage,
			sessionId,
		);
		const ctx = {
			session,
			ui: { terminal: { columns: 160 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleUsageCommand([
			accountReport(provider, "locked@example.test", 0.8, "org-locked", "Configured Org"),
			accountReport(provider, "sibling@example.test", 0.2, "org-sibling", "Sibling Org"),
		]);

		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = stripVTControlCharacters(renderPresentedBlocks(firstCall?.[0]));
		const lines = output.split("\n");
		const policyIndex = lines.findIndex(line =>
			line.includes("Locked account: locked@example.test (Configured Org) (strict)"),
		);
		expect(policyIndex).toBeGreaterThan(0);
		expect(lines[policyIndex - 1]?.trim()).toBe("Openai Codex");
		expect(output).toContain("in use by this session: locked@example.test (Configured Org)");
		const [labelRow, barRow, valueRow] = findUsageGroupRows(output, "Monthly");
		expect(labelRow).toContain("locked@example.test");
		expect(labelRow).toContain("sibling@example.test");
		expect(barRow).not.toContain("% free");
		expect(valueRow?.indexOf("20% free")).toBe(labelRow?.search(/\S/));
		expect(valueRow?.indexOf("80% free")).toBe(labelRow?.indexOf("sibling@example.test"));
		expect(output).not.toContain("50% free");
		expect(output).not.toContain("in use by this session (failover):");
		expect(getOAuthAccountSelection).toHaveBeenCalledTimes(1);
		expect(getOAuthAccountSelection).toHaveBeenCalledWith(provider);
		expect(listStoredOAuthAccounts).toHaveBeenCalledTimes(1);
		expect(listStoredOAuthAccounts).toHaveBeenCalledWith(provider, sessionId);
		expect(getOAuthAccountIdentity).toHaveBeenCalledTimes(1);
		expect(getOAuthAccountIdentity).toHaveBeenCalledWith(provider, sessionId);
	});

	it("keeps the combined percentage for automatic account routing", async () => {
		const present = vi.fn();
		const provider = "openai-codex";
		const authStorage = {
			getOAuthAccountSelection: vi.fn(() => undefined),
			listStoredOAuthAccounts: vi.fn(() => [
				{
					position: 0,
					credentialId: 11,
					email: "first@example.test",
					active: true,
				},
				{
					position: 1,
					credentialId: 12,
					email: "second@example.test",
					active: false,
				},
			]),
			getOAuthAccountIdentity: vi.fn(() => ({ email: "first@example.test" })),
		} as unknown as UsageRoutingAuthStorage;
		const session = createUsageSessionDouble(authStorage, "automatic-routing-session");
		const ctx = {
			session,
			ui: { terminal: { columns: 160 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleUsageCommand([
			accountReport(provider, "first@example.test", 0.8),
			accountReport(provider, "second@example.test", 0.2),
		]);

		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = stripVTControlCharacters(renderPresentedBlocks(firstCall?.[0]));
		const [labelRow, barRow, followingRow] = findUsageGroupRows(output, "Monthly");
		expect(labelRow).toContain("first@example.test");
		expect(labelRow).toContain("second@example.test");
		expect(barRow).toContain("50% free");
		expect(followingRow ?? "").not.toContain("% free");
		expect(output).not.toContain("Locked account:");
	});

	it("distinguishes configured and org-qualified actual accounts during failover", async () => {
		const present = vi.fn();
		const provider = "anthropic";
		const authStorage = {
			getOAuthAccountSelection: vi.fn(() => ({
				identityHash: "b".repeat(64),
				credentialId: 21,
				available: true,
				allowSiblingFailover: true,
			})),
			listStoredOAuthAccounts: vi.fn(() => [
				{
					position: 0,
					credentialId: 21,
					email: "locked@example.test",
					orgId: "org-configured",
					orgName: "Configured Org",
					active: false,
				},
				{
					position: 1,
					credentialId: 22,
					email: "actual@example.test",
					orgId: "org-actual",
					orgName: "Actual Org",
					active: true,
				},
			]),
			getOAuthAccountIdentity: vi.fn(() => ({
				email: "actual@example.test",
				orgId: "org-actual",
				orgName: "Actual Org",
			})),
		} as unknown as UsageRoutingAuthStorage;
		const session = createUsageSessionDouble(authStorage, "failover-routing-session");
		const ctx = {
			session,
			ui: { terminal: { columns: 160 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleUsageCommand([
			accountReport(provider, "locked@example.test", 0.9, "org-configured", "Configured Org"),
			accountReport(provider, "actual@example.test", 0.4, "org-actual", "Actual Org"),
		]);

		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = stripVTControlCharacters(renderPresentedBlocks(firstCall?.[0]));
		expect(output).toContain("Locked account: locked@example.test (Configured Org) (failover enabled)");
		expect(output).toContain("in use by this session (failover): actual@example.test (Actual Org)");
		const [labelRow, barRow, valueRow] = findUsageGroupRows(output, "Monthly");
		expect(valueRow?.indexOf("10% free")).toBe(labelRow?.indexOf("locked@example.test"));
		expect(valueRow?.indexOf("60% free")).toBe(labelRow?.indexOf("● actual@example.test"));
		expect(barRow).not.toContain("% free");
		expect(output).not.toContain("35% free");
		expect(output).toContain("● actual@example.test (Actual Org)");
		expect(output).not.toContain("● locked@example.test (Configured Org)");
	});

	it("renders stale lock intent without inventing a selected account label", async () => {
		const present = vi.fn();
		const provider = "openai-codex";
		const authStorage = {
			getOAuthAccountSelection: vi.fn(() => ({
				identityHash: "c".repeat(64),
				credentialId: 404,
				available: false,
				allowSiblingFailover: false,
			})),
			listStoredOAuthAccounts: vi.fn(() => [
				{
					position: 0,
					credentialId: 31,
					email: "remaining@example.test",
					active: false,
				},
			]),
			getOAuthAccountIdentity: vi.fn(() => undefined),
		} as unknown as UsageRoutingAuthStorage;
		const session = createUsageSessionDouble(authStorage, "stale-routing-session");
		const ctx = {
			session,
			ui: { terminal: { columns: 120 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleUsageCommand([accountReport(provider, "remaining@example.test", 0.3)]);

		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = stripVTControlCharacters(renderPresentedBlocks(firstCall?.[0]));
		const lines = output.split("\n");
		const policyIndex = lines.findIndex(line =>
			line.includes("Locked account unavailable; choose another in /settings"),
		);
		expect(policyIndex).toBeGreaterThan(0);
		expect(lines[policyIndex - 1]?.trim()).toBe("Openai Codex");
		const [labelRow, barRow, valueRow] = findUsageGroupRows(output, "Monthly");
		expect(valueRow?.indexOf("70% free")).toBe(labelRow?.indexOf("remaining@example.test"));
		expect(barRow).not.toContain("% free");
		expect(output).not.toContain("Locked account:");
		expect(output).not.toContain("in use by this session:");
	});
});
