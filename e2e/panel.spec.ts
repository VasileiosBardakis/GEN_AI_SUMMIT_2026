import { expect, test } from "@playwright/test";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { startDemoServer } from "../scripts/lib/static-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");
const demoDir = path.join(rootDir, "apps", "demo");

test("extension panel displays optimization library with DESIGN.md craft and no debug stream", async () => {
  const demoServer = await startDemoServer({ dir: demoDir, port: 0 });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-panel-e2e-"));
  const executablePath = await resolveChromeExecutable();

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    }
    const extensionId = new URL(serviceWorker.url()).host;

    const demoPage = context.pages()[0] || (await context.newPage());
    await demoPage.goto(demoServer.url, { waitUntil: "load" });

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/dist/panel.html`, {
      waitUntil: "domcontentloaded",
    });

    await expect(panel.locator("h1")).toHaveText("Optimization Library");
    await expect(panel.locator("[data-eyes-brand-mark]")).toBeVisible();
    await expect(panel.locator(".product")).toHaveText("Eyes");

    const bodyText = await panel.locator("body").innerText();
    expect(bodyText).not.toContain("Captured Events");
    expect(bodyText).not.toContain("Trace Volume");
    expect(bodyText).not.toContain("Live Event Stream");
    expect(bodyText).not.toContain("RUNG");
    expect(bodyText).not.toContain("AI");

    await expect(panel.locator("#sum-saved")).toHaveText("10m 6s");
    await expect(panel.locator("#sum-runs")).toHaveText("32");
    await expect(panel.locator("#sum-active")).toHaveText("3");

    const cards = panel.locator(".opt-card");
    await expect(cards).toHaveCount(4);

    // Run the first snippet optimization and verify run count & time saved increment and persist
    const firstCard = cards.first();
    await firstCard.locator('[data-action="run"]').click();
    await expect(panel.locator("#sum-runs")).toHaveText("33");
    await expect(panel.locator("#sum-saved")).toHaveText("10m 28s");

    // Toggle the recessed dot-grid DAG flow view
    await firstCard.locator('[data-action="flow"]').click();
    const dag = firstCard.locator(".dag-canvas");
    await expect(dag).toBeVisible();
    await expect(dag).toContainText("Your flow");
    await expect(dag).toContainText("Eyes flow");

    // Reload panel to confirm persistence in chrome.storage.local
    await panel.reload({ waitUntil: "domcontentloaded" });
    await expect(panel.locator("#sum-runs")).toHaveText("33");
    await expect(panel.locator("#sum-saved")).toHaveText("10m 28s");

    // Filter tabs work cleanly
    await panel.locator('.filter-tab[data-filter="suggested"]').click();
    await expect(panel.locator(".opt-card")).toHaveCount(1);
    await panel.locator('.filter-tab[data-filter="all"]').click();
    await expect(panel.locator(".opt-card")).toHaveCount(4);
  } finally {
    await context.close().catch(() => {});
    await demoServer.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});
