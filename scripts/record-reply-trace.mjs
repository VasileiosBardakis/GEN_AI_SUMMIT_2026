/* global console, process, setTimeout */
import http from "node:http";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "../server/src/app.ts";
import { readEvents } from "../server/src/trace.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const contentScriptPath = path.join(rootDir, "extension", "dist", "content.js");
const tracesDir = path.join(rootDir, "traces");
const SESSION_ID = "real_reply_x3";

const REPLIES = [
  "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
  "Hi, thanks for your order. It ships Monday and tracking will follow shortly.",
  "Hi, thanks for your order! It ships Friday and tracking will follow shortly.",
  "Can you please send the updated tax invoice for the November consulting retainer?",
];

const INBOX_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Customer Support Inbox</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; }
    .thread-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
    .thread-row { padding: 10px 14px; border: 1px solid #dadce0; border-radius: 4px; cursor: pointer; }
    .composer { display: flex; flex-direction: column; gap: 8px; max-width: 520px; }
    textarea { min-height: 90px; padding: 8px; font-family: inherit; }
    .actions { display: flex; gap: 8px; }
  </style>
</head>
<body>
  <h1>Support Inbox</h1>
  <div role="list" class="thread-list">
    <div role="row" tabindex="0" data-testid="thread-row-1" class="thread-row">Order #101 — Shipping status</div>
    <div role="row" tabindex="0" data-testid="thread-row-2" class="thread-row">Order #102 — Tracking inquiry</div>
    <div role="row" tabindex="0" data-testid="thread-row-3" class="thread-row">Order #103 — Delivery schedule</div>
    <div role="row" tabindex="0" data-testid="thread-row-4" class="thread-row">Invoice request — November retainer</div>
  </div>
  <div class="composer">
    <div class="actions">
      <button type="button" data-testid="reply-btn">Reply</button>
    </div>
    <label for="reply-body">Reply body</label>
    <textarea id="reply-body" role="textbox" data-testid="reply-body" aria-label="Reply body" class="reply-editor"></textarea>
    <div class="actions">
      <button type="button" data-testid="send-btn">Send</button>
    </div>
  </div>
  <script>
    const replyBody = document.getElementById("reply-body");
    const sendBtn = document.querySelector('[data-testid="send-btn"]');
    sendBtn.addEventListener("click", () => {
      replyBody.value = "";
    });
  </script>
</body>
</html>`;

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
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function ensureExtensionBuilt() {
  if (!fs.existsSync(contentScriptPath)) {
    await import("../extension/build.mjs");
  }
}

async function main() {
  await ensureExtensionBuilt();
  const contentScriptCode = await readFile(contentScriptPath, "utf8");

  await mkdir(tracesDir, { recursive: true });
  const tmpTracesDir = await mkdtemp(path.join(tracesDir, ".tmp-record-"));

  const collectorServer = createServer({ tracesDir: tmpTracesDir });
  const inboxServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INBOX_HTML);
  });

  let browser;
  try {
    const collectorPort = await listenOnRandomPort(collectorServer);
    const inboxPort = await listenOnRandomPort(inboxServer);

    const initScript = `
      try { sessionStorage.setItem("__eyes_session__", ${JSON.stringify(SESSION_ID)}); } catch {}
      window.__EYES_CONFIG__ = {
        mode: "semantic",
        endpoint: "http://127.0.0.1:${collectorPort}/events",
        batchMs: 100,
        maxBatchSize: 50
      };
      ${contentScriptCode}
    `;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript({ content: initScript });

    await page.goto(`http://127.0.0.1:${inboxPort}/inbox`);

    for (let i = 0; i < REPLIES.length; i++) {
      const threadIndex = i + 1;
      const replyText = REPLIES[i];

      await page.getByTestId(`thread-row-${threadIndex}`).click();
      await page.getByTestId("reply-btn").click();
      await page.getByTestId("reply-body").click();
      await page.keyboard.type(replyText, { delay: 5 });
      await page.getByTestId("send-btn").click();
    }

    await page.evaluate("window.__EYES_FLUSH__ && window.__EYES_FLUSH__()");

    const deadline = Date.now() + 10000;
    let capturedEvents = [];
    while (Date.now() < deadline) {
      capturedEvents = await readEvents(tmpTracesDir, SESSION_ID);
      const blurCommits = capturedEvents.filter(
        (ev) => ev.type === "input" && ev.meta?.subType === "blur_commit",
      );
      if (blurCommits.length >= REPLIES.length) {
        break;
      }
      await page.evaluate("window.__EYES_FLUSH__ && window.__EYES_FLUSH__()");
      await sleep(50);
    }

    const blurCommits = capturedEvents.filter(
      (ev) => ev.type === "input" && ev.meta?.subType === "blur_commit",
    );
    if (blurCommits.length < REPLIES.length) {
      throw new Error(
        `Timed out waiting for ${REPLIES.length} blur_commit events (got ${blurCommits.length})`,
      );
    }

    const tmpTraceFile = path.join(tmpTracesDir, `${SESSION_ID}.jsonl`);
    const outputTraceFile = path.join(tracesDir, `${SESSION_ID}.jsonl`);
    const rawJsonl = await readFile(tmpTraceFile, "utf8");
    await writeFile(outputTraceFile, rawJsonl, "utf8");

    console.log(
      `Recorded ${capturedEvents.length} events (${blurCommits.length} blur_commit) to ${outputTraceFile}`,
    );
  } finally {
    if (browser) {
      await browser.close();
    }
    await closeHttpServer(inboxServer);
    await closeHttpServer(collectorServer);
    await rm(tmpTracesDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
