import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopRoot = path.resolve(".");
const mainBundle = path.join(desktopRoot, ".vite", "build", "main.js");
const electronBinary = path.join(desktopRoot, "node_modules", "electron", "dist", "electron.exe");

function sessionHeader(cwd: string): string {
  const timestamp = new Date().toISOString();
  return `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp, cwd })}\n`;
}

test("proves Work and Code against the compiled OMP runtime", async () => {
  test.skip(process.env.BRANCHLIGHT_REAL_OMP !== "1", "set BRANCHLIGHT_REAL_OMP=1 to run with configured credentials");
  const userData = await mkdtemp(path.join(os.tmpdir(), "branchlight-real-"));
  const workFolder = await mkdtemp(path.join(os.tmpdir(), "branchlight-real-work-"));
  const codeFolder = await mkdtemp(path.join(os.tmpdir(), "branchlight-real-code-"));
  const workSessionFile = path.join(workFolder, "branchlight-real-work.jsonl");
  const codeSessionFile = path.join(codeFolder, "branchlight-real-code.jsonl");
  await writeFile(workSessionFile, sessionHeader(workFolder), "utf8");
  await writeFile(codeSessionFile, sessionHeader(codeFolder), "utf8");
  const now = new Date().toISOString();
  await writeFile(path.join(userData, "sessions-v1.json"), JSON.stringify({
    version: 1,
    sessions: [
      { id: "real-work-session", kind: "work", cwd: workFolder, ompSessionId: "", sessionFile: workSessionFile, title: "Real work proof", createdAt: now, lastOpenedAt: now },
      { id: "real-code-session", kind: "code", cwd: codeFolder, ompSessionId: "", sessionFile: codeSessionFile, title: "Real code proof", createdAt: now, lastOpenedAt: now },
    ],
    activeByKind: { work: "real-work-session", code: "real-code-session" },
  }, null, 2), "utf8");

  const app = await electron.launch({
    executablePath: electronBinary,
    args: [`--user-data-dir=${userData}`, mainBundle],
    env: { ...process.env, ELECTRON_ENABLE_SECURITY_WARNINGS: "1" },
  });
  const page = await app.firstWindow();
  page.on("dialog", dialog => void dialog.accept());
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
    await page.getByRole("combobox", { name: "Message OMP" }).fill("Write result.txt containing exactly BRANCHLIGHT_READY. Then use the task tool to ask one verifier subagent to check the file and report its result.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(async () => {
      try {
        return await readFile(path.join(workFolder, "result.txt"), "utf8");
      } catch {
        return null;
      }
    }, { timeout: 120_000 }).toBe("BRANCHLIGHT_READY");
    await expect(page.locator(".agent-card").first()).toBeVisible();
    await page.getByRole("button", { name: /Stop/ }).click();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    expect((await stat(workSessionFile)).isFile()).toBe(true);
    expect((await readFile(path.join(userData, "sessions-v1.json"), "utf8"))).toContain("real-work-session");

    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
    await expect(page.getByText("BRANCHLIGHT_READY")).toBeVisible();

    await page.getByRole("tab", { name: /Code/ }).click();
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
    await page.getByRole("combobox", { name: "Message OMP" }).fill("Read result.txt and show the detailed tool call and result. Do not modify the file.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Technical details").first()).toBeVisible();
    await page.getByRole("button", { name: /Stop/ }).click();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  } finally {
    await app.close();
  }
});
