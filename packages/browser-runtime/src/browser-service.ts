import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import type { AdoptTargetOptions, BrowserActionOptions, BrowserElementQueryInfo, BrowserTargetIdentity } from "./types";

interface AdoptedTargetEntry {
	target: BrowserTargetIdentity;
	page: Page;
	cdpUrl: string;
	isShared: boolean;
	cleanup: () => void;
}

export class PlaywrightBrowserService {
	readonly #connections = new Map<string, { browser: Browser; context: BrowserContext; isShared: boolean }>();
	readonly #adoptedTargets = new Map<string, AdoptedTargetEntry>();
	#isClosed = false;

	get adoptedCount(): number {
		return this.#adoptedTargets.size;
	}

	async connectCdp(cdpUrl: string, isShared = true): Promise<{ browser: Browser; context: BrowserContext }> {
		const existing = this.#connections.get(cdpUrl);
		if (existing) return existing;

		const browser = await chromium.connectOverCDP(cdpUrl);
		const context = browser.contexts()[0] ?? (await browser.newContext());
		const entry = { browser, context, isShared };
		this.#connections.set(cdpUrl, entry);
		return entry;
	}

	registerBrowserContext(cdpUrl: string, browser: Browser, context: BrowserContext, isShared = true): void {
		this.#connections.set(cdpUrl, { browser, context, isShared });
	}

	async adoptTarget(options: AdoptTargetOptions): Promise<Page> {
		if (this.#isClosed) throw new Error("Browser service is closed");
		const target = options.target;

		if (!target.targetId) {
			throw new Error("stale_target: targetId is required for exact adoption");
		}

		const existing = this.#adoptedTargets.get(target.paneId);
		if (existing) {
			if (
				existing.target.documentEpoch !== target.documentEpoch ||
				existing.target.workspaceId !== target.workspaceId
			) {
				throw new Error("stale_target: documentEpoch or workspace mismatch");
			}
			if (existing.target.targetId !== target.targetId) {
				throw new Error("stale_target: targetId changed for pane");
			}
			return existing.page;
		}

		const isShared = options.isShared ?? true;
		const { context } = await this.connectCdp(options.cdpUrl, isShared);

		// Match exact page by DevTools targetId via CDP session - NO URL or first-page fallback
		const pages = context.pages();
		let matchedPage: Page | undefined;

		for (const page of pages) {
			try {
				const cdp = await context.newCDPSession(page);
				const info = await cdp.send("Target.getTargetInfo");
				await cdp.detach();
				if (info.targetInfo.targetId === target.targetId) {
					matchedPage = page;
					break;
				}
			} catch {}
		}

		if (!matchedPage) {
			throw new Error(`not_found: exact target ${target.targetId} was not found in browser context`);
		}

		const onFrameNavigated = (frame: unknown): void => {
			if (matchedPage && frame === matchedPage.mainFrame()) {
				target.url = matchedPage.url();
				target.documentEpoch++;
				void matchedPage
					.title()
					.then(title => {
						target.title = title;
					})
					.catch(() => {});
			}
		};

		const onClose = (): void => {
			this.#adoptedTargets.delete(target.paneId);
		};

		matchedPage.on("framenavigated", onFrameNavigated);
		matchedPage.on("close", onClose);

		const cleanup = (): void => {
			if (matchedPage) {
				matchedPage.removeListener("framenavigated", onFrameNavigated);
				matchedPage.removeListener("close", onClose);
			}
		};

		this.#adoptedTargets.set(target.paneId, {
			target,
			page: matchedPage,
			cdpUrl: options.cdpUrl,
			isShared,
			cleanup,
		});

		target.health = "ready";
		return matchedPage;
	}

	getTarget(paneId: string): BrowserTargetIdentity | undefined {
		return this.#adoptedTargets.get(paneId)?.target;
	}

	getPage(paneId: string): Page | undefined {
		return this.#adoptedTargets.get(paneId)?.page;
	}

	async navigate(paneId: string, url: string): Promise<string> {
		const entry = this.#adoptedTargets.get(paneId);
		if (!entry) throw new Error(`Target pane ${paneId} is not adopted`);

		await entry.page.goto(url, { waitUntil: "domcontentloaded" });
		const currentUrl = entry.page.url();
		const title = await entry.page.title().catch(() => undefined);

		entry.target.url = currentUrl;
		entry.target.title = title;
		entry.target.documentEpoch++;

		return currentUrl;
	}

	async ariaSnapshot(paneId: string): Promise<string> {
		const entry = this.#adoptedTargets.get(paneId);
		if (!entry) throw new Error(`Target pane ${paneId} is not adopted`);
		return entry.page.locator(":root").ariaSnapshot();
	}

	async screenshot(paneId: string, options: { fullPage?: boolean } = {}): Promise<Buffer> {
		const entry = this.#adoptedTargets.get(paneId);
		if (!entry) throw new Error(`Target pane ${paneId} is not adopted`);
		return entry.page.screenshot({ fullPage: options.fullPage });
	}

	async evaluate<T = unknown>(paneId: string, script: string): Promise<T> {
		const entry = this.#adoptedTargets.get(paneId);
		if (!entry) throw new Error(`Target pane ${paneId} is not adopted`);
		return entry.page.evaluate(script) as Promise<T>;
	}

	async click(paneId: string, selector: string, options: BrowserActionOptions = {}): Promise<void> {
		const entry = this.#adoptedTargets.get(paneId);
		if (!entry) throw new Error(`Target pane ${paneId} is not adopted`);
		await entry.page.locator(selector).click({ timeout: options.timeoutMs });
	}

	async fill(paneId: string, selector: string, value: string, options: BrowserActionOptions = {}): Promise<void> {
		const entry = this.#adoptedTargets.get(paneId);
		if (!entry) throw new Error(`Target pane ${paneId} is not adopted`);
		await entry.page.locator(selector).fill(value, { timeout: options.timeoutMs });
	}

	async queryElements(paneId: string, selector: string): Promise<BrowserElementQueryInfo[]> {
		const entry = this.#adoptedTargets.get(paneId);
		if (!entry) throw new Error(`Target pane ${paneId} is not adopted`);

		const locators = entry.page.locator(selector);
		const count = await locators.count();
		const results: BrowserElementQueryInfo[] = [];

		for (let i = 0; i < Math.min(count, 50); i++) {
			const el = locators.nth(i);
			const box = await el.boundingBox().catch(() => null);
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

	async releaseTarget(paneId: string): Promise<void> {
		const entry = this.#adoptedTargets.get(paneId);
		if (!entry) return;

		entry.cleanup();
		this.#adoptedTargets.delete(paneId);

		// Shared browser target: NEVER close page or terminate browser
		if (!entry.isShared) {
			await entry.page.close().catch(() => {});
		}
	}

	async close(): Promise<void> {
		if (this.#isClosed) return;
		this.#isClosed = true;

		for (const paneId of Array.from(this.#adoptedTargets.keys())) {
			await this.releaseTarget(paneId);
		}

		for (const [cdpUrl, conn] of this.#connections) {
			// Shared / attached CDP: NEVER call browser.close()
			if (!conn.isShared) {
				await conn.context.close().catch(() => {});
				await conn.browser.close().catch(() => {});
			}
		}
		this.#connections.clear();
	}
}
