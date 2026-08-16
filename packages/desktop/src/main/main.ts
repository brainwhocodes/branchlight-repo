import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { WorkspaceCommandV1, WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { ensureWorkspaceRuntime, type WorkspaceRuntimeDescriptor } from "@oh-my-pi/pi-workspace-runtime/bootstrap";
import type { WorkspaceClient } from "@oh-my-pi/pi-workspace-runtime/client";
import { app, BrowserWindow, ipcMain, net, protocol, session } from "electron";
import { AppSettingsStore } from "./app-settings";
import { defaultWorkspacePath, ompExecutablePath, runtimeRootDir } from "./backend-path";
import { DesktopHost } from "./desktop-host";
import { safeExternalUrl } from "./guards";
import { shutdownDesktopServices } from "./shutdown";
import { WorkspaceHost } from "./workspace-host";

const DEV_SERVER =
	typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string" ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL) : undefined;
const CONTENT_SECURITY_POLICY =
	"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
let mainWindow: BrowserWindow | undefined;
let host: DesktopHost | undefined;
let appSettingsStore: AppSettingsStore | undefined;
let quitting = false;
let workspace: WorkspaceHost | undefined;
let runtimeDescriptor: WorkspaceRuntimeDescriptor | undefined;
let runtimeClient: WorkspaceClient | undefined;

const DEFAULT_WORKSPACE_ID = "workspace-default";
const DEFAULT_LOCATION_ID = "location-default";

async function executeBootstrapCommand(
	client: WorkspaceClient,
	command: WorkspaceCommandV1,
): Promise<WorkspaceDocumentV1> {
	const result = await client.executeCommandWithRetry(() => command);
	if (result.status === "accepted" || result.status === "duplicate") return result.document;
	throw new Error(`Workspace bootstrap command ${command.type} failed: ${result.error?.message ?? result.status}`);
}

async function ensureDefaultWorkspace(client: WorkspaceClient): Promise<void> {
	let document = client.document ?? (await client.getDocument());
	if (document.workspaces.length === 0) {
		document = await executeBootstrapCommand(client, {
			version: 1,
			commandId: "workspace-bootstrap-default",
			workspaceId: DEFAULT_WORKSPACE_ID,
			expectedRevision: document.revision,
			issuedAt: 1,
			type: "workspace.create",
			payload: {
				locationId: DEFAULT_LOCATION_ID,
				locationName: "Local",
				address: { kind: "local", path: defaultWorkspacePath() },
				name: "Workspace",
			},
		});
	}

	const workspaceId = document.workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID;
	const defaultProfiles = [
		{ id: "profile-omp", name: "Oh My Pi", protocol: "omp" as const, config: {}, capabilityIds: [] },
		{ id: "profile-codex", name: "Codex", protocol: "acp" as const, config: {}, capabilityIds: [] },
		{ id: "profile-claude", name: "Claude Code", protocol: "terminal" as const, config: {}, capabilityIds: [] },
	];

	for (const profile of defaultProfiles) {
		if (document.agentProfiles.some(item => item.id === profile.id)) continue;
		document = await executeBootstrapCommand(client, {
			version: 1,
			commandId: `profile-bootstrap-${profile.id}`,
			workspaceId,
			expectedRevision: document.revision,
			issuedAt: 1,
			type: "profile.create",
			payload: {
				id: profile.id,
				name: profile.name,
				protocol: profile.protocol,
				config: profile.config,
				capabilityIds: profile.capabilityIds,
			},
		});
	}
}

app.name = "Mars Kommander";
app.setName("Mars Kommander");
app.setAppUserModelId("labs.mars-kommander.desktop");
app.commandLine.appendSwitch("remote-debugging-port", "9222");
protocol.registerSchemesAsPrivileged([
	{ scheme: "branchlight", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	});
	void app
		.whenReady()
		.then(async () => {
			if (process.platform === "darwin" && app.dock && typeof app.dock.setIcon === "function") {
				const iconCandidates = [
					path.join(__dirname, "..", "..", "resources", "icon.png"),
					path.join(__dirname, "..", "..", "resources", "icon.icns"),
				];
				for (const cand of iconCandidates) {
					if (existsSync(cand)) {
						try {
							app.dock.setIcon(cand);
							break;
						} catch {}
					}
				}
			}
			registerProtocol();
			configureSecurity();
			appSettingsStore = new AppSettingsStore(app.getPath("userData"), defaultWorkspacePath());
			await appSettingsStore.load();
			host = new DesktopHost(app.getPath("userData"));
			await host.load();
			const runtimeRoot = runtimeRootDir();
			try {
				runtimeDescriptor = await ensureWorkspaceRuntime({
					runtimeDir: runtimeRoot,
					executablePath: ompExecutablePath(),
				});
			} catch (error) {
				logger.error("Branchlight runtime startup failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				app.quit();
				return;
			}
			runtimeClient = runtimeDescriptor.client;

			let doc: WorkspaceDocumentV1;
			try {
				const initialDocument = runtimeClient.document ?? (await runtimeClient.getDocument());
				await ensureDefaultWorkspace(runtimeClient);
				doc = runtimeClient.document ?? initialDocument;
			} catch (error) {
				logger.error("Could not initialize workspace authority", { error: String(error) });
				app.quit();
				return;
			}

			mainWindow = createWindow();
			mainWindow.on("closed", () => {
				host?.setWindow(undefined);
				mainWindow = undefined;
			});
			host.setWindow(mainWindow);
			workspace = new WorkspaceHost(mainWindow, appSettingsStore);

			let runtimeGeneration = 0;
			let reconnecting = false;

			async function reconnectRuntime(): Promise<void> {
				if (reconnecting || quitting) return;
				reconnecting = true;
				if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
					mainWindow.webContents.send("branchlight:workspace", {
						type: "connection-state",
						state: "reconnecting",
					});
				}

				let attempts = 0;
				const maxAttempts = 10;
				while (!quitting && attempts < maxAttempts) {
					attempts++;
					const delay = Math.min(500 * 1.5 ** (attempts - 1), 5000);
					await new Promise(r => setTimeout(r, delay));
					if (quitting) break;
					try {
						const nextDescriptor = await ensureWorkspaceRuntime({
							runtimeDir: runtimeRoot,
							executablePath: ompExecutablePath(),
						});
						const nextClient = nextDescriptor.client;
						await nextClient.getDocument();
						runtimeDescriptor = nextDescriptor;
						runtimeClient = nextClient;
						await bindRuntimeClient(nextClient);
						if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
							mainWindow.webContents.send("branchlight:workspace", {
								type: "connection-state",
								state: "connected",
							});
						}
						reconnecting = false;
						return;
					} catch (error) {
						logger.warn("Runtime reconnect attempt failed", { attempt: attempts, error: String(error) });
					}
				}
				reconnecting = false;
			}

			function bindRuntimeClient(client: WorkspaceClient): Promise<void> {
				const generation = ++runtimeGeneration;
				if (client.principal && client.document) {
					host?.setWorkspaceAuthority(client.principal, client.document);
				}
				if (workspace) {
					void workspace.replaceClient(client);
				}

				client.onDocument(d => {
					if (generation !== runtimeGeneration) return;
					if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
					if (client.principal) {
						host?.setWorkspaceAuthority(client.principal, d);
						workspace?.syncWithDocument(d);
					}
					mainWindow.webContents.send("branchlight:workspace-document", d);
				});

				client.onConnectionState(state => {
					if (generation !== runtimeGeneration) return;
					if (!state.connected && state.unexpected) {
						void reconnectRuntime();
					}
				});

				return Promise.resolve();
			}

			await bindRuntimeClient(runtimeClient);
			registerIpc(host, workspace, appSettingsStore);
			if (host.bootstrap().warning) {
				mainWindow.webContents.once("did-finish-load", () => {
					if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
						mainWindow.webContents.send("branchlight:event", {
							sessionId: "",
							type: "warning",
							message: host?.bootstrap().warning,
						});
					}
				});
			}
			await loadRenderer(mainWindow);
		})
		.catch(error => {
			console.error("STARTUP ERROR:", error);
			logger.error("Branchlight startup failed", { error: error instanceof Error ? error.message : String(error) });
			app.quit();
		});
	app.on("before-quit", event => {
		if (quitting || (!host && !workspace)) return;
		event.preventDefault();
		quitting = true;
		void shutdownDesktopServices({
			host,
			workspace,
			runtimeClient,
			quit: () => app.quit(),
		});
	});
	app.on("window-all-closed", () => {
		app.quit();
	});
}

function createWindow(): BrowserWindow {
	const iconCandidate = path.join(__dirname, "..", "..", "resources", "icon.png");
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 640,
		title: "Mars Kommander",
		frame: false,
		backgroundColor: "#242321",
		...(existsSync(iconCandidate) ? { icon: iconCandidate } : {}),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webviewTag: false,
			webSecurity: true,
		},
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event, url) => {
		if (DEV_SERVER && url.startsWith(DEV_SERVER.origin)) return;
		if (url.startsWith("branchlight://")) return;
		event.preventDefault();
	});
	window.webContents.on("will-attach-webview", event => event.preventDefault());
	return window;
}

function configureSecurity(): void {
	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	session.defaultSession.setPermissionCheckHandler(() => false);
}

function registerProtocol(): void {
	protocol.handle("branchlight", async request => {
		if (DEV_SERVER) return net.fetch(new URL("index.html", DEV_SERVER).toString());
		const root = path.resolve(__dirname, "..", "renderer", "main_window");
		const url = new URL(request.url);
		let relative: string;
		try {
			relative = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
		} catch {
			return new Response("Bad path", { status: 400 });
		}
		if (relative.length === 0) relative = "index.html";
		const candidate = path.resolve(root, relative === "index.html" ? "src/renderer/index.html" : relative);
		const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
		const candidateKey = process.platform === "win32" ? candidate.toLowerCase() : candidate;
		if (candidateKey !== rootKey && !candidateKey.startsWith(`${rootKey}${path.sep}`))
			return new Response("Forbidden", { status: 403 });
		try {
			await fs.access(candidate);
			const response = await net.fetch(pathToFileURL(candidate).toString());
			const headers = new Headers(response.headers);
			headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
			return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
		} catch {
			return new Response("Not found", { status: 404 });
		}
	});
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
	if (DEV_SERVER) await window.loadURL(new URL("src/renderer/index.html", DEV_SERVER).toString());
	else await window.loadURL("branchlight://app/index.html");
}

function registerIpc(desktopHost: DesktopHost, workspaceHost: WorkspaceHost, settingsStore?: AppSettingsStore): void {
	ipcMain.handle("branchlight:bootstrap", event => {
		assertTrustedSender(event);
		return desktopHost.bootstrap();
	});
	ipcMain.handle("branchlight:auth-status", event => {
		assertTrustedSender(event);
		return desktopHost.getAuthStatus();
	});
	ipcMain.handle("branchlight:oauth-accounts", event => {
		assertTrustedSender(event);
		return desktopHost.getOAuthAccounts();
	});
	ipcMain.handle("branchlight:set-oauth-account-lock", (event, providerId: unknown, credentialId: unknown) => {
		assertTrustedSender(event);
		return desktopHost.setOAuthAccountLock(providerId, credentialId);
	});
	ipcMain.handle("branchlight:set-oauth-account-failover", (event, enabled: unknown) => {
		assertTrustedSender(event);
		return desktopHost.setOAuthAccountFailover(enabled);
	});
	ipcMain.handle("branchlight:remove-oauth-account", (event, providerId: unknown, credentialId: unknown) => {
		assertTrustedSender(event);
		return desktopHost.removeOAuthAccount(providerId, credentialId);
	});
	ipcMain.handle("branchlight:auth-login", (event, provider: unknown) => {
		assertTrustedSender(event);
		return desktopHost.loginProvider(provider);
	});
	ipcMain.handle("branchlight:auth-logout", (event, provider: unknown) => {
		assertTrustedSender(event);
		return desktopHost.logoutProvider(provider);
	});
	ipcMain.handle("branchlight:auth-prompt", (event, value: unknown) => {
		assertTrustedSender(event);
		return desktopHost.respondAuthPrompt(value);
	});
	ipcMain.handle("branchlight:settings-get", event => {
		assertTrustedSender(event);
		return settingsStore?.settings;
	});
	ipcMain.handle("branchlight:settings-update", async (event, updates: unknown) => {
		assertTrustedSender(event);
		const updated = await settingsStore?.update(typeof updates === "object" && updates !== null ? updates : {});
		workspaceHost.updateTheme();
		return updated;
	});
	ipcMain.handle("branchlight:settings-reset", async event => {
		assertTrustedSender(event);
		const reset = await settingsStore?.reset();
		workspaceHost.updateTheme();
		return reset;
	});
	ipcMain.handle("branchlight:agent-settings", (event, id: unknown) => {
		assertTrustedSender(event);
		return desktopHost.getAgentSettings(id);
	});
	ipcMain.handle("branchlight:set-agent-setting", (event, id: unknown, path: unknown, value: unknown) => {
		assertTrustedSender(event);
		return desktopHost.setAgentSetting(id, path, value);
	});
	ipcMain.handle("branchlight:choose-and-create", (event, kind: unknown) => {
		assertTrustedSender(event);
		return desktopHost.chooseAndCreate(kind);
	});
	ipcMain.handle("branchlight:open", (event, id: unknown) => {
		assertTrustedSender(event);
		return desktopHost.openSession(id);
	});
	ipcMain.handle("branchlight:resume", (event, id: unknown) => {
		assertTrustedSender(event);
		return desktopHost.resume(id);
	});
	ipcMain.handle("branchlight:timeline-page", (event, id: unknown, before: unknown, limit: unknown) => {
		assertTrustedSender(event);
		return desktopHost.loadTimelinePage(id, before, limit);
	});
	ipcMain.handle("branchlight:timeline-item", (event, id: unknown, itemId: unknown) => {
		assertTrustedSender(event);
		return desktopHost.loadTimelineItem(id, itemId);
	});
	ipcMain.handle("branchlight:available-commands", (event, id: unknown) => {
		assertTrustedSender(event);
		return desktopHost.getAvailableCommands(id);
	});
	ipcMain.handle("branchlight:available-models", (event, id: unknown) => {
		assertTrustedSender(event);
		return desktopHost.getAvailableModels(id);
	});
	ipcMain.handle("branchlight:openrouter-model-routing", (event, id: unknown, modelId: unknown) => {
		assertTrustedSender(event);
		return desktopHost.getOpenRouterModelRouting(id, modelId);
	});
	ipcMain.handle(
		"branchlight:set-openrouter-provider-enabled",
		(event, id: unknown, modelId: unknown, providerId: unknown, enabled: unknown) => {
			assertTrustedSender(event);
			return desktopHost.setOpenRouterProviderEnabled(id, modelId, providerId, enabled);
		},
	);
	ipcMain.handle("branchlight:stop", (event, id: unknown) => {
		assertTrustedSender(event);
		return desktopHost.stop(id);
	});
	ipcMain.handle("branchlight:rename", (event, id: unknown, title: unknown) => {
		assertTrustedSender(event);
		return desktopHost.rename(id, title);
	});
	ipcMain.handle("branchlight:prompt", (event, id: unknown, text: unknown) => {
		assertTrustedSender(event);
		return desktopHost.prompt(id, text);
	});
	ipcMain.handle("branchlight:steer", (event, id: unknown, text: unknown) => {
		assertTrustedSender(event);
		return desktopHost.steer(id, text);
	});
	ipcMain.handle("branchlight:queue", (event, id: unknown, text: unknown) => {
		assertTrustedSender(event);
		return desktopHost.queueFollowUp(id, text);
	});
	ipcMain.handle("branchlight:abort", (event, id: unknown) => {
		assertTrustedSender(event);
		return desktopHost.abort(id);
	});
	ipcMain.handle("branchlight:set-model", (event, id: unknown, provider: unknown, model: unknown) => {
		assertTrustedSender(event);
		return desktopHost.setModel(id, provider, model);
	});
	ipcMain.handle("branchlight:set-thinking", (event, id: unknown, level: unknown) => {
		assertTrustedSender(event);
		return desktopHost.setThinking(id, level);
	});
	ipcMain.handle("branchlight:set-fast", (event, id: unknown, enabled: unknown) => {
		assertTrustedSender(event);
		return desktopHost.setFastMode(id, enabled);
	});
	ipcMain.handle("branchlight:set-queue-mode", (event, id: unknown, kind: unknown, mode: unknown) => {
		assertTrustedSender(event);
		return desktopHost.setQueueMode(id, kind, mode);
	});
	ipcMain.handle("branchlight:set-interrupt-mode", (event, id: unknown, mode: unknown) => {
		assertTrustedSender(event);
		return desktopHost.setInterruptMode(id, mode);
	});
	ipcMain.handle("branchlight:set-auto-compaction", (event, id: unknown, enabled: unknown) => {
		assertTrustedSender(event);
		return desktopHost.setAutoCompaction(id, enabled);
	});
	ipcMain.handle("branchlight:set-auto-retry", (event, id: unknown, enabled: unknown) => {
		assertTrustedSender(event);
		return desktopHost.setAutoRetry(id, enabled);
	});
	ipcMain.handle("branchlight:extension-response", (event, id: unknown, response: unknown) => {
		assertTrustedSender(event);
		return desktopHost.extensionResponse(id, response);
	});
	ipcMain.handle("branchlight:subagent-messages", (event, id: unknown, subagentId: unknown, fromByte: unknown) => {
		assertTrustedSender(event);
		return desktopHost.getSubagentMessages(id, subagentId, fromByte);
	});
	ipcMain.handle("branchlight:file-diff", (event, id: unknown, target: unknown) => {
		assertTrustedSender(event);
		return desktopHost.loadFileDiff(id, target);
	});
	ipcMain.handle("branchlight:open-workspace-file", (event, id: unknown, target: unknown) => {
		assertTrustedSender(event);
		return desktopHost.openWorkspaceFile(id, target);
	});
	ipcMain.handle("branchlight:open-external", (event, url: unknown) => {
		assertTrustedSender(event);
		return desktopHost.openExternal(url);
	});
	ipcMain.handle("branchlight:workspace-document-get", async event => {
		assertTrustedSender(event);
		return runtimeClient?.document ?? (await runtimeClient?.getDocument()) ?? null;
	});
	ipcMain.handle("branchlight:browser-create", (event, options: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.createBrowser(options as import("./workspace-host").CreateBrowserOptions);
	});
	ipcMain.handle("branchlight:browser-navigate", (event, id: unknown, url: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.navigateBrowser(id, url);
	});
	ipcMain.handle("branchlight:browser-control", (event, id: unknown, action: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.controlBrowser(id, action);
	});
	ipcMain.handle("branchlight:browser-bounds", (event, id: unknown, bounds: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.setBrowserBounds(id, bounds);
	});
	ipcMain.handle("branchlight:browser-visible", (event, ids: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.setVisibleBrowsers(ids);
	});
	ipcMain.handle("branchlight:browser-close", (event, id: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.closeBrowser(id);
	});
	ipcMain.handle("branchlight:terminal-create", (event, options: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.createTerminal(options as import("./workspace-host").CreateTerminalOptions);
	});
	ipcMain.handle("branchlight:terminal-write", (event, id: unknown, data: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.writeTerminal(id, data);
	});
	ipcMain.handle("branchlight:terminal-resize", (event, id: unknown, cols: unknown, rows: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.resizeTerminal(id, cols, rows);
	});
	ipcMain.handle("branchlight:terminal-close", (event, id: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.closeTerminal(id);
	});
	ipcMain.handle("branchlight:tab-update", (event, tabId: unknown, updates: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.updateTab(tabId, updates);
	});
	ipcMain.handle("branchlight:tab-close", (event, tabId: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.closeTab(tabId);
	});
	ipcMain.handle("branchlight:pane-close", (event, paneId: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.closePane(paneId);
	});
	ipcMain.on("branchlight:pane-context-menu", (event, id: unknown, canSplit: unknown) => {
		assertTrustedSender(event);
		workspaceHost.showPaneContextMenu(id, canSplit);
	});
	ipcMain.handle("branchlight:selection-start", (event, id: unknown, agentId: unknown, captureMode: unknown) => {
		assertTrustedSender(event);
		const pane = typeof id === "string" ? id.trim() : "";
		const targetAgent = typeof agentId === "string" && agentId.trim().length > 0 ? agentId.trim() : undefined;
		const mode = captureMode === "screenshot" ? "screenshot" : "dom";
		const epoch = workspaceHost.getBrowserDocumentEpoch(pane);
		const scope = desktopHost.resolveSelectionScope(pane, targetAgent, epoch);
		return workspaceHost.startSelection(scope, { captureMode: mode });
	});
	ipcMain.handle("branchlight:selection-cancel", (event, id: unknown, reason: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.cancelSelection(id, reason);
	});
	ipcMain.handle("branchlight:selection-commit", (event, id: unknown, instruction: unknown) => {
		assertTrustedSender(event);
		const pane = typeof id === "string" ? id.trim() : "";
		return workspaceHost.commitSelection(pane, typeof instruction === "string" ? instruction : undefined);
	});
	ipcMain.handle("branchlight:selection-state", (event, id: unknown) => {
		assertTrustedSender(event);
		return workspaceHost.getSelectionState(id);
	});
	ipcMain.handle("branchlight:window-minimize", event => {
		assertTrustedSender(event);
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) throw new Error("Window is unavailable");
		window.minimize();
	});
	ipcMain.handle("branchlight:window-toggle-maximize", event => {
		assertTrustedSender(event);
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) throw new Error("Window is unavailable");
		if (window.isMaximized()) window.unmaximize();
		else window.maximize();
		return window.isMaximized();
	});
	ipcMain.handle("branchlight:window-close", event => {
		assertTrustedSender(event);
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) throw new Error("Window is unavailable");
		window.close();
	});
	ipcMain.handle("branchlight:validate-external", (event, url: unknown) => {
		assertTrustedSender(event);
		return safeExternalUrl(url).toString();
	});
}

function assertTrustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): void {
	const senderUrl = event.senderFrame?.url;
	if (!senderUrl) throw new Error("Untrusted IPC sender");
	if (senderUrl.startsWith("branchlight://app/")) return;
	if (DEV_SERVER && new URL(senderUrl).origin === new URL(DEV_SERVER).origin) return;
	throw new Error("Untrusted IPC sender");
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
