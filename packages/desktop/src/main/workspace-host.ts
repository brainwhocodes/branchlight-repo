import * as path from "node:path";
import { type BrowserWindow, WebContentsView } from "electron";
import type {
	BrowserBounds,
	BrowserNavigationAction,
	BrowserViewState,
	TerminalViewState,
	WorkspaceEvent,
} from "../shared/contracts";
import { defaultWorkspacePath, ompExecutablePath } from "./backend-path";
import { TerminalBridge } from "./terminal-bridge";

const DEFAULT_BROWSER_URL = "https://omp.sh";

interface BrowserEntry {
	view: WebContentsView;
	state: BrowserViewState;
	attached: boolean;
	bounds: BrowserBounds;
	workspaceName: string;
	pageTitle: string;
	applyingTitle: boolean;
}

function paneId(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z0-9-]{8,100}$/i.test(value)) throw new TypeError("Invalid pane id");
	return value;
}

function dimension(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 2 || (value as number) > 500)
		throw new RangeError(`${label} must be between 2 and 500`);
	return value as number;
}

function browserUrl(value: unknown): URL {
	if (typeof value !== "string") throw new TypeError("Address must be text");
	const address = value.trim();
	if (address.length === 0) return new URL(DEFAULT_BROWSER_URL);
	let candidate = address;
	if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
		candidate =
			/\s/.test(candidate) || !candidate.includes(".")
				? `https://www.google.com/search?q=${encodeURIComponent(candidate)}`
				: `https://${candidate}`;
	}
	const url = new URL(candidate);
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Only HTTP and HTTPS addresses can open here");
	return url;
}

function browserBounds(value: unknown): BrowserBounds {
	if (typeof value !== "object" || value === null) throw new TypeError("Invalid browser bounds");
	const source = value as Record<string, unknown>;
	const numbers = [source.x, source.y, source.width, source.height];
	if (!numbers.every(item => typeof item === "number" && Number.isFinite(item)))
		throw new TypeError("Browser bounds must be finite numbers");
	return {
		x: Math.max(0, Math.round(source.x as number)),
		y: Math.max(0, Math.round(source.y as number)),
		width: Math.max(0, Math.round(source.width as number)),
		height: Math.max(0, Math.round(source.height as number)),
	};
}

export class WorkspaceHost {
	#window: BrowserWindow;
	#browsers = new Map<string, BrowserEntry>();
	#visibleBrowsers = new Set<string>();
	#terminal: TerminalBridge;
	#browserCdpUrl: string;

	constructor(window: BrowserWindow, browserCdpUrl: string) {
		this.#window = window;
		this.#browserCdpUrl = browserCdpUrl;
		this.#terminal = new TerminalBridge(event => this.#send(event));
	}

	createBrowser(rawId: unknown, rawUrl: unknown): BrowserViewState {
		const id = paneId(rawId);
		const existing = this.#browsers.get(id);
		if (existing) return { ...existing.state };
		const url = browserUrl(rawUrl).toString();
		const view = new WebContentsView({
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webSecurity: true,
			},
		});
		view.setBackgroundColor("#f6f2eb");
		const entry: BrowserEntry = {
			view,
			attached: false,
			bounds: { x: 0, y: 0, width: 0, height: 0 },
			workspaceName: "Browser",
			pageTitle: "New browser",
			applyingTitle: false,
			state: { id, url, title: "New browser", canGoBack: false, canGoForward: false, loading: true },
		};
		this.#browsers.set(id, entry);
		this.#bindBrowser(id, entry);
		if (this.#visibleBrowsers.has(id)) this.#attach(entry);
		void view.webContents.loadURL(url).catch(error => this.#setBrowserError(id, error));
		return { ...entry.state };
	}

	nameBrowser(rawId: unknown, rawName: unknown): void {
		const id = paneId(rawId);
		if (typeof rawName !== "string") throw new TypeError("Browser name must be text");
		const name = rawName.trim();
		if (name.length === 0 || Array.from(name).length > 160)
			throw new RangeError("Browser name must contain 1–160 characters");
		const entry = this.#requireBrowser(id);
		entry.workspaceName = name;
		this.#applyBrowserTargetTitle(entry);
	}

	navigateBrowser(rawId: unknown, rawUrl: unknown): BrowserViewState {
		const id = paneId(rawId);
		const entry = this.#requireBrowser(id);
		const url = browserUrl(rawUrl).toString();
		entry.state = { ...entry.state, url, loading: true, error: undefined };
		this.#emitBrowserState(id);
		void entry.view.webContents.loadURL(url).catch(error => this.#setBrowserError(id, error));
		return { ...entry.state };
	}

	controlBrowser(rawId: unknown, rawAction: unknown): void {
		const id = paneId(rawId);
		const entry = this.#requireBrowser(id);
		if (rawAction !== "back" && rawAction !== "forward" && rawAction !== "reload" && rawAction !== "stop")
			throw new TypeError("Invalid browser action");
		const action: BrowserNavigationAction = rawAction;
		const history = entry.view.webContents.navigationHistory;
		if (action === "back" && history.canGoBack()) history.goBack();
		else if (action === "forward" && history.canGoForward()) history.goForward();
		else if (action === "reload") entry.view.webContents.reload();
		else if (action === "stop") entry.view.webContents.stop();
	}

	setBrowserBounds(rawId: unknown, rawBounds: unknown): void {
		const entry = this.#requireBrowser(paneId(rawId));
		entry.bounds = browserBounds(rawBounds);
		if (entry.attached && entry.bounds.width > 0 && entry.bounds.height > 0) entry.view.setBounds(entry.bounds);
	}

	setVisibleBrowsers(value: unknown): void {
		if (!Array.isArray(value) || value.length > 32) throw new TypeError("Invalid visible browser list");
		const ids = value.map(paneId);
		this.#visibleBrowsers = new Set(ids);
		for (const [id, entry] of this.#browsers) {
			if (this.#visibleBrowsers.has(id)) this.#attach(entry);
			else this.#detach(entry);
		}
	}

	closeBrowser(rawId: unknown): void {
		const id = paneId(rawId);
		const entry = this.#browsers.get(id);
		if (!entry) return;
		this.#browsers.delete(id);
		this.#visibleBrowsers.delete(id);
		this.#detach(entry);
		if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
	}

	async createTerminal(rawId: unknown, rawCols: unknown, rawRows: unknown): Promise<TerminalViewState> {
		const id = paneId(rawId);
		const cols = dimension(rawCols, "Terminal columns");
		const rows = dimension(rawRows, "Terminal rows");
		const cwd = defaultWorkspacePath();
		const executableDirectory = path.dirname(ompExecutablePath());
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string") env[key] = value;
		}
		const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
		env[pathKey] = `${executableDirectory}${path.delimiter}${env[pathKey] ?? ""}`;
		env.TERM = "xterm-256color";
		env.COLORTERM = "truecolor";
		env.TERM_PROGRAM = "Branchlight";
		env.TERM_PROGRAM_VERSION = "0.1.0";
		env.PI_BROWSER_CDP_URL = this.#browserCdpUrl;
		env.BRANCHLIGHT_TERMINAL = "1";
		const windows = process.platform === "win32";
		const shell = process.env.BRANCHLIGHT_SHELL ?? (windows ? "powershell.exe" : (process.env.SHELL ?? "/bin/bash"));
		const args = process.env.BRANCHLIGHT_SHELL ? [] : windows ? ["-NoLogo"] : ["-l"];
		const started = await this.#terminal.create({ type: "start", id, shell, args, cwd, cols, rows, env });
		return started;
	}

	writeTerminal(rawId: unknown, rawData: unknown): void {
		const id = paneId(rawId);
		if (typeof rawData !== "string" || new TextEncoder().encode(rawData).byteLength > 512 * 1024)
			throw new TypeError("Invalid terminal input");
		this.#terminal.write(id, rawData);
	}

	resizeTerminal(rawId: unknown, rawCols: unknown, rawRows: unknown): void {
		this.#terminal.resize(paneId(rawId), dimension(rawCols, "Terminal columns"), dimension(rawRows, "Terminal rows"));
	}

	closeTerminal(rawId: unknown): void {
		this.#terminal.close(paneId(rawId));
	}

	async stop(): Promise<void> {
		for (const id of [...this.#browsers.keys()]) this.closeBrowser(id);
		await this.#terminal.shutdown();
	}

	#bindBrowser(id: string, entry: BrowserEntry): void {
		const { webContents } = entry.view;
		webContents.on("did-start-loading", () => {
			entry.state = { ...entry.state, loading: true, error: undefined };
			this.#emitBrowserState(id);
		});
		webContents.on("did-stop-loading", () => {
			entry.state = { ...entry.state, loading: false };
			this.#refreshBrowserState(id);
		});
		webContents.on("did-navigate", (_event, url) => {
			entry.state = { ...entry.state, url };
			this.#refreshBrowserState(id);
		});
		webContents.on("did-navigate-in-page", (_event, url) => {
			entry.state = { ...entry.state, url };
			this.#refreshBrowserState(id);
		});
		webContents.on("page-title-updated", (_event, title) => {
			const expected = this.#browserTargetTitle(entry);
			if (entry.applyingTitle && title === expected) {
				entry.applyingTitle = false;
				return;
			}
			const prefix = `Branchlight · ${entry.workspaceName} · `;
			if (title.startsWith(prefix)) return;
			entry.pageTitle = title.trim().slice(0, 160) || "Browser";
			entry.state = { ...entry.state, title: entry.pageTitle };
			this.#emitBrowserState(id);
			this.#applyBrowserTargetTitle(entry);
		});
		webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
			if (!isMainFrame || errorCode === -3) return;
			entry.state = {
				...entry.state,
				url: validatedURL || entry.state.url,
				loading: false,
				error: errorDescription || `Navigation failed (${errorCode})`,
			};
			this.#emitBrowserState(id);
		});
		webContents.on("focus", () => this.#send({ type: "browser-focus", paneId: id }));
		webContents.on("render-process-gone", (_event, details) => {
			entry.state = { ...entry.state, loading: false, error: `Browser process stopped: ${details.reason}` };
			this.#emitBrowserState(id);
		});
		webContents.on("will-navigate", (event, url) => {
			try {
				browserUrl(url);
			} catch {
				event.preventDefault();
			}
		});
		webContents.on("will-redirect", (event, url) => {
			try {
				browserUrl(url);
			} catch {
				event.preventDefault();
			}
		});
		webContents.setWindowOpenHandler(details => {
			try {
				const url = browserUrl(details.url).toString();
				this.#send({ type: "browser-new-window", paneId: id, url });
			} catch {}
			return { action: "deny" };
		});
	}

	#browserTargetTitle(entry: BrowserEntry): string {
		return `Branchlight · ${entry.workspaceName} · ${entry.pageTitle}`;
	}

	#applyBrowserTargetTitle(entry: BrowserEntry): void {
		if (entry.view.webContents.isDestroyed()) return;
		const targetTitle = this.#browserTargetTitle(entry);
		entry.applyingTitle = true;
		void entry.view.webContents
			.executeJavaScript(`document.title = ${JSON.stringify(targetTitle)}`, true)
			.catch(() => {
				entry.applyingTitle = false;
			});
	}

	#refreshBrowserState(id: string): void {
		const entry = this.#browsers.get(id);
		if (!entry || entry.view.webContents.isDestroyed()) return;
		const history = entry.view.webContents.navigationHistory;
		entry.state = {
			...entry.state,
			url: entry.view.webContents.getURL() || entry.state.url,
			canGoBack: history.canGoBack(),
			canGoForward: history.canGoForward(),
		};
		this.#emitBrowserState(id);
	}

	#setBrowserError(id: string, error: unknown): void {
		const entry = this.#browsers.get(id);
		if (!entry) return;
		entry.state = { ...entry.state, loading: false, error: error instanceof Error ? error.message : String(error) };
		this.#emitBrowserState(id);
	}

	#emitBrowserState(id: string): void {
		const state = this.#browsers.get(id)?.state;
		if (state) this.#send({ type: "browser-state", paneId: id, state: { ...state } });
	}

	#send(event: WorkspaceEvent): void {
		if (!this.#window.isDestroyed() && !this.#window.webContents.isDestroyed())
			this.#window.webContents.send("branchlight:workspace", event);
	}

	#requireBrowser(id: string): BrowserEntry {
		const entry = this.#browsers.get(id);
		if (!entry) throw new Error("Browser pane is unavailable");
		return entry;
	}

	#attach(entry: BrowserEntry): void {
		if (!entry.attached) {
			this.#window.contentView.addChildView(entry.view);
			entry.attached = true;
		}
		if (entry.bounds.width > 0 && entry.bounds.height > 0) entry.view.setBounds(entry.bounds);
	}

	#detach(entry: BrowserEntry): void {
		if (!entry.attached) return;
		this.#window.contentView.removeChildView(entry.view);
		entry.attached = false;
	}
}
