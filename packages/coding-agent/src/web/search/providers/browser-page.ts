import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Browser, Page } from "playwright-core";
import { applyStealthPatches, applyViewport, BROWSER_PROTOCOL_TIMEOUT_MS } from "../../../tools/browser/launch";
import { acquireBrowser, holdBrowser, releaseBrowser } from "../../../tools/browser/registry";
import { connectOverCdp } from "../../../tools/browser/tab-worker";
import { buildBrowserNavigationHeaders } from "./browser-headers";
import { SEARCH_HARD_TIMEOUT_MS } from "./utils";

const browserConnections = new Map<string, Promise<Browser>>();

/**
 * Playwright intentionally has no public disconnect API. Keep one CDP
 * connection per registry endpoint and let a shared browser's disconnect event
 * retire it; calling Browser.close() here could terminate a broker-owned or
 * otherwise attached browser.
 */
function connectBrowser(cdpEndpoint: string): Promise<Browser> {
	const existing = browserConnections.get(cdpEndpoint);
	if (existing) return existing;

	const pending = connectOverCdp(cdpEndpoint, BROWSER_PROTOCOL_TIMEOUT_MS);
	browserConnections.set(cdpEndpoint, pending);
	void pending.then(
		browser => {
			browser.once("disconnected", () => {
				if (browserConnections.get(cdpEndpoint) === pending) browserConnections.delete(cdpEndpoint);
			});
		},
		() => {
			if (browserConnections.get(cdpEndpoint) === pending) browserConnections.delete(cdpEndpoint);
		},
	);
	return pending;
}

/** HTML plus the response status and final URL after redirects or browser navigation. */
export interface LoadedHtmlPage {
	html: string;
	status: number;
	url: string;
}

interface BrowserFallbackOptions {
	homeUrl?: string;
	ready?: { selector: string; timeoutMs: number };
	afterNavigation?: (page: Page, signal: AbortSignal) => Promise<void>;
	shouldFallback: (page: LoadedHtmlPage) => boolean;
	attempts?: number;
	retryDelayMs?: number;
}

/** Controls a browser-profiled fetch and its optional headless-browser fallback. */
export interface BrowserFetchOptions {
	fetch?: FetchImpl;
	signal: AbortSignal;
	timeoutMs?: number;
	randomizeHeaders?: boolean;
	referer?: string;
	init?: Omit<RequestInit, "headers" | "signal">;
	headers?: Readonly<Record<string, string>>;
	browser?: BrowserFallbackOptions;
}

async function fetchHtmlPage(url: string, options: BrowserFetchOptions, fetchImpl: FetchImpl): Promise<LoadedHtmlPage> {
	const response = await fetchImpl(url, {
		...options.init,
		headers: {
			...buildBrowserNavigationHeaders({ randomized: options.randomizeHeaders }),
			...(options.referer ? { Referer: options.referer, "Sec-Fetch-Site": "same-origin" } : {}),
			...options.headers,
		},
		signal: options.signal,
	});
	return { html: await response.text(), status: response.status, url: response.url || url };
}

async function browseHtmlPage(
	url: string,
	options: BrowserFallbackOptions,
	signal: AbortSignal,
	timeoutMs = SEARCH_HARD_TIMEOUT_MS,
): Promise<LoadedHtmlPage> {
	const { homeUrl, ready } = options;
	const attempts = Math.max(1, options.attempts ?? 1);
	const handle = await untilAborted(signal, () =>
		acquireBrowser(
			{ kind: "headless", headless: true },
			{
				cwd: process.cwd(),
				signal,
			},
		),
	);
	if (!("cdpEndpoint" in handle)) {
		await releaseBrowser(handle, { kill: false });
		throw new Error("Headless browser acquisition returned a non-CDP browser");
	}

	holdBrowser(handle);
	let page: Page | undefined;
	try {
		const browser = await untilAborted(signal, () => connectBrowser(handle.cdpEndpoint));
		const context = browser.contexts()[0];
		if (!context) throw new Error("Headless browser CDP endpoint has no default context");
		const activePage = await untilAborted(signal, () => context.newPage());
		page = activePage;
		await applyViewport(activePage);
		await applyStealthPatches(browser, activePage);
		if (homeUrl) {
			await untilAborted(signal, () =>
				activePage.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
			);
		}
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt > 0 && options.retryDelayMs) await Bun.sleep(options.retryDelayMs);

			const response = await untilAborted(signal, () =>
				activePage.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
			);
			if (options.afterNavigation) await options.afterNavigation(activePage, signal);
			if (ready) {
				await untilAborted(signal, () =>
					activePage
						.waitForSelector(ready.selector, { state: "attached", timeout: ready.timeoutMs })
						.catch(() => null),
				);
			}
			const loaded = {
				html: await untilAborted(signal, () => activePage.content()),
				status: response?.status() ?? 200,
				url: activePage.url(),
			};
			if (!options.shouldFallback(loaded) || attempt === attempts - 1) return loaded;
		}
		throw new Error("Browser fallback exhausted without a response");
	} finally {
		await page?.close().catch(() => undefined);
		await releaseBrowser(handle, { kill: false });
	}
}

/** Fetch with a fresh browser profile, escalating rejected production responses to the stealth browser. */
export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
	const fetchImpl = options.fetch ?? fetch;
	let page: LoadedHtmlPage;
	try {
		page = await fetchHtmlPage(url, options, fetchImpl);
	} catch (error) {
		if (options.fetch || !options.browser) throw error;
		return browseHtmlPage(url, options.browser, options.signal, options.timeoutMs);
	}

	if (!options.browser || options.fetch) return page;
	const isSuccessful = page.status >= 200 && page.status < 300;
	if (isSuccessful && !options.browser.shouldFallback(page)) return page;
	return browseHtmlPage(url, options.browser, options.signal, options.timeoutMs);
}
