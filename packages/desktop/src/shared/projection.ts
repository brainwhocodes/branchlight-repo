import type { SessionKind, TimelineFileChange, TimelineItem } from "./contracts";

export function projectTimeline(kind: SessionKind, items: readonly TimelineItem[]): TimelineItem[] {
	if (kind === "code") return [...items];
	return items.map(item => {
		if (item.kind !== "tool") return item;
		return {
			...item,
			args: undefined,
			result: undefined,
			detail: item.toolName === "generate_image" ? item.detail : undefined,
		};
	});
}

export function changedFiles(items: readonly TimelineItem[]): TimelineFileChange[] {
	const latestByPath = new Map<string, TimelineFileChange>();
	for (const item of items) {
		if (item.status !== "complete" || item.isError === true || !item.files) continue;
		for (const file of item.files) {
			latestByPath.delete(file.path);
			latestByPath.set(file.path, file);
		}
	}
	return Array.from(latestByPath.values()).reverse();
}
