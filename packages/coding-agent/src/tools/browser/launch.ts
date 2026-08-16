import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, getBrowserCacheDir, logger, removeWithRetries } from "@oh-my-pi/pi-utils";
import {
	chromiumExecutablePath,
	detectChromiumPlatform,
	installChromium,
	PLAYWRIGHT_CHROMIUM_VERSION,
} from "@oh-my-pi/pi-utils/chromium";
import type { Subprocess } from "bun";
import type { Browser, CDPSession, Page } from "playwright-core";
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
import { gracefulKillTreeOnce, waitForCdp } from "./attach";
import stealthTamperingScript from "./stealth/00_stealth_tampering.txt" with { type: "text" };
import stealthActivityScript from "./stealth/01_stealth_activity.txt" with { type: "text" };
import stealthHairlineScript from "./stealth/02_stealth_hairline.txt" with { type: "text" };
import stealthBotdScript from "./stealth/03_stealth_botd.txt" with { type: "text" };
import stealthIframeScript from "./stealth/04_stealth_iframe.txt" with { type: "text" };
import stealthWebglScript from "./stealth/05_stealth_webgl.txt" with { type: "text" };
import stealthScreenScript from "./stealth/06_stealth_screen.txt" with { type: "text" };
import stealthFontsScript from "./stealth/07_stealth_fonts.txt" with { type: "text" };
import stealthAudioScript from "./stealth/08_stealth_audio.txt" with { type: "text" };
import stealthLocaleScript from "./stealth/09_stealth_locale.txt" with { type: "text" };
import stealthPluginsScript from "./stealth/10_stealth_plugins.txt" with { type: "text" };
import stealthHardwareScript from "./stealth/11_stealth_hardware.txt" with { type: "text" };
import stealthCodecsScript from "./stealth/12_stealth_codecs.txt" with { type: "text" };
import stealthWorkerScript from "./stealth/13_stealth_worker.txt" with { type: "text" };

export const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };

/** Per-CDP operation ceiling; caller tool timeouts remain authoritative. */
export const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;
const STEALTH_ACCEPT_LANGUAGE = "en-US,en";

/**
 * Resolve Chromium without loading Playwright or consulting private package
 * internals. The pinned Chrome-for-Testing version is owned by pi-utils.
 */
let chromiumExecutablePromise: Promise<string | undefined> | undefined;
export async function ensureChromiumExecutable(): Promise<string | undefined> {
	const envPath = process.env.OMP_BROWSER_EXECUTABLE_PATH;
	if (envPath) return envPath;
	const sysChrome = await resolveSystemChromium();
	if (sysChrome) return sysChrome;
	if (chromiumExecutablePromise) return chromiumExecutablePromise;

	chromiumExecutablePromise = (async () => {
		const platform = detectChromiumPlatform();
		if (!platform) {
			logger.warn("Could not detect browser platform");
			return undefined;
		}
		const cacheDir = getBrowserCacheDir();
		const executablePath = chromiumExecutablePath({
			version: PLAYWRIGHT_CHROMIUM_VERSION,
			cacheDir,
			platform,
		});
		if (fs.existsSync(executablePath)) return executablePath;

		logger.warn("Downloading OMP Chromium (first browser use)", {
			version: PLAYWRIGHT_CHROMIUM_VERSION,
			platform,
			cacheDir,
		});
		let lastReportedPercent = -1;
		const installation = await installChromium({
			version: PLAYWRIGHT_CHROMIUM_VERSION,
			cacheDir,
			platform,
			onProgress: ({ downloadedBytes, totalBytes }) => {
				if (totalBytes <= 0) return;
				const percent = Math.floor((downloadedBytes / totalBytes) * 100);
				if (percent >= lastReportedPercent + 10 || downloadedBytes === totalBytes) {
					lastReportedPercent = percent;
					logger.debug(
						`Chromium download: ${percent}% (${Math.round(downloadedBytes / 1_000_000)} / ${Math.round(totalBytes / 1_000_000)} MB)`,
					);
				}
			},
		});
		return installation.executablePath;
	})().catch(error => {
		chromiumExecutablePromise = undefined;
		throw new ToolError(
			`Failed to install OMP Chromium: ${(error as Error).message}. ` +
				"Set OMP_BROWSER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary, or install one manually.",
		);
	});
	return chromiumExecutablePromise;
}

let resolvedChromium: string | null | undefined; // undefined = unchecked; null = not found

function isExecutableFile(p: string): boolean {
	try {
		const st = fs.statSync(p);
		if (!st.isFile()) return false;
		if (process.platform === "win32") return true;
		fs.accessSync(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function isChromiumExecutable(p: string): Promise<boolean> {
	if (!isExecutableFile(p)) return false;
	try {
		const probeTimeoutMs = 3000;
		const proc = Bun.spawn([p, "--version"], {
			stdout: "pipe",
			stderr: "ignore",
			signal: AbortSignal.timeout(probeTimeoutMs),
			killSignal: "SIGKILL",
		});
		const stdout = await Promise.race([
			new Response(proc.stdout).text(),
			Bun.sleep(probeTimeoutMs + 500).then(() => null),
		]);
		if (stdout === null) return false;
		await proc.exited;
		return proc.exitCode === 0 && /Chrom|Edg/i.test(stdout);
	} catch {
		return false;
	}
}

/** Flatpak application id published by the Ungoogled Chromium project. */
const UNGOOGLED_CHROMIUM_FLATPAK_ID = "io.github.ungoogled_software.ungoogled_chromium";

function systemChromiumCandidates(
	platform: NodeJS.Platform = process.platform,
	home = os.homedir(),
	which: (name: string) => string | null | undefined = $which,
): string[] {
	const candidates: string[] = [];
	switch (platform) {
		case "darwin": {
			for (const root of ["/Applications", path.join(home, "Applications")]) {
				candidates.push(
					path.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
					path.join(root, "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
					path.join(root, "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"),
					path.join(root, "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
					path.join(root, "Chromium.app/Contents/MacOS/Chromium"),
					path.join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
				);
			}
			break;
		}
		case "linux": {
			const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"];
			for (const name of names) {
				const found = which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				"/usr/bin/google-chrome-stable",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
				"/var/lib/flatpak/exports/bin/com.google.Chrome",
				"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
			);
			let onNixos = false;
			try {
				onNixos = fs.existsSync("/etc/NIXOS");
			} catch {}
			if (onNixos) {
				candidates.push(path.join(home, ".nix-profile/bin/chromium"), "/run/current-system/sw/bin/chromium");
			}
			for (const name of ["ungoogled-chromium", "ungoogled-chromium-browser"]) {
				const found = which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				// Ungoogled Chromium. Distro and AUR packages that keep the plain
				// `chromium` name are already covered above; these are the paths
				// unique to it, including the system and per-user Flatpak shims.
				"/usr/bin/ungoogled-chromium",
				"/usr/bin/ungoogled-chromium-browser",
				`/var/lib/flatpak/exports/bin/${UNGOOGLED_CHROMIUM_FLATPAK_ID}`,
				path.join(home, ".local/share/flatpak/exports/bin", UNGOOGLED_CHROMIUM_FLATPAK_ID),
			);
			break;
		}
		case "win32": {
			const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
			const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
			const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData\\Local");
			candidates.push(
				path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFiles, "Chromium\\Application\\chrome.exe"),
				path.join(localAppData, "Chromium\\Application\\chrome.exe"),
				path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
				path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
			);
			break;
		}
	}
	return candidates;
}

async function resolveSystemChromium(): Promise<string | undefined> {
	if (resolvedChromium !== undefined) return resolvedChromium ?? undefined;
	const seen = new Set<string>();
	for (const candidate of systemChromiumCandidates()) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (await isChromiumExecutable(candidate)) {
			resolvedChromium = candidate;
			logger.debug("Using system Chrome/Chromium", { path: candidate });
			return candidate;
		}
	}
	resolvedChromium = null;
	return undefined;
}

export interface BrowserLaunchOptions {
	headless: boolean;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	executablePath?: string;
	userDataDir?: string;
	args?: readonly string[];
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Fully resolved, source-owned Chromium process specification. */
export interface BrowserLaunchSpec {
	executablePath: string;
	args: string[];
	userDataDir: string;
	ownsUserDataDir: boolean;
}

/** An OMP-owned Chromium process after its dynamic CDP port is verified. */
export interface LaunchedBrowserProcess extends BrowserLaunchSpec {
	subprocess: Subprocess;
	cdpEndpoint: string;
}

const BASE_CHROMIUM_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-background-networking",
	"--disable-background-timer-throttling",
	"--disable-backgrounding-occluded-windows",
	"--disable-breakpad",
	"--disable-dev-shm-usage",
	"--disable-hang-monitor",
	"--disable-prompt-on-repost",
	"--disable-renderer-backgrounding",
	"--disable-sync",
	"--disable-blink-features=AutomationControlled",
	"--force-color-profile=srgb",
	"--no-first-run",
	"--no-default-browser-check",
	"--password-store=basic",
	"--use-mock-keychain",
	"--disable-search-engine-choice-screen",
] as const;

function enabledEnv(name: string): boolean {
	const value = process.env[name]?.toLowerCase();
	return value === "true" || value === "1" || value === "yes" || value === "on";
}

function commandLineValue(args: readonly string[], name: string): string | undefined {
	const prefix = `${name}=`;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg.startsWith(prefix)) return arg.slice(prefix.length) || undefined;
		if (arg === name) return args[index + 1];
	}
	return undefined;
}

function withoutRemoteDebuggingPort(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--remote-debugging-port") {
			index++;
			continue;
		}
		if (arg.startsWith("--remote-debugging-port=")) continue;
		result.push(arg);
	}
	return result;
}
function withoutUserDataDir(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--user-data-dir") {
			index++;
			continue;
		}
		if (arg.startsWith("--user-data-dir=")) continue;
		result.push(arg);
	}
	return result;
}

/**
 * Build the only Chromium launch argv used by process-local and broker-owned
 * browsers. No Playwright launch defaults or private APIs participate.
 */
export async function buildBrowserLaunchSpec(opts: BrowserLaunchOptions): Promise<BrowserLaunchSpec> {
	const executablePath = opts.executablePath ?? (await ensureChromiumExecutable());
	if (!executablePath) throw new ToolError("No Chrome or Chromium executable is available");
	const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
	const requestedArgs = withoutRemoteDebuggingPort(opts.args ?? []);
	const suppliedProfile = opts.userDataDir ?? commandLineValue(requestedArgs, "--user-data-dir");
	const suppliedArgs = withoutUserDataDir(requestedArgs);
	const ownsUserDataDir = suppliedProfile === undefined;
	const userDataDir = suppliedProfile
		? path.resolve(suppliedProfile)
		: await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-browser-profile-"));
	await fs.promises.mkdir(userDataDir, { recursive: true });

	const args = [
		...BASE_CHROMIUM_ARGS,
		`--window-size=${viewport.width},${viewport.height}`,
		...(opts.headless ? ["--headless=new", "--hide-scrollbars", "--mute-audio"] : []),
		...suppliedArgs,
		`--user-data-dir=${userDataDir}`,
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=0",
	];
	const proxy = process.env.OMP_BROWSER_PROXY;
	if (proxy) {
		args.push(`--proxy-server=${proxy}`);
		if (enabledEnv("OMP_BROWSER_PROXY_BYPASS_LOOPBACK")) args.push("--proxy-bypass-list=<-loopback>");
	}
	if (enabledEnv("OMP_BROWSER_PROXY_IGNORE_CERT_ERRORS")) args.push("--ignore-certificate-errors");
	if (!args.some(arg => !arg.startsWith("-"))) args.push("about:blank");
	return { executablePath, args: [...new Set(args)], userDataDir, ownsUserDataDir };
}

async function waitForDevToolsActivePort(
	userDataDir: string,
	startedAt: number,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string> {
	const activePortPath = path.join(userDataDir, "DevToolsActivePort");
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		try {
			const stat = await fs.promises.stat(activePortPath);
			if (stat.mtimeMs < startedAt) throw new Error("stale DevToolsActivePort");
			const text = await fs.promises.readFile(activePortPath, "utf8");
			const [rawPort] = text.split(/\r?\n/);
			const port = Number.parseInt(rawPort ?? "", 10);
			if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
				throw new Error(`invalid DevTools port ${JSON.stringify(rawPort)}`);
			}
			const cdpEndpoint = `http://127.0.0.1:${port}`;
			await waitForCdp(cdpEndpoint, Math.max(1, deadline - Date.now()), signal);
			return cdpEndpoint;
		} catch (error) {
			if (signal?.aborted) throwIfAborted(signal);
			lastError = error;
		}
		await Bun.sleep(100);
	}
	throw new ToolError(
		`Timed out waiting for Chromium DevToolsActivePort${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
	);
}

/** Spawn an OMP-owned Chromium and verify its plain HTTP CDP endpoint. */
export async function launchBrowserProcess(opts: BrowserLaunchOptions): Promise<LaunchedBrowserProcess> {
	const spec = await buildBrowserLaunchSpec(opts);
	const startedAt = Date.now();
	const subprocess = Bun.spawn([spec.executablePath, ...spec.args], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	subprocess.unref();
	try {
		const cdpEndpoint = await waitForDevToolsActivePort(
			spec.userDataDir,
			startedAt,
			opts.timeoutMs ?? 30_000,
			opts.signal,
		);
		return { ...spec, subprocess, cdpEndpoint };
	} catch (error) {
		await gracefulKillTreeOnce(subprocess.pid).catch(() => undefined);
		if (spec.ownsUserDataDir) await removeUserDataDir(spec.userDataDir);
		if (opts.signal?.aborted) throw new ToolAbortError("Browser launch aborted");
		throw error;
	}
}

/** Broker boundary retaining its nullable unavailable-host contract. */
export async function resolveSharedBrowserLaunchSpec(opts: {
	headless: boolean;
	userDataDir: string;
	viewport?: { width: number; height: number };
}): Promise<BrowserLaunchSpec | null> {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) return null;
	return await buildBrowserLaunchSpec({ ...opts, executablePath });
}

/**
 * Remove an OMP-owned headless Chromium profile directory, tolerating the brief
 * window on Windows in which Chromium (or an orphaned browser subprocess) still
 * holds the profile lock. The shared temp remover centralizes retry handling
 * for EBUSY/EPERM/ENOTEMPTY; if the directory is still busy afterwards we warn
 * and leave it for a later cleanup pass rather than throwing — a shutdown cleanup
 * failure must never crash the process (issue #7058).
 */
export async function removeUserDataDir(dir: string): Promise<void> {
	try {
		await removeWithRetries(dir);
	} catch (error) {
		logger.warn("Left Chromium profile directory in place after cleanup failure", {
			dir,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function applyViewport(
	page: Page,
	viewport?: { width: number; height: number; deviceScaleFactor?: number },
): Promise<void> {
	const resolved = viewport ?? DEFAULT_VIEWPORT;
	await page.setViewportSize({ width: resolved.width, height: resolved.height });
}

// =====================================================================
// Stealth patches
// =====================================================================

export interface UserAgentOverride {
	userAgent: string;
	platform: string;
	acceptLanguage: string;
	userAgentMetadata: {
		brands: Array<{ brand: string; version: string }>;
		fullVersion: string;
		fullVersionList: Array<{ brand: string; version: string }>;
		platform: string;
		platformVersion: string;
		architecture: string;
		bitness: string;
		model: string;
		mobile: boolean;
	};
}

async function resolveMacOsProductVersion(): Promise<string> {
	if (os.platform() !== "darwin") return "";
	try {
		const plist = await Bun.file("/System/Library/CoreServices/SystemVersion.plist").text();
		return plist.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
	} catch {
		return "";
	}
}

async function resolveUserAgentOverride(browser: Browser, page: Page): Promise<UserAgentOverride> {
	const rawUserAgent = await page.evaluate(() => navigator.userAgent);
	let userAgent = rawUserAgent.replace("HeadlessChrome/", "Chrome/");
	if (userAgent.includes("Linux") && !userAgent.includes("Android")) {
		userAgent = userAgent.replace(/\(([^)]+)\)/, "(Windows NT 10.0; Win64; x64)");
	}

	const uaVersionMatch = userAgent.match(/Chrome\/([\d.]+)/);
	const browserVersionMatch = browser.version().match(/([\d.]+)/);
	const legacyVersion = uaVersionMatch?.[1] ?? browserVersionMatch?.[1] ?? "0";
	const fullVersion = browserVersionMatch?.[1] ?? legacyVersion;
	const majorVersion = Number.parseInt(legacyVersion.split(".")[0] ?? "0", 10) || 0;
	const isAndroid = userAgent.includes("Android");
	const isMac = userAgent.includes("Mac OS X");
	const isWindows = userAgent.includes("Windows");
	const platform = isMac ? "MacIntel" : isAndroid ? "Android" : userAgent.includes("Linux") ? "Linux" : "Win32";
	const platformFull = isMac ? "macOS" : isAndroid ? "Android" : userAgent.includes("Linux") ? "Linux" : "Windows";
	const platformVersion = isMac
		? await resolveMacOsProductVersion()
		: userAgent.includes("Android ")
			? (userAgent.match(/Android ([^;]+)/)?.[1] ?? "")
			: isWindows
				? (userAgent.match(/Windows NT ([\d.]+)/)?.[1] ?? "")
				: "";
	const architecture = isAndroid ? "" : os.arch() === "arm64" ? "arm" : os.arch().includes("64") ? "x86" : "";
	const bitness = isAndroid ? "" : os.arch().includes("64") ? "64" : "";
	const model = isAndroid ? (userAgent.match(/Android.*?;\s([^)]+)/)?.[1] ?? "") : "";

	const brandOrders = [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0],
	] as const;
	const order = brandOrders[majorVersion % brandOrders.length] ?? brandOrders[0];
	const escapedChars = [" ", " ", ";"] as const;
	const greaseyBrand = `${escapedChars[order[0]]}Not${escapedChars[order[1]]}A${escapedChars[order[2]]}Brand`;
	const brands: { brand: string; version: string }[] = [];
	brands[order[0]] = { brand: greaseyBrand, version: "99" };
	brands[order[1]] = { brand: "Chromium", version: String(majorVersion) };
	brands[order[2]] = { brand: "Google Chrome", version: String(majorVersion) };
	const fullVersionList = brands.map(({ brand }) => ({
		brand,
		version: brand === greaseyBrand ? "99.0.0.0" : fullVersion,
	}));

	return {
		userAgent,
		platform,
		acceptLanguage: STEALTH_ACCEPT_LANGUAGE,
		userAgentMetadata: {
			brands,
			fullVersion,
			fullVersionList,
			platform: platformFull,
			platformVersion,
			architecture,
			bitness,
			model,
			mobile: isAndroid,
		},
	};
}

async function sendUserAgentOverride(session: CDPSession, override: UserAgentOverride): Promise<void> {
	try {
		await session.send("Network.enable");
		await session.send("Network.setUserAgentOverride", override);
	} catch (error) {
		logger.debug("Failed to apply Network user-agent override", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	try {
		await session.send("Emulation.setUserAgentOverride", override);
	} catch (error) {
		logger.debug("Failed to apply Emulation user-agent override", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

const STEALTH_PATCH_SCRIPTS = [
	stealthTamperingScript,
	stealthActivityScript,
	stealthHairlineScript,
	stealthBotdScript,
	stealthIframeScript,
	stealthWebglScript,
	stealthScreenScript,
	stealthFontsScript,
	stealthAudioScript,
	stealthLocaleScript,
	stealthPluginsScript,
	stealthHardwareScript,
	stealthCodecsScript,
	stealthWorkerScript,
];

function buildStealthInjectionScript(scripts: readonly string[] = STEALTH_PATCH_SCRIPTS): string {
	const joint = scripts
		.map(
			script => `
		try {
			${script};
		} catch (e) {}
	`,
		)
		.join(";\n");

	return `(() => {
				const Page_Function_toString = Function.prototype.toString;
				const Page_FunctionToStringDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
				const Page_Proxy = Proxy;
				const Page_WeakMap = WeakMap;
				const Page_WeakMap_get = Page_WeakMap.prototype.get;
				const Page_WeakMap_set = Page_WeakMap.prototype.set;
				// Native function cache - captured before any tampering.
				// A same-origin iframe yields natives uncontaminated by page-level
				// tampering, but at document-start (when this preload runs) there is
				// no documentElement to attach it to. In that case the page itself
				// hasn't executed yet, so window's own natives are still pristine —
				// fall back to window instead of bailing, otherwise none of the
				// fingerprint patches below would ever run.
				let iframe = null;
				const container = document.head ?? document.documentElement;
				if (container) {
					iframe = document.createElement("iframe");
					iframe.style.display = "none";
					container.appendChild(iframe);
					if (!iframe.contentWindow) iframe = null;
				}
				try {
					const nativeWindow = iframe ? iframe.contentWindow : window;

					// Cache pristine native functions
					const Function_toString = nativeWindow.Function.prototype.toString;
					const Object_getOwnPropertyDescriptor = nativeWindow.Object.getOwnPropertyDescriptor;
					const Object_getOwnPropertyDescriptors = nativeWindow.Object.getOwnPropertyDescriptors;
					const Object_getPrototypeOf = nativeWindow.Object.getPrototypeOf;
					const Object_defineProperty = nativeWindow.Object.defineProperty;
					const Object_getOwnPropertyDescriptorOriginal = nativeWindow.Object.getOwnPropertyDescriptor;
					const Object_create = nativeWindow.Object.create;
					const Object_keys = nativeWindow.Object.keys;
					const Object_getOwnPropertyNames = nativeWindow.Object.getOwnPropertyNames;
					const Object_entries = nativeWindow.Object.entries;
					const Object_setPrototypeOf = nativeWindow.Object.setPrototypeOf;
					const Object_assign = nativeWindow.Object.assign;
					const Window_setTimeout = nativeWindow.setTimeout;
					const Math_random = nativeWindow.Math.random;
					const Math_floor = nativeWindow.Math.floor;
					const Math_max = nativeWindow.Math.max;
					const Math_min = nativeWindow.Math.min;
					const Window_Event = nativeWindow.Event;
					const Promise_resolve = nativeWindow.Promise.resolve.bind(nativeWindow.Promise);
					const Window_Blob = nativeWindow.Blob;
					const Window_Proxy = nativeWindow.Proxy;
					const Reflect_get = nativeWindow.Reflect.get;
					const Reflect_set = nativeWindow.Reflect.set;
					const Reflect_apply = nativeWindow.Reflect.apply;
					const Reflect_construct = nativeWindow.Reflect.construct;
					const Reflect_defineProperty = nativeWindow.Reflect.defineProperty;
					const Reflect_deleteProperty = nativeWindow.Reflect.deleteProperty;
					const Reflect_getOwnPropertyDescriptor = nativeWindow.Reflect.getOwnPropertyDescriptor;
					const Reflect_getPrototypeOf = nativeWindow.Reflect.getPrototypeOf;
					const Reflect_has = nativeWindow.Reflect.has;
					const Reflect_isExtensible = nativeWindow.Reflect.isExtensible;
					const Reflect_ownKeys = nativeWindow.Reflect.ownKeys;
					const Reflect_preventExtensions = nativeWindow.Reflect.preventExtensions;
					const Reflect_setPrototypeOf = nativeWindow.Reflect.setPrototypeOf;
					const Intl_DateTimeFormat = nativeWindow.Intl.DateTimeFormat;
					const Date_constructor = nativeWindow.Date;

					const nativeFunctionSources = new Page_WeakMap();
					const makeNativeString = (name) => "function " + (name || "") + "() { [native code] }";
					const registerNativeSource = (fn, source) => {
						if (typeof fn === "function") Reflect_apply(Page_WeakMap_set, nativeFunctionSources, [fn, source]);
						return fn;
					};
					const patchToString = (fn, name) => registerNativeSource(fn, makeNativeString(name));
					if (${scripts.length > 0 ? "true" : "false"}) {
						const functionToStringProxy = new Page_Proxy(Page_Function_toString, {
							apply(target, thisArg, args) {
								const source = Reflect_apply(Page_WeakMap_get, nativeFunctionSources, [thisArg]);
								if (source) return source;
								return Reflect_apply(target, thisArg, args || []);
							},
							get(target, key, receiver) {
								return Reflect_get(target, key, receiver);
							},
						});
						registerNativeSource(functionToStringProxy, makeNativeString("toString"));
						Object_defineProperty(Function.prototype, "toString", {
							...(Page_FunctionToStringDescriptor || {
								writable: true,
								configurable: true,
								enumerable: false,
							}),
							value: functionToStringProxy,
						});
					}

					${joint}
				} finally {
					if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
				}})();`;
}

async function injectStealthScripts(page: Page): Promise<void> {
	await page.addInitScript({ content: buildStealthInjectionScript() });
}

/** Builds the browser-page stealth bootstrap source for regression tests. */
export function buildStealthInjectionScriptForTest(scripts: readonly string[] = STEALTH_PATCH_SCRIPTS): string {
	return buildStealthInjectionScript(scripts);
}

/** Apply stealth patches and a page-scoped UA override without retaining CDP resources. */
export async function applyStealthPatches(browser: Browser, page: Page): Promise<void> {
	const override = await resolveUserAgentOverride(browser, page);
	const session = await page.context().newCDPSession(page);
	try {
		await sendUserAgentOverride(session, override);
	} finally {
		await session.detach().catch(() => undefined);
	}
	await injectStealthScripts(page);
}

/** Exposes executable candidates for detection tests. */
export function systemChromiumCandidatesForTest(
	platform: NodeJS.Platform = process.platform,
	home?: string,
	which?: (name: string) => string | null | undefined,
): string[] {
	return systemChromiumCandidates(platform, home, which);
}

export async function chromiumExecutableProbeForTest(executablePath: string): Promise<boolean> {
	return isChromiumExecutable(executablePath);
}
