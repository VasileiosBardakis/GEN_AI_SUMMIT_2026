/* global console, process, Buffer, fetch, URL, WebSocket, setTimeout, clearTimeout */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "../server/src/app.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const contentScriptPath = path.join(rootDir, "extension/dist/content.js");
const tracesDir = path.join(rootDir, "traces");

const CHROME_BIN =
  "/home/harris/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const SHEETS_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Q4 Supplier Pricing - Google Sheets</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; height: 2200px; }
    .toolbar { display: flex; gap: 8px; padding: 8px; background: #f8fafd; border-bottom: 1px solid #dadce0; align-items: center; }
    #t-name-box { width: 60px; padding: 4px; border: 1px solid #dadce0; font-family: monospace; }
    #t-formula-bar-input { flex: 1; padding: 4px; border: 1px solid #dadce0; font-family: monospace; }
    table.grid { border-collapse: collapse; width: 100%; }
    table.grid th, table.grid td { border-collapse: collapse; border: 1px solid #e0e0e0; padding: 6px 10px; min-width: 110px; height: 24px; }
    table.grid td[role="gridcell"]:focus { outline: 2px solid #1a73e8; background: #e8f0fe; }
    .context-menu { position: fixed; background: white; border: 1px solid #dadce0; box-shadow: 0 4px 12px rgba(0,0,0,0.15); border-radius: 4px; padding: 4px 0; min-width: 220px; z-index: 1000; }
    .goog-menuitem { display: flex; justify-content: space-between; padding: 6px 14px; cursor: pointer; font-size: 13px; }
    .goog-menuitem-accel { color: #5f6368; margin-left: 16px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <input id="t-name-box" aria-label="Name box" value="A1" />
    <input id="t-formula-bar-input" aria-label="Formula bar" placeholder="fx" />
    <div role="tab" aria-selected="true" class="docs-sheet-active-tab"><span class="docs-sheet-tab-name">Invoices_Nov</span></div>
  </div>
  <table class="grid" role="grid">
    <thead>
      <tr><th></th><th>A (Item)</th><th>B (Net EUR)</th><th>C (Gross EUR)</th></tr>
    </thead>
    <tbody>
      <tr aria-rowindex="1"><th>1</th><td role="gridcell" tabindex="0" data-cell="A1" data-row="1" data-col="1" contenteditable="true">Item_01</td><td role="gridcell" tabindex="0" data-cell="B1" data-row="1" data-col="2" contenteditable="true">100</td><td role="gridcell" tabindex="0" data-cell="C1" data-row="1" data-col="3" contenteditable="true"></td></tr>
      <tr aria-rowindex="2"><th>2</th><td role="gridcell" tabindex="0" data-cell="A2" data-row="2" data-col="1" contenteditable="true">Item_02</td><td role="gridcell" tabindex="0" data-cell="B2" data-row="2" data-col="2" contenteditable="true">250</td><td role="gridcell" tabindex="0" data-cell="C2" data-row="2" data-col="3" contenteditable="true"></td></tr>
      <tr aria-rowindex="3"><th>3</th><td role="gridcell" tabindex="0" data-cell="A3" data-row="3" data-col="1" contenteditable="true">Item_03</td><td role="gridcell" tabindex="0" data-cell="B3" data-row="3" data-col="2" contenteditable="true">400</td><td role="gridcell" tabindex="0" data-cell="C3" data-row="3" data-col="3" contenteditable="true"></td></tr>
      <tr aria-rowindex="4"><th>4</th><td role="gridcell" tabindex="0" data-cell="A4" data-row="4" data-col="1" contenteditable="true">Item_04</td><td role="gridcell" tabindex="0" data-cell="B4" data-row="4" data-col="2" contenteditable="true">550</td><td role="gridcell" tabindex="0" data-cell="C4" data-row="4" data-col="3" contenteditable="true"></td></tr>
    </tbody>
  </table>
  <script>
    const nameBox = document.getElementById('t-name-box');
    document.querySelectorAll('[role="gridcell"]').forEach(cell => {
      cell.addEventListener('focus', () => {
        nameBox.value = cell.getAttribute('data-cell') || 'A1';
      });
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const existing = document.querySelector('.context-menu');
        if (existing) existing.remove();
        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('data-context-menu', 'true');
        menu.style.left = (e.clientX || 120) + 'px';
        menu.style.top = (e.clientY || 120) + 'px';
        menu.innerHTML = \`
          <div role="menuitem" class="goog-menuitem" data-action="copy"><span>Copy</span><span class="goog-menuitem-accel">Ctrl+C</span></div>
          <div role="menuitem" class="goog-menuitem" data-action="paste"><span>Paste</span><span class="goog-menuitem-accel">Ctrl+V</span></div>
          <div role="menuitem" class="goog-menuitem" data-action="rename"><span>Rename / Edit cell</span><span class="goog-menuitem-accel">F2</span></div>
          <div role="menuitem" class="goog-menuitem" data-action="fill-down"><span>Fill down</span><span class="goog-menuitem-accel">Ctrl+D</span></div>
        \`;
        menu.addEventListener('click', () => menu.remove());
        document.body.appendChild(menu);
      });
    });
  </script>
</body>
</html>`;

const FORM_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Supplier Portal — Company & Billing Details</title></head>
<body>
  <form id="company-form" data-testid="company-form">
    <label>Company Name <input id="company-name" name="company_name" autocomplete="organization" data-testid="input-company" /></label>
    <label>Owner Email <input id="owner-email" name="owner_email" type="email" autocomplete="email" data-testid="input-email" /></label>
    <label>City (Autofill test) <input id="city-field" name="city" autocomplete="address-level2" data-testid="input-city" /></label>
    <label>Portal Password <input id="portal-password" name="portal_password" type="password" autocomplete="current-password" data-testid="input-password" /></label>
    <label>Payment Notes <input id="payment-notes" name="notes" placeholder="Enter Wire Instructions" data-testid="input-notes" /></label>
    <button type="submit" data-testid="submit-company">Save Profile</button>
  </form>
  <script>
    document.getElementById('company-form').addEventListener('submit', e => e.preventDefault());
  </script>
</body>
</html>`;

const PORTAL_ERP_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>ERP Invoice Entry</title></head>
<body>
  <div id="invoice-source" data-testid="portal-invoice-id" data-cell="A2">INV-2026-0841</div>
  <input id="erp-invoice-field" name="invoice_ref" data-testid="erp-invoice-input" placeholder="Paste invoice ID" />
</body>
</html>`;

const OAUTH_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Sign in with Google — OAuth Consent</title></head>
<body>
  <h1>Authorize ERP Sync</h1>
  <button id="open-consent-modal" data-testid="btn-review-perms">Review Permissions</button>
  <script>
    document.getElementById('open-consent-modal').addEventListener('click', () => {
      const dlg = document.createElement('div');
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      dlg.innerHTML = '<h2>Allow access to your Google Sheets & ERP account?</h2><p>Permissions requested: spreadsheets.readonly, erp.invoices.write</p><button data-testid="btn-allow">Allow</button>';
      document.body.appendChild(dlg);
    });
  </script>
</body>
</html>`;

function startTestAppServer() {
  const srv = http.createServer((req, res) => {
    const urlPath = (req.url || "/").split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (urlPath === "/sheets") res.end(SHEETS_HTML);
    else if (urlPath === "/onboarding-form") res.end(FORM_HTML);
    else if (urlPath === "/erp") res.end(PORTAL_ERP_HTML);
    else if (urlPath.startsWith("/oauth")) res.end(OAUTH_HTML);
    else res.end(SHEETS_HTML);
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (msg) => {
      const data = JSON.parse(String(msg.data));
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runModeBenchmark(mode, collectorPort, appPort, cdp) {
  const sessionId = `probe_${mode}`;
  const sessionFile = path.join(tracesDir, `${sessionId}.jsonl`);
  if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);

  const contentScriptCode = fs.readFileSync(contentScriptPath, "utf8");
  const initScript = `
    try { sessionStorage.setItem("__eyes_session__", "${sessionId}"); } catch {}
    window.__EYES_CONFIG__ = {
      mode: "${mode}",
      endpoint: "http://127.0.0.1:${collectorPort}/events",
      batchMs: 100,
      maxBatchSize: 50
    };
    ${contentScriptCode}
  `;

  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: initScript,
  });

  async function navigate(url) {
    await cdp.send("Page.navigate", { url });
    await sleep(220);
  }

  async function evalInPage(expr) {
    return cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true });
  }

  // 1. Sheets page: mousemove trajectory across 40 points + clicks + arrow keys + 3 context menus + cell renaming + 3 formulas + scroll + wheel
  await navigate(`http://127.0.0.1:${appPort}/sheets`);

  await evalInPage(`
    (async () => {
      const cells = Array.from(document.querySelectorAll('[role="gridcell"]'));
      // Simulate realistic 60Hz mouse movement across 30 points over cells
      for (let i = 0; i < 30; i++) {
        const target = cells[i % cells.length];
        target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 80 + i * 8, clientY: 100 + i * 4 }));
      }
      const a1 = document.querySelector('[data-cell="A1"]');
      a1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 90, clientY: 110 }));
      a1.focus();
      a1.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 90, clientY: 110 }));
      a1.click();

      for (const c of ['A2', 'A3', 'A4']) {
        const el = document.querySelector('[data-cell="' + c + '"]');
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
      }
    })()
  `);
  await sleep(100);

  for (const [idx, cellId] of ["A1", "A2", "A3"].entries()) {
    await evalInPage(`
      (() => {
        const cell = document.querySelector('[data-cell="${cellId}"]');
        cell.focus();
        cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, clientX: 140, clientY: 160 }));
        cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 140, clientY: 160 }));
        cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 2, clientX: 140, clientY: 160 }));
      })()
    `);
    await sleep(60);
    await evalInPage(`
      (() => {
        const renameItem = document.querySelector('[data-action="rename"]');
        if (renameItem) {
          renameItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
          renameItem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
          renameItem.click();
        }
        const cell = document.querySelector('[data-cell="${cellId}"]');
        cell.focus();
        const newText = 'Renamed_SKU_0${idx + 1}';
        let partial = '';
        for (const ch of newText) {
          partial += ch;
          cell.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true }));
          cell.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: ch }));
          cell.textContent = partial;
          cell.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
          cell.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true }));
        }
        cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        cell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        cell.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      })()
    `);
    await sleep(60);
  }

  for (const row of [1, 2, 3]) {
    const cellId = `C${row}`;
    const formula = `=B${row}*1.24`;
    await evalInPage(`
      (() => {
        const cell = document.querySelector('[data-cell="${cellId}"]');
        cell.focus();
        cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
        let partial = '';
        for (const ch of '${formula}') {
          partial += ch;
          cell.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
          cell.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: ch }));
          cell.textContent = partial;
          cell.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
          cell.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        }
        cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        cell.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      })()
    `);
    await sleep(60);
  }

  // Simulate 15 rapid scroll & wheel ticks
  await evalInPage(`
    (async () => {
      for (let i = 1; i <= 15; i++) {
        window.scrollTo(0, i * 40);
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
        window.dispatchEvent(new Event('scroll'));
      }
      if (window.__EYES_FLUSH__) await window.__EYES_FLUSH__();
    })()
  `);
  await sleep(150);

  // 2. Onboarding Form: manual typing vs autofill + password & inline IBAN/token scrubbing
  await navigate(`http://127.0.0.1:${appPort}/onboarding-form`);
  await evalInPage(`
    (async () => {
      function typeIntoInput(el, text) {
        el.focus();
        el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        let val = '';
        for (const ch of text) {
          val += ch;
          el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
          el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: ch }));
          el.value = val;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      }

      typeIntoInput(document.getElementById('company-name'), 'Nikolaidis Logistics SA');
      typeIntoInput(document.getElementById('owner-email'), 'info@nikolaidis-logistics.gr');

      // Browser autofill on city
      const city = document.getElementById('city-field');
      city.focus();
      city.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      city.value = 'Athens, Attica';
      city.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: 'Athens, Attica' }));
      city.dispatchEvent(new Event('change', { bubbles: true }));
      city.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

      // Sensitive password + IBAN/token
      typeIntoInput(document.getElementById('portal-password'), 'SuperSecretPass!2026');
      typeIntoInput(document.getElementById('payment-notes'), 'Pay to IBAN GR1601101250000000012300695 with token sk-live-9876543210abcdef123456');

      document.querySelector('[data-testid="submit-company"]').click();
      if (window.__EYES_FLUSH__) await window.__EYES_FLUSH__();
    })()
  `);
  await sleep(150);

  // 3. ERP Copy-Paste
  await navigate(`http://127.0.0.1:${appPort}/erp`);
  await evalInPage(`
    (async () => {
      const src = document.getElementById('invoice-source');
      const range = document.createRange();
      range.selectNodeContents(src);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      src.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      const dt = new DataTransfer();
      dt.setData('text/plain', 'INV-2026-0841');
      src.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: dt }));

      const dest = document.getElementById('erp-invoice-field');
      dest.focus();
      dest.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      dest.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: dt }));
      dest.value = 'INV-2026-0841';
      dest.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: 'INV-2026-0841' }));
      dest.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      if (window.__EYES_FLUSH__) await window.__EYES_FLUSH__();
    })()
  `);
  await sleep(150);

  // 4. OAuth Authorize + Consent Modal
  await navigate(
    `http://127.0.0.1:${appPort}/oauth/authorize?client_id=erp-sync-app&scope=spreadsheets.readonly+erp.write&response_type=code&access_token=secret_oauth_tok_999`
  );
  await evalInPage(`
    (async () => {
      document.getElementById('open-consent-modal').click();
      if (window.__EYES_FLUSH__) await window.__EYES_FLUSH__();
    })()
  `);
  await sleep(250);

  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });

  const rawText = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, "utf8") : "";
  const lines = rawText.trim().split("\n").filter(Boolean);
  const events = lines.map((l) => JSON.parse(l));
  const rawBytes = Buffer.byteLength(rawText, "utf8");
  const gzipBytes = zlib.gzipSync(Buffer.from(rawText, "utf8")).length;

  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;

  return {
    mode,
    eventCount: events.length,
    distinctTypes: Object.keys(counts).length,
    rawBytes,
    gzipBytes,
    avgBytesPerEvent: events.length ? Math.round(rawBytes / events.length) : 0,
    counts,
  };
}

async function main() {
  const backendServer = createServer({ tracesDir });
  const collectorPort = await new Promise((resolve) => {
    backendServer.listen(0, "127.0.0.1", () => {
      resolve(backendServer.address().port);
    });
  });

  const appServer = await startTestAppServer();
  const appPort = appServer.address().port;

  const userDataDir = "/tmp/opencode/chrome-eyes-bench-" + Date.now();
  fs.mkdirSync(userDataDir, { recursive: true });

  const chromeProc = spawn(
    CHROME_BIN,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const wsEndpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error("Chrome launch timeout: " + stderr)), 10000);
    chromeProc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });

  const browserUrl = new URL(wsEndpoint);
  const targets = await (await fetch(`http://${browserUrl.host}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === "page");

  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const results = [];
  for (const mode of ["all_raw", "all_throttled", "semantic"]) {
    results.push(await runModeBenchmark(mode, collectorPort, appPort, cdp));
  }

  cdp.close();
  chromeProc.kill("SIGKILL");
  appServer.close();
  backendServer.close();

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
