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

async function launchExtensionContext() {
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

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
  }
  const extensionId = new URL(serviceWorker.url()).host;

  return {
    context,
    demoServer,
    extensionId,
    async cleanup() {
      await context.close().catch(() => {});
      await demoServer.close();
      fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

test("extension panel renders empty state when GET /library returns []", async () => {
  const env = await launchExtensionContext();

  try {
    await env.context.route("http://localhost:8787/library", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, items: [] }),
      });
    });

    const panel = await env.context.newPage();
    await panel.goto(`chrome-extension://${env.extensionId}/dist/panel.html`, {
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

    await expect(panel.locator(".opt-card")).toHaveCount(0);
    await expect(panel.locator("#sum-saved")).toHaveText("0s");
    await expect(panel.locator("#sum-runs")).toHaveText("0");
    await expect(panel.locator("#sum-active")).toHaveText("0");
  } finally {
    await env.cleanup();
  }
});

test("extension panel renders saved workflow with real stats and runs script on open demo tab", async () => {
  const env = await launchExtensionContext();

  try {
    const demoPage = env.context.pages()[0] || (await env.context.newPage());
    await demoPage.goto(env.demoServer.url, { waitUntil: "load" });

    const entry = {
      id: "lib_copy_invoice_erp",
      name: "Copy invoice reference to ERP",
      description: "Reads the current invoice code and fills the ERP reference box in one click.",
      kind: "workflow",
      status: "active",
      solution: "Read #invoice-source and fill #erp-invoice.",
      script: {
        name: "Copy invoice reference to ERP",
        steps: [
          { action: "readText", target: { kind: "css", value: "#invoice-source" }, bind: "ref" },
          { action: "fill", target: { kind: "css", value: "#erp-invoice" }, value: "{{ref}}" },
        ],
      },
      eyes: {
        intent: "Copy invoice reference into ERP field",
        scope: { apps: ["127.0.0.1"], urlPatterns: [], pageHints: [] },
        targetHints: { roles: ["textbox"], labelContains: ["invoice"], locators: [] },
        textHints: { prefixHints: [], minCharsBeforeMatch: 0 },
        guards: { fieldEmptyOnly: true, requireClipboard: false, cooldownMs: 60_000, minSignals: 2 },
      },
      stats: {
        repetitions: 4,
        stepCount: 2,
        manualSeconds: 50,
        replaySeconds: 8,
        timeSavedSeconds: 42,
      },
      runCount: 0,
      createdAt: 1_000,
      updatedAt: 2_000,
    };

    await env.context.route("http://localhost:8787/library", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, items: [entry] }),
      });
    });

    const panel = await env.context.newPage();
    await panel.goto(`chrome-extension://${env.extensionId}/dist/panel.html`, {
      waitUntil: "domcontentloaded",
    });

    const cards = panel.locator(".opt-card");
    await expect(cards).toHaveCount(1);
    const card = cards.first();
    await expect(card).toContainText("42s");
    await expect(panel.locator("#sum-runs")).toHaveText("0");
    await expect(panel.locator("#sum-saved")).toHaveText("0s");
    await expect(panel.locator("#sum-active")).toHaveText("1");

    await card.locator('[data-action="run"]').click();

    await expect(demoPage.locator("#erp-invoice")).toHaveValue("INV-2026-0841");
    await expect(panel.locator("#sum-runs")).toHaveText("1");
    await expect(panel.locator("#sum-saved")).toHaveText("42s");
  } finally {
    await env.cleanup();
  }
});

// GEN-131: workflows are saved active automatically and no longer render Add/Dismiss
test.skip("extension panel preserves locally activated workflow across reload when missing from GET /library", async () => {
  const env = await launchExtensionContext();

  try {
    await env.context.route("http://localhost:8787/library", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, items: [] }),
      });
    });

    const suggestedWorkflow = {
      id: "local_suggested_workflow_1",
      title: "Sync order number to dispatch",
      description: "Copies order reference into dispatch form.",
      kind: "workflow",
      status: "suggested",
      app: "Dispatch Portal",
      preview: "Sync order number",
      timeSavedPerRunSec: 18,
      runCount: 0,
      totalTimeSavedSec: 0,
      detectedCount: 3,
      createdAt: 1_000,
    };

    const panel = await env.context.newPage();
    await panel.goto(`chrome-extension://${env.extensionId}/dist/panel.html`, {
      waitUntil: "domcontentloaded",
    });

    await panel.evaluate(async (item) => {
      const chromeApi = (globalThis as {
        chrome?: { storage?: { local?: { set: (items: Record<string, unknown>) => Promise<void> } } };
      }).chrome;
      await chromeApi?.storage?.local?.set({
        eyes_optimization_library_v1: [item],
      });
    }, suggestedWorkflow);

    const cards = panel.locator(".opt-card");
    await expect(cards).toHaveCount(1);
    await expect(panel.locator("#sum-active")).toHaveText("0");

    await cards.first().locator('[data-action="activate"]').click();
    await expect(panel.locator("#sum-active")).toHaveText("1");

    await panel.reload({ waitUntil: "domcontentloaded" });

    await expect(panel.locator(".opt-card")).toHaveCount(1);
    await expect(panel.locator(".opt-card").first()).toContainText(
      "Sync order number to dispatch"
    );
    await expect(panel.locator("#sum-active")).toHaveText("1");
  } finally {
    await env.cleanup();
  }
});

test("extension panel live-refreshes newly saved server entries while open", async () => {
  const env = await launchExtensionContext();

  try {
    let serverItems: unknown[] = [];
    await env.context.route("http://localhost:8787/library", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, items: serverItems }),
      });
    });

    const panel = await env.context.newPage();
    await panel.goto(`chrome-extension://${env.extensionId}/dist/panel.html`, {
      waitUntil: "domcontentloaded",
    });

    await expect(panel.locator(".opt-card")).toHaveCount(0);

    serverItems = [
      {
        id: "lib_live_refresh_1",
        name: "Live-saved workflow",
        description: "Appears without manual reload.",
        kind: "workflow",
        status: "active",
        solution: "Fill #erp-invoice.",
        script: {
          name: "Live-saved workflow",
          steps: [{ action: "click", target: { kind: "css", value: "#save-btn" } }],
        },
        eyes: {
          intent: "Live-saved workflow",
          scope: { apps: ["127.0.0.1"], urlPatterns: [], pageHints: [] },
          targetHints: { roles: ["button"], labelContains: ["save"], locators: [] },
          textHints: { prefixHints: [], minCharsBeforeMatch: 0 },
          guards: { fieldEmptyOnly: false, requireClipboard: false, cooldownMs: 60_000, minSignals: 1 },
        },
        stats: { repetitions: 3, stepCount: 1, manualSeconds: 18, replaySeconds: 2, timeSavedSeconds: 16 },
        runCount: 0,
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ];

    await expect(panel.locator(".opt-card")).toHaveCount(1, { timeout: 6_000 });
    await expect(panel.locator(".opt-card").first()).toContainText("Live-saved workflow");
  } finally {
    await env.cleanup();
  }
});
