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

test("portal-to-erp 3-row cross-tab copy/paste triggers Run popup with real Gemini and does not trigger after 1 row", async () => {
  test.skip(
    !process.env.GOOGLE_CLOUD_PROJECT,
    "GOOGLE_CLOUD_PROJECT must be set for real Gemini E2E test",
  );
  test.setTimeout(90_000);

  const prevUseVertexAi = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENAI_USE_VERTEXAI) {
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
  }

  const demoServer = await startDemoServer({ dir: demoDir, port: 0 });
  const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-portal-erp-traces-"));
  const dataDir = path.join(tracesDir, "data");
  const apiServer: http.Server = createServer({
    tracesDir,
    dataDir,
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

    // 1. Row 1 only: must yield 0 popups
    await completeRow(1);
    await erpPage.waitForTimeout(1500);
    await expect(erpPage.locator("#__eyes_suggestion_host__")).toHaveCount(0);
    await expect(portalPage.locator("#__eyes_suggestion_host__")).toHaveCount(0);

    // 2. Continue rows 2 and 3
    await completeRow(2);
    await completeRow(3);

    // Verify GET /report?llm=0 sees a wf_* finding with repetitions === 3 and verdict !== "do_not_automate"
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
                repetitions: wf.stats.repetitions,
                verdict: wf.verdict,
              }
            : null;
        },
        { timeout: 20_000 },
      )
      .toMatchObject({
        repetitions: 3,
      });

    const reportRes = await fetch(`${apiBaseUrl}/report?llm=0`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    const wfFinding = report.findings.find((f) => f.id.startsWith("wf_"));
    expect(wfFinding).toBeDefined();
    expect(wfFinding?.stats.repetitions).toBe(3);
    expect(wfFinding?.verdict).not.toBe("do_not_automate");

    // Verify the auto-proposed Run popup appears on erpPage
    const popup = erpPage.locator('#__eyes_suggestion_host__[data-eyes-suggestion="click"]');
    await expect(popup).toBeVisible({ timeout: 60_000 });

    const primaryText = await popup.evaluate((host) => {
      return host.shadowRoot?.querySelector("[data-eyes-primary]")?.textContent?.trim() ?? "";
    });
    expect(primaryText).toBe("Run");
  } finally {
    if (prevUseVertexAi === undefined) {
      delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    } else {
      process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertexAi;
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
