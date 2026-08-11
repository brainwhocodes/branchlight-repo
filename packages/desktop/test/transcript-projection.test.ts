import { describe, expect, it } from "vitest";
import { TranscriptStore } from "../src/main/transcript-store";
import type { TimelineItem } from "../src/shared/contracts";
import { outputPath, projectTimeline, workOutputItems } from "../src/shared/projection";

describe("TranscriptStore", () => {
	it("pairs tool results with streamed tool calls and preserves unknown events", () => {
		const store = new TranscriptStore();
		store.load([
			{
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.md" } }],
			},
		]);
		store.apply({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: "partial" });
		store.apply({ type: "tool_execution_end", toolCallId: "tool-1", result: "complete", isError: false });
		store.apply({ type: "future_event", payload: { stable: true } });

		const items = store.snapshot;
		const tool = items.find(item => item.toolCallId === "tool-1");
		expect(tool).toMatchObject({ toolName: "read", status: "complete", detail: "complete" });
		expect(items.at(-1)).toMatchObject({ kind: "raw", detail: expect.stringContaining("future_event") });
	});
	it("keeps image progress readable and surfaces generated images without duplicating base64 in details", () => {
		const store = new TranscriptStore();
		const image = { data: "aGVsbG8=", mimeType: "image/png" };
		store.apply({ type: "tool_execution_start", toolCallId: "image-1", toolName: "generate_image", args: {} });
		const progress = store.apply({
			type: "tool_execution_update",
			toolCallId: "image-1",
			partialResult: { details: { images: [image] } },
		});
		expect(progress).toMatchObject({
			status: "running",
			images: [image],
			detail: expect.stringContaining("[inline image omitted]"),
		});
		expect(progress?.detail).not.toContain(image.data);

		const complete = store.apply({
			type: "tool_execution_end",
			toolCallId: "image-1",
			result: { content: [{ type: "text", text: "Generated image." }], details: { images: [image] } },
			isError: false,
		});
		expect(complete).toMatchObject({ status: "complete", images: [image], detail: "Generated image." });
	});
	it("projects successful native xdev image results as image generation", () => {
		const store = new TranscriptStore();
		const image = { data: "PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml", type: "image" };
		store.apply({
			type: "tool_execution_start",
			toolCallId: "xdev-image",
			toolName: "write",
			args: { path: "xd://generate_image" },
		});

		const complete = store.apply({
			type: "tool_execution_end",
			toolCallId: "xdev-image",
			result: {
				content: [{ type: "text", text: "[Image: image/svg+xml]" }],
				details: { xdev: { inner: { rawContent: [image] } } },
			},
			isError: false,
		});

		expect(complete).toMatchObject({
			status: "complete",
			isError: false,
			toolName: "generate_image",
			images: [{ data: image.data, mimeType: image.mimeType }],
		});
		expect(complete?.detail).not.toContain(image.data);
	});

	it("streams one stable reasoning item before the assistant answer", () => {
		const store = new TranscriptStore();
		expect(
			store.applyChanges({
				type: "message_start",
				message: { id: "reasoned-message", role: "assistant", content: [] },
			}),
		).toEqual([]);

		const first = store.applyChanges({
			type: "message_update",
			message: {
				id: "reasoned-message",
				role: "assistant",
				content: [{ type: "thinking", thinking: "Inspecting the failure." }],
			},
		});
		const second = store.applyChanges({
			type: "message_update",
			message: {
				id: "reasoned-message",
				role: "assistant",
				content: [{ type: "thinking", thinking: "Inspecting the failure.\nTracing the event." }],
			},
		});
		const complete = store.applyChanges({
			type: "message_end",
			message: {
				id: "reasoned-message",
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Inspecting the failure.\nTracing the event." },
					{ type: "text", text: "The event is now projected." },
				],
			},
		});

		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ kind: "thinking", status: "running", text: "Inspecting the failure." });
		expect(second[0]?.id).toBe(first[0]?.id);
		expect(complete).toEqual([
			expect.objectContaining({ id: first[0]?.id, kind: "thinking", status: "complete" }),
			expect.objectContaining({ kind: "assistant", text: "The event is now projected." }),
		]);
		expect(store.snapshot.map(item => item.kind)).toEqual(["thinking", "assistant"]);
	});
	it("surfaces slash command output as a completed notice", () => {
		const store = new TranscriptStore();
		const item = store.apply({ type: "command_output", text: "Fixture status: ready" });

		expect(item).toMatchObject({ kind: "notice", status: "complete", text: "Fixture status: ready" });
		expect(store.snapshot).toContainEqual(item);
	});

	it("updates message text without duplicating the message item", () => {
		const store = new TranscriptStore();
		store.apply({ type: "message_start", message: { id: "m-1", role: "assistant", content: "one" } });
		store.apply({ type: "message_update", message: { id: "m-1", role: "assistant", content: "two" } });
		expect(store.snapshot.filter(item => item.kind === "assistant")).toHaveLength(1);
		expect(store.snapshot.find(item => item.kind === "assistant")?.text).toBe("two");
	});
});

describe("audience projections", () => {
	const items: TimelineItem[] = [
		{
			id: "write-ok",
			kind: "tool",
			text: "write",
			toolName: "write",
			args: { path: "result.txt" },
			status: "complete",
		},
		{
			id: "edit-error",
			kind: "tool",
			text: "edit",
			toolName: "edit",
			args: { path: "bad.txt" },
			status: "error",
			isError: true,
		},
		{
			id: "bash",
			kind: "tool",
			text: "bash",
			toolName: "bash",
			args: { path: "not-an-artifact" },
			status: "complete",
		},
	];

	it("only exposes successful explicit write/edit outputs in Work", () => {
		const outputs = workOutputItems(items);
		expect(outputs.map(outputPath)).toEqual(["result.txt"]);
	});

	it("removes tool payloads from Work projection but keeps Code details", () => {
		expect(projectTimeline("work", items)[0]).toMatchObject({ id: "write-ok", args: undefined, result: undefined });
		expect(projectTimeline("code", items)[0].args).toEqual({ path: "result.txt" });
	});
});
