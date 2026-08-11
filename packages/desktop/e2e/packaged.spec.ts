import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, expect, test } from "@playwright/test";

const desktopRoot = path.resolve(".");
const packagedRoot = path.join(desktopRoot, "out", "@branchlight-desktop-win32-x64");
const packagedBinary = path.join(packagedRoot, "Branchlight.exe");
const fixture = path.join(desktopRoot, "e2e", "rpc-fixture.cjs");

test("loads the packaged protocol and extraResource backend", async () => {
  expect(existsSync(packagedBinary)).toBe(true);
  expect(existsSync(path.join(packagedRoot, "resources", "omp.exe"))).toBe(true);
  expect(existsSync(path.join(packagedRoot, "resources", "THIRD_PARTY_LICENSES.txt"))).toBe(true);
  expect(existsSync(path.join(packagedRoot, "resources", "rpc-config.yml"))).toBe(true);

  const userData = await mkdtemp(path.join(os.tmpdir(), "branchlight-packaged-e2e-"));
  const workFolder = await mkdtemp(path.join(os.tmpdir(), "branchlight-packaged-work-"));
  const sessionFile = path.join(workFolder, ".branchlight-fixture.jsonl");
  const now = new Date().toISOString();
  await writeFile(sessionFile, "fixture\n", "utf8");
  await writeFile(
    path.join(userData, "sessions-v1.json"),
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: "packaged-work-0001",
          kind: "work",
          cwd: workFolder,
          ompSessionId: "fixture-session-0001",
          sessionFile,
          title: "Packaged workspace",
          createdAt: now,
          lastOpenedAt: now,
        },
      ],
      activeByKind: { work: "packaged-work-0001", code: null },
    }),
    "utf8",
  );

  const cdpPort = await reservePort();
  const child = spawn(packagedBinary, [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`], {
    cwd: packagedRoot,
    env: {
      ...process.env,
      BRANCHLIGHT_RPC_FIXTURE: fixture,
      BRANCHLIGHT_NODE: "node",
      ELECTRON_ENABLE_SECURITY_WARNINGS: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", chunk => {
    stderr += String(chunk);
  });

  try {
    await expect.poll(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        return response.ok;
      } catch {
        return false;
      }
    }, { timeout: 30_000 }).toBe(true);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    try {
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) throw new Error("Packaged app did not expose a browser window");
      await expect.poll(() => page.url()).toBe("branchlight://app/index.html");
      await expect.poll(() => page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0);
      await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Packaged workspace", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Resume" }).click();
      await expect(page.getByText("Fixture ready.")).toBeVisible();
      await page.getByRole("combobox", { name: "Message OMP" }).fill("packaged proof");
      await page.getByRole("button", { name: "Send" }).click();
      const privilegedInput = page.getByRole("textbox", { name: "Sensitive input" });
      await expect(privilegedInput).toHaveAttribute("type", "password");
      await privilegedInput.fill("fixture-packaged-password");
      await page.getByRole("button", { name: "Submit" }).click();
      await expect(page.getByText("Fixture completed the requested work.")).toBeVisible();
      expect(stderr).not.toContain("Electron Security Warning");
    } finally {
      await browser.close();
    }
  } finally {
    child.kill();
  }
});

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return port;
}
