import { describe, expect, it } from "vitest";
import { commandInsertion, searchSlashCommands, slashCommandQuery } from "../src/renderer/command-search";
import type { SlashCommand } from "../src/shared/contracts";

const commands: SlashCommand[] = [
	{ name: "status", aliases: ["usage"], description: "Show session usage", source: "builtin" },
	{ name: "compact", description: "Compact the current context", input: { hint: "instructions" }, source: "builtin" },
	{ name: "copy", description: "Copy the last response", source: "builtin" },
];

describe("slash command search", () => {
	it("opens only for a command token and fuzzy-matches non-prefix input", () => {
		expect(slashCommandQuery("/cmp")).toBe("cmp");
		expect(slashCommandQuery("/compact now")).toBeNull();
		expect(slashCommandQuery("hello /compact")).toBeNull();
		expect(searchSlashCommands(commands, "cmp").map(command => command.name)).toEqual(["compact"]);
	});

	it("prioritizes exact aliases and preserves argument entry", () => {
		expect(searchSlashCommands(commands, "usage")[0]?.name).toBe("status");
		expect(commandInsertion(commands[0])).toBe("/status");
		expect(commandInsertion(commands[1])).toBe("/compact ");
	});
});
