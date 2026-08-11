import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, net, protocol, session } from "electron";
import { DesktopHost } from "./desktop-host";
import { safeExternalUrl } from "./guards";

const DEV_SERVER = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string" ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;
const CONTENT_SECURITY_POLICY =
	"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
let mainWindow: BrowserWindow | undefined;
let host: DesktopHost | undefined;
let quitting = false;

protocol.registerSchemesAsPrivileged([
	{ scheme: "branchlight", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (!mainWindow) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	});
	void app
		.whenReady()
		.then(async () => {
			app.setName("Branchlight");
			app.setAppUserModelId("labs.branchlight.desktop");
			registerProtocol();
			configureSecurity();
			host = new DesktopHost(app.getPath("userData"));
			await host.load();
			mainWindow = createWindow();
			host.setWindow(mainWindow);
			registerIpc(host);
			if (host.bootstrap().warning)
				mainWindow.webContents.once("did-finish-load", () =>
					mainWindow?.webContents.send("branchlight:event", {
						sessionId: "",
						type: "warning",
						message: host?.bootstrap().warning,
					}),
				);
			await loadRenderer(mainWindow);
		})
		.catch(() => {
			app.quit();
		});
	app.on("before-quit", event => {
		if (quitting || !host) return;
		event.preventDefault();
		quitting = true;
		void host
			.stopAll()
			.then(() => host?.close())
			.finally(() => app.quit());
	});
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
}

function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 640,
		title: "Branchlight",
		frame: false,
		backgroundColor: "#f5f8fb",
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
	window.webContents.on("will-navigate", event => event.preventDefault());
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
	if (DEV_SERVER) await window.loadURL(`${DEV_SERVER}/src/renderer/index.html`);
	else await window.loadURL("branchlight://app/index.html");
}

function registerIpc(desktopHost: DesktopHost): void {
	ipcMain.handle("branchlight:bootstrap", event => {
		assertTrustedSender(event);
		return desktopHost.bootstrap();
	});
	ipcMain.handle("branchlight:auth-status", event => {
		assertTrustedSender(event);
		return desktopHost.getAuthStatus();
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

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
	const senderUrl = event.senderFrame?.url;
	if (!senderUrl) throw new Error("Untrusted IPC sender");
	if (senderUrl.startsWith("branchlight://app/")) return;
	if (DEV_SERVER && new URL(senderUrl).origin === new URL(DEV_SERVER).origin) return;
	throw new Error("Untrusted IPC sender");
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
