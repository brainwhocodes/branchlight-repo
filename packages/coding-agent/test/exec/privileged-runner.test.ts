import { describe, expect, it } from "bun:test";
import type { ExecOptions, ExecResult } from "../../src/exec/exec";
import { runPrivileged } from "../../src/exec/privileged-runner";
import { SudoCredentialBroker } from "../../src/exec/sudo-credential-broker";

describe("SudoCredentialBroker", () => {
	it("deduplicates concurrent prompts and expires cached credentials", async () => {
		const broker = new SudoCredentialBroker();
		const deferred = Promise.withResolvers<string | undefined>();
		let promptCalls = 0;
		const prompt = async () => {
			promptCalls++;
			return deferred.promise;
		};

		const first = broker.request("project", prompt, 100);
		const second = broker.request("project", prompt, 100);
		deferred.resolve("secret");

		expect(await Promise.all([first, second])).toEqual(["secret", "secret"]);
		expect(promptCalls).toBe(1);
		broker.remember("project", "secret", 100, 1_000);
		expect(broker.get("project", 1_099)).toBe("secret");
		expect(broker.get("project", 1_100)).toBeUndefined();
	});
});

describe("runPrivileged", () => {
	it("passes cwd, environment, argv, and the password only to sudo stdin", async () => {
		const broker = new SudoCredentialBroker();
		const calls: Array<{ command: string; args: string[]; cwd: string; options: ExecOptions | undefined }> = [];
		const execute = async (
			command: string,
			args: string[],
			cwd: string,
			options?: ExecOptions,
		): Promise<ExecResult> => {
			calls.push({ command, args, cwd, options });
			return { stdout: "ok", stderr: "", code: 0, killed: false };
		};

		const result = await runPrivileged({
			platform: "linux",
			command: "command with spaces",
			args: ["--flag", "value"],
			cwd: "/workspace",
			env: { OMP_TEST_VALUE: "present" },
			credentialScope: "workspace",
			credentialPrompt: async () => "secret",
			broker,
			execute,
		});

		expect(result).toEqual({ stdout: "ok", stderr: "", code: 0, killed: false });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			command: "sudo",
			args: ["-S", "-E", "-p", "OMP_SUDO_PASSWORD_REQUIRED", "--", "command with spaces", "--flag", "value"],
			cwd: "/workspace",
		});
		expect(calls[0]?.options?.input).toBe("secret\n");
		expect(calls[0]?.options?.env?.OMP_TEST_VALUE).toBe("present");
	});
	it("redacts the credential if the child echoes stdin", async () => {
		const result = await runPrivileged({
			platform: "linux",
			command: "cat",
			credentialPrompt: async () => "secret",
			broker: new SudoCredentialBroker(),
			execute: async () => ({ stdout: "secret output", stderr: "secret warning", code: 0, killed: false }),
		});

		expect(result).toEqual({ stdout: "[REDACTED] output", stderr: "[REDACTED] warning", code: 0, killed: false });
	});

	it("clears a rejected credential and prompts once more", async () => {
		const broker = new SudoCredentialBroker();
		const inputs: Array<string | Buffer | Uint8Array | undefined> = [];
		let promptCalls = 0;
		const execute = async (
			_command: string,
			_args: string[],
			_cwd: string,
			options?: ExecOptions,
		): Promise<ExecResult> => {
			inputs.push(options?.input);
			return inputs.length === 1
				? { stdout: "", stderr: "OMP_SUDO_PASSWORD_REQUIRED", code: 1, killed: false }
				: { stdout: "ok", stderr: "", code: 0, killed: false };
		};

		const result = await runPrivileged({
			platform: "linux",
			command: "id",
			credentialScope: "shared",
			credentialPrompt: async () => {
				promptCalls++;
				return promptCalls === 1 ? "wrong" : "right";
			},
			broker,
			execute,
		});

		expect(result.stdout).toBe("ok");
		expect(promptCalls).toBe(2);
		expect(inputs).toEqual(["wrong\n", "right\n"]);
	});

	it("rejects unsupported Windows hosts before prompting", async () => {
		let prompted = false;
		await expect(
			runPrivileged({
				platform: "win32",
				command: "whoami",
				credentialPrompt: async () => {
					prompted = true;
					return "secret";
				},
			}),
		).rejects.toThrow("unavailable on Windows");
		expect(prompted).toBe(false);
	});
});
