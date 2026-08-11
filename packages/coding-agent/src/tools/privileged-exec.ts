import { type } from "@oh-my-pi/omptype";
import { runPrivileged } from "../exec/privileged-runner";
import type { CustomTool, CustomToolFactory } from "../extensibility/custom-tools/types";
import description from "../prompts/tools/privileged-exec.md" with { type: "text" };

const privilegedExecSchema = type({
	command: "string",
	"args?": "string[]",
	"cwd?": "string",
	"env?": "Record<string, string>",
	"credential_scope?": "string",
});

type PrivilegedExecParams = typeof privilegedExecSchema.infer;

interface PrivilegedExecDetails {
	command: string;
	cwd: string;
	code: number;
	killed: boolean;
}

export const createPrivilegedExecTool: CustomToolFactory = pi => {
	const tool: CustomTool<typeof privilegedExecSchema, PrivilegedExecDetails> = {
		name: "privileged_exec",
		label: "Privileged execution",
		strict: false,
		approval: "exec",
		description,
		parameters: privilegedExecSchema,
		formatApprovalDetails: args => {
			const params = args as Partial<PrivilegedExecParams>;
			const command = [params.command, ...(params.args ?? [])].filter(Boolean).join(" ");
			return `command: ${command}\ncwd: ${params.cwd ?? pi.cwd}`;
		},
		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			if (!pi.hasUI) {
				return {
					content: [{ type: "text", text: "Privileged execution requires an interactive password prompt." }],
					isError: true,
				};
			}

			try {
				const cwd = params.cwd ?? pi.cwd;
				const result = await runPrivileged({
					command: params.command,
					args: params.args,
					cwd,
					env: params.env,
					credentialScope: params.credential_scope ?? cwd,
					credentialPrompt: scope =>
						pi.ui.input("Administrator password", `Credential scope: ${scope}`, { sensitive: true }),
					signal,
				});
				const output = [result.stdout, result.stderr]
					.filter(Boolean)
					.join(result.stdout && result.stderr ? "\n" : "");
				return {
					content: [{ type: "text", text: output || `Command exited with code ${result.code}.` }],
					details: {
						command: [params.command, ...(params.args ?? [])].join(" "),
						cwd,
						code: result.code,
						killed: result.killed,
					},
					isError: result.code !== 0,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : "Privileged command failed." }],
					isError: true,
				};
			}
		},
	};

	return tool;
};
