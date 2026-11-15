/* global console, document, HTMLInputElement, process, setTimeout */
import fs from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { resolveChromeExecutable } from "./lib/chrome.mjs";
import { startDemoServer } from "./lib/static-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const demoDir = path.join(rootDir, "apps", "demo");
const assetsDir = path.join(rootDir, "extension", "assets");
const outPath = path.join(assetsDir, "replay-demo.webm");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "eyes-replay-demo-"));
  const demo = await startDemoServer({ dir: demoDir, port: 5173 });

  let browser;
  try {
    const executablePath = fs.existsSync(chromium.executablePath())
      ? undefined
      : await resolveChromeExecutable();

    browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({
      viewport: { width: 640, height: 360 },
      recordVideo: { dir: tmpDir, size: { width: 320, height: 180 } },
      permissions: ["clipboard-read", "clipboard-write"],
    });

    const page = await context.newPage();
    const video = page.video();
    if (!video) {
      throw new Error("Playwright video recording was not initialized");
    }

    await page.goto(`${demo.url}/index.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#copy-invoice").scrollIntoViewIfNeeded();
    await sleep(350);

    const invoices = ["INV-2026-0841", "INV-2026-0842"];
    for (const ref of invoices) {
      await page.evaluate((value) => {
        const el = document.getElementById("invoice-source");
        if (el) el.textContent = value;
        const input = document.getElementById("erp-invoice");
        if (input instanceof HTMLInputElement) input.value = "";
      }, ref);
      await sleep(120);

      await page.locator("#copy-invoice").click();
      await sleep(140);

      const erpInput = page.locator("#erp-invoice");
      await erpInput.click();
      await sleep(100);
      await page.keyboard.press("ControlOrMeta+V");
      await sleep(220);
    }

    await context.close();
    const recordedPath = await video.path();

    await mkdir(assetsDir, { recursive: true });
    await copyFile(recordedPath, outPath);

    const info = await stat(outPath);
    if (info.size < 1024) {
      throw new Error(`Recorded replay video is unexpectedly small (${info.size} bytes)`);
    }

    console.log(`[replay] recorded ${info.size} bytes -> ${outPath}`);
  } finally {
    if (browser) await browser.close();
    await demo.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
