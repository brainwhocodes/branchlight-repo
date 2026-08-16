import { expect, test } from "bun:test";
import * as path from "node:path";
import { PLAYWRIGHT_CHROMIUM_VERSION } from "@oh-my-pi/pi-utils/chromium";
import playwrightPackage from "playwright-core/package.json" with { type: "json" };

interface PlaywrightBrowsersMetadata {
	browsers: Array<{
		name: string;
		browserVersion?: string;
	}>;
}

test("the browser runtime and Chromium installer match pinned Playwright metadata", async () => {
	expect(playwrightPackage.version).toBe("1.62.1");
	const packageJsonPath = Bun.resolveSync("playwright-core/package.json", import.meta.dir);
	const metadata = (await Bun.file(
		path.join(path.dirname(packageJsonPath), "browsers.json"),
	).json()) as PlaywrightBrowsersMetadata;
	const chromium = metadata.browsers.find(browser => browser.name === "chromium");
	expect(chromium?.browserVersion).toBe(PLAYWRIGHT_CHROMIUM_VERSION);
});
