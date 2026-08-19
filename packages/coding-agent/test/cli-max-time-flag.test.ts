import { describe, expect, it, vi } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runCli } from "../src/cli";

function startupOAuthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function startupAccountHash(suffix: string): string {
	const hash = credentialPinHash("anthropic", {
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	});
	if (!hash) throw new Error(`Expected a persistent hash for ${suffix}`);
	return hash;
}

describe("parseArgs — --max-time flag", () => {
	it("parses --max-time seconds as maxTime", () => {
		const result = parseArgs(["--max-time", "3", "--print", "hello"]);

		expect(result.maxTime).toBe(3);
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --max-time duration suffixes as seconds", () => {
		const cases = [
			{ value: "5s", expected: 5 },
			{ value: "10m", expected: 600 },
			{ value: "1h", expected: 3_600 },
		];

		for (const { value, expected } of cases) {
			const result = parseArgs(["--max-time", value, "--print", "hello"]);

			expect(result.maxTime).toBe(expected);
			expect(result.print).toBe(true);
			expect(result.messages).toEqual(["hello"]);
		}
	});

	it("throws a visible parse error for invalid --max-time values", () => {
		const invalidValues = ["5d", "0", "-1", "Infinity", "NaN"];

		for (const value of invalidValues) {
			let thrown: unknown;

			try {
				parseArgs(["--max-time", value, "--print", "hello"]);
			} catch (error) {
				thrown = error;
			}

			if (!(thrown instanceof Error)) {
				throw new Error(`--max-time ${value} did not throw a visible parse error`);
			}
			expect(thrown.message).toContain("--max-time");
		}
	});

	it("reports invalid --max-time values as CLI usage errors", async () => {
		const previousExitCode = process.exitCode;
		let observedExitCode: string | number | null | undefined;
		const captured: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		try {
			await runCli(["--max-time", "5d", "--print", "hello"]);
			observedExitCode = process.exitCode;
		} finally {
			vi.restoreAllMocks();
			process.exitCode = previousExitCode ?? 0;
		}

		const stderr = captured.join("");
		expect(observedExitCode).toBe(2);
		expect(stderr).toContain("Error: Invalid --max-time value");
		expect(stderr).toContain("Run `omp --help` for available flags.");
		expect(stderr).not.toContain("parseMaxTimeSeconds");
		expect(stderr).not.toContain("CliUsageError");
	});

	it("converts maxTime to an absolute session deadline", async () => {
		using tempDir = TempDir.createSync("@omp-max-time-");
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		let observedOptions: CreateAgentSessionOptions | undefined;
		const parsed = parseArgs(["--max-time", "3", "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		const beforeRun = Date.now();
		try {
			await runRootCommand(parsed, ["--max-time", "3", "--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") {
				throw error;
			}
		} finally {
			authStorage.close();
		}
		const afterRun = Date.now();

		expect(observedOptions?.deadline).toBeGreaterThanOrEqual(beforeRun + 3_000);
		expect(observedOptions?.deadline).toBeLessThanOrEqual(afterRun + 3_000);
	});

	it("installs the persisted lock before the first model availability lookup across startup modes", async () => {
		using tempDir = TempDir.createSync("@omp-startup-account-policy-");
		const previousNoTitle = process.env.PI_NO_TITLE;
		const cases = [
			{ name: "interactive", rawArgs: [] },
			{ name: "print", rawArgs: ["--print", "hello"] },
			{ name: "ACP", rawArgs: ["--mode", "acp"] },
		] as const;

		try {
			for (const testCase of cases) {
				const authStorage = await AuthStorage.create(path.join(tempDir.path(), `${testCase.name}-auth.db`));
				await authStorage.set("anthropic", [
					startupOAuthCredential(`${testCase.name}-a`),
					startupOAuthCredential(`${testCase.name}-b`),
				]);
				const selectedSuffix = `${testCase.name}-b`;
				const identityHash = startupAccountHash(selectedSuffix);
				const selectedAccount = authStorage
					.listStoredOAuthAccounts("anthropic")
					.find(account => account.accountId === `account-${selectedSuffix}`);
				const settings = Settings.isolated({
					"marketplace.autoUpdate": "off",
					enabledModels: ["anthropic/*"],
					"providers.oauthAccountLocks": { anthropic: identityHash },
					"providers.oauthAccountFailover": true,
				});
				const parsed = parseArgs([...testCase.rawArgs]);
				parsed.noExtensions = true;
				parsed.noSkills = true;
				parsed.noRules = true;
				parsed.noTools = true;
				parsed.noLsp = true;
				parsed.sessionDir = tempDir.path();
				const stopAtAvailability = new Error(`stop at ${testCase.name} availability`);
				const availabilitySpy = vi.spyOn(ModelRegistry.prototype, "getAvailable").mockImplementation(function (
					this: ModelRegistry,
				) {
					expect(this.authStorage).toBe(authStorage);
					expect(authStorage.getOAuthAccountSelection("anthropic")).toEqual({
						identityHash,
						credentialId: selectedAccount?.credentialId,
						available: true,
						allowSiblingFailover: true,
					});
					throw stopAtAvailability;
				});

				try {
					await expect(
						runRootCommand(parsed, [...testCase.rawArgs], {
							discoverAuthStorage: async () => authStorage,
							settings,
							createAgentSession: async () => {
								throw new Error("Session creation reached before availability sentinel");
							},
						}),
					).rejects.toBe(stopAtAvailability);
				} finally {
					availabilitySpy.mockRestore();
					authStorage.close();
				}
			}
		} finally {
			if (previousNoTitle === undefined) delete process.env.PI_NO_TITLE;
			else process.env.PI_NO_TITLE = previousNoTitle;
		}
	});
});
