import type { WorkspaceBrowserV1 } from "@oh-my-pi/pi-wire";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

export interface WorkspaceBrowserSessionOptions {
	id: string;
	url?: string;
	cdpUrl?: string;
	headless?: boolean;
	onNavigation?: (id: string, url: string, title?: string) => void;
	onClose?: (id: string) => void;
	onError?: (id: string, error: Error) => void;
}

export interface BrowserElementInfo {
	selector: string;
	tagName: string;
	text?: string;
	attributes?: Record<string, string>;
	boundingBox?: { x: number; y: number; width: number; height: number };
}

export class WorkspaceBrowserSession {
	readonly id: string;
	#url: string;
	readonly #cdpUrl?: string;
	readonly #headless: boolean;
	readonly #onNavigation?: (id: string, url: string, title?: string) => void;
	readonly #onClose?: (id: string) => void;
	readonly #onError?: (id: string, error: Error) => void;

	#browser?: Browser;
	#context?: BrowserContext;
	#page?: Page;
	#status: WorkspaceBrowserV1["status"] = "opening";
	#title?: string;
	#isClosed = false;

	constructor(options: WorkspaceBrowserSessionOptions) {
		this.id = options.id;
		this.#url = options.url ?? "about:blank";
		this.#cdpUrl = options.cdpUrl;
		this.#headless = options.headless ?? true;
		this.#onNavigation = options.onNavigation;
		this.#onClose = options.onClose;
		this.#onError = options.onError;
	}

	get status(): WorkspaceBrowserV1["status"] {
		return this.#status;
	}

	get url(): string {
		return this.#url;
	}

	get title(): string | undefined {
		return this.#title;
	}

	get page(): Page | undefined {
		return this.#page;
	}

	async open(): Promise<void> {
		if (this.#status === "open" || this.#isClosed) {
			throw new Error(`Browser session ${this.id} is already open or closed`);
		}

		try {
			let browser: Browser;
			if (this.#cdpUrl) {
				browser = await chromium.connectOverCDP(this.#cdpUrl);
			} else {
				browser = await chromium.launch({ headless: this.#headless });
			}
			this.#browser = browser;

			const context = browser.contexts()[0] ?? (await browser.newContext());
			this.#context = context;

			const page = context.pages()[0] ?? (await context.newPage());
			this.#page = page;

			page.on("framenavigated", frame => {
				if (frame === page.mainFrame()) {
					this.#url = frame.url();
					void page
						.title()
						.then(title => {
							this.#title = title;
							this.#onNavigation?.(this.id, this.#url, title);
						})
						.catch(() => {
							this.#onNavigation?.(this.id, this.#url);
						});
				}
			});

			page.on("close", () => {
				this.#handleClose();
			});

			if (this.#url && this.#url !== "about:blank") {
				await page.goto(this.#url, { waitUntil: "domcontentloaded" });
				this.#title = await page.title();
			}

			this.#status = "open";
		} catch (error) {
			this.#status = "failed";
			const err = error instanceof Error ? error : new Error(String(error));
			this.#onError?.(this.id, err);
			throw err;
		}
	}

	async navigate(url: string): Promise<string> {
		if (this.#status !== "open" || !this.#page || this.#isClosed) {
			throw new Error(`Browser session ${this.id} is not open`);
		}
		this.#url = url;
		await this.#page.goto(url, { waitUntil: "domcontentloaded" });
		this.#title = await this.#page.title();
		this.#onNavigation?.(this.id, this.#url, this.#title);
		return this.#url;
	}

	async evaluate<T = unknown>(script: string): Promise<T> {
		if (!this.#page || this.#isClosed) {
			throw new Error(`Browser session ${this.id} is not open`);
		}
		return this.#page.evaluate(script) as Promise<T>;
	}

	async screenshot(options: { fullPage?: boolean } = {}): Promise<Buffer> {
		if (!this.#page || this.#isClosed) {
			throw new Error(`Browser session ${this.id} is not open`);
		}
		return this.#page.screenshot({ fullPage: options.fullPage });
	}

	async ariaSnapshot(): Promise<string> {
		if (!this.#page || this.#isClosed) {
			throw new Error(`Browser session ${this.id} is not open`);
		}
		return this.#page.locator(":root").ariaSnapshot();
	}

	async queryElements(selector: string): Promise<BrowserElementInfo[]> {
		if (!this.#page || this.#isClosed) {
			throw new Error(`Browser session ${this.id} is not open`);
		}
		const locators = this.#page.locator(selector);
		const count = await locators.count();
		const results: BrowserElementInfo[] = [];

		for (let i = 0; i < Math.min(count, 50); i++) {
			const el = locators.nth(i);
			const box = await el.boundingBox();
			const text = await el.textContent().catch(() => null);
			const tagName = await el.evaluate(node => node.tagName.toLowerCase()).catch(() => "unknown");
			results.push({
				selector: `${selector} >> nth=${i}`,
				tagName,
				text: text ?? undefined,
				boundingBox: box ?? undefined,
			});
		}
		return results;
	}

	async close(): Promise<void> {
		if (this.#isClosed) return;
		this.#isClosed = true;
		this.#status = "closed";

		if (this.#context) {
			await this.#context.close().catch(() => {});
			this.#context = undefined;
		}

		if (this.#browser) {
			await this.#browser.close().catch(() => {});
			this.#browser = undefined;
		}

		this.#page = undefined;
		this.#onClose?.(this.id);
	}

	#handleClose(): void {
		if (this.#isClosed) return;
		this.#isClosed = true;
		this.#status = "closed";
		this.#page = undefined;
		this.#onClose?.(this.id);
	}
}

export class WorkspaceBrowserManager {
	readonly #sessions = new Map<string, WorkspaceBrowserSession>();
	readonly #onNavigation?: (id: string, url: string, title?: string) => void;
	readonly #onClose?: (id: string) => void;

	constructor(
		options: {
			onNavigation?: (id: string, url: string, title?: string) => void;
			onClose?: (id: string) => void;
		} = {},
	) {
		this.#onNavigation = options.onNavigation;
		this.#onClose = options.onClose;
	}

	get sessionCount(): number {
		return this.#sessions.size;
	}

	getSession(id: string): WorkspaceBrowserSession | undefined {
		return this.#sessions.get(id);
	}

	async openSession(options: WorkspaceBrowserSessionOptions): Promise<WorkspaceBrowserSession> {
		if (this.#sessions.has(options.id)) {
			throw new Error(`Browser session ${options.id} already exists`);
		}
		const session = new WorkspaceBrowserSession({
			...options,
			onNavigation: (id, url, title) => {
				options.onNavigation?.(id, url, title);
				this.#onNavigation?.(id, url, title);
			},
			onClose: id => {
				this.#sessions.delete(id);
				options.onClose?.(id);
				this.#onClose?.(id);
			},
		});
		this.#sessions.set(options.id, session);
		await session.open();
		return session;
	}

	async navigate(id: string, url: string): Promise<string> {
		const session = this.#sessions.get(id);
		if (!session) throw new Error(`Browser session ${id} not found`);
		return session.navigate(url);
	}

	async closeSession(id: string): Promise<void> {
		const session = this.#sessions.get(id);
		if (!session) return;
		this.#sessions.delete(id);
		await session.close();
	}

	async closeAll(): Promise<void> {
		const sessions = Array.from(this.#sessions.values());
		this.#sessions.clear();
		await Promise.all(sessions.map(s => s.close()));
	}
}
