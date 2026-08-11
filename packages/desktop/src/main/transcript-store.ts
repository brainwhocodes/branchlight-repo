import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { TimelineFileChange, TimelineImage, TimelineItem } from "../shared/contracts";

export class TranscriptStore {
	#items: TimelineItem[] = [];
	#toolById = new Map<string, TimelineItem>();
	#messageById = new Map<string, TimelineItem>();
	#thinkingByMessage = new Map<string, TimelineItem>();
	#sequence = 0;

	load(messages: readonly unknown[]): void {
		this.#items = [];
		this.#toolById.clear();
		this.#messageById.clear();
		this.#thinkingByMessage.clear();
		for (const message of messages) this.#appendMessage(message);
	}

	get size(): number {
		return this.#items.length;
	}
	get snapshot(): TimelineItem[] {
		return this.#items.map(item => ({ ...item }));
	}

	page(start: number, limit: number): TimelineItem[] {
		return this.#items.slice(start, start + limit);
	}

	find(id: string): TimelineItem | undefined {
		const item = this.#items.find(candidate => candidate.id === id);
		return item ? { ...item } : undefined;
	}

	apply(event: unknown): TimelineItem | undefined {
		return this.applyChanges(event).at(-1);
	}

	applyChanges(event: unknown): TimelineItem[] {
		if (typeof event !== "object" || event === null || !("type" in event)) return [this.#appendRaw(event)];
		const frame = event as Record<string, unknown>;
		const type = typeof frame.type === "string" ? frame.type : "unknown";
		if (
			(type === "message_start" || type === "message_update" || type === "message_end") &&
			frame.message !== undefined
		) {
			return this.#upsertMessage(frame.message, type === "message_end");
		}
		if (type === "tool_execution_start") {
			const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : undefined;
			const toolName = normalizeToolName(frame.toolName, frame.args);
			let item = toolCallId ? this.#toolById.get(toolCallId) : undefined;
			if (!item) {
				item = {
					id: this.#nextId(),
					kind: "tool",
					text: toolName ?? "Tool",
					toolName,
					toolCallId,
					args: frame.args,
					files: extractFileChanges(toolName, frame.args),
					status: "running",
				};
				this.#items.push(item);
				if (toolCallId) this.#toolById.set(toolCallId, item);
			} else {
				item.text = toolName ?? item.text;
				item.toolName = toolName ?? item.toolName;
				item.args = frame.args;
				item.files = extractFileChanges(item.toolName, frame.args);
				item.status = "running";
				delete item.isError;
			}
			return [{ ...item }];
		}
		if (type === "tool_execution_update") {
			const toolId = typeof frame.toolCallId === "string" ? frame.toolCallId : undefined;
			const item = toolId ? this.#toolById.get(toolId) : undefined;
			if (item) {
				const images = extractImages(frame.partialResult);
				if (images.length > 0) item.images = images;
				item.detail = formatToolDetail(item.toolName, frame.partialResult);
				item.result = frame.partialResult;
				return [{ ...item }];
			}
		}
		if (type === "tool_execution_end") {
			const toolId = typeof frame.toolCallId === "string" ? frame.toolCallId : undefined;
			const item = toolId ? this.#toolById.get(toolId) : undefined;
			if (item) {
				item.status = frame.isError === true ? "error" : "complete";
				item.isError = frame.isError === true;
				item.result = frame.result;
				const images = extractImages(frame.result);
				if (images.length > 0) item.images = images;
				item.detail = formatToolDetail(item.toolName, frame.result);
				return [{ ...item }];
			}
		}
		if (type === "command_output" && typeof frame.text === "string") {
			const item: TimelineItem = {
				id: this.#nextId(),
				kind: "notice",
				text: frame.text,
				status: "complete",
			};
			this.#items.push(item);
			return [item];
		}
		if (type === "notice") {
			const item: TimelineItem = {
				id: this.#nextId(),
				kind: "notice",
				text: typeof frame.message === "string" ? frame.message : "Notice",
				status: frame.level === "error" ? "error" : "complete",
			};
			this.#items.push(item);
			return [item];
		}
		if (
			type === "thinking_level_changed" ||
			type === "model_changed" ||
			type === "auto_compaction_start" ||
			type === "auto_compaction_end" ||
			type === "retry_fallback_applied" ||
			type === "retry_fallback_succeeded"
		) {
			const item: TimelineItem = { id: this.#nextId(), kind: "marker", text: markerText(type, frame) };
			this.#items.push(item);
			return [item];
		}
		if (type === "todo_reminder" || type === "todo_auto_clear") {
			const item: TimelineItem = {
				id: this.#nextId(),
				kind: "todo",
				text: type === "todo_auto_clear" ? "Todos cleared" : "Todo progress updated",
				detail: formatValue(frame.todos),
			};
			this.#items.push(item);
			return [item];
		}
		if (
			type === "agent_start" ||
			type === "agent_end" ||
			type === "turn_start" ||
			type === "turn_end" ||
			type === "prompt_result"
		)
			return [];
		return [this.#appendRaw(event)];
	}

	#appendMessage(value: unknown): TimelineItem | undefined {
		if (typeof value !== "object" || value === null) return undefined;
		const message = value as Record<string, unknown>;
		if (message.role === "toolResult") {
			const toolId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
			const item = toolId ? this.#toolById.get(toolId) : undefined;
			if (item) {
				item.status = message.isError === true ? "error" : "complete";
				item.isError = message.isError === true;
				item.result = message;
				const images = extractImages(message);
				if (images.length > 0) item.images = images;
				item.detail = formatToolDetail(item.toolName, message.content);
			}
			return item;
		}
		return this.#upsertMessage(value, true).at(-1);
	}

	#upsertMessage(value: unknown, complete: boolean): TimelineItem[] {
		if (typeof value !== "object" || value === null) return [];
		const message = value as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "unknown";
		if (role === "toolResult") {
			const result = this.#appendMessage(value);
			return result ? [{ ...result }] : [];
		}
		const key =
			typeof message.id === "string" ? message.id : `${role}:${String(message.timestamp ?? this.#sequence)}`;
		const text = extractText(message.content);
		const content = Array.isArray(message.content) ? message.content : [];
		const thinkingParts: string[] = [];
		const toolCalls: Record<string, unknown>[] = [];
		for (const block of content) {
			if (!isRecord(block)) continue;
			if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
				thinkingParts.push(block.thinking);
			}
			if (block.type === "toolCall" && typeof block.id === "string") toolCalls.push(block);
		}

		const changes: TimelineItem[] = [];
		const thinkingText = thinkingParts.join("\n\n");
		let thinking = this.#thinkingByMessage.get(key);
		if (thinkingText.length > 0) {
			if (!thinking) {
				thinking = {
					id: this.#nextId(),
					kind: "thinking",
					text: thinkingText,
					status: complete ? "complete" : "running",
				};
				this.#items.push(thinking);
				this.#thinkingByMessage.set(key, thinking);
			} else {
				thinking.text = thinkingText;
				thinking.status = complete ? "complete" : "running";
			}
			changes.push({ ...thinking });
		} else if (complete && thinking) {
			thinking.status = "complete";
			changes.push({ ...thinking });
		}

		let item = this.#messageById.get(key);
		if (!item && (role !== "assistant" || text.length > 0)) {
			item = {
				id: this.#nextId(),
				kind: role === "user" ? "user" : role === "assistant" ? "assistant" : "raw",
				text,
				timestamp: typeof message.timestamp === "string" ? message.timestamp : undefined,
			};
			this.#items.push(item);
			this.#messageById.set(key, item);
		} else if (item) {
			item.text = text;
		}
		if (item) changes.push({ ...item });

		for (const candidate of toolCalls) {
			const toolCallId = candidate.id as string;
			const toolName = normalizeToolName(candidate.name, candidate.arguments);
			let tool = this.#toolById.get(toolCallId);
			if (!tool) {
				tool = {
					id: this.#nextId(),
					kind: "tool",
					text: toolName ?? "Tool",
					toolName,
					toolCallId,
					args: candidate.arguments,
					files: extractFileChanges(toolName, candidate.arguments),
					status: "running",
				};
				this.#items.push(tool);
				this.#toolById.set(toolCallId, tool);
			} else {
				tool.text = toolName ?? tool.text;
				tool.toolName = toolName ?? tool.toolName;
				tool.args = candidate.arguments;
				tool.files = extractFileChanges(tool.toolName, candidate.arguments);
			}
			changes.push({ ...tool });
		}
		return changes;
	}

	#appendRaw(value: unknown): TimelineItem {
		const item: TimelineItem = {
			id: this.#nextId(),
			kind: "raw",
			text: "Unrecognized event",
			detail: formatValue(value),
		};
		this.#items.push(item);
		return item;
	}

	#nextId(): string {
		this.#sequence += 1;
		return `timeline-${this.#sequence}`;
	}
}

function extractText(value: unknown): string {
	const record = isRecord(value) ? value : undefined;
	const blocks = Array.isArray(value) ? value : record && "content" in record ? record.content : undefined;
	if (!Array.isArray(blocks)) return typeof value === "string" ? value : "";
	return blocks
		.map(block => {
			if (!isRecord(block)) return "";
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}
function normalizeToolName(value: unknown, args: unknown): string | undefined {
	const name = typeof value === "string" ? value : undefined;
	if (name !== "write" || !isRecord(args) || args.path !== "xd://generate_image") return name;
	return "generate_image";
}
function extractFileChanges(toolName: string | undefined, args: unknown): TimelineFileChange[] | undefined {
	if (!isRecord(args)) return undefined;
	if (toolName === "write") {
		const target = workspacePath(args.path);
		return target ? [{ path: target, operation: "write" }] : undefined;
	}
	if (toolName !== "edit" || typeof args.input !== "string") return undefined;

	const files: TimelineFileChange[] = [];
	const seen = new Set<string>();
	for (const match of args.input.matchAll(/^\[([^#\r\n]+)#[0-9A-F]{4}\]$/gim)) {
		const target = workspacePath(match[1]);
		if (!target || seen.has(target)) continue;
		seen.add(target);
		files.push({ path: target, operation: "edit" });
	}
	return files.length > 0 ? files : undefined;
}

function workspacePath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const target = value.trim();
	if (!target || /^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return undefined;
	return target;
}
function formatToolDetail(toolName: string | undefined, value: unknown): string {
	if (toolName === "generate_image") return extractText(value) || formatValue(value);
	return formatValue(value);
}

function extractImages(value: unknown): TimelineImage[] {
	const seenImages = new Set<string>();
	const visited = new Set<object>();
	const images: TimelineImage[] = [];

	const visit = (candidate: unknown): void => {
		if (isInlineImage(candidate)) {
			const key = `${candidate.mimeType}:${candidate.data}`;
			if (!seenImages.has(key)) {
				seenImages.add(key);
				images.push({ data: candidate.data, mimeType: candidate.mimeType });
			}
			return;
		}
		if (typeof candidate !== "object" || candidate === null || visited.has(candidate)) return;
		visited.add(candidate);
		if (Array.isArray(candidate)) {
			for (const nested of candidate) visit(nested);
			return;
		}
		const record = candidate as Record<string, unknown>;
		visit(record.content);
		visit(record.details);
		visit(record.images);
		visit(record.rawContent);
		visit(record.xdev);
		visit(record.inner);
	};

	visit(value);
	return images;
}

function isInlineImage(value: unknown): value is TimelineImage {
	if (!isRecord(value)) return false;
	return (
		typeof value.data === "string" &&
		typeof value.mimeType === "string" &&
		value.mimeType.startsWith("image/") &&
		value.data.length > 0
	);
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return (
			JSON.stringify(
				value,
				(_key, nestedValue) =>
					isInlineImage(nestedValue) ? { ...nestedValue, data: "[inline image omitted]" } : nestedValue,
				2,
			) ?? ""
		);
	} catch {
		return "[unserializable]";
	}
}

function markerText(type: string, frame: Record<string, unknown>): string {
	if (type === "thinking_level_changed") return `Thinking level → ${String(frame.thinkingLevel ?? "off")}`;
	if (type === "model_changed") return "Model changed";
	if (type === "auto_compaction_start") return "Context compaction started";
	if (type === "auto_compaction_end")
		return frame.aborted === true ? "Context compaction aborted" : "Context compaction complete";
	if (type === "retry_fallback_applied")
		return `Retry fallback: ${String(frame.from ?? "model")} → ${String(frame.to ?? "fallback")}`;
	return "Retry fallback succeeded";
}
