/**
 * Privileged command execution with a side-channel password prompt.
 *
 * Commands and environment values are passed as argv/spawn options; shell
 * interpolation is never involved. Passwords are written only to sudo stdin
 * and are not included in returned output or errors.
 */

import { type ExecOptions, type ExecResult, execCommand } from "./exec";
import { type SudoCredentialBroker, type SudoCredentialPrompt, sudoCredentialBroker } from "./sudo-credential-broker";

const SUDO_PROMPT_MARKER = "OMP_SUDO_PASSWORD_REQUIRED";
const SUDO_EXECUTABLE = "sudo";

export interface PrivilegedRunOptions extends ExecOptions {
	/** Command to execute as root. */
	command: string;
	/** Positional arguments for command. */
	args?: string[];
	/** Working directory for both sudo and the target command. */
	cwd?: string;
	/** Environment additions/removals for the target command. */
	env?: Record<string, string | undefined>;
	/** Broker namespace shared by cooperating agent sessions. */
	credentialScope?: string;
	/** Called only when no valid credential is cached. */
	credentialPrompt?: SudoCredentialPrompt;
	/** Credential cache lifetime. */
	credentialTtlMs?: number;
	/** Process-local credential broker. Defaults to the shared broker. */
	broker?: SudoCredentialBroker;
	/** Injectable executor for contract tests and alternate hosts. */
	execute?: PrivilegedExecutor;
	/** Host platform override for contract tests. */
	platform?: NodeJS.Platform;
}

export type PrivilegedExecutor = (
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
) => Promise<ExecResult>;

export async function runPrivileged(options: PrivilegedRunOptions): Promise<ExecResult> {
	if ((options.platform ?? process.platform) === "win32") {
		throw new Error("Privileged execution is unavailable on Windows; use an administrator process instead.");
	}
	if (!options.command) throw new Error("Privileged command is required.");

	const cwd = options.cwd ?? process.cwd();
	const scope = options.credentialScope ?? cwd;
	const broker = options.broker ?? sudoCredentialBroker;
	const prompt = options.credentialPrompt;
	const execute = options.execute ?? execCommand;
	const sudoArgs = ["-S", "-E", "-p", SUDO_PROMPT_MARKER, "--", options.command, ...(options.args ?? [])];
	const baseEnv = { ...process.env, ...options.env };
	let credential = broker.get(scope);

	for (let attempt = 0; attempt < 2; attempt++) {
		if (credential === undefined) {
			if (!prompt) throw new Error("A privileged command requires an interactive password prompt.");
			credential = await broker.request(scope, prompt, options.credentialTtlMs);
			if (credential === undefined) throw new Error("Privileged command cancelled.");
		}

		const result = await execute(SUDO_EXECUTABLE, sudoArgs, cwd, {
			...options,
			cwd,
			env: baseEnv,
			input: `${credential}\n`,
		});
		if (!isSudoAuthenticationFailure(result)) return redactExecResult(result, credential);

		broker.clear(scope);
		credential = undefined;
	}

	return {
		stdout: "",
		stderr: "sudo authentication failed",
		code: 1,
		killed: false,
	};
}

function isSudoAuthenticationFailure(result: ExecResult): boolean {
	return result.stderr.includes(SUDO_PROMPT_MARKER);
}
function redactExecResult(result: ExecResult, credential: string): ExecResult {
	return {
		...result,
		stdout: redactSecret(result.stdout, credential),
		stderr: redactSecret(result.stderr, credential),
	};
}

function redactSecret(value: string, secret: string): string {
	if (secret.length === 0 || !value.includes(secret)) return value;
	return value.split(secret).join("[REDACTED]");
}
