import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type Locator, type Page } from "@playwright/test";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { createServer } from "../server/src/app.ts";
import { readEvents } from "../server/src/trace.ts";
import { EventsSchema } from "../shared/schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const contentScriptPath = path.join(rootDir, "extension", "dist", "content.js");
const tracesDir = path.join(rootDir, "traces");
const SESSION_ID = "workday_30m_demo";

const SHEETS_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Q4 Invoices - Google Sheets</title></head>
<body style="font-family: system-ui, sans-serif; margin: 52px 28px; background:#f8fafc; color:#0f172a; min-height: 1100px;">
  <h1>Q4 Invoices — Google Sheets</h1>
  <div style="margin-bottom:12px;">Active Cell: <input id="t-name-box" aria-label="Name box" value="A1" readonly style="width:76px;padding:5px 8px;font-family:monospace;" /></div>
  <table role="grid" border="1" cellpadding="12" style="border-collapse:collapse;background:#fff;width:100%;max-width:860px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
    <thead><tr style="background:#e2e8f0;"><th>Invoice</th><th>Amount EUR</th><th>Vendor</th><th>Cost Center</th></tr></thead>
    <tbody>
      ${[
        ["1", "INV-2026-101", "1450", "Aegean Freight", "OPS-EU"],
        ["2", "INV-2026-102", "2890", "Hellas Cloud", "INFRA"],
        ["3", "INV-2026-103", "920", "Piraeus Supply", "LOG-01"],
        ["4", "INV-2026-104", "3100", "Attica Labs", "RND-02"],
        ["5", "INV-2026-105", "675", "Nordic Office", "ADM-04"],
        ["6", "INV-2026-106", "4210", "Thrace Logistics", "OPS-EU"],
        ["7", "INV-2026-107", "1180", "Ionian Media", "MKT-03"],
        ["8", "INV-2026-108", "2340", "Delta Hardware", "INFRA"],
      ]
        .map(
          ([r, inv, amt, ven, cc]) =>
            `<tr aria-rowindex="${r}"><td role="gridcell" tabindex="0" data-cell="A${r}" data-row="${r}" data-col="1">${inv}</td><td role="gridcell" tabindex="0" data-cell="B${r}" data-row="${r}" data-col="2">${amt}</td><td role="gridcell" tabindex="0" data-cell="C${r}" data-row="${r}" data-col="3">${ven}</td><td role="gridcell" tabindex="0" data-cell="D${r}" data-row="${r}" data-col="4">${cc}</td></tr>`,
        )
        .join("\n")}
    </tbody>
  </table>
  <script>
    const nb = document.getElementById("t-name-box");
    document.querySelectorAll("td[data-cell]").forEach((td) => {
      td.addEventListener("click", () => {
        nb.value = td.dataset.cell;
        document.querySelectorAll("td[data-cell]").forEach((el) => (el.style.background = ""));
        td.style.background = "#dbeafe";
      });
    });
  </script>
</body>
</html>`;

const ERP_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Acme ERP - Invoice Entry</title></head>
<body style="font-family: system-ui, sans-serif; margin: 52px 28px; background:#0f172a; color:#e2e8f0; min-height: 1100px;">
  <h1>Acme ERP — Invoice Posting</h1>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:920px;">
    <form id="erp-form" style="display:grid;gap:12px;background:#1e293b;padding:20px;border-radius:10px;">
      <label>Invoice Ref <input id="erp-ref" name="invoice_ref" data-testid="erp-ref" style="width:100%;padding:9px;margin-top:4px;background:#0f172a;color:#fff;border:1px solid #334155;border-radius:6px;" /></label>
      <label>Amount EUR <input id="erp-amount" name="amount_eur" data-testid="erp-amount" style="width:100%;padding:9px;margin-top:4px;background:#0f172a;color:#fff;border:1px solid #334155;border-radius:6px;" /></label>
      <label>Status
        <select id="erp-status" name="status" data-testid="erp-status" style="width:100%;padding:9px;margin-top:4px;background:#0f172a;color:#fff;border:1px solid #334155;border-radius:6px;">
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="hold">On Hold</option>
        </select>
      </label>
      <button type="submit" data-testid="erp-submit" style="padding:10px;background:#2563eb;color:#fff;border:0;border-radius:6px;font-weight:600;">Post Invoice</button>
    </form>
    <section style="background:#1e293b;padding:20px;border-radius:10px;display:grid;gap:12px;align-content:start;">
      <h2 style="margin:0;font-size:16px;">Account Notes & Ledger</h2>
      <label>Department Note <input id="dept-note" name="dept_note" data-testid="dept-note" style="width:100%;padding:9px;margin-top:4px;background:#0f172a;color:#fff;border:1px solid #334155;border-radius:6px;" /></label>
      <button type="button" data-testid="save-note" style="padding:8px 12px;background:#334155;color:#fff;border:0;border-radius:6px;">Save Note</button>
      <div id="erp-log" style="color:#38bdf8;font-family:monospace;font-size:13px;">Ready</div>
    </section>
  </div>
  <script>
    const log = document.getElementById("erp-log");
    document.getElementById("erp-form").addEventListener("submit", (e) => {
      e.preventDefault();
      log.textContent = "Posted " + document.getElementById("erp-ref").value + " (" + document.getElementById("erp-amount").value + " EUR)";
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
<body style="font-family: system-ui, sans-serif; margin: 52px 28px; background:#f8fafc; color:#111827; min-height: 1000px;">
  <h1>Support Inbox</h1>
  <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
    <button type="button" data-testid="thread-1" style="padding:8px 12px;">Order #401 (Shipping)</button>
    <button type="button" data-testid="thread-2" style="padding:8px 12px;">Order #402 (ETA)</button>
    <button type="button" data-testid="thread-3" style="padding:8px 12px;">Order #403 (Tracking)</button>
    <button type="button" data-testid="thread-4" style="padding:8px 12px;">Billing #404 (VAT)</button>
    <button type="button" data-testid="thread-5" style="padding:8px 12px;">Order #405 (Friday)</button>
  </div>
  <textarea id="reply-box" aria-label="Reply body" data-testid="reply-box" rows="5" cols="68" style="padding:12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;"></textarea>
  <div style="margin-top:10px;"><button type="button" data-testid="send-reply" style="padding:10px 18px;background:#16a34a;color:#fff;border:0;border-radius:6px;font-weight:600;">Send Reply</button></div>
  <div id="inbox-status" style="margin-top:12px;color:#0f766e;"></div>
  <script>
    document.querySelector('[data-testid="send-reply"]').addEventListener("click", () => {
      document.getElementById("inbox-status").textContent = "Sent reply (" + document.getElementById("reply-box").value.length + " chars)";
      document.getElementById("reply-box").value = "";
    });
  </script>
</body>
</html>`;

const DOCS_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Internal Wiki - Operations SOP</title></head>
<body style="font-family: system-ui, sans-serif; margin: 52px 28px; min-height: 1500px; background:#fefce8; color:#1c1917;">
  <h1>Operations SOP & Tax Reference</h1>
  <div style="display:flex;gap:8px;margin-bottom:16px;">
    <input id="wiki-search" aria-label="Wiki search" data-testid="wiki-search" placeholder="Filter docs" style="padding:8px;width:280px;" />
    <button type="button" data-testid="wiki-tab-tax" style="padding:8px 12px;">Q4 Tax Codes</button>
    <button type="button" data-testid="wiki-tab-audit" style="padding:8px 12px;">Audit Checklist</button>
  </div>
  <div id="wiki-body" style="max-width:720px;line-height:1.7;">
    <p>Verify cost center codes against Q4 approved vendor ledger before posting to Acme ERP.</p>
    <p style="margin-top:260px;">EU intra-community VAT exemptions require validated VIES registration numbers.</p>
    <p style="margin-top:260px;">End-of-day reconciliation runs at 18:00 EET.</p>
  </div>
</body>
</html>`;

const ROUTES: Record<string, string> = {
  "/sheets": SHEETS_HTML,
  "/erp": ERP_HTML,
  "/inbox": INBOX_HTML,
  "/docs": DOCS_HTML,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha8(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function formatSimTime(msFromStart: number): string {
  const totalSec = Math.max(0, Math.round(msFromStart / 1000));
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function resolveFfmpegExecutable(): string {
  const pwCache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(pwCache)) {
    const dirs = fs
      .readdirSync(pwCache)
      .filter((d) => d.startsWith("ffmpeg-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      const candidate = path.join(pwCache, d, "ffmpeg-linux");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "ffmpeg";
}

function encodeWebmFromJpegs(
  ffmpegPath: string,
  frames: Buffer[],
  fps: number,
  outPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      [
        "-y",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "1200k",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        outPath,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.stdin.on("error", (err) => {
      // Ignore EPIPE when ffmpeg exits early; close handler reports stderr.
      if ((err as NodeJS.ErrnoException).code !== "EPIPE") reject(err);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });

    (async () => {
      for (const frame of frames) {
        if (!proc.stdin.write(frame)) {
          await new Promise<void>((res) => proc.stdin.once("drain", res));
        }
      }
      proc.stdin.end();
    })().catch(reject);
  });
}

test("Playwright 30m simulated workday: continuous human replay + 30x timelapse + trace", async () => {
  test.setTimeout(120_000);
  if (!fs.existsSync(contentScriptPath)) {
    throw new Error("Missing extension/dist/content.js — run pnpm run build:extension first");
  }
  const contentScriptCode = await readFile(contentScriptPath, "utf8");
  await mkdir(tracesDir, { recursive: true });
  const tmpTracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-workday-video-"));

  const collectorServer = createServer({
    tracesDir: tmpTracesDir,
    dataDir: path.join(tmpTracesDir, "data"),
  });
  const appServer = http.createServer((req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ROUTES[pathname] ?? DOCS_HTML);
  });

  await new Promise<void>((resolve) => collectorServer.listen(0, "127.0.0.1", () => resolve()));
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", () => resolve()));
  const collectorAddr = collectorServer.address() as { port: number };
  const appAddr = appServer.address() as { port: number };

  const executablePath = fs.existsSync(chromium.executablePath())
    ? undefined
    : await resolveChromeExecutable();
  const browser = await chromium.launch({ headless: true, executablePath });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.addCookies([
      {
        name: "SOCS",
        value: "CAESHAgBEhJnd3NfMjAyNDAyMjgtMF9SQzIaAmVuIAEaBgiA_LyuBg",
        domain: ".youtube.com",
        path: "/",
      },
    ]);

    const cursorOverlayScript = `
      (() => {
        if (window.top !== window.self) return;
        const install = () => {
          if (document.getElementById("sim-cursor")) return;
          const cur = document.createElement("div");
          cur.id = "sim-cursor";
          cur.setAttribute("data-eyes-ui", "true");
          cur.style.cssText = "position:fixed;left:24px;top:64px;width:18px;height:18px;border-radius:999px;background:rgba(56,189,248,0.85);border:2px solid #0f172a;box-shadow:0 0 0 2px rgba(255,255,255,0.8);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:transform 80ms ease;";
          document.documentElement.appendChild(cur);
          document.addEventListener("mousemove", (e) => {
            cur.style.left = e.clientX + "px";
            cur.style.top = e.clientY + "px";
          }, true);
          document.addEventListener("mousedown", (e) => {
            cur.style.left = e.clientX + "px";
            cur.style.top = e.clientY + "px";
            cur.style.transform = "translate(-50%,-50%) scale(1.45)";
            cur.style.background = "rgba(250,204,21,0.95)";
            setTimeout(() => {
              cur.style.transform = "translate(-50%,-50%) scale(1)";
              cur.style.background = "rgba(56,189,248,0.85)";
            }, 140);
          }, true);
        };
        if (document.documentElement) install();
        else document.addEventListener("DOMContentLoaded", install, { once: true });
      })();
    `;

    const initScript = `
      try { sessionStorage.setItem("__eyes_session__", ${JSON.stringify(SESSION_ID)}); } catch {}
      window.__EYES_CONFIG__ = {
        mode: "semantic",
        endpoint: "http://127.0.0.1:${collectorAddr.port}/events",
        batchMs: 80,
        maxBatchSize: 50
      };
      ${contentScriptCode}
      ${cursorOverlayScript}
    `;
    await context.addInitScript({ content: initScript });

    const page: Page = await context.newPage();
    const cdp = await context.newCDPSession(page);

    const capturedFrames: Buffer[] = [];
    let currentHudLabel = "Starting workday";
    let currentHost = "docs.localhost";
    const simStartMs = Date.now() - 30 * 60_000;
    let simClockMs = simStartMs;
    const timeline: Array<{ label: string; realStart: number; realEnd: number; simAnchor: number }> =
      [];
    let prevApp: string | undefined;

    cdp.on("Page.screencastFrame", (params: { data: string; sessionId: number }) => {
      capturedFrames.push(Buffer.from(params.data, "base64"));
      void cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 82,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    });

    const urlFor = (host: string, pathname: string) => `http://${host}:${appAddr.port}${pathname}`;

    async function updateHud(): Promise<void> {
      const clockText = `${formatSimTime(simClockMs - simStartMs)} / 30:00`;
      await page
        .evaluate(
          ({ text, site, task }) => {
            let hud = document.getElementById("workday-hud");
            if (!hud) {
              hud = document.createElement("div");
              hud.id = "workday-hud";
              hud.setAttribute("data-eyes-ui", "true");
              hud.style.cssText =
                "position:fixed;top:0;left:0;right:0;z-index:2147483646;background:#111827;color:#f8fafc;padding:7px 14px;font:600 12px/1.2 ui-monospace,monospace;display:flex;justify-content:space-between;border-bottom:2px solid #38bdf8;pointer-events:none;";
              document.documentElement.appendChild(hud);
            }
            hud.textContent = `[SIM ${text}]  ${site}  —  ${task}`;
          },
          { text: clockText, site: currentHost, task: currentHudLabel },
        )
        .catch(() => {});
    }

    let cursorX = 120;
    let cursorY = 120;
    async function humanMove(x: number, y: number, steps = 10): Promise<void> {
      await page.mouse.move(x, y, { steps });
      cursorX = x;
      cursorY = y;
    }

    async function humanClick(locator: Locator): Promise<void> {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (box) {
        const tx = Math.round(box.x + box.width * 0.5);
        const ty = Math.round(box.y + box.height * 0.5);
        await humanMove(
          Math.round((cursorX + tx) / 2 + 12),
          Math.round((cursorY + ty) / 2 - 8),
          6,
        );
        await humanMove(tx, ty, 8);
        await page.mouse.click(tx, ty);
      } else {
        await locator.click();
      }
    }

    async function humanScroll(deltaY: number, bursts = 4): Promise<void> {
      const step = Math.round(deltaY / bursts);
      for (let i = 0; i < bursts; i++) {
        await page.mouse.wheel(0, step);
        await sleep(80);
      }
    }

    async function humanType(text: string, delay = 14): Promise<void> {
      await page.keyboard.type(text, { delay });
    }

    async function emitTabSwitch(host: string, title: string, targetUrl: string): Promise<void> {
      await fetch(`http://127.0.0.1:${collectorAddr.port}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          {
            v: 1,
            id: crypto.randomUUID(),
            ts: Date.now(),
            session: SESSION_ID,
            source: "browser",
            app: host,
            window: title,
            url: targetUrl,
            type: "tab_switch",
            meta: {
              subType: prevApp && prevApp !== host ? "cross_app_switch" : "same_app_switch",
              fromApp: prevApp,
              toApp: host,
            },
          },
        ]),
      });
      prevApp = host;
    }

    async function switchSite(host: string, pathname: string, title: string, label: string) {
      const targetUrl = urlFor(host, pathname);
      currentHost = host;
      currentHudLabel = label;
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await updateHud();
      await emitTabSwitch(host, title, targetUrl);
    }

    async function runPhase(label: string, simAdvanceMs: number, fn: () => Promise<void>) {
      const realStart = Date.now();
      const simAnchor = simClockMs;
      currentHudLabel = label;
      await fn();
      await page.evaluate("window.__EYES_FLUSH__ && window.__EYES_FLUSH__()").catch(() => {});
      const realEnd = Date.now();
      simClockMs += simAdvanceMs;
      await updateHud();
      timeline.push({ label, realStart, realEnd, simAnchor });
    }

    async function doInvoiceRound(rowNum: number, invRef: string, amount: string, label: string) {
      await switchSite("sheets.localhost", "/sheets", "Q4 Invoices - Google Sheets", label);
      await humanClick(page.locator(`td[data-cell="A${rowNum}"]`));
      await sleep(70);
      await fetch(`http://127.0.0.1:${collectorAddr.port}/events`, {
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

      await switchSite("erp.localhost", "/erp", "Acme ERP - Invoice Entry", label);
      await humanClick(page.getByTestId("erp-ref"));
      await page.getByTestId("erp-ref").fill(invRef);
      await fetch(`http://127.0.0.1:${collectorAddr.port}/events`, {
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
              timeSinceCopyMs: 1400,
            },
          },
        ]),
      });
      await humanClick(page.getByTestId("erp-amount"));
      await humanType(amount, 16);
      await humanClick(page.getByTestId("erp-status"));
      await page.getByTestId("erp-status").selectOption("approved");
      await humanClick(page.getByTestId("erp-submit"));
      await sleep(80);
    }

    async function slackOnRealYouTube(query: string, label: string) {
      currentHost = "www.youtube.com";
      currentHudLabel = label;
      try {
        await page.goto("https://www.youtube.com", {
          waitUntil: "domcontentloaded",
          timeout: 12_000,
        });
        await updateHud();
        await emitTabSwitch("www.youtube.com", "YouTube", "https://www.youtube.com/");

        const searchInput = page.locator('input[name="search_query"]').first();
        await searchInput.waitFor({ state: "visible", timeout: 6000 });
        await humanClick(searchInput);
        await humanType(query, 24);
        await page.keyboard.press("Enter");
        await page.waitForSelector("ytd-video-renderer a#video-title", { timeout: 8000 });
        await updateHud();
        await humanScroll(420, 4);
        await humanMove(460, 320, 8);
        await humanClick(page.locator("ytd-video-renderer a#video-title").first());
        await page.waitForSelector("video", { timeout: 8000 });
        await updateHud();
        await sleep(2200);
        await humanScroll(520, 5);
        await humanMove(380, 420, 8);
        await sleep(1600);
      } catch {
        await switchSite("docs.localhost", "/docs", "Break Browsing", label);
        await humanScroll(500, 5);
      }
    }

    await runPhase("Morning SOP check + ERP note", 150_000, async () => {
      await switchSite("docs.localhost", "/docs", "Internal Wiki - Operations SOP", "Morning Wiki");
      await humanMove(350, 240, 10);
      await humanClick(page.getByTestId("wiki-tab-audit"));
      await humanScroll(480, 5);
      await humanScroll(-240, 3);
      await switchSite("erp.localhost", "/erp", "Acme ERP - Invoice Entry", "One-off ERP Note");
      await humanClick(page.getByTestId("dept-note"));
      await humanType("Q4 audit checkk", 18);
      await page.keyboard.press("Backspace");
      await humanClick(page.getByTestId("save-note"));
    });

    await runPhase("Invoice Loop #1", 120_000, () =>
      doInvoiceRound(1, "INV-2026-101", "1450", "Invoice Loop #1"),
    );
    await runPhase("Invoice Loop #2", 120_000, () =>
      doInvoiceRound(2, "INV-2026-102", "2890", "Invoice Loop #2"),
    );
    await runPhase("Invoice Loop #3", 120_000, () =>
      doInvoiceRound(3, "INV-2026-103", "920", "Invoice Loop #3"),
    );

    await runPhase("Slacking on YouTube #1", 330_000, () =>
      slackOnRealYouTube("lofi hip hop radio", "Slacking on YouTube #1"),
    );

    await runPhase("Support Replies (x4 + noise)", 300_000, async () => {
      await switchSite("inbox.localhost", "/inbox", "Support Inbox - Helpdesk", "Support Replies");
      const replies = [
        "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
        "Hi, thanks for your order. It ships Monday and tracking will follow shortly.",
        "Hi, thanks for your order! It ships Friday and tracking will follow shortly.",
        "Attached is the revised VAT breakdown for your November consulting invoice.",
        "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
      ];
      for (let i = 0; i < replies.length; i++) {
        await humanClick(page.getByTestId(`thread-${i + 1}`));
        await humanClick(page.getByTestId("reply-box"));
        await humanType(replies[i], 6);
        await humanClick(page.getByTestId("send-reply"));
      }
    });

    await runPhase("Ad-hoc Docs Lookup", 180_000, async () => {
      await switchSite("docs.localhost", "/docs", "Internal Wiki - Operations SOP", "Ad-hoc Docs");
      await humanClick(page.getByTestId("wiki-search"));
      await humanType("vat exemption 2026", 16);
      await humanClick(page.getByTestId("wiki-tab-tax"));
      await humanScroll(560, 6);
      await humanMove(600, 380, 10);
      await humanScroll(-400, 4);
    });

    await runPhase("Slacking on YouTube #2", 240_000, () =>
      slackOnRealYouTube("mechanical keyboard sound test", "Slacking on YouTube #2"),
    );

    await runPhase("Invoice Loop #4", 90_000, () =>
      doInvoiceRound(4, "INV-2026-104", "3100", "Invoice Loop #4"),
    );
    await runPhase("Invoice Loop #5", 100_000, () =>
      doInvoiceRound(5, "INV-2026-105", "675", "Invoice Loop #5"),
    );
    await runPhase("Invoice Loop #6", 110_000, () =>
      doInvoiceRound(6, "INV-2026-106", "4210", "Invoice Loop #6"),
    );

    await cdp.send("Page.stopScreencast").catch(() => {});
    await page.evaluate("window.__EYES_FLUSH__ && window.__EYES_FLUSH__()").catch(() => {});
    await sleep(150);

    const ffmpegPath = resolveFfmpegExecutable();
    expect(capturedFrames.length).toBeGreaterThan(80);

    // 1. Readable human-speed replay (12 fps, continuous active motion)
    const replayOut = path.join(tracesDir, "workday_replay.webm");
    await encodeWebmFromJpegs(ffmpegPath, capturedFrames, 12, replayOut);

    // 2. Crisp 30x timelapse (all active frames played fast at 30 fps -> ~1 min for 30m simulated)
    const timelapseOut = path.join(tracesDir, "workday_30x.webm");
    await encodeWebmFromJpegs(ffmpegPath, capturedFrames, 30, timelapseOut);

    // Remove obsolete workday_3m.webm if present
    await unlink(path.join(tracesDir, "workday_3m.webm")).catch(() => {});

    expect((await stat(replayOut)).size).toBeGreaterThan(20_000);
    expect((await stat(timelapseOut)).size).toBeGreaterThan(20_000);

    const rawEvents = await readEvents(tmpTracesDir, SESSION_ID);
    const mapped = rawEvents.map((ev) => {
      let phase = timeline[0];
      for (const p of timeline) {
        if (ev.ts >= p.realStart) phase = p;
      }
      return { ...ev, ts: phase.simAnchor + Math.max(0, ev.ts - phase.realStart) };
    });
    mapped.sort((a, b) => a.ts - b.ts);
    const validated = EventsSchema.parse(mapped);
    expect(validated.length).toBeGreaterThan(100);
    expect(validated[validated.length - 1].ts - validated[0].ts).toBeGreaterThanOrEqual(29 * 60_000);

    await writeFile(
      path.join(tracesDir, `${SESSION_ID}.jsonl`),
      validated.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    await context.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => collectorServer.close(() => resolve()));
    await rm(tmpTracesDir, { recursive: true, force: true });
  }
});
