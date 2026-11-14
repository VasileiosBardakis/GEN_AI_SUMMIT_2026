import { chromium, expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { startDemoServer } from "../scripts/lib/static-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const demoDir = path.join(rootDir, "apps", "demo");

test("portal and erp cross-tab copy/paste saves invoice rows without extension", async () => {
  const demoServer = await startDemoServer({ dir: demoDir, port: 0 });
  const executablePath = fs.existsSync(chromium.executablePath())
    ? undefined
    : await resolveChromeExecutable();
  const browser = await chromium.launch({ headless: true, executablePath });

  try {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });

    const portalPage = await context.newPage();
    const erpPage = await context.newPage();

    await portalPage.goto(`http://localhost:${demoServer.port}/portal.html`, {
      waitUntil: "load",
    });
    await erpPage.goto(`http://127.0.0.1:${demoServer.port}/erp.html`, {
      waitUntil: "load",
    });

    const copyAndPasteField = async (copyTestId: string, erpTestId: string) => {
      await portalPage.getByTestId(copyTestId).click();
      const input = erpPage.getByTestId(erpTestId);
      await input.click();
      await erpPage.keyboard.press("ControlOrMeta+V");
    };

    // Row 1 via the detail panel
    await copyAndPasteField("copy-portal-invoice-id", "erp-invoice-id");
    await copyAndPasteField("copy-portal-vendor", "erp-vendor");
    await copyAndPasteField("copy-portal-amount", "erp-amount");
    await copyAndPasteField("copy-portal-date", "erp-date");

    await erpPage.locator("#save-btn").click();

    await expect(erpPage.getByTestId("erp-invoice-id")).toHaveValue("");
    await expect(erpPage.getByTestId("erp-vendor")).toHaveValue("");
    await expect(erpPage.getByTestId("erp-amount")).toHaveValue("");
    await expect(erpPage.getByTestId("erp-date")).toHaveValue("");

    const savedRows = erpPage.locator("#saved-invoices tr");
    await expect(savedRows).toHaveCount(1);
    await expect(savedRows.nth(0)).toContainText("INV-2026-001");
    await expect(savedRows.nth(0)).toContainText("Acme Industrial");
    await expect(savedRows.nth(0)).toContainText("1250.00 EUR");
    await expect(savedRows.nth(0)).toContainText("2026-03-01");

    // Row 2 via the portal table cells
    await copyAndPasteField("copy-portal-invoice-id-2", "erp-invoice-id");
    await copyAndPasteField("copy-portal-vendor-2", "erp-vendor");
    await copyAndPasteField("copy-portal-amount-2", "erp-amount");
    await copyAndPasteField("copy-portal-date-2", "erp-date");

    await erpPage.locator("#save-btn").click();

    await expect(savedRows).toHaveCount(2);
    await expect(savedRows.nth(1)).toContainText("INV-2026-002");
    await expect(savedRows.nth(1)).toContainText("Globex Corp");
    await expect(savedRows.nth(1)).toContainText("840.50 EUR");
    await expect(savedRows.nth(1)).toContainText("2026-03-04");
  } finally {
    await browser.close().catch(() => {});
    await demoServer.close();
  }
});
