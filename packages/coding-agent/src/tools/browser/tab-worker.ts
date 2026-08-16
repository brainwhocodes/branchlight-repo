import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { postmortem, Snowflake, untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { HTMLElement } from "@oh-my-pi/pi-utils/dom";
import {
	type Browser,
	type BrowserContext,
	type CDPSession,
	type ConnectOverCDPTransport,
	chromium,
	type Dialog,
	type Download,
	type ElementHandle,
	type Frame,
	type Response as HTTPResponse,
	type Locator,
	type Page,
	type Request,
	type Route,
} from "playwright-core";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { resizeImage } from "../../utils/image-resize";
import { resolveToCwd } from "../path-utils";
import { formatScreenshot } from "../render-utils";
import {
	bindRunFacade,
	CELL_BUDGET_SLACK_MS,
	installBrowserWorkerRejectionGuard,
	isBrowserRunOwnedRejection,
	markBrowserRunRejection,
	markHandled,
	observeBrowserRunPromise,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForRun,
	withBrowserPromiseCombinatorTracking,
} from "../run-scope";
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
import {
	type AriaSnapshotOptions,
	assertSelectorString,
	captureAriaSnapshot,
	parseAriaRefSelector,
	resolveAriaRefHandle,
} from "./aria/aria-snapshot";
import { applyStealthPatches, applyViewport, DEFAULT_VIEWPORT } from "./launch";
import { extractReadableFromHtml, type ReadableFormat } from "./readable";

import { cloneSafe, RunOutput } from "./run-output";
import type {
	Observation,
	ObservationEntry,
	ReadyInfo,
	RunErrorPayload,
	ScreenshotResult,
	SessionSnapshot,
	ToolReply,
	Transport,
	WorkerInbound,
	WorkerInitPayload,
} from "./tab-protocol";

type PageRouteUrl = Parameters<Page["route"]>[0];
type PageRouteHandler = (route: Route, request: Request) => Promise<unknown> | unknown;

declare global {
	var document: {
		readonly visibilityState: "visible" | "hidden";
	};
}

const INTERACTIVE_AX_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"searchbox",
	"treeitem",
]);

const ARIA_QUERY_ROLES = [
	"button",
	"link",
	"textbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"searchbox",
	"treeitem",
	"heading",
	"img",
] as const;

const LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

/** Accepted selector namespaces. Raw CSS, including Playwright pseudos, passes through unchanged. */

type DialogPolicy = "accept" | "dismiss";
type DragTarget = string | { readonly x: number; readonly y: number };
/** Last JS dialog seen on the page; kept for timeout attribution until handled or navigation. */
interface OpenDialogInfo {
	type: string;
	message: string;
}

/**
 * Per-op fail-fast ceilings for `tab.*` helpers. All are kept strictly under the cell
 * budget (`timeoutMs - OP_DEADLINE_SLACK_MS`) so a stalled helper rejects with a named,
 * attributable error that leaves recovery budget — never the opaque whole-cell
 * "Browser code execution timed out" path that consumed the entire run.
 *
 * - `QUICK_OP_TIMEOUT_MS`: page-coupled reads that should resolve fast (`observe`,
 *   `screenshot`, `extract`, `ariaSnapshot`).
 * - `ACTION_OP_TIMEOUT_MS`: interactive point actions (`click`, `fill`, `type`, …) and
 *   the default for wait helpers when no explicit `{ timeout }` is given. Selector ops
 *   additionally fail fast after `ZERO_MATCH_FAIL_FAST_MS` of confirmed zero matches
 *   (see `#zeroMatchWatchdog`), so the full ceiling is only spent on elements that
 *   exist but are not yet actionable.
 *
 * `goto` and `evaluate` stay uncapped (`Number.POSITIVE_INFINITY`): navigation and user
 * code legitimately use the full cell budget.
 */
const QUICK_OP_TIMEOUT_MS = 20_000;
const ACTION_OP_TIMEOUT_MS = 8_000;
/** Maximum wait for a renderer acknowledgement after a wheel event is queued. */
const SCROLL_ACK_TIMEOUT_MS = 2_000;
/** Headroom subtracted from the cell budget so a per-op deadline fires before it. */
const OP_DEADLINE_SLACK_MS = CELL_BUDGET_SLACK_MS;
/**
 * A selector op whose selector has matched nothing for this long fails fast with the
 * zero-match hint instead of burning the rest of its deadline: a wrong selector or a
 * wrong page (consent wall, pre-navigation document) is the common agent failure and
 * should cost ~2s, not the full action ceiling. Explicit `{ timeout }` waits opt out.
 */
const ZERO_MATCH_FAIL_FAST_MS = 2_000;
/** Poll cadence for the zero-match watchdog. */
const ZERO_MATCH_POLL_MS = 250;
/** Cleanup must settle inside the supervisor's 750ms post-run grace window. */
const REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS = 250;

export interface OpTimeouts {
	/** Largest per-op deadline allowed — strictly below the cell budget. */
	budgetBound: number;
	/** Ceiling for quick page reads. */
	quickOpMs: number;
	/** Ceiling for interactive actions + default for waits. */
	actionOpMs: number;
}

/** Resolve the per-op fail-fast ceilings for a given cell budget. */
export function resolveOpTimeouts(cellTimeoutMs: number): OpTimeouts {
	const budgetBound = Math.max(1, cellTimeoutMs - OP_DEADLINE_SLACK_MS);
	return {
		budgetBound,
		quickOpMs: Math.min(budgetBound, QUICK_OP_TIMEOUT_MS),
		actionOpMs: Math.min(budgetBound, ACTION_OP_TIMEOUT_MS),
	};
}
const HELD_RESOURCE_CLEANUP_TIMEOUT_MS = 100;
const FORCED_ROUTE_CLEANUP_TIMEOUT_MS = 50;

/** Queue a wheel event without treating a delayed renderer acknowledgement as dispatch failure. */
export async function dispatchScroll(
	dispatch: () => Promise<void>,
	ackTimeoutMs = SCROLL_ACK_TIMEOUT_MS,
): Promise<void> {
	const deadline = Promise.withResolvers<void>();
	const timer = setTimeout(() => deadline.resolve(), ackTimeoutMs);
	timer.unref();
	try {
		await Promise.race([dispatch(), deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Effective timeout for a wait helper (`waitFor*`). A positive explicit `{ timeout }` is
 * honored but clamped to the cell budget so it still fails fast + named; raising the tool
 * `timeout` raises that cap, so a longer budget stays meaningful. No `{ timeout }` uses the
 * action ceiling. `{ timeout: 0 }` / `Infinity` ("disable") maps to the largest bounded wait
 * (`budgetBound`) — the harness never permits an unbounded wait. Garbage input
 * (negative, `NaN`) falls back to the action ceiling rather than the longest wait.
 */
export function resolveWaitTimeout(cellTimeoutMs: number, explicit?: number): number {
	const { budgetBound, actionOpMs } = resolveOpTimeouts(cellTimeoutMs);
	if (explicit === undefined) return actionOpMs;
	// Public "disable" sentinels — still bounded by the budget here.
	if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;
	// Positive finite → honored + clamped. Negative/NaN garbage → default, not the longest wait.
	if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, budgetBound);
	return actionOpMs;
}

interface ScreenshotOptions {
	selector?: string;
	fullPage?: boolean;
	silent?: boolean;
}

interface TabApi {
	readonly name: string;
	readonly page: Page;
	readonly signal?: AbortSignal;
	url(): string;
	title(): Promise<string>;
	goto(
		url: string,
		opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" },
	): Promise<void>;
	observe(opts?: { includeAll?: boolean; viewportOnly?: boolean }): Promise<Observation>;
	ariaSnapshot(selector?: string, opts?: AriaSnapshotOptions): Promise<string>;
	screenshot(opts?: ScreenshotOptions): Promise<string>;
	extract(format?: ReadableFormat): Promise<string>;
	click(selector: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: string, opts?: { selector?: string }): Promise<void>;
	scroll(deltaX: number, deltaY: number): Promise<void>;
	drag(from: DragTarget, to: DragTarget): Promise<void>;
	waitFor(selector: string, opts?: { timeout?: number }): Promise<ActionableHandle>;
	evaluate<TResult, TArgs extends unknown[]>(
		fn: string | ((...args: TArgs) => TResult | Promise<TResult>),
		...args: TArgs
	): Promise<TResult>;
	scrollIntoView(selector: string): Promise<void>;
	select(selector: string, ...values: string[]): Promise<string[]>;
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string>;
	waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<HTTPResponse>;
	waitForSelector(
		selector: string,
		opts?: { timeout?: number; visible?: boolean; hidden?: boolean },
	): Promise<ActionableHandle | null>;
	waitForNavigation(opts?: {
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		timeout?: number;
	}): Promise<HTTPResponse | null>;
	id(n: number): Promise<ActionableHandle>;
	ref(id: string): Promise<ActionableHandle>;
}

export function normalizeSelector(selector: string): string {
	assertSelectorString(selector);
	if (!selector) return selector;
	if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some(prefix => selector.startsWith(prefix))) {
		throw new ToolError(`Unsupported selector prefix. Use CSS, aria/, text/, xpath/, or pierce/. Got: ${selector}`);
	}
	if (selector.startsWith("p-text/")) return `text/${selector.slice("p-text/".length)}`;
	if (selector.startsWith("p-xpath/")) return `xpath/${selector.slice("p-xpath/".length)}`;
	if (selector.startsWith("p-pierce/")) return `pierce/${selector.slice("p-pierce/".length)}`;
	if (selector.startsWith("p-aria/")) return `aria/${selector.slice("p-aria/".length)}`;
	return selector;
}

function locatorForSelector(page: Page, selector: string): Locator {
	const normalized = normalizeSelector(selector);
	if (normalized.startsWith("text/")) return page.getByText(normalized.slice("text/".length));
	if (normalized.startsWith("aria/")) {
		const query = normalized.slice("aria/".length);
		const nameMatch = query.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const roleMatch = query.match(/\[\s*role\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name =
			nameMatch?.[1] ??
			nameMatch?.[2] ??
			nameMatch?.[3]?.trim() ??
			query.replace(/\[\s*(?:name|role)\s*=.*$/i, "").trim();
		const role = roleMatch?.[1] ?? roleMatch?.[2] ?? roleMatch?.[3]?.trim();
		if (role && ARIA_QUERY_ROLES.includes(role as (typeof ARIA_QUERY_ROLES)[number])) {
			return page.getByRole(role as (typeof ARIA_QUERY_ROLES)[number], { name });
		}
		let locator = page.getByRole(ARIA_QUERY_ROLES[0], { name });
		for (const candidate of ARIA_QUERY_ROLES.slice(1)) {
			locator = locator.or(page.getByRole(candidate, { name }));
		}
		return locator;
	}
	if (normalized.startsWith("xpath/")) return page.locator(`xpath=${normalized.slice("xpath/".length)}`);
	if (normalized.startsWith("pierce/")) return page.locator(normalized.slice("pierce/".length));
	return page.locator(normalized);
}

type PublicWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

function playwrightWaitUntil(waitUntil: PublicWaitUntil): "load" | "domcontentloaded" | "networkidle" {
	return waitUntil === "networkidle0" ? "networkidle" : waitUntil === "networkidle2" ? "domcontentloaded" : waitUntil;
}

/**
 * Legacy networkidle2 contract: navigation listeners are installed before the
 * trigger, then the page must remain at no more than two in-flight requests for 500ms.
 */
export async function withNetworkIdle2<T>(
	page: Page,
	action: () => Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	const inflight = new Set<Request>();
	const settled = Promise.withResolvers<void>();
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	let idleTimer: NodeJS.Timeout | undefined;
	void settled.promise.catch(() => undefined);
	let armed = false;
	const update = (): void => {
		if (!armed) return;
		if (inflight.size > 2) {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = undefined;
			return;
		}
		if (idleTimer) return;
		idleTimer = setTimeout(() => settled.resolve(), 500);
		idleTimer.unref();
	};
	const onRequest = (request: Request): void => {
		inflight.add(request);
		update();
	};
	const onSettled = (request: Request): void => {
		inflight.delete(request);
		update();
	};
	const onAbort = (): void => settled.reject(combined.reason);
	page.on("request", onRequest);
	page.on("requestfinished", onSettled);
	page.on("requestfailed", onSettled);
	if (combined.aborted) onAbort();
	else combined.addEventListener("abort", onAbort, { once: true });
	try {
		const result = await action();
		armed = true;
		update();
		await settled.promise;
		return result;
	} finally {
		clearTimeout(idleTimer);
		combined.removeEventListener("abort", onAbort);
		page.off("request", onRequest);
		page.off("requestfinished", onSettled);
		page.off("requestfailed", onSettled);
	}
}

function isInteractiveNode(node: {
	role: string;
	checked?: unknown;
	pressed?: unknown;
	selected?: unknown;
	expanded?: unknown;
	focused?: boolean;
}): boolean {
	if (INTERACTIVE_AX_ROLES.has(node.role)) return true;
	return (
		node.checked !== undefined ||
		node.pressed !== undefined ||
		node.selected !== undefined ||
		node.expanded !== undefined ||
		node.focused === true
	);
}

/** Playwright handles natively expose the same `fill()` contract promised by TabApi. */
export type ActionableHandle = ElementHandle;

export function toActionableHandle(handle: ElementHandle): ActionableHandle {
	return handle;
}

async function fillViaHandle(handle: ElementHandle, value: string, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () => handle.fill(value, { timeout: ACTION_OP_TIMEOUT_MS, signal }));
}

/**
 * Strip `user:pass@` from a URL before surfacing it in tool outputs / details
 * so Basic Auth credentials don't leak into transcripts. Returns the original
 * string verbatim when it doesn't parse as a URL or when there are no
 * credentials to redact.
 */
function redactUrlCredentials(url: string): string {
	if (!url || (!url.includes("@") && !url.includes("//"))) return url;
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

class BrowserResourceCleanupError extends ToolError {}

interface RunPageScope {
	page: Page;
	cleanup(): Promise<void>;
}

/**
 * Track every route, listener, and download installed while a browser.run cell owns the
 * page. Playwright routing is page-scoped, so teardown first settles held routes and then
 * drains handlers before restoring the original event methods.
 */
function createRunPageScope(page: Page): RunPageScope {
	type Listener = (...args: never[]) => unknown;
	const listeners: Array<{ event: string; listener: Listener }> = [];
	const activeRoutes = new Set<Route>();
	const downloads = new Set<Download>();
	const routeHandlers = new Map<PageRouteHandler, PageRouteHandler>();
	const methods = {
		on: page.on,
		off: page.off,
		once: page.once,
		addListener: page.addListener,
		prependListener: page.prependListener,
		removeAllListeners: page.removeAllListeners,
		unrouteAll: page.unrouteAll,
		route: page.route,
		unroute: page.unroute,
	};
	const descriptors = new Map<keyof typeof methods, PropertyDescriptor | undefined>();
	for (const key of Object.keys(methods) as Array<keyof typeof methods>) {
		descriptors.set(key, Object.getOwnPropertyDescriptor(page, key));
	}
	const rawOn = (event: string, listener: Listener): void => {
		Reflect.apply(methods.on, page, [event, listener]);
	};
	const rawOff = (event: string, listener: Listener): void => {
		Reflect.apply(methods.off, page, [event, listener]);
	};
	const remember = (event: string, listener: Listener, prepend = false): Page => {
		Reflect.apply(prepend ? methods.prependListener : methods.on, page, [event, listener]);
		listeners.push({ event, listener });
		return page;
	};
	const forget = (event: string, listener?: Listener): Page => {
		if (listener) {
			rawOff(event, listener);
			const index = listeners.findLastIndex(entry => entry.event === event && entry.listener === listener);
			if (index >= 0) listeners.splice(index, 1);
		} else {
			for (const entry of listeners.splice(0).filter(entry => entry.event === event)) {
				rawOff(entry.event, entry.listener);
			}
		}
		return page;
	};
	const downloadListener = (download: Download): void => {
		downloads.add(download);
	};
	rawOn("download", downloadListener);

	Object.defineProperties(page, {
		on: { configurable: true, value: (event: string, listener: Listener) => remember(event, listener) },
		addListener: { configurable: true, value: (event: string, listener: Listener) => remember(event, listener) },
		prependListener: {
			configurable: true,
			value: (event: string, listener: Listener) => remember(event, listener, true),
		},
		once: {
			configurable: true,
			value: (event: string, listener: Listener): Page => {
				const wrapper: Listener = (...args) => {
					forget(event, wrapper);
					return listener(...args);
				};
				return remember(event, wrapper);
			},
		},
		off: { configurable: true, value: (event: string, listener?: Listener) => forget(event, listener) },
		removeAllListeners: {
			configurable: true,
			value: (event?: string): Page => {
				const removed =
					event === undefined ? listeners.splice(0) : listeners.filter(entry => entry.event === event);
				if (event !== undefined) {
					for (let i = listeners.length - 1; i >= 0; i--) {
						if (listeners[i]?.event === event) listeners.splice(i, 1);
					}
				}
				for (const entry of removed) rawOff(entry.event, entry.listener);
				return page;
			},
		},
		route: {
			configurable: true,
			value: async (url: PageRouteUrl, handler: PageRouteHandler, options?: { times?: number }): Promise<void> => {
				const wrapped: PageRouteHandler = async (route, request) => {
					activeRoutes.add(route);
					const finish = async (method: "abort" | "continue" | "fallback" | "fulfill", args: unknown[]) => {
						activeRoutes.delete(route);
						return await Reflect.apply(route[method], route, args);
					};
					const scopedRoute = new Proxy(route, {
						get(target, property, receiver) {
							if (
								property === "abort" ||
								property === "continue" ||
								property === "fallback" ||
								property === "fulfill"
							) {
								return (...args: unknown[]) => finish(property, args);
							}
							const value = Reflect.get(target, property, receiver);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
					await handler(scopedRoute, request);
				};
				routeHandlers.set(handler, wrapped);
				await Reflect.apply(methods.route, page, [url, wrapped, options]);
			},
		},
		unroute: {
			configurable: true,
			value: async (url: PageRouteUrl, handler?: PageRouteHandler): Promise<void> => {
				const wrapped = handler ? routeHandlers.get(handler) : undefined;
				await Reflect.apply(methods.unroute, page, [url, wrapped]);
				if (handler) routeHandlers.delete(handler);
			},
		},
		unrouteAll: {
			configurable: true,
			value: async (options?: { behavior?: "default" | "wait" | "ignoreErrors" }): Promise<void> => {
				await Reflect.apply(methods.unrouteAll, page, [options]);
				activeRoutes.clear();
				routeHandlers.clear();
			},
		},
	});

	return {
		page,
		async cleanup() {
			for (const [key, descriptor] of descriptors) {
				if (descriptor) Object.defineProperty(page, key, descriptor);
				else Reflect.deleteProperty(page, key);
			}
			for (const entry of listeners.splice(0)) rawOff(entry.event, entry.listener);
			rawOff("download", downloadListener);
			let cleanupIssue: unknown;
			try {
				await withTimeout(
					Promise.all([...activeRoutes].map(route => route.continue().catch(() => undefined))).then(
						() => undefined,
					),
					HELD_RESOURCE_CLEANUP_TIMEOUT_MS,
					"Timed out releasing held browser routes",
				);
			} catch (error) {
				cleanupIssue = error;
			}
			activeRoutes.clear();
			try {
				await withTimeout(
					Promise.all(
						[...downloads].map(async download => {
							await download.cancel().catch(() => undefined);
							await download.delete().catch(() => undefined);
						}),
					).then(() => undefined),
					HELD_RESOURCE_CLEANUP_TIMEOUT_MS,
					"Timed out disposing browser downloads",
				);
			} catch (error) {
				cleanupIssue ??= error;
			}
			if (!page.isClosed()) {
				try {
					await withTimeout(
						Reflect.apply(methods.unrouteAll, page, [{ behavior: "wait" }]),
						REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS,
						"Timed out clearing browser request routes",
					);
				} catch (error) {
					if (!page.isClosed()) {
						cleanupIssue ??= error;
						await withTimeout(
							Promise.resolve(Reflect.apply(methods.unrouteAll, page, [{ behavior: "ignoreErrors" }])),
							FORCED_ROUTE_CLEANUP_TIMEOUT_MS,
							"Timed out forcing browser route cleanup",
						).catch(() => undefined);
					}
				}
			}
			if (cleanupIssue) {
				throw new BrowserResourceCleanupError("Failed to clean browser resources after browser.run", {
					error: cleanupIssue instanceof Error ? cleanupIssue.message : String(cleanupIssue),
				});
			}
		},
	};
}

function errorPayload(error: unknown): RunErrorPayload {
	const recoverTab = error instanceof BrowserResourceCleanupError || undefined;
	if (error instanceof ToolAbortError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: true };
	}
	if (error instanceof ToolError) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isToolError: true,
			isAbort: false,
			recoverTab,
		};
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: false };
	}
	return { name: "Error", message: String(error), isToolError: false, isAbort: false };
}

function replyError(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Tool call aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const Ctor = payload.isToolError ? ToolError : Error;
	const err = new Ctor(payload.message);
	if (payload.name) err.name = payload.name;
	if (payload.stack) err.stack = payload.stack;
	return err;
}

async function resolveCdpWebSocketUrl(endpoint: string, timeoutMs: number): Promise<string> {
	if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
		return endpoint;
	}
	const cleanEndpoint = endpoint.replace(/\/+$/, "");
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${cleanEndpoint}/json/version`, { signal: controller.signal });
		if (!res.ok) throw new ToolError(`CDP /json/version request failed with status ${res.status}`);
		const data = (await res.json()) as { webSocketDebuggerUrl?: string };
		if (!data.webSocketDebuggerUrl) {
			throw new ToolError("CDP /json/version response did not contain webSocketDebuggerUrl");
		}
		return data.webSocketDebuggerUrl;
	} catch (error) {
		if (controller.signal.aborted) {
			throw new ToolError(`Timed out retrieving WebSocket URL from ${cleanEndpoint} after ${timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function createCdpWebSocketTransport(wsUrl: string, timeoutMs: number): Promise<ConnectOverCDPTransport> {
	const ws = new WebSocket(wsUrl);
	const transport: ConnectOverCDPTransport = {
		send(message: object) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(message));
			}
		},
		close() {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
				ws.close();
			}
		},
		onmessage: undefined,
		onclose: undefined,
	};
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			try {
				ws.close();
			} catch {}
			reject(new ToolError(`WebSocket connection to ${wsUrl} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		function onOpen(): void {
			cleanup();
			resolve();
		}
		function onError(): void {
			cleanup();
			reject(new ToolError(`WebSocket connection error to ${wsUrl}`));
		}
		function cleanup(): void {
			clearTimeout(timer);
			ws.removeEventListener("open", onOpen);
			ws.removeEventListener("error", onError);
		}
		ws.addEventListener("open", onOpen);
		ws.addEventListener("error", onError);
	});
	ws.addEventListener("message", event => {
		try {
			const data =
				typeof event.data === "string"
					? JSON.parse(event.data)
					: JSON.parse(new TextDecoder().decode(event.data as ArrayBuffer));
			transport.onmessage?.(data);
		} catch {
			// ignore malformed payloads
		}
	});
	ws.addEventListener("close", event => {
		transport.onclose?.(event.reason);
	});
	return transport;
}

export async function connectOverCdp(cdpEndpoint: string, timeoutMs: number = 30_000): Promise<Browser> {
	const wsUrl = await resolveCdpWebSocketUrl(cdpEndpoint, Math.max(timeoutMs, 5_000));
	const transport = await createCdpWebSocketTransport(wsUrl, Math.max(timeoutMs, 5_000));
	return await chromium.connectOverCDP(transport);
}

async function targetIdForPage(context: BrowserContext, page: Page): Promise<string> {
	const session = await context.newCDPSession(page);
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

interface ObservedNode {
	role: string;
	name?: string;
	value?: string;
	description?: string;
	keyshortcuts?: string;
	disabled?: boolean;
	checked?: boolean | "mixed";
	pressed?: boolean | "mixed";
	selected?: boolean;
	expanded?: boolean;
	required?: boolean;
	readonly?: boolean;
	multiselectable?: boolean;
	multiline?: boolean;
	modal?: boolean;
	focused?: boolean;
}

async function collectObservationEntries(
	core: WorkerCore,
	page: Page,
	entries: ObservationEntry[],
	options: { viewportOnly: boolean; includeAll: boolean },
): Promise<void> {
	const selector = options.includeAll
		? "body *"
		: '[role],a[href],button,input,select,option,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
	const handles = await page.locator(selector).elementHandles();
	for (const handle of handles) {
		let keep = false;
		try {
			const node = await handle.evaluate(element => {
				const el = element as unknown as HTMLElement & {
					tagName: string;
					innerText?: string;
					textContent?: string | null;
					getAttribute(name: string): string | null;
					matches(selector: string): boolean;
					disabled?: boolean;
					checked?: boolean;
					value?: string;
					selected?: boolean;
					readOnly?: boolean;
					required?: boolean;
					multiple?: boolean;
					labels?: ArrayLike<{ innerText?: string; textContent?: string | null }>;
				};
				const tag = el.tagName.toLowerCase();
				const explicitRole = el.getAttribute("role");
				const inputType = el.getAttribute("type")?.toLowerCase();
				const role =
					explicitRole ??
					(tag === "a"
						? "link"
						: tag === "button" || tag === "summary" || inputType === "button" || inputType === "submit"
							? "button"
							: inputType === "checkbox"
								? "checkbox"
								: inputType === "radio"
									? "radio"
									: inputType === "search"
										? "searchbox"
										: inputType === "number"
											? "spinbutton"
											: inputType === "range"
												? "slider"
												: tag === "select"
													? el.multiple
														? "listbox"
														: "combobox"
													: tag === "textarea" || tag === "input"
														? "textbox"
														: tag);
				const attr = (name: string): string | null => el.getAttribute(name);
				const bool = (name: string): boolean | undefined => {
					const value = attr(name);
					return value === null ? undefined : value === "true";
				};
				const tristate = (name: string): boolean | "mixed" | undefined => {
					const value = attr(name);
					return value === null ? undefined : value === "mixed" ? "mixed" : value === "true";
				};
				const labelText = el.labels
					? Array.from(el.labels)
							.map(label => label.innerText ?? label.textContent ?? "")
							.join(" ")
							.trim()
					: "";
				return {
					role,
					name:
						attr("aria-label") ??
						(labelText || undefined) ??
						attr("placeholder") ??
						attr("alt") ??
						attr("title") ??
						(el.innerText ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500),
					value: el.value,
					description: attr("aria-description") ?? undefined,
					keyshortcuts: attr("aria-keyshortcuts") ?? undefined,
					disabled: el.disabled || bool("aria-disabled"),
					checked: el.checked ?? tristate("aria-checked"),
					pressed: tristate("aria-pressed"),
					selected: el.selected ?? bool("aria-selected"),
					expanded: bool("aria-expanded"),
					required: el.required || bool("aria-required"),
					readonly: el.readOnly || bool("aria-readonly"),
					multiselectable: bool("aria-multiselectable"),
					multiline: bool("aria-multiline"),
					modal: bool("aria-modal"),
					focused: el.matches(":focus"),
				} satisfies ObservedNode;
			});
			if (!options.includeAll && !isInteractiveNode(node)) continue;
			if (options.viewportOnly) {
				const box = await handle.boundingBox();
				const viewport = page.viewportSize();
				if (
					!box ||
					!viewport ||
					box.x + box.width <= 0 ||
					box.y + box.height <= 0 ||
					box.x >= viewport.width ||
					box.y >= viewport.height
				) {
					continue;
				}
			}
			const id = core.nextElementId();
			const states: string[] = [];
			if (node.disabled) states.push("disabled");
			if (node.checked !== undefined) states.push(`checked=${String(node.checked)}`);
			if (node.pressed !== undefined) states.push(`pressed=${String(node.pressed)}`);
			if (node.selected !== undefined) states.push(`selected=${String(node.selected)}`);
			if (node.expanded !== undefined) states.push(`expanded=${String(node.expanded)}`);
			if (node.required) states.push("required");
			if (node.readonly) states.push("readonly");
			if (node.multiselectable) states.push("multiselectable");
			if (node.multiline) states.push("multiline");
			if (node.modal) states.push("modal");
			if (node.focused) states.push("focused");
			core.cacheElement(id, handle);
			keep = true;
			entries.push({
				id,
				role: node.role,
				name: node.name,
				value: node.value,
				description: node.description,
				keyshortcuts: node.keyshortcuts,
				states,
			});
		} finally {
			if (!keep) await handle.dispose().catch(() => undefined);
		}
	}
}

/**
 * Hint appended to a selector op's fail-fast timeout, given the selector's current
 * match count: a missing element (consent wall, wrong page) reads differently from
 * a present-but-unactionable one.
 */
export function formatSelectorMatchHint(count: number): string {
	return count === 0
		? "; selector currently matches no elements — run tab.observe() or tab.ariaSnapshot() to inspect the page"
		: `; selector currently matches ${count} element(s) but the action never became possible — the element may be hidden or covered (try tab.scrollIntoView() or a more specific selector)`;
}

export interface InflightOp {
	label: string;
	startedAt: number;
}

interface ActiveRun {
	id: string;
	ac: AbortController;
	signal: AbortSignal;
	output: RunOutput;
	screenshots: ScreenshotResult[];
	pendingTools: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
	rejectionOwner: object;
	floatingRejections: unknown[];
	floatingFailure: { promise: Promise<never>; reject(reason?: unknown): void };
	/** Element handles returned to user code and disposed when this run ends. */
	handles: Set<ElementHandle>;
	/** Helper invocations currently awaiting the page/network, keyed by op id. */
	inflight: Map<number, InflightOp>;
	opCounter: number;
}

/** Human-readable label for a screenshot op, used in op tracking + timeout errors. */
export function describeScreenshot(opts?: ScreenshotOptions): string {
	if (opts?.selector) return `tab.screenshot({ selector: ${JSON.stringify(opts.selector)} })`;
	if (opts?.fullPage) return "tab.screenshot({ fullPage: true })";
	return "tab.screenshot()";
}
export async function preparePageForScreenshot(
	page: Pick<Page, "bringToFront" | "evaluate">,
	signal: AbortSignal | undefined,
	activate: boolean,
): Promise<void> {
	if (activate) {
		await untilAborted(signal, () => page.bringToFront()).catch(() => undefined);
		return;
	}
	const visible = await untilAborted(signal, () => page.evaluate(() => document.visibilityState === "visible")).catch(
		() => false,
	);
	if (!visible) {
		throw new ToolError("The attached browser tab is not visible; switch to it before taking a screenshot");
	}
}

/** Summarize still-running helpers (oldest first) so a cell timeout names what stalled. */
export function describeInflight(inflight: Map<number, InflightOp>): string {
	const now = Date.now();
	return [...inflight.values()]
		.sort((a, b) => a.startedAt - b.startedAt)
		.map(op => `${op.label} (${((now - op.startedAt) / 1000).toFixed(1)}s)`)
		.join(", ");
}

export class WorkerCore {
	#transport: Transport;
	#browser?: Browser;
	#context?: BrowserContext;
	#page?: Page;
	#targetId?: string;
	#elementCache = new Map<number, ElementHandle>();
	#elementCounter = 0;
	#active: ActiveRun | null = null;
	#runtime: JsRuntime | null = null;
	#unsub: () => void;
	#isolated: boolean;
	#uninstallRejectionGuard: () => void;
	#mode?: WorkerInitPayload["mode"];
	#activateForScreenshot = true;
	#dialogPolicy?: DialogPolicy;
	#dialogHandler?: (dialog: Dialog) => void;
	#dialogObserver?: (dialog: Dialog) => void;
	#navigationObserver?: (frame: Frame) => void;
	#openDialog?: OpenDialogInfo;

	constructor(transport: Transport, isolated: boolean) {
		this.#transport = transport;
		this.#isolated = isolated;
		this.#unsub = this.#transport.onMessage(msg => {
			void this.#handleMessage(msg as WorkerInbound);
		});
		this.#uninstallRejectionGuard = this.#installRejectionGuard();
	}

	#installRejectionGuard(): () => void {
		if (!this.#isolated) {
			return postmortem.interceptUnhandledRejections(reason => this.#consumeUnhandledRejection(reason));
		}
		return installBrowserWorkerRejectionGuard(reason => this.#consumeUnhandledRejection(reason));
	}

	#consumeUnhandledRejection(reason: unknown): boolean {
		const active = this.#active;
		if (!active) return false;
		if (!isBrowserRunOwnedRejection(reason, active.rejectionOwner, `browser-run-${active.id}.js`)) return false;
		this.#recordFloatingRejection(active, reason);
		return true;
	}

	#recordFloatingRejection(active: ActiveRun, reason: unknown): void {
		if (postmortem.isExpectedCleanupError(reason)) return;
		if (this.#active !== active) {
			this.#log("warn", "Unhandled rejection after browser run ended", {
				runId: active.id,
				error: reason instanceof Error ? reason.message : String(reason),
			});
			return;
		}
		const isFirst = active.floatingRejections.length === 0;
		active.floatingRejections.push(reason);
		if (isFirst) active.floatingFailure.reject(this.#floatingRejectionError(reason));
	}

	#floatingRejectionError(reason: unknown): Error {
		const message = reason instanceof Error ? reason.message : String(reason);
		const error = new Error(`Unhandled rejection (missing await?): ${message}`, { cause: reason });
		if (reason instanceof Error) error.name = reason.name;
		return error;
	}

	#foldFloatingRejections(active: ActiveRun, failure: { error: unknown } | undefined): { error: unknown } | undefined {
		const rejections = active.floatingRejections;
		if (rejections.length === 0) return failure;
		let reported = rejections;
		if (!failure) {
			failure = { error: this.#floatingRejectionError(rejections[0]) };
			reported = rejections.slice(1);
		} else if (failure.error instanceof Error && failure.error.cause === rejections[0]) {
			reported = rejections.slice(1);
		}
		for (const reason of reported) {
			this.#log("warn", "Additional unhandled browser-run rejection", {
				error: reason instanceof Error ? reason.message : String(reason),
			});
		}
		return failure;
	}

	nextElementId(): number {
		this.#elementCounter += 1;
		return this.#elementCounter;
	}

	cacheElement(id: number, handle: ElementHandle): void {
		this.#elementCache.set(id, handle);
	}

	async #handleMessage(msg: WorkerInbound): Promise<void> {
		switch (msg.type) {
			case "init":
				await this.#init(msg.payload);
				return;
			case "run":
				await this.#run(msg);
				return;
			case "abort":
				if (this.#active?.id === msg.id) {
					const reason = msg.expectedCleanup
						? postmortem.markExpectedCleanupError(new ToolAbortError())
						: new ToolAbortError();
					this.#active.ac.abort(reason);
				}
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				await this.#close();
				return;
		}
	}

	async #init(payload: WorkerInitPayload): Promise<void> {
		try {
			this.#mode = payload.mode;
			this.#activateForScreenshot = payload.mode === "headless" || payload.activateForScreenshot !== false;
			this.#browser = await connectOverCdp(payload.cdpEndpoint, payload.timeoutMs);
			const context = this.#browser.contexts()[0];
			if (!context) throw new ToolError("Connected browser has no default context");
			this.#context = context;
			if (payload.mode === "headless") {
				this.#page = await context.newPage();
				this.#observeDialogs();
				await applyStealthPatches(this.#browser, this.#page);
				await applyViewport(this.#page, payload.viewport);
				if (payload.dialogs) await this.#applyDialogPolicy(payload.dialogs);
			} else {
				const page = await this.#findAttachedPage(payload.targetId);
				if (payload.recover) await this.#recoverAttachedPage(page);
				this.#page = page;
				await this.#claimRelayTarget(page);
				this.#observeDialogs();
				if (payload.dialogs) await this.#applyDialogPolicy(payload.dialogs);
			}
			if (payload.url) {
				await this.#navigatePage(payload.url, payload.waitUntil ?? "load", payload.timeoutMs);
			}
			this.#targetId = await targetIdForPage(this.#context, this.#page);
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#transport.send({ type: "init-failed", error: errorPayload(error) });
		}
	}

	async #findAttachedPage(targetId: string): Promise<Page> {
		const browser = this.#requireBrowser();
		for (const context of browser.contexts()) {
			for (const page of context.pages()) {
				if ((await targetIdForPage(context, page).catch(() => "")) === targetId) {
					this.#context = context;
					return page;
				}
			}
		}
		throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
	}

	/**
	 * Tell the omp browser relay this worker drives the adopted page, so the
	 * relay adds it to the per-window "omp" tab group. Best-effort: plain CDP
	 * backends reject the relay-private method.
	 */
	async #claimRelayTarget(page: Page): Promise<void> {
		let session: CDPSession | undefined;
		try {
			session = await this.#requireContext().newCDPSession(page);
			await session.send("OMP.claimTarget" as never);
		} catch {
			// Not the omp relay; nothing to claim.
		} finally {
			await session?.detach().catch(() => undefined);
		}
	}

	/** Best-effort unblocking of a wedged exact target during post-timeout recovery. */
	async #recoverAttachedPage(page: Page): Promise<void> {
		let session: CDPSession | undefined;
		try {
			session = await this.#requireContext().newCDPSession(page);
			await session.send("Page.enable").catch(() => undefined);
			await session.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
			await session.send("Page.stopLoading").catch(() => undefined);
			await session.send("Fetch.disable").catch(() => undefined);
		} catch (error) {
			this.#log("debug", "Recovery CDP session failed; proceeding with attach", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			await session?.detach().catch(() => undefined);
		}
	}

	/**
	 * Record JS dialogs for timeout attribution without handling them (semantics of an
	 * unset `dialogs` policy are unchanged — the page stays blocked until user code or
	 * the policy handler acts). Cleared when the policy handler settles the dialog or a
	 * main-frame navigation proves the modal is gone.
	 */
	#observeDialogs(): void {
		const page = this.#requirePage();
		this.#dialogObserver = dialog => {
			this.#openDialog = { type: dialog.type(), message: dialog.message() };
		};
		this.#navigationObserver = frame => {
			if (frame === page.mainFrame()) this.#openDialog = undefined;
		};
		page.on("dialog", this.#dialogObserver);
		page.on("framenavigated", this.#navigationObserver);
	}

	async #currentReadyInfo(): Promise<ReadyInfo> {
		const page = this.#requirePage();
		const targetId = this.#targetId ?? (await targetIdForPage(this.#requireContext(), page));
		this.#targetId = targetId;
		return {
			url: redactUrlCredentials(page.url()),
			title: await page.title().catch(() => undefined),
			viewport: page.viewportSize() ?? DEFAULT_VIEWPORT,
			targetId,
		};
	}

	async #applyDialogPolicy(policy: DialogPolicy): Promise<void> {
		const page = this.#requirePage();
		if (this.#dialogPolicy === policy && this.#dialogHandler) return;
		if (this.#dialogHandler) page.off("dialog", this.#dialogHandler);
		const handler = (dialog: Dialog): void => {
			const action = policy === "accept" ? dialog.accept() : dialog.dismiss();
			void action.then(
				() => {
					this.#openDialog = undefined;
				},
				err =>
					this.#log("debug", "Dialog auto-handler failed", {
						policy,
						error: err instanceof Error ? err.message : String(err),
					}),
			);
		};
		page.on("dialog", handler);
		this.#dialogPolicy = policy;
		this.#dialogHandler = handler;
		const session = await this.#requireContext()
			.newCDPSession(page)
			.catch(() => undefined);
		try {
			await session?.send("Page.handleJavaScriptDialog", { accept: policy === "accept" }).catch(() => undefined);
		} finally {
			await session?.detach().catch(() => undefined);
		}
	}

	async #navigatePage(
		url: string,
		waitUntil: PublicWaitUntil,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<HTTPResponse | null> {
		const page = this.#requirePage();
		try {
			if (waitUntil === "networkidle2") {
				return await withNetworkIdle2(
					page,
					() => page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs, signal }),
					timeoutMs,
					signal,
				);
			}
			return await page.goto(url, { waitUntil: playwrightWaitUntil(waitUntil), timeout: timeoutMs, signal });
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") {
				throw new ToolError(`Navigation timeout of ${timeoutMs} ms exceeded: ${error.message}`);
			}
			throw error;
		}
	}

	async #postReadyInfo(): Promise<void> {
		try {
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#log("debug", "Failed to refresh tab info", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #run(msg: Extract<WorkerInbound, { type: "run" }>): Promise<void> {
		if (this.#active) {
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: false,
				error: errorPayload(new ToolError("Tab worker is busy")),
			});
			return;
		}
		const timeoutSignal = AbortSignal.timeout(msg.timeoutMs);
		const ac = new AbortController();
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
		const output = new RunOutput();
		const screenshots: ScreenshotResult[] = [];
		const floatingFailure = Promise.withResolvers<never>();
		const active: ActiveRun = {
			id: msg.id,
			ac,
			signal,
			output,
			screenshots,
			pendingTools: new Map(),
			rejectionOwner: {},
			floatingRejections: [],
			floatingFailure,
			handles: new Set(),
			inflight: new Map(),
			opCounter: 0,
		};
		this.#active = active;
		let completed = false;
		let returnValue: unknown;
		let failure: { error: unknown } | undefined;
		let runPage: RunPageScope | undefined;
		try {
			throwIfAborted(signal);
			runPage = createRunPageScope(this.#requirePage());
			const browser = this.#requireBrowser();
			const runBrowser = new Proxy(browser, {
				get(target, property, receiver) {
					if (property === "close") {
						return async () => {
							throw new ToolError("browser.close() is disabled because the connected browser is shared");
						};
					}
					const value = Reflect.get(target, property, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const tabApi = this.#createTabApi(msg.name, msg.timeoutMs, signal, msg.session, output, screenshots, active);
			const runtime = this.#ensureRuntime(msg.session);
			runtime.setCwd(msg.session.cwd);
			const onFloatingRejection = (reason: unknown): void => this.#recordFloatingRejection(active, reason);
			runtime.setRunScope({
				page: bindRunFacade(runPage.page, signal, active.rejectionOwner, onFloatingRejection),
				browser: bindRunFacade(runBrowser, signal, active.rejectionOwner, onFloatingRejection),
				tab: bindRunFacade(tabApi, signal, active.rejectionOwner, onFloatingRejection),
				assert: (cond: unknown, text?: string): void => {
					if (!cond) throw new ToolError(text ?? "Assertion failed");
				},
				// Both wait forms register in the in-flight map so a cell that dies while
				// sleeping/polling names the culprit instead of a bare whole-cell timeout.
				wait: (msOrPredicate: number | (() => unknown), opts?: WaitPredicateOptions): Promise<unknown> => {
					const label = typeof msOrPredicate === "number" ? `wait(${msOrPredicate}ms)` : "wait(predicate)";
					const resolved =
						typeof msOrPredicate === "number"
							? undefined
							: { timeout: resolvePredicateTimeout(msg.timeoutMs, opts?.timeout), interval: opts?.interval };
					return observeBrowserRunPromise(
						this.#runOp(active, label, signal, Number.POSITIVE_INFINITY, sig =>
							waitForRun(msOrPredicate, sig, resolved),
						),
						active.rejectionOwner,
						onFloatingRejection,
					);
				},
			});
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				const abortError =
					signal.reason instanceof ToolAbortError
						? signal.reason
						: new ToolAbortError(undefined, { cause: signal.reason });
				if (timeoutSignal.aborted) {
					const stalled = describeInflight(active.inflight);
					const dialog = this.#openDialog;
					const dialogNote = dialog
						? `; a ${dialog.type}(${JSON.stringify(dialog.message.slice(0, 80))}) dialog opened during this run and may still block the page — reopen the tab with dialogs:"accept"|"dismiss" or handle page.on('dialog')`
						: "";
					rejectCancel(
						new ToolError(
							`Browser code execution timed out after ${msg.timeoutMs}ms${stalled ? ` (stalled on ${stalled})` : ""}${dialogNote}`,
						),
					);
				} else {
					rejectCancel(abortError);
				}
				// Cancel in-flight tool calls so user code's awaited proxies reject promptly.
				const toolAbort = timeoutSignal.aborted
					? postmortem.markExpectedCleanupError(new ToolAbortError(undefined, { cause: timeoutSignal.reason }))
					: abortError;
				for (const pending of active.pendingTools.values()) {
					pending.reject(toolAbort);
				}
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				const hooks = this.#hooksForActiveRun();
				if (!hooks) throw new ToolError("Browser runtime started without an active run");
				returnValue = await withBrowserPromiseCombinatorTracking(
					active.rejectionOwner,
					onFloatingRejection,
					async () =>
						await Promise.race([
							runtime.run(msg.code, `browser-run-${msg.id}.js`, hooks, {
								runId: msg.id,
								cwd: msg.session.cwd,
							}),
							cancelRejection,
							floatingFailure.promise,
						]),
				);
				completed = true;
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			failure = { error };
		} finally {
			runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Browser run ended")));
			await Bun.sleep(0);
			try {
				await withTimeout(
					Promise.all([...active.handles].map(handle => handle.dispose().catch(() => undefined))).then(
						() => undefined,
					),
					HELD_RESOURCE_CLEANUP_TIMEOUT_MS,
					"Timed out disposing browser-run handles",
				);
			} catch (error) {
				failure = {
					error: new BrowserResourceCleanupError("Failed to dispose browser-run handles", { error }),
				};
			}
			active.handles.clear();
			try {
				await runPage?.cleanup();
			} catch (error) {
				failure = { error };
			}
			failure = this.#foldFloatingRejections(active, failure);
			if (this.#active?.id === msg.id) this.#active = null;
		}
		if (failure) {
			this.#transport.send({ type: "result", id: msg.id, ok: false, error: errorPayload(failure.error) });
			return;
		}
		if (completed) {
			await this.#postReadyInfo();
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: true,
				payload: { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots },
			});
		}
	}

	#ensureRuntime(session: SessionSnapshot): JsRuntime {
		if (this.#runtime) return this.#runtime;
		this.#runtime = new JsRuntime({
			initialCwd: session.cwd,
			sessionId: `browser-tab-${this.#targetId ?? "unknown"}`,
		});
		return this.#runtime;
	}

	#hooksForActiveRun(): RuntimeHooks | null {
		const active = this.#active;
		if (!active) return null;
		return {
			onText: chunk => {
				throwIfAborted(active.signal);
				active.output.pushText(chunk);
				this.#log("debug", chunk.replace(/\n$/, ""));
			},
			onDisplay: output => {
				throwIfAborted(active.signal);
				active.output.pushDisplay(output);
			},
			callTool: (name, args) => {
				throwIfAborted(active.signal);
				return this.#callTool(active, name, args);
			},
		};
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `tab-tc-${active.id}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const active = this.#active;
		if (!active) return;
		const pending = active.pendingTools.get(id);
		if (!pending) return;
		active.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	/**
	 * Wrap a tab helper so it (a) registers in the active run's in-flight map for
	 * timeout diagnostics and (b) honors an optional per-op deadline that fails fast
	 * with a named error instead of silently consuming the whole cell budget. Pass
	 * `Number.POSITIVE_INFINITY` for `perOpTimeoutMs` to bound the op only by the cell
	 * budget (used for `evaluate` running user code and for locator helpers that carry
	 * Playwright's own operation timeout). When the op targets a `selector`, the
	 * fail-fast timeout carries a best-effort match-count hint, and — when
	 * `zeroMatchAfterMs` is set — a watchdog aborts the op early once the selector has
	 * matched nothing for that long.
	 */
	async #runOp<T>(
		active: ActiveRun,
		label: string,
		cellSignal: AbortSignal,
		perOpTimeoutMs: number,
		fn: (signal: AbortSignal) => Promise<T>,
		opts?: { selector?: string; zeroMatchAfterMs?: number },
	): Promise<T> {
		const opId = active.opCounter++;
		active.inflight.set(opId, { label, startedAt: Date.now() });
		const capped = Number.isFinite(perOpTimeoutMs) && perOpTimeoutMs > 0;
		const opTimeout = capped ? AbortSignal.timeout(perOpTimeoutMs) : undefined;
		const opSignal = opTimeout ? AbortSignal.any([cellSignal, opTimeout]) : cellSignal;
		const selector = opts?.selector;
		const watchdog =
			selector !== undefined && opts?.zeroMatchAfterMs !== undefined && parseAriaRefSelector(selector) === null
				? { selector, afterMs: opts.zeroMatchAfterMs }
				: undefined;
		// Fired when the watchdog wins the race (tears down the in-flight action) and in
		// the finally (stops the watchdog's polling once the op settles either way).
		const earlyAc = new AbortController();
		try {
			if (!watchdog) return await fn(opSignal);
			const racedSignal = AbortSignal.any([opSignal, earlyAc.signal]);
			return await Promise.race([
				fn(racedSignal),
				this.#zeroMatchWatchdog(watchdog.selector, label, watchdog.afterMs, racedSignal),
			]);
		} catch (err) {
			// our per-op deadline fired, or Playwright's own (equal) timeout fired first —
			// after the operation signal has already torn down the pending action.
			// Cell-budget aborts and uncapped helpers (goto/evaluate) keep their native errors.
			if (
				capped &&
				!cellSignal.aborted &&
				(opTimeout?.aborted || (err instanceof Error && err.name === "TimeoutError"))
			) {
				const hint = selector ? await this.#selectorTimeoutHint(selector) : "";
				throw markBrowserRunRejection(
					new ToolError(`${label} timed out after ${perOpTimeoutMs}ms${hint}`),
					active.rejectionOwner,
				);
			}
			throw markBrowserRunRejection(err, active.rejectionOwner);
		} finally {
			earlyAc.abort();
			active.inflight.delete(opId);
		}
	}

	/**
	 * Fail-fast arm raced against a selector op: rejects once the selector has matched
	 * nothing for the whole `afterMs` window, so a wrong selector or wrong page (consent
	 * wall, pre-navigation document) costs ~2s instead of the full action deadline.
	 * Disarms — hangs until the settled race drops it — the moment at least one element
	 * matches; an inconclusive probe (mid-navigation, detached frame) never counts
	 * toward the zero-match window.
	 */
	async #zeroMatchWatchdog(selector: string, label: string, afterMs: number, signal: AbortSignal): Promise<never> {
		const page = this.#requirePage();
		const deadline = Date.now() + afterMs;
		while (!signal.aborted) {
			let count: number | null = null;
			try {
				count = await locatorForSelector(page, selector).count();
			} catch {
				// Inconclusive probe — keep polling without advancing toward failure.
			}
			if (count !== null && count > 0) break;
			if (count === 0 && Date.now() >= deadline) {
				throw new ToolError(`${label} failed fast after ${afterMs}ms${formatSelectorMatchHint(0)}`);
			}
			try {
				await untilAborted(signal, () => Bun.sleep(ZERO_MATCH_POLL_MS));
			} catch {
				break;
			}
		}
		return await new Promise<never>(() => {});
	}

	/**
	 * Best-effort match-count probe for a timed-out selector op. Never throws;
	 * empty string when the probe fails, stalls, or the selector is an aria-ref.
	 */
	async #selectorTimeoutHint(selector: string): Promise<string> {
		if (parseAriaRefSelector(selector) !== null) return "";
		try {
			const count = await Promise.race([
				locatorForSelector(this.#requirePage(), selector).count(),
				Bun.sleep(1_000).then(() => null),
			]);
			if (count === null) return "";
			return formatSelectorMatchHint(count);
		} catch {
			return "";
		}
	}

	#createTabApi(
		name: string,
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		active: ActiveRun,
	): TabApi {
		const page = this.#requirePage();
		const { budgetBound, quickOpMs, actionOpMs } = resolveOpTimeouts(timeoutMs);
		const waitMs = (explicit?: number): number => resolveWaitTimeout(timeoutMs, explicit);
		const INF = Number.POSITIVE_INFINITY;
		const op = <T>(
			label: string,
			perOpMs: number,
			fn: (sig: AbortSignal) => Promise<T>,
			selectorOpts?: { selector?: string; zeroMatchAfterMs?: number },
		): Promise<T> => markHandled(this.#runOp(active, label, signal, perOpMs, fn, selectorOpts));
		return {
			name,
			page,
			signal,
			url: () => page.url(),
			title: () => op("tab.title()", INF, sig => untilAborted(sig, () => page.title())),
			goto: (url, opts) =>
				op(`tab.goto(${JSON.stringify(url)})`, INF, async sig => {
					await this.#clearElementCache();
					try {
						await untilAborted(sig, () => this.#navigatePage(url, opts?.waitUntil ?? "load", budgetBound, sig));
					} catch (err) {
						if (err instanceof Error && err.name === "TimeoutError") {
							await this.#stopLoading();
							throw new ToolError(
								`tab.goto(${JSON.stringify(url)}) timed out after ${budgetBound}ms; pending navigation stopped — retry with a longer tool timeout or waitUntil:"domcontentloaded"`,
							);
						}
						throw err;
					}
				}),
			observe: opts => op("tab.observe()", quickOpMs, sig => this.#collectObservation({ ...opts, signal: sig })),
			ariaSnapshot: (selector, opts) =>
				op(
					selector ? `tab.ariaSnapshot(${JSON.stringify(selector)})` : "tab.ariaSnapshot()",
					quickOpMs,
					async sig => {
						let root: ElementHandle | null = null;
						if (selector) {
							root =
								parseAriaRefSelector(selector) !== null
									? await this.#resolveAriaRef(selector)
									: await untilAborted(sig, () =>
											locatorForSelector(page, selector).elementHandle({ timeout: quickOpMs }),
										);
						}
						try {
							return await untilAborted(sig, () => captureAriaSnapshot(page, root, opts));
						} finally {
							await root?.dispose().catch(() => undefined);
						}
					},
				),
			screenshot: opts =>
				op(describeScreenshot(opts), quickOpMs, sig =>
					this.#captureScreenshot(session, output, screenshots, sig, opts),
				),
			extract: (format = "markdown") =>
				op(`tab.extract(${JSON.stringify(format)})`, quickOpMs, async sig => {
					const html = (await untilAborted(sig, () => page.content())) as string;
					const result = await extractReadableFromHtml(html, page.url(), format);
					if (!result) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) found no readable content on ${page.url()}`,
						);
					}
					const content = format === "markdown" ? result.markdown : result.text;
					if (!content) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${page.url()}`,
						);
					}
					return content;
				}),
			click: selector =>
				op(
					`tab.click(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						if (parseAriaRefSelector(selector) !== null) {
							const handle = await this.#resolveAriaRef(selector);
							try {
								await untilAborted(sig, () => handle.click());
							} finally {
								await handle.dispose().catch(() => undefined);
							}
							return;
						}
						await untilAborted(sig, () =>
							locatorForSelector(page, selector).click({ timeout: actionOpMs, signal: sig }),
						);
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			type: (selector, text) =>
				op(
					`tab.type(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await untilAborted(sig, () => handle.type(text, { delay: 0 }));
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			fill: (selector, value) =>
				op(
					`tab.fill(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						if (parseAriaRefSelector(selector) !== null) {
							const handle = await this.#resolveAriaRef(selector);
							try {
								await fillViaHandle(handle, value, sig);
							} finally {
								await handle.dispose().catch(() => undefined);
							}
							return;
						}
						await untilAborted(sig, () =>
							locatorForSelector(page, selector).fill(value, { timeout: actionOpMs, signal: sig }),
						);
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			press: (key, opts) =>
				op(
					`tab.press(${JSON.stringify(key)})`,
					actionOpMs,
					async sig => {
						const selector = opts?.selector;
						if (selector) {
							if (parseAriaRefSelector(selector) !== null) {
								const handle = await this.#resolveAriaRef(selector);
								try {
									await untilAborted(sig, () => handle.focus());
								} finally {
									await handle.dispose().catch(() => undefined);
								}
							} else
								await untilAborted(sig, () =>
									locatorForSelector(page, selector).focus({ timeout: actionOpMs, signal: sig }),
								);
						}
						await untilAborted(sig, () => page.keyboard.press(key));
					},
					opts?.selector ? { selector: opts.selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS } : undefined,
				),
			scroll: (deltaX, deltaY) =>
				op("tab.scroll()", actionOpMs, sig =>
					untilAborted(sig, () => dispatchScroll(() => page.mouse.wheel(deltaX, deltaY))),
				),
			drag: (from, to) => op("tab.drag()", actionOpMs, sig => this.#drag(from, to, sig)),
			waitFor: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitFor(${JSON.stringify(selector)})`,
					w,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, w, sig);
						active.handles.add(handle);
						return toActionableHandle(handle);
					},
					{ selector, zeroMatchAfterMs: opts?.timeout === undefined ? ZERO_MATCH_FAIL_FAST_MS : undefined },
				);
			},
			waitForSelector: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitForSelector(${JSON.stringify(selector)})`,
					w,
					async sig => {
						let handle: ElementHandle;
						if (parseAriaRefSelector(selector) !== null) {
							handle = await this.#resolveAriaRef(selector);
						} else {
							const locator = locatorForSelector(page, selector);
							const state = opts?.hidden ? "hidden" : opts?.visible ? "visible" : "attached";
							await untilAborted(sig, () => locator.waitFor({ state, timeout: w, signal: sig }));
							if (opts?.hidden) return null;
							handle = await locator.elementHandle({ timeout: w });
						}
						active.handles.add(handle);
						return toActionableHandle(handle);
					},
					{
						selector,
						// `hidden: true` waits for zero matches — that is success, never a fast-fail.
						zeroMatchAfterMs: opts?.timeout === undefined && !opts?.hidden ? ZERO_MATCH_FAIL_FAST_MS : undefined,
					},
				);
			},
			waitForNavigation: opts => {
				const w = waitMs(opts?.timeout);
				const waitUntil = opts?.waitUntil ?? "load";
				return op("tab.waitForNavigation()", w, sig =>
					waitUntil === "networkidle2"
						? withNetworkIdle2(
								page,
								() => page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: w, signal: sig }),
								w,
								sig,
							)
						: untilAborted(sig, () =>
								page.waitForNavigation({ waitUntil: playwrightWaitUntil(waitUntil), timeout: w, signal: sig }),
							),
				);
			},
			evaluate: (fn, ...args) =>
				op("tab.evaluate()", INF, sig =>
					untilAborted(sig, () =>
						typeof fn === "string"
							? page.evaluate(fn)
							: page.evaluate(
									({ source, values }) => {
										const callable = new Function(`return (${source})`)() as (...input: unknown[]) => unknown;
										return callable(...values);
									},
									{ source: fn.toString(), values: args },
								),
					),
				) as never,
			scrollIntoView: selector =>
				op(
					`tab.scrollIntoView(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await untilAborted(sig, () =>
								handle.evaluate(el => {
									const target = el as unknown as {
										scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void;
									};
									target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
								}),
							);
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			select: (selector, ...values) =>
				op(
					`tab.select(${JSON.stringify(selector)})`,
					actionOpMs,
					sig => this.#select(selector, values, actionOpMs, sig),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			uploadFile: (selector, ...filePaths) =>
				op(
					`tab.uploadFile(${JSON.stringify(selector)})`,
					actionOpMs,
					sig => this.#uploadFile(selector, filePaths, actionOpMs, sig, session),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			waitForUrl: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForUrl()", w, sig => this.#waitForUrl(pattern, w, sig));
			},
			waitForResponse: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForResponse()", w, sig => this.#waitForResponse(pattern, w, sig));
			},
			id: async id => toActionableHandle(await this.#resolveCachedHandle(id)),
			ref: async id => {
				const handle = await this.#resolveAriaRef(id);
				active.handles.add(handle);
				return toActionableHandle(handle);
			},
		};
	}

	async #collectObservation(options: {
		includeAll?: boolean;
		viewportOnly?: boolean;
		signal?: AbortSignal;
	}): Promise<Observation> {
		const page = this.#requirePage();
		await this.#clearElementCache();
		const includeAll = options.includeAll ?? false;
		const viewportOnly = options.viewportOnly ?? false;
		const entries: ObservationEntry[] = [];
		await untilAborted(options.signal, () =>
			collectObservationEntries(this, page, entries, { includeAll, viewportOnly }),
		);
		const scroll = (await untilAborted(options.signal, () =>
			page.evaluate(() => {
				const win = globalThis as unknown as {
					scrollX: number;
					scrollY: number;
					innerWidth: number;
					innerHeight: number;
					document: { documentElement: { scrollWidth: number; scrollHeight: number } };
				};
				const doc = win.document.documentElement;
				return {
					x: win.scrollX,
					y: win.scrollY,
					width: win.innerWidth,
					height: win.innerHeight,
					scrollWidth: doc.scrollWidth,
					scrollHeight: doc.scrollHeight,
				};
			}),
		)) as Observation["scroll"];
		return {
			url: page.url(),
			title: (await untilAborted(options.signal, () => page.title())) as string,
			viewport: page.viewportSize() ?? DEFAULT_VIEWPORT,
			scroll,
			elements: entries,
		};
	}

	async #captureScreenshot(
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		signal: AbortSignal | undefined,
		opts: ScreenshotOptions = {},
	): Promise<string> {
		const page = this.#requirePage();
		// Multiple tabs can share one Chromium (sibling headless tabs on a shared
		// endpoint, cdp/app attach). CDP `Page.captureScreenshot` reads the
		// compositor surface, which follows the *active* target: a backgrounded
		// page can stall waiting for a fresh frame (the 20s screenshot timeouts)
		// or hand back a sibling tab's pixels. Activate first; best-effort so an
		// already-active or freshly-closed target never fails the capture.
		//
		// For a user-driven browser, redundant activation would steal window focus.
		// The supervisor disables it only after adopting the visible tab; if the user
		// later switches away, reject capture rather than risk sibling-tab pixels.
		await preparePageForScreenshot(page, signal, this.#activateForScreenshot);
		const fullPage = opts.selector ? false : (opts.fullPage ?? false);
		const captureType = "png";
		const captureMime = "image/png" as const;
		let buffer: Buffer;
		if (opts.selector) {
			const handle =
				parseAriaRefSelector(opts.selector) !== null
					? await this.#resolveAriaRef(opts.selector)
					: await untilAborted(signal, () =>
							locatorForSelector(page, opts.selector!).elementHandle({ timeout: QUICK_OP_TIMEOUT_MS }),
						);
			try {
				await untilAborted(signal, () =>
					handle.evaluate(el => {
						const target = el as unknown as {
							scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void;
						};
						target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
					}),
				).catch(() => undefined);
				buffer = (await untilAborted(signal, () =>
					handle.screenshot({ type: captureType, timeout: QUICK_OP_TIMEOUT_MS }),
				)) as Buffer;
			} finally {
				await handle.dispose().catch(() => undefined);
			}
		} else {
			buffer = (await untilAborted(signal, () => page.screenshot({ type: captureType, fullPage }))) as Buffer;
		}
		const resized = await resizeImage(
			{ type: "image", data: buffer.toBase64(), mimeType: captureMime },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
		);
		const saveFullRes = !!session.browserScreenshotDir;
		const savedBuffer = saveFullRes ? buffer : resized.buffer;
		const savedMimeType = saveFullRes ? captureMime : resized.mimeType;
		const ext = savedMimeType === "image/webp" ? "webp" : savedMimeType === "image/jpeg" ? "jpg" : "png";
		const dest = session.browserScreenshotDir
			? path.join(
					session.browserScreenshotDir,
					`screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
				)
			: path.join(os.tmpdir(), `omp-sshots-${Snowflake.next()}.${ext}`);
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await Bun.write(dest, savedBuffer);
		const info: ScreenshotResult = {
			dest,
			mimeType: savedMimeType,
			bytes: savedBuffer.length,
			width: resized.width,
			height: resized.height,
		};
		screenshots.push(info);
		if (!opts.silent) {
			const lines = formatScreenshot({
				saveFullRes,
				savedMimeType,
				savedByteLength: savedBuffer.length,
				dest,
				resized,
			});
			output.push({ type: "text", text: lines.join("\n") });
			output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		return dest;
	}

	async #drag(from: DragTarget, to: DragTarget, signal: AbortSignal): Promise<void> {
		const page = this.#requirePage();
		const resolveDragPoint = async (
			target: DragTarget,
			role: "from" | "to",
		): Promise<{ x: number; y: number; handle?: ElementHandle }> => {
			if (typeof target === "string") {
				const handle =
					parseAriaRefSelector(target) !== null
						? await this.#resolveAriaRef(target)
						: await untilAborted(signal, () =>
								locatorForSelector(page, target).elementHandle({ timeout: ACTION_OP_TIMEOUT_MS }),
							);
				const box = (await untilAborted(signal, () => handle.boundingBox())) as {
					x: number;
					y: number;
					width: number;
					height: number;
				} | null;
				if (!box) {
					await handle.dispose().catch(() => undefined);
					throw new ToolError(`Drag ${role} element has no bounding box (likely not visible): ${target}`);
				}
				return { x: box.x + box.width / 2, y: box.y + box.height / 2, handle };
			}
			if (
				target !== null &&
				typeof target === "object" &&
				typeof (target as { x: unknown }).x === "number" &&
				typeof (target as { y: unknown }).y === "number"
			) {
				return { x: (target as { x: number }).x, y: (target as { y: number }).y };
			}
			throw new ToolError(
				`Drag ${role} must be a selector string or { x: number, y: number } point. Got: ${typeof target}`,
			);
		};
		const start = await resolveDragPoint(from, "from");
		let end: { x: number; y: number; handle?: ElementHandle } | undefined;
		try {
			end = await resolveDragPoint(to, "to");
			await untilAborted(signal, () => page.mouse.move(start.x, start.y));
			await untilAborted(signal, () => page.mouse.down());
			await untilAborted(signal, () => page.mouse.move(end!.x, end!.y, { steps: 12 }));
			await untilAborted(signal, () => page.mouse.up());
		} finally {
			if (start.handle) await start.handle.dispose().catch(() => undefined);
			if (end?.handle) await end.handle.dispose().catch(() => undefined);
		}
	}

	async #select(selector: string, values: string[], timeoutMs: number, signal: AbortSignal): Promise<string[]> {
		if (parseAriaRefSelector(selector) !== null) {
			const handle = await this.#resolveAriaRef(selector);
			try {
				return await untilAborted(signal, () => handle.selectOption(values, { timeout: timeoutMs, signal }));
			} finally {
				await handle.dispose().catch(() => undefined);
			}
		}
		return await untilAborted(signal, () =>
			locatorForSelector(this.#requirePage(), selector).selectOption(values, { timeout: timeoutMs, signal }),
		);
	}

	async #uploadFile(
		selector: string,
		filePaths: string[],
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
	): Promise<void> {
		if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
		const handle = await this.#resolveActionHandle(selector, timeoutMs, signal);
		try {
			const absolute = filePaths.map(filePath => resolveToCwd(filePath, session.cwd));
			const input = await handle.evaluate(el => ({
				tagName: (el as unknown as { tagName: string }).tagName,
				type: (el as unknown as { getAttribute(name: string): string | null }).getAttribute("type"),
			}));
			if (input.tagName !== "INPUT" || input.type?.toLowerCase() !== "file") {
				throw new ToolError(
					`tab.uploadFile() requires an <input type="file"> element (got <${input.tagName.toLowerCase()}>)`,
				);
			}
			await untilAborted(signal, () => handle.setInputFiles(absolute, { timeout: timeoutMs, signal }));
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	async #waitForUrl(pattern: string | RegExp, timeout: number, signal: AbortSignal): Promise<string> {
		const page = this.#requirePage();
		const isRegex = pattern instanceof RegExp;
		const handle = await untilAborted(signal, () =>
			page.waitForFunction(
				({ matcher, regex, flags }) => {
					const url = (globalThis as unknown as { location: { href: string } }).location.href;
					return regex ? new RegExp(matcher, flags).test(url) : url.includes(matcher);
				},
				{ matcher: isRegex ? pattern.source : pattern, regex: isRegex, flags: isRegex ? pattern.flags : "" },
				{ timeout, polling: 200 },
			),
		);
		await handle.dispose().catch(() => undefined);
		return page.url();
	}

	async #waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		timeout: number,
		signal: AbortSignal,
	): Promise<HTTPResponse> {
		const page = this.#requirePage();
		const predicate: (response: HTTPResponse) => boolean | Promise<boolean> =
			typeof pattern === "function"
				? pattern
				: pattern instanceof RegExp
					? response => pattern.test(response.url())
					: response => response.url().includes(pattern);
		return (await untilAborted(signal, () => page.waitForResponse(predicate, { timeout, signal }))) as HTTPResponse;
	}

	async #resolveCachedHandle(id: number): Promise<ElementHandle> {
		const handle = this.#elementCache.get(id);
		if (!handle) throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
		try {
			const isConnected = (await handle.evaluate(el => el.isConnected)) as boolean;
			if (!isConnected) {
				await this.#clearElementCache();
				throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
			}
		} catch (err) {
			if (err instanceof ToolError) throw err;
			await this.#clearElementCache();
			throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
		}
		return handle;
	}

	async #resolveAriaRef(id: string): Promise<ElementHandle> {
		const ref = parseAriaRefSelector(id) ?? id.trim();
		const handle = await resolveAriaRefHandle(this.#requirePage(), ref);
		if (!handle) {
			throw new ToolError(
				`Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`,
			);
		}
		return handle;
	}

	/**
	 * Resolve a selector to an ElementHandle for handle-based actions. An
	 * `aria-ref=eN` selector resolves against the latest ariaSnapshot's refs
	 * (main world); anything else goes through the normal locator wait.
	 */
	async #resolveActionHandle(selector: string, timeoutMs: number, sig: AbortSignal): Promise<ElementHandle> {
		if (parseAriaRefSelector(selector) !== null) return this.#resolveAriaRef(selector);
		const locator = locatorForSelector(this.#requirePage(), selector);
		await untilAborted(sig, () => locator.waitFor({ state: "attached", timeout: timeoutMs, signal: sig }));
		return await locator.elementHandle({ timeout: timeoutMs });
	}
	async #clearElementCache(): Promise<void> {
		if (this.#elementCache.size === 0) {
			this.#elementCounter = 0;
			return;
		}
		const handles = [...this.#elementCache.values()];
		this.#elementCache.clear();
		this.#elementCounter = 0;
		await Promise.all(handles.map(handle => handle.dispose().catch(() => undefined)));
	}

	/** Best-effort `Page.stopLoading` so an abandoned navigation cannot stall later ops. */
	async #stopLoading(): Promise<void> {
		try {
			const session = await this.#requireContext().newCDPSession(this.#requirePage());
			try {
				await session.send("Page.stopLoading");
			} finally {
				await session.detach().catch(() => undefined);
			}
		} catch (error) {
			this.#log("debug", "Page.stopLoading failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #close(): Promise<void> {
		this.#unsub();
		this.#uninstallRejectionGuard();
		await withTimeout(
			this.#clearElementCache(),
			HELD_RESOURCE_CLEANUP_TIMEOUT_MS,
			"Timed out disposing cached browser handles",
		).catch(() => undefined);
		const page = this.#page;
		if (page && !page.isClosed()) {
			if (this.#dialogHandler) page.off("dialog", this.#dialogHandler);
			if (this.#dialogObserver) page.off("dialog", this.#dialogObserver);
			if (this.#navigationObserver) page.off("framenavigated", this.#navigationObserver);
			if (this.#mode === "headless") {
				await withTimeout(
					page.close(),
					REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS,
					"Timed out closing the owned browser page",
				).catch(() => undefined);
			}
		}
		// Never call Browser.close(): every CDP connection is attached and process ownership
		// belongs to the registry. Closing the worker port lets process exit drop only its socket.
		this.#transport.send({ type: "closed" });
		this.#transport.close();
	}

	#requirePage(): Page {
		if (!this.#page) throw new ToolError("Tab worker is not initialized");
		return this.#page;
	}

	#requireContext(): BrowserContext {
		if (!this.#context) throw new ToolError("Tab worker is not initialized");
		return this.#context;
	}

	#requireBrowser(): Browser {
		if (!this.#browser) throw new ToolError("Tab worker is not initialized");
		return this.#browser;
	}

	#log(level: "debug" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
		this.#transport.send({ type: "log", level, msg, meta });
	}
}
