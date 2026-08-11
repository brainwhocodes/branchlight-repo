import type { SessionKind, TimelineItem } from "./contracts";

export function projectTimeline(kind: SessionKind, items: readonly TimelineItem[]): TimelineItem[] {
	if (kind === "code") return [...items];
	return items.map(item =>
		item.kind === "tool" ? { ...item, args: undefined, result: undefined, detail: undefined } : item,
	);
}

export function workOutputItems(items: readonly TimelineItem[]): TimelineItem[] {
	return items.filter(item => {
		if (
			item.status !== "complete" ||
			item.isError === true ||
			(item.toolName !== "write" && item.toolName !== "edit")
		)
			return false;
		return Boolean(readPath(item.args));
	});
}

export function outputPath(item: TimelineItem): string | undefined {
	return readPath(item.args);
}

function readPath(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("path" in value)) return undefined;
	const candidate = value as { path?: unknown };
	return typeof candidate.path === "string" && candidate.path.length > 0 ? candidate.path : undefined;
}
