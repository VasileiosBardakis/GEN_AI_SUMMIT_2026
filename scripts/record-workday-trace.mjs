/* global console, fetch, navigator, process, setTimeout */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { EventsSchema } from "../shared/schema.ts";
import { createServer } from "../server/src/app.ts";
import { readEvents } from "../server/src/trace.ts";
import { resolveChromeExecutable } from "./lib/chrome.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const contentScriptPath = path.join(rootDir, "extension", "dist", "content.js");
const tracesDir = path.join(rootDir, "traces");
const SESSION_ID = "workday_30m_demo";

const SHEETS_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Q4 Invoices - Google Sheets</title></head>
<body style="font-family: system-ui, sans-serif; margin: 24px;">
  <h1>Q4 Invoices</h1>
  <input id="t-name-box" aria-label="Name box" value="A1" readonly />
  <table role="grid" border="1" cellpadding="8">
    <thead><tr><th>Invoice</th><th>Amount EUR</th><th>Vendor</th></tr></thead>
    <tbody>
      <tr aria-rowindex="1">
        <td role="gridcell" tabindex="0" data-cell="A1" data-row="1" data-col="1">INV-2026-101</td>
        <td role="gridcell" tabindex="0" data-cell="B1" data-row="1" data-col="2">1450</td>
        <td role="gridcell" tabindex="0" data-cell="C1" data-row="1" data-col="3">Aegean Freight</td>
      </tr>
      <tr aria-rowindex="2">
        <td role="gridcell" tabindex="0" data-cell="A2" data-row="2" data-col="1">INV-2026-102</td>
        <td role="gridcell" tabindex="0" data-cell="B2" data-row="2" data-col="2">2890</td>
        <td role="gridcell" tabindex="0" data-cell="C2" data-row="2" data-col="3">Hellas Cloud</td>
      </tr>
      <tr aria-rowindex="3">
        <td role="gridcell" tabindex="0" data-cell="A3" data-row="3" data-col="1">INV-2026-103</td>
        <td role="gridcell" tabindex="0" data-cell="B3" data-row="3" data-col="2">920</td>
        <td role="gridcell" tabindex="0" data-cell="C3" data-row="3" data-col="3">Piraeus Supply</td>
      </tr>
      <tr aria-rowindex="4">
        <td role="gridcell" tabindex="0" data-cell="A4" data-row="4" data-col="1">INV-2026-104</td>
        <td role="gridcell" tabindex="0" data-cell="B4" data-row="4" data-col="2">3100</td>
        <td role="gridcell" tabindex="0" data-cell="C4" data-row="4" data-col="3">Attica Labs</td>
      </tr>
      <tr aria-rowindex="5">
        <td role="gridcell" tabindex="0" data-cell="A5" data-row="5" data-col="1">INV-2026-105</td>
        <td role="gridcell" tabindex="0" data-cell="B5" data-row="5" data-col="2">675</td>
        <td role="gridcell" tabindex="0" data-cell="C5" data-row="5" data-col="3">Nordic Office</td>
      </tr>
    </tbody>
  </table>
  <script>
    const nb = document.getElementById("t-name-box");
    document.querySelectorAll("td[data-cell]").forEach((td) => {
      td.addEventListener("click", () => { nb.value = td.dataset.cell; });
    });
  </script>
</body>
</html>`;

const ERP_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Acme ERP - Invoice Entry</title></head>
<body style="font-family: system-ui, sans-serif; margin: 24px;">
  <h1>Acme ERP</h1>
  <section>
    <h2>Invoice Posting</h2>
    <form id="erp-form">
      <label>Invoice Ref <input id="erp-ref" name="invoice_ref" data-testid="erp-ref" /></label>
      <label>Amount EUR <input id="erp-amount" name="amount_eur" data-testid="erp-amount" /></label>
      <label>Status
        <select id="erp-status" name="status" data-testid="erp-status">
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="hold">On Hold</option>
        </select>
      </label>
      <button type="submit" data-testid="erp-submit">Post Invoice</button>
    </form>
  </section>
  <section>
    <h2>Account Settings</h2>
    <label>Department Note <input id="dept-note" name="dept_note" data-testid="dept-note" /></label>
    <button type="button" data-testid="save-note">Save Note</button>
  </section>
  <div id="erp-log"></div>
  <script>
    document.getElementById("erp-form").addEventListener("submit", (e) => {
      e.preventDefault();
      document.getElementById("erp-log").textContent = "Posted " + document.getElementById("erp-ref").value;
      document.getElementById("erp-ref").value = "";
      document.getElementById("erp-amount").value = "";
      document.getElementById("erp-status").value = "pending";
    });
  </script>
</body>
</html>`;

const INBOX_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Support Inbox - Helpdesk</title></head>
<body style="font-family: system-ui, sans-serif; margin: 24px;">
  <h1>Support Inbox</h1>
  <div>
    <button type="button" data-testid="thread-1">Order #401</button>
    <button type="button" data-testid="thread-2">Order #402</button>
    <button type="button" data-testid="thread-3">Order #403</button>
    <button type="button" data-testid="thread-4">Billing #404</button>
  </div>
  <textarea id="reply-box" aria-label="Reply body" data-testid="reply-box" rows="4" cols="60"></textarea>
  <div><button type="button" data-testid="send-reply">Send Reply</button></div>
  <script>
    document.querySelector('[data-testid="send-reply"]').addEventListener("click", () => {
      document.getElementById("reply-box").value = "";
    });
  </script>
</body>
</html>`;

const YOUTUBE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>YouTube - Home</title></head>
<body style="font-family: system-ui, sans-serif; margin: 24px; min-height: 1800px;">
  <h1>YouTube</h1>
  <input id="yt-search" aria-label="Search" data-testid="yt-search" placeholder="Search videos" />
  <button type="button" data-testid="yt-search-btn">Search</button>
  <div style="margin-top: 24px; display: grid; gap: 16px;">
    <button type="button" data-testid="yt-video-1">Lo-fi Hip Hop Radio - Beats to Relax/Study to</button>
    <button type="button" data-testid="yt-video-2">Mechanical Keyboard Sound Test (ASMR)</button>
    <button type="button" data-testid="yt-like">Like Video</button>
  </div>
  <div id="yt-player" style="margin-top: 24px;">Idle</div>
  <script>
    document.querySelector('[data-testid="yt-video-1"]').addEventListener("click", () => {
      document.title = "Lo-fi Hip Hop Radio - YouTube";
      document.getElementById("yt-player").textContent = "Playing Lo-fi";
    });
    document.querySelector('[data-testid="yt-video-2"]').addEventListener("click", () => {
      document.title = "Mechanical Keyboard Sound Test - YouTube";
      document.getElementById("yt-player").textContent = "Playing Keyboard";
    });
  </script>
</body>
</html>`;

const DOCS_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Internal Wiki - Operations SOP</title></head>
<body style="font-family: system-ui, sans-serif; margin: 24px; min-height: 1600px;">
  <h1>Operations SOP</h1>
  <input id="wiki-search" aria-label="Wiki search" data-testid="wiki-search" placeholder="Filter docs" />
  <button type="button" data-testid="wiki-tab-tax">Q4 Tax Codes</button>
  <button type="button" data-testid="wiki-tab-audit">Audit Checklist</button>
  <p style="margin-top: 400px;">End of SOP section.</p>
</body>
</html>`;

const ROUTES = {
  "/sheets": SHEETS_HTML,
  "/erp": ERP_HTML,
  "/inbox": INBOX_HTML,
  "/youtube": YOUTUBE_HTML,
  "/docs": DOCS_HTML,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listenOnRandomPort(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function ensureExtensionBuilt() {
  if (!fs.existsSync(contentScriptPath)) {
    await import("../extension/build.mjs");
  }
}

function sha8(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
}

async function main() {
  await ensureExtensionBuilt();
  const contentScriptCode = await readFile(contentScriptPath, "utf8");

  await mkdir(tracesDir, { recursive: true });
  const tmpTracesDir = await mkdtemp(path.join(tracesDir, ".tmp-workday-"));

  const collectorServer = createServer({ tracesDir: tmpTracesDir });
  const appServer = http.createServer((req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    const html = ROUTES[pathname] ?? DOCS_HTML;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  let browser;
  try {
    const collectorPort = await listenOnRandomPort(collectorServer);
    const appPort = await listenOnRandomPort(appServer);

    const initScript = `
      try { sessionStorage.setItem("__eyes_session__", ${JSON.stringify(SESSION_ID)}); } catch {}
      window.__EYES_CONFIG__ = {
        mode: "semantic",
        endpoint: "http://127.0.0.1:${collectorPort}/events",
        batchMs: 80,
        maxBatchSize: 50
      };
      ${contentScriptCode}
    `;

    const executablePath = fs.existsSync(chromium.executablePath())
      ? undefined
      : await resolveChromeExecutable();
    browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    await context.addInitScript({ content: initScript });

    const sheetsPage = await context.newPage();
    const erpPage = await context.newPage();
    const inboxPage = await context.newPage();
    const youtubePage = await context.newPage();
    const docsPage = await context.newPage();

    const urlFor = (host, pathname) => `http://${host}:${appPort}${pathname}`;

    const simStartMs = Date.now() - 30 * 60_000;
    let simClockMs = simStartMs;
    const timeline = [];
    let activeMeta = null;

    async function flushAllPages() {
      for (const p of [sheetsPage, erpPage, inboxPage, youtubePage, docsPage]) {
        if (!p.isClosed()) {
          await p.evaluate("window.__EYES_FLUSH__ && window.__EYES_FLUSH__()").catch(() => {});
        }
      }
      await sleep(120);
    }

    async function runPhase(label, gapMs, fn) {
      simClockMs += gapMs;
      const realStart = Date.now();
      const simAnchor = simClockMs;
      await fn();
      await flushAllPages();
      const realEnd = Date.now();
      const durationMs = Math.max(100, realEnd - realStart);
      simClockMs += durationMs;
      timeline.push({ label, realStart, realEnd, simAnchor });
    }

    async function switchTab(page, app, title, url) {
      const prevApp = activeMeta?.app;
      await page.bringToFront();
      if (page.url() === "about:blank") {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      }
      activeMeta = { app, title, url };
      await fetch(`http://127.0.0.1:${collectorPort}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          {
            v: 1,
            id: crypto.randomUUID(),
            ts: Date.now(),
            session: SESSION_ID,
            source: "browser",
            app,
            window: title,
            url,
            type: "tab_switch",
            meta: {
              subType: prevApp && prevApp !== app ? "cross_app_switch" : "same_app_switch",
              fromApp: prevApp,
              toApp: app,
            },
          },
        ]),
      });
    }

    async function doInvoiceRound(rowNum, invRef, amount) {
      await switchTab(
        sheetsPage,
        "sheets.localhost",
        "Q4 Invoices - Google Sheets",
        urlFor("sheets.localhost", "/sheets"),
      );
      await sheetsPage.locator(`td[data-cell="A${rowNum}"]`).click();
      await sheetsPage.evaluate((text) => navigator.clipboard.writeText(text), invRef);
      await fetch(`http://127.0.0.1:${collectorPort}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          {
            v: 1,
            id: crypto.randomUUID(),
            ts: Date.now(),
            session: SESSION_ID,
            source: "browser",
            app: "sheets.localhost",
            window: "Q4 Invoices - Google Sheets",
            url: urlFor("sheets.localhost", "/sheets"),
            type: "copy",
            clipboard: {
              fromApp: "sheets.localhost",
              fromUrl: urlFor("sheets.localhost", "/sheets"),
              fromCell: `A${rowNum}`,
              text: invRef,
              textHash: sha8(invRef),
            },
          },
        ]),
      });

      await switchTab(
        erpPage,
        "erp.localhost",
        "Acme ERP - Invoice Entry",
        urlFor("erp.localhost", "/erp"),
      );
      await erpPage.getByTestId("erp-ref").click();
      await erpPage.getByTestId("erp-ref").fill(invRef);
      await fetch(`http://127.0.0.1:${collectorPort}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          {
            v: 1,
            id: crypto.randomUUID(),
            ts: Date.now(),
            session: SESSION_ID,
            source: "browser",
            app: "erp.localhost",
            window: "Acme ERP - Invoice Entry",
            url: urlFor("erp.localhost", "/erp"),
            type: "paste",
            target: {
              locators: [{ kind: "testid", value: "erp-ref" }],
              tag: "input",
              label: "Invoice Ref",
              role: "textbox",
            },
            value: invRef,
            clipboard: {
              fromApp: "sheets.localhost",
              toApp: "erp.localhost",
              fromUrl: urlFor("sheets.localhost", "/sheets"),
              fromCell: `A${rowNum}`,
              text: invRef,
              textHash: sha8(invRef),
              timeSinceCopyMs: 1800,
            },
          },
        ]),
      });
      await erpPage.getByTestId("erp-amount").click();
      await erpPage.keyboard.type(amount, { delay: 5 });
      await erpPage.getByTestId("erp-status").selectOption("approved");
      await erpPage.getByTestId("erp-submit").click();
    }

    // 00:00 - 03:30 | Non-repeatable morning startup: Wiki + one-off ERP note
    await runPhase("Morning wiki + one-off ERP settings", 0, async () => {
      await switchTab(
        docsPage,
        "docs.localhost",
        "Internal Wiki - Operations SOP",
        urlFor("docs.localhost", "/docs"),
      );
      await docsPage.getByTestId("wiki-tab-audit").click();
      await docsPage.mouse.wheel(0, 450);

      await switchTab(
        erpPage,
        "erp.localhost",
        "Acme ERP - Invoice Entry",
        urlFor("erp.localhost", "/erp"),
      );
      await erpPage.getByTestId("dept-note").click();
      await erpPage.keyboard.type("Q4 audit check", { delay: 5 });
      await erpPage.keyboard.press("Backspace");
      await erpPage.getByTestId("save-note").click();
    });

    // 03:30 - 08:30 | Repeatable Workflow A (Rounds 1 & 2)
    await runPhase("Invoice loop #1 (INV-2026-101)", 210_000, () =>
      doInvoiceRound(1, "INV-2026-101", "1450"),
    );
    await runPhase("Invoice loop #2 (INV-2026-102)", 140_000, () =>
      doInvoiceRound(2, "INV-2026-102", "2890"),
    );

    // 08:30 - 14:15 | Slacking off #1: YouTube video + scrolling
    await runPhase("Slacking on YouTube #1", 160_000, async () => {
      await switchTab(
        youtubePage,
        "youtube.localhost",
        "YouTube - Home",
        urlFor("youtube.localhost", "/youtube"),
      );
      await youtubePage.getByTestId("yt-search").click();
      await youtubePage.keyboard.type("lofi beats", { delay: 5 });
      await youtubePage.getByTestId("yt-search-btn").click();
      await youtubePage.getByTestId("yt-video-1").click();
      await youtubePage.mouse.wheel(0, 600);
    });

    // 14:15 - 18:45 | Repeatable Workflow B: Support Inbox replies (3 similar + 1 unique)
    await runPhase("Support reply #1 (shipping Friday)", 320_000, async () => {
      await switchTab(
        inboxPage,
        "inbox.localhost",
        "Support Inbox - Helpdesk",
        urlFor("inbox.localhost", "/inbox"),
      );
      await inboxPage.getByTestId("thread-1").click();
      await inboxPage.getByTestId("reply-box").click();
      await inboxPage.keyboard.type(
        "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
        { delay: 4 },
      );
      await inboxPage.getByTestId("send-reply").click();
    });

    await runPhase("Support reply #2 (shipping Monday)", 75_000, async () => {
      await inboxPage.getByTestId("thread-2").click();
      await inboxPage.getByTestId("reply-box").click();
      await inboxPage.keyboard.type(
        "Hi, thanks for your order. It ships Monday and tracking will follow shortly.",
        { delay: 4 },
      );
      await inboxPage.getByTestId("send-reply").click();
    });

    await runPhase("Support reply #3 (shipping Friday)", 80_000, async () => {
      await inboxPage.getByTestId("thread-3").click();
      await inboxPage.getByTestId("reply-box").click();
      await inboxPage.keyboard.type(
        "Hi, thanks for your order! It ships Friday and tracking will follow shortly.",
        { delay: 4 },
      );
      await inboxPage.getByTestId("send-reply").click();
    });

    await runPhase("Non-repeatable billing reply #4", 95_000, async () => {
      await inboxPage.getByTestId("thread-4").click();
      await inboxPage.getByTestId("reply-box").click();
      await inboxPage.keyboard.type(
        "Attached is the revised VAT breakdown for your November consulting invoice.",
        { delay: 4 },
      );
      await inboxPage.getByTestId("send-reply").click();
    });

    // 18:45 - 22:00 | Non-repeatable ad-hoc lookup
    await runPhase("Ad-hoc tax code lookup", 150_000, async () => {
      await switchTab(
        docsPage,
        "docs.localhost",
        "Internal Wiki - Operations SOP",
        urlFor("docs.localhost", "/docs"),
      );
      await docsPage.getByTestId("wiki-search").click();
      await docsPage.keyboard.type("vat exemption 2026", { delay: 5 });
      await docsPage.getByTestId("wiki-tab-tax").click();
      await docsPage.mouse.wheel(0, -300);
    });

    // 22:00 - 25:30 | Slacking off #2: YouTube break
    await runPhase("Slacking on YouTube #2", 190_000, async () => {
      await switchTab(
        youtubePage,
        "youtube.localhost",
        "YouTube - Home",
        urlFor("youtube.localhost", "/youtube"),
      );
      await youtubePage.getByTestId("yt-video-2").click();
      await youtubePage.getByTestId("yt-like").click();
      await youtubePage.mouse.wheel(0, 400);
    });

    // 25:30 - 30:00 | Back to Repeatable Workflow A (Rounds 3, 4, 5)
    await runPhase("Invoice loop #3 (INV-2026-103)", 190_000, () =>
      doInvoiceRound(3, "INV-2026-103", "920"),
    );
    await runPhase("Invoice loop #4 (INV-2026-104)", 95_000, () =>
      doInvoiceRound(4, "INV-2026-104", "3100"),
    );
    await runPhase("Invoice loop #5 (INV-2026-105)", 95_000, () =>
      doInvoiceRound(5, "INV-2026-105", "675"),
    );

    await flushAllPages();
    await sleep(300);

    const rawEvents = await readEvents(tmpTracesDir, SESSION_ID);
    if (rawEvents.length === 0) {
      throw new Error("No events captured during Playwright workday session");
    }

    // Remap real capture timestamps onto the simulated 30-minute timeline
    const mappedEvents = rawEvents.map((ev) => {
      let phase = timeline[0];
      for (const p of timeline) {
        if (ev.ts >= p.realStart) phase = p;
      }
      const delta = Math.max(0, ev.ts - phase.realStart);
      return { ...ev, ts: phase.simAnchor + delta };
    });

    // Ensure total span covers ~30 minutes cleanly
    mappedEvents.sort((a, b) => a.ts - b.ts);
    const validated = EventsSchema.parse(mappedEvents);

    const outputTraceFile = path.join(tracesDir, `${SESSION_ID}.jsonl`);
    await writeFile(
      outputTraceFile,
      validated.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const spanMin = (
      (validated[validated.length - 1].ts - validated[0].ts) /
      60_000
    ).toFixed(1);
    const apps = [...new Set(validated.map((e) => e.app))].join(", ");
    console.log(
      `Recorded ${validated.length} events spanning ${spanMin} simulated min across [${apps}] -> ${outputTraceFile}`,
    );
  } finally {
    if (browser) await browser.close();
    await closeHttpServer(appServer);
    await closeHttpServer(collectorServer);
    await rm(tmpTracesDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
