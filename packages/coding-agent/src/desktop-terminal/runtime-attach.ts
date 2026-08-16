import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { postmortem } from "@oh-my-pi/pi-utils";
import type { WorkspaceCommandV1 } from "@oh-my-pi/pi-wire";
import { WorkspaceClient } from "@oh-my-pi/pi-workspace-runtime/client";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../extensibility/extensions/types";

export function createBranchlightLifecycleExtension(): ExtensionFactory | undefined {
	const runtimeRoot = process.env.PI_RUNTIME_DIR;
	const token = process.env.PI_RUNTIME_TOKEN;
	const terminalId = process.env.BRANCHLIGHT_TERMINAL_ID;
	if (process.env.BRANCHLIGHT_TERMINAL !== "1" || !runtimeRoot || !token || !terminalId) return undefined;

	const paneId = process.env.BRANCHLIGHT_PANE_ID;
	const profileId = process.env.BRANCHLIGHT_PROFILE_ID ?? "profile-omp";
	const workspaceIdFromEnvironment = process.env.BRANCHLIGHT_WORKSPACE_ID;
	let client: WorkspaceClient | undefined;
	let attachedAgentId: string | undefined;
	let attachedSessionId: string | undefined;
	let unsubscribeClientEvents: (() => void) | undefined;
	let unregisterPostmortem: (() => void) | undefined;
	const getClient = async (): Promise<WorkspaceClient> => {
		if (!client) client = new WorkspaceClient({ runtimeRoot, token });
		if (!client.isConnected) await client.connect();
		return client;
	};

	const detach = async (
		closeClient: boolean,
		reason = closeClient ? "session-shutdown" : "session-switch",
	): Promise<void> => {
		const currentClient = client;
		const agentId = attachedAgentId;
		const sessionId = attachedSessionId;
		attachedAgentId = undefined;
		attachedSessionId = undefined;
		try {
			if (currentClient?.isConnected && agentId && sessionId) {
				const workspaceId = workspaceIdFromEnvironment ?? currentClient.document?.activeWorkspaceId;
				if (workspaceId) {
					const command: WorkspaceCommandV1 = {
						version: 1,
						commandId: `cmd-detach-${crypto.randomUUID()}`,
						workspaceId,
						expectedRevision: currentClient.document?.revision ?? 0,
						issuedAt: Date.now(),
						type: "agent.detach",
						payload: { id: agentId, reason },
					};
					await currentClient.executeCommandWithRetry(() => command).catch(() => {});
				}
			}
		} finally {
			if (unsubscribeClientEvents) {
				unsubscribeClientEvents();
				unsubscribeClientEvents = undefined;
			}
			if (closeClient) {
				if (unregisterPostmortem) {
					unregisterPostmortem();
					unregisterPostmortem = undefined;
				}
				await currentClient?.close().catch(() => {});
				client = undefined;
			}
		}
	};

	const attach = async (api: ExtensionAPI, context: ExtensionContext): Promise<void> => {
		const currentClient = await getClient();
		const sessionId = context.sessionManager.getSessionId();
		const agentId = `branchlight-agent-${profileId}-${sessionId}`;
		if (attachedAgentId === agentId && attachedSessionId === sessionId) return;
		if (attachedAgentId) await detach(false);
		const workspaceId = workspaceIdFromEnvironment ?? currentClient.document?.activeWorkspaceId;
		if (!workspaceId) throw new Error("Branchlight workspace runtime has no active workspace");
		const command: WorkspaceCommandV1 = {
			version: 1,
			commandId: `cmd-attach-${crypto.randomUUID()}`,
			workspaceId,
			expectedRevision: currentClient.document?.revision ?? 0,
			issuedAt: Date.now(),
			type: "agent.attach",
			payload: {
				id: agentId,
				profileId,
				sessionId,
				terminalId,
				...(paneId ? { paneId } : {}),
			},
		};
		const result = await currentClient.executeCommandWithRetry(() => command);
		if (result.status === "rejected") {
			throw new Error(`Failed to attach agent to workspace runtime: ${result.error?.message ?? "rejected"}`);
		}
		attachedAgentId = agentId;
		attachedSessionId = sessionId;
		if (unsubscribeClientEvents) {
			unsubscribeClientEvents();
			unsubscribeClientEvents = undefined;
		}

		unsubscribeClientEvents = currentClient.onEvent(event => {
			if (event.type === "session.event" || event.type === "element.edit") {
				const payload = event.payload as Record<string, unknown>;
				if (payload.id !== attachedAgentId && payload.agentId !== attachedAgentId) return;

				const selector = typeof payload.selector === "string" ? payload.selector : "";
				const url = typeof payload.url === "string" ? payload.url : "";
				let dom = "";
				if (typeof payload.domSnapshot === "string") {
					dom = payload.domSnapshot;
				} else if (payload.domSnapshot && typeof payload.domSnapshot === "object") {
					const snap = payload.domSnapshot as { html?: string; summary?: string };
					dom = snap.html || snap.summary || JSON.stringify(payload.domSnapshot).slice(0, 4000);
				} else if (typeof payload.selectedElement === "string") {
					dom = payload.selectedElement;
				}
				const screenshot = payload.screenshot as
					| { base64?: string; mimeType?: string; dataUrl?: string }
					| undefined;

				const parts: (TextContent | ImageContent)[] = [];
				if (screenshot?.base64) {
					parts.push({
						type: "image",
						data: screenshot.base64,
						mimeType: (screenshot.mimeType as "image/jpeg" | "image/png") || "image/jpeg",
					});
				}

				let text =
					typeof payload.message === "string" && payload.message.trim().length > 0
						? payload.message
						: `Targeted browser element: \`${selector}\``;
				if (url && !text.includes(url)) text += `\nPage URL: ${url}`;
				if (dom && !text.includes(dom))
					text += `\n\nElement DOM snippet:\n\`\`\`html\n${dom.slice(0, 4000)}\n\`\`\``;

				parts.push({ type: "text", text });

				try {
					api.sendUserMessage(parts);
				} catch (err) {
					api.logger.error("Failed to send element selection to agent", { error: String(err) });
				}
			}
		});
	};

	const reportFailure = (api: ExtensionAPI, context: ExtensionContext, error: unknown): void => {
		const message = error instanceof Error ? error.message : String(error);
		api.logger.error(`Branchlight runtime attachment failed: ${message}`);
		if (context.hasUI) context.ui.notify(`Branchlight attachment failed: ${message}`, "error");
	};

	return api => {
		api.on("session_start", async (_event, context) => {
			try {
				await attach(api, context);
			} catch (error) {
				reportFailure(api, context, error);
			}
		});
		api.on("session_switch", async (_event, context) => {
			try {
				await detach(false);
				await attach(api, context);
			} catch (error) {
				reportFailure(api, context, error);
			}
		});
		api.on("session_shutdown", async () => {
			await detach(true);
		});
		unregisterPostmortem = postmortem.register("branchlight-agent-detach", () => detach(true));
	};
}
