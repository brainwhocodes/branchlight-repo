import { describe, expect, it, vi } from "bun:test";
import { type PendingExtensionRequest, requestRpcDialog } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

describe("RPC extension UI", () => {
	it("cancels the remote dialog when its signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "High-risk command", message: "Allow this command?" },
			response => ("confirmed" in response ? response.confirmed : false),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the RPC dialog request to carry an id");
		}

		controller.abort();

		expect(await result).toBe(false);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "confirm",
			title: "High-risk command",
			message: "Allow this command?",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(pendingRequests.size).toBe(0);
	});
	it("marks sensitive input requests and resolves them without changing the frame", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ sensitive: true },
			undefined,
			{ method: "input", title: "Administrator password", placeholder: "Password", sensitive: true },
			response => ("value" in response ? response.value : undefined),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the sensitive RPC dialog request to carry an id");
		}

		pendingRequests.get(request.id)?.resolve({ type: "extension_ui_response", id: request.id, value: "secret" });

		expect(await result).toBe("secret");
		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "input",
			title: "Administrator password",
			placeholder: "Password",
			sensitive: true,
		});
		expect(pendingRequests.size).toBe(0);
	});
});
