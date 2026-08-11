import { fuzzyRank } from "@oh-my-pi/pi-tui/fuzzy";
import type { SlashCommand } from "../shared/contracts";

export function slashCommandQuery(draft: string): string | null {
	if (!draft.startsWith("/") || draft.includes("\n")) return null;
	const query = draft.slice(1);
	return /\s/.test(query) ? null : query;
}

export function searchSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
	const normalizedQuery = query.toLowerCase();
	return fuzzyRank(commands, query, commandSearchText)
		.sort((left, right) => {
			const priority = commandPriority(left.item, normalizedQuery) - commandPriority(right.item, normalizedQuery);
			return priority || left.score - right.score || left.item.name.localeCompare(right.item.name);
		})
		.map(result => result.item);
}

export function commandInsertion(command: SlashCommand): string {
	const acceptsArguments = command.input?.hint || (command.subcommands?.length ?? 0) > 0;
	return `/${command.name}${acceptsArguments ? " " : ""}`;
}

function commandSearchText(command: SlashCommand): string {
	return [
		command.name,
		...(command.aliases ?? []),
		command.description ?? "",
		...(command.subcommands?.flatMap(subcommand => [subcommand.name, subcommand.description ?? ""]) ?? []),
	].join(" ");
}

function commandPriority(command: SlashCommand, query: string): number {
	if (!query) return 0;
	const name = command.name.toLowerCase();
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;
	const aliases = command.aliases?.map(alias => alias.toLowerCase()) ?? [];
	if (aliases.includes(query)) return 2;
	if (aliases.some(alias => alias.startsWith(query))) return 3;
	return 4;
}
