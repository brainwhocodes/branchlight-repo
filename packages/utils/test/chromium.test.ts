import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ChromiumPlatform,
	chromiumDownloadUrl,
	chromiumExecutablePath,
	detectChromiumPlatform,
	getInstalledChromium,
	installChromium,
	PLAYWRIGHT_CHROMIUM_VERSION,
} from "../src/chromium";

const VERSION = "123.0.6312.58";
const ROOTS: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-chromium-test-"));
	ROOTS.push(root);
	return root;
}

afterAll(async () => {
	for (const root of ROOTS) await fs.rm(root, { recursive: true, force: true });
});

describe("Chrome-for-Testing layout goldens", () => {
	const goldens = [
		{
			platform: ChromiumPlatform.LINUX,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/linux64/chrome-linux64.zip`,
			executable: `/cache/chrome/linux-${VERSION}/chrome-linux64/chrome`,
		},
		{
			platform: ChromiumPlatform.LINUX_ARM,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/linux64/chrome-linux64.zip`,
			executable: `/cache/chrome/linux_arm-${VERSION}/chrome-linux64/chrome`,
		},
		{
			platform: ChromiumPlatform.MAC,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/mac-x64/chrome-mac-x64.zip`,
			executable: `/cache/chrome/mac-${VERSION}/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
		},
		{
			platform: ChromiumPlatform.MAC_ARM,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/mac-arm64/chrome-mac-arm64.zip`,
			executable: `/cache/chrome/mac_arm-${VERSION}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
		},
		{
			platform: ChromiumPlatform.WIN32,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/win32/chrome-win32.zip`,
			executable: `/cache/chrome/win32-${VERSION}/chrome-win32/chrome.exe`,
		},
		{
			platform: ChromiumPlatform.WIN64,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/win64/chrome-win64.zip`,
			executable: `/cache/chrome/win64-${VERSION}/chrome-win64/chrome.exe`,
		},
	] as const;

	for (const golden of goldens) {
		test(golden.platform, () => {
			expect(String(chromiumDownloadUrl(golden.platform, VERSION))).toBe(golden.url);
			expect(
				chromiumExecutablePath({
					platform: golden.platform,
					version: VERSION,
					cacheDir: "/cache",
				}),
			).toBe(golden.executable);
		});
	}
});

test("detectChromiumPlatform maps the current supported host", () => {
	const platform = detectChromiumPlatform();
	if (process.platform === "darwin")
		expect(platform).toBe(process.arch === "arm64" ? ChromiumPlatform.MAC_ARM : ChromiumPlatform.MAC);
	else if (process.platform === "linux")
		expect(platform).toBe(process.arch === "arm64" ? ChromiumPlatform.LINUX_ARM : ChromiumPlatform.LINUX);
	else if (process.platform === "win32")
		expect(platform).toBe(process.arch === "ia32" ? ChromiumPlatform.WIN32 : ChromiumPlatform.WIN64);
});

test("getInstalledChromium scans only valid cache installation names", async () => {
	const root = await makeRoot();
	await Promise.all([
		fs.mkdir(path.join(root, "chrome", `linux-${VERSION}`), { recursive: true }),
		fs.mkdir(path.join(root, "chrome", "not-an-install"), { recursive: true }),
		fs.mkdir(path.join(root, "unknown", `linux-${VERSION}`), { recursive: true }),
	]);
	const installed = await getInstalledChromium({ cacheDir: root });
	expect(installed).toEqual([
		{
			version: VERSION,
			platform: ChromiumPlatform.LINUX,
			path: path.join(root, "chrome", `linux-${VERSION}`),
			executablePath: path.join(root, "chrome", `linux-${VERSION}`, "chrome-linux64", "chrome"),
		},
	]);
});

test("installChromium streams and extracts stored, deflated, nested, executable, and symlink entries", async () => {
	const root = await makeRoot();
	const fixture = Bun.file(path.join(import.meta.dir, "fixtures/browsers/synthetic-chrome.zip"));
	const server = Bun.serve({ port: 0, fetch: () => new Response(fixture) });
	const progress: Array<{ downloadedBytes: number; totalBytes: number }> = [];
	try {
		const installed = await installChromium({
			platform: ChromiumPlatform.LINUX,
			version: VERSION,
			cacheDir: root,
			baseUrl: String(server.url),
			onProgress: update => progress.push(update),
		});
		const executable = await fs.readFile(installed.executablePath, "utf8");
		expect(executable).toBe("#!/bin/sh\necho synthetic chrome\n");
		expect((await fs.stat(installed.executablePath)).mode & 0o777).toBe(0o755);
		expect(await fs.readFile(path.join(installed.path, "chrome-linux64/nested/data.txt"), "utf8")).toBe(
			"nested fixture\n",
		);
		expect((await fs.stat(path.join(installed.path, "chrome-linux64/nested/data.txt"))).mode & 0o777).toBe(0o640);
		expect(await fs.readlink(path.join(installed.path, "chrome-linux64/chrome-link"))).toBe("chrome");
		expect(progress.length).toBeGreaterThan(0);
		expect(progress.at(-1)?.downloadedBytes).toBe(fixture.size);
		expect(progress.at(-1)?.totalBytes).toBe(fixture.size);
	} finally {
		server.stop(true);
	}
});

test("installChromium rejects archive traversal", async () => {
	const root = await makeRoot();
	const fixture = Bun.file(path.join(import.meta.dir, "fixtures/browsers/traversal.zip"));
	const server = Bun.serve({ port: 0, fetch: () => new Response(fixture) });
	try {
		await expect(
			installChromium({
				platform: ChromiumPlatform.LINUX,
				version: VERSION,
				cacheDir: root,
				baseUrl: String(server.url),
			}),
		).rejects.toThrow("Unsafe path in ZIP archive");
		expect(await fs.readdir(root)).not.toContain("escaped.txt");
	} finally {
		server.stop(true);
	}
});

const networkTest = process.env.OMP_TEST_BROWSER_INSTALL ? test : test.skip;
networkTest(
	"network: downloads and installs Playwright's pinned Chrome-for-Testing version",
	async () => {
		const root = await makeRoot();
		const platform = detectChromiumPlatform();
		if (!platform) throw new Error("Network browser test requires a supported platform");
		const installed = await installChromium({
			platform,
			version: PLAYWRIGHT_CHROMIUM_VERSION,
			cacheDir: root,
		});
		expect((await fs.stat(installed.executablePath)).isFile()).toBe(true);
	},
	300_000,
);
