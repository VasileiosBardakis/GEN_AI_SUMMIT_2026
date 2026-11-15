import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import type { Report } from "@gen/shared";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { startDemoServer } from "../scripts/lib/static-server.mjs";
import { createServer } from "../server/src/app.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");
const demoDir = path.join(rootDir, "apps", "demo");

test("portal-to-erp cross-tab copy/paste triggers Run popup after 2-3 field pairs with real Gemini and Run fills the rest", async () => {
  test.skip(true, "removed by f35b69c / GEN-114");
  test.skip(
    !process.env.GOOGLE_CLOUD_PROJECT,
    "GOOGLE_CLOUD_PROJECT must be set for real Gemini E2E test",
  );
  test.setTimeout(120_000);

  const prevUseVertexAi = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  const prevCompileTimeout = process.env.V2_COMPILE_TIMEOUT_MS;
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENAI_USE_VERTEXAI) {
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
  }
  if (!process.env.V2_COMPILE_TIMEOUT_MS) {
    process.env.V2_COMPILE_TIMEOUT_MS = "25000";
  }

  const demoServer = await startDemoServer({ dir: demoDir, port: 0 });
  const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-portal-erp-traces-"));
  const dataDir = path.join(tracesDir, "data");
  const apiServer: http.Server = createServer({
    tracesDir,
    dataDir,
    pipeline: "v2",
    autoPropose: true,
    proposeDebounceMs: 500,
  });

  await new Promise<void>((resolve) => {
    apiServer.listen(0, "127.0.0.1", () => resolve());
  });
  const apiAddr = apiServer.address() as AddressInfo;
  const apiBaseUrl = `http://127.0.0.1:${apiAddr.port}`;

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-portal-erp-profile-"));
  const executablePath = await resolveChromeExecutable();

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: true,
    recordVideo: { dir: path.join(rootDir, "test-results", "videos") },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await context.route("http://localhost:8787/**", async (route) => {
    const req = route.request();
    const targetUrl = req.url().replace("http://localhost:8787", apiBaseUrl);
    try {
      const response = await fetch(targetUrl, {
        method: req.method(),
        headers: req.headers(),
        body: req.postDataBuffer() ?? undefined,
      });
      const body = Buffer.from(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      await route.fulfill({ status: response.status, headers, body });
    } catch {
      await route.abort().catch(() => {});
    }
  });

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    }
    expect(serviceWorker.url()).toContain("background.js");

    const portalPage = context.pages()[0] || (await context.newPage());
    const erpPage = await context.newPage();

    await portalPage.goto(`http://localhost:${demoServer.port}/portal.html`, {
      waitUntil: "load",
    });
    await erpPage.goto(`http://127.0.0.1:${demoServer.port}/erp.html`, {
      waitUntil: "load",
    });

    // Give content scripts time to attach after document_idle
    await portalPage.waitForTimeout(300);
    await erpPage.waitForTimeout(300);

    const copyAndPasteField = async (copyTestId: string, erpTestId: string) => {
      await portalPage.bringToFront();
      await portalPage.getByTestId(copyTestId).click();
      await erpPage.bringToFront();
      const input = erpPage.getByTestId(erpTestId);
      await input.click();
      await erpPage.keyboard.press("ControlOrMeta+V");
    };

    const completeRow = async (rowIdx: number) => {
      await copyAndPasteField(`copy-portal-invoice-id-${rowIdx}`, "erp-invoice-id");
      await copyAndPasteField(`copy-portal-vendor-${rowIdx}`, "erp-vendor");
      await copyAndPasteField(`copy-portal-amount-${rowIdx}`, "erp-amount");
      await copyAndPasteField(`copy-portal-date-${rowIdx}`, "erp-date");
      await erpPage.locator("#save-btn").click();
      await expect(erpPage.locator("#saved-invoices tr")).toHaveCount(rowIdx);
    };

    const popup = erpPage.locator('#__eyes_suggestion_host__[data-eyes-suggestion="click"]');

    // 1. Perform 2-3 copied/pasted field pairs (and continue rows 1-3 if needed until Run popup appears)
    await copyAndPasteField("copy-portal-invoice-id-1", "erp-invoice-id");
    await copyAndPasteField("copy-portal-vendor-1", "erp-vendor");
    if (!(await popup.isVisible().catch(() => false))) {
      await copyAndPasteField("copy-portal-amount-1", "erp-amount");
    }
    if (!(await popup.isVisible().catch(() => false))) {
      await copyAndPasteField("copy-portal-date-1", "erp-date");
      await erpPage.locator("#save-btn").click();
      await expect(erpPage.locator("#saved-invoices tr")).toHaveCount(1);
    }
    for (const rowIdx of [2, 3]) {
      if (await popup.isVisible().catch(() => false)) break;
      await completeRow(rowIdx);
    }

    // Verify GET /report?llm=0 sees a wf_* finding and verdict !== "do_not_automate"
    await expect
      .poll(
        async () => {
          const res = await fetch(`${apiBaseUrl}/report?llm=0`);
          if (!res.ok) return null;
          const report = (await res.json()) as Report;
          const wf = report.findings.find((f) => f.id.startsWith("wf_"));
          return wf
            ? {
                id: wf.id,
                verdict: wf.verdict,
              }
            : null;
        },
        { timeout: 20_000 },
      )
      .toBeTruthy();

    const reportRes = await fetch(`${apiBaseUrl}/report?llm=0`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    const wfFinding = report.findings.find((f) => f.id.startsWith("wf_"));
    expect(wfFinding).toBeDefined();
    expect(wfFinding?.verdict).not.toBe("do_not_automate");

    // Verify the auto-proposed Run popup appears on erpPage
    await expect(popup).toBeVisible({ timeout: 60_000 });

    const primaryText = await popup.evaluate((host) => {
      return host.shadowRoot?.querySelector("[data-eyes-primary]")?.textContent?.trim() ?? "";
    });
    expect(primaryText).toBe("Run");

    // 2. Click Run and verify replay fills and saves the remaining rows onto erpPage
    const beforeCount = await erpPage.locator("#saved-invoices tr").count();
    await popup.locator("[data-eyes-primary]").click();

    const savedRows = erpPage.locator("#saved-invoices tr");
    await expect(savedRows.nth(beforeCount)).toBeVisible({ timeout: 30_000 });
    const afterCount = await savedRows.count();
    expect(afterCount).toBeGreaterThan(beforeCount);
  } finally {
    if (prevUseVertexAi === undefined) {
      delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    } else {
      process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertexAi;
    }
    if (prevCompileTimeout === undefined) {
      delete process.env.V2_COMPILE_TIMEOUT_MS;
    } else {
      process.env.V2_COMPILE_TIMEOUT_MS = prevCompileTimeout;
    }
    await context.close().catch(() => {});
    apiServer.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      apiServer.close((err) => (err ? reject(err) : resolve()));
    });
    await demoServer.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(tracesDir, { recursive: true, force: true });
  }
});
