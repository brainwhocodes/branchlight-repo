import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopRoot = path.resolve(".");
const mainBundle = path.join(desktopRoot, ".vite", "build", "main.js");
const electronBinary = path.join(desktopRoot, "node_modules", "electron", "dist", "electron.exe");
const fixture = path.join(desktopRoot, "e2e", "rpc-fixture.cjs");

test("keeps a 5MiB reasoning and 10,000-entry transcript responsive", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "branchlight-performance-"));
  const workFolder = await mkdtemp(path.join(os.tmpdir(), "branchlight-performance-work-"));
  const sessionFile = path.join(workFolder, ".branchlight-performance.jsonl");
  const now = new Date().toISOString();
  await writeFile(sessionFile, "fixture\n", "utf8");
  await writeFile(
    path.join(userData, "sessions-v1.json"),
    JSON.stringify({
      version: 1,
      sessions: [{
        id: "performance-session-0001",
        kind: "work",
        cwd: workFolder,
        ompSessionId: "fixture-session-0001",
        sessionFile,
        title: "Performance fixture",
        createdAt: now,
        lastOpenedAt: now,
      }],
      activeByKind: { work: "performance-session-0001", code: null },
    }),
    "utf8",
  );

  const app = await electron.launch({
    executablePath: electronBinary,
    args: [`--user-data-dir=${userData}`, mainBundle],
    env: {
      ...process.env,
      BRANCHLIGHT_RPC_FIXTURE: fixture,
      BRANCHLIGHT_NODE: "node",
      BRANCHLIGHT_PERF_FIXTURE: "1",
    },
  });
  const page = await app.firstWindow();
  const context = page.context();
  let traceStarted = false;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await context.tracing.start({ screenshots: true, snapshots: false });
    traceStarted = true;
    await page.evaluate(() => {
      const inputPaints: number[] = [];
      const longTasks: number[] = [];
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
      document.addEventListener("input", () => {
        const started = performance.now();
        requestAnimationFrame(() => inputPaints.push(performance.now() - started));
      });
      (window as Window & { __branchlightPerf?: { inputPaints: number[]; longTasks: number[] } }).__branchlightPerf = { inputPaints, longTasks };
    });

    await page.getByRole("button", { name: "Resume" }).click();
    await expect.poll(async () => page.locator(".state-pill").textContent(), { timeout: 15_000 }).toBe("ready");
    await expect(page.getByText("Performance timeline entry 9999")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".timeline-item")).toHaveCount(200);
    const reasoningSummary = page.locator("summary", { hasText: "Reasoning" }).first();
    await expect(reasoningSummary).toBeVisible();
    await reasoningSummary.click();
    await expect(page.locator(".reasoning-copy").first()).toBeVisible();

    const composer = page.getByRole("combobox", { name: "Message OMP" });
    await composer.click();
    await composer.pressSequentially("performance input");
    await expect.poll(async () => page.evaluate(() => {
      const perf = (window as Window & { __branchlightPerf?: { inputPaints: number[] } }).__branchlightPerf;
      return perf?.inputPaints.length ?? 0;
    })).toBeGreaterThan(0);
    await page.locator(".timeline-scroll").evaluate(element => { element.scrollTop = 0; });
    await page.getByRole("button", { name: /Load 100 older entries/ }).click();
    await expect(page.locator(".timeline-item")).toHaveCount(300);

    const metrics = await page.evaluate(() => {
      const perf = (window as Window & { __branchlightPerf?: { inputPaints: number[]; longTasks: number[] } }).__branchlightPerf;
      const inputPaints = [...(perf?.inputPaints ?? [])].sort((a, b) => a - b);
      return {
        maxLongTask: Math.max(0, ...(perf?.longTasks ?? [])),
        p95InputPaint: inputPaints[Math.max(0, Math.ceil(inputPaints.length * 0.95) - 1)] ?? 0,
      };
    });
    expect(metrics.maxLongTask).toBeLessThan(200);
    expect(metrics.p95InputPaint).toBeLessThan(100);
  } finally {
    if (traceStarted) await context.tracing.stop({ path: path.resolve("test-results", "performance-5MiB-10k-trace.zip") });
  }
});
