import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import type { ActionScript } from "../server/src/hands/types.ts";
import type { StageLogEvent } from "../server/src/propose.ts";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { createServer } from "../server/src/app.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");

const FORM_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Inventory Entry Form</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; padding: 32px; }
    main { max-width: 720px; margin: 0 auto; display: grid; gap: 20px; }
    section { background: #111c33; border: 1px solid #1e293b; border-radius: 10px; padding: 20px; }
    .header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    h1 { margin: 0; font-size: 20px; }
    a { color: #60a5fa; text-decoration: underline; font-size: 13px; }
    label { display: grid; gap: 6px; font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
    input, button { font: inherit; }
    input { background: #0b1325; border: 1px solid #334155; color: #e2e8f0; border-radius: 6px; padding: 9px 10px; }
    button { background: #1d4ed8; border: 0; color: white; border-radius: 6px; padding: 9px 16px; cursor: pointer; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border: 1px solid #1e293b; padding: 8px 10px; text-align: left; }
    th { background: #0b1325; color: #94a3b8; }
  </style>
</head>
<body>
  <main>
    <section>
      <div class="header-row">
        <h1>Inventory Entry Form</h1>
        <a href="/help-missing" id="help-link" data-testid="help-link">Help</a>
      </div>
      <form id="item-form">
        <label for="item-input">Item Name
          <input id="item-input" name="item" data-testid="item-input" type="text" placeholder="Enter item name" />
        </label>
        <label for="note-input">Note
          <input id="note-input" name="note" data-testid="note-input" type="text" placeholder="Enter note" />
        </label>
        <button type="button" id="save-entry-btn" data-testid="save-entry-btn">Save Entry</button>
      </form>
    </section>

    <section>
      <h2>Saved Rows</h2>
      <table>
        <thead>
          <tr><th>#</th><th>Item Name</th><th>Note</th></tr>
        </thead>
        <tbody id="saved-entries" data-testid="saved-entries"></tbody>
      </table>
    </section>
  </main>

  <script>
    const form = document.getElementById("item-form");
    const saveBtn = document.getElementById("save-entry-btn");
    const itemInput = document.getElementById("item-input");
    const noteInput = document.getElementById("note-input");
    const savedEntries = document.getElementById("saved-entries");
    window.__inMemoryRows = [];

    function saveCurrentRow() {
      const idx = window.__inMemoryRows.length + 1;
      const entry = { idx, item: itemInput.value, note: noteInput.value };
      window.__inMemoryRows.push(entry);

      const row = document.createElement("tr");
      const idxCell = document.createElement("td");
      idxCell.textContent = String(idx);
      const itemCell = document.createElement("td");
      itemCell.textContent = entry.item;
      const noteCell = document.createElement("td");
      noteCell.textContent = entry.note;
      row.appendChild(idxCell);
      row.appendChild(itemCell);
      row.appendChild(noteCell);
      savedEntries.appendChild(row);

      itemInput.value = "";
      noteInput.value = "";
    }

    saveBtn.addEventListener("click", saveCurrentRow);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveCurrentRow();
    });
  </script>
</body>
</html>`;

const HELP_404_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>404 Not Found</title></head>
<body><h1>404 Error: Help Page Missing</h1><p>Broken help destination.</p></body>
</html>`;

test("3-repeat form with Help excursion drops Help click and reload so existing 3 rows remain and next row saves", async () => {
  test.skip(true, "removed by f35b69c / GEN-114");
  const testInfo = test.info();
  test.skip(
    !process.env.GOOGLE_CLOUD_PROJECT,
    "GOOGLE_CLOUD_PROJECT must be set for real Gemini E2E test",
  );
  test.setTimeout(90_000);

  const prevUseVertexAi = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  const prevPipeline = process.env.BRAIN_PIPELINE;
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENAI_USE_VERTEXAI) {
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
  }
  process.env.BRAIN_PIPELINE = "v2";

  const appServer = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/help-missing") {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HELP_404_HTML);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(FORM_HTML);
  });
  await new Promise<void>((resolve) => {
    appServer.listen(0, "127.0.0.1", () => resolve());
  });
  const appPort = (appServer.address() as AddressInfo).port;

  const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-help-click-traces-"));
  const dataDir = path.join(tracesDir, "data");
  const stageLogs: StageLogEvent[] = [];
  const apiServer: http.Server = createServer({
    tracesDir,
    dataDir,
    pipeline: "v2",
    autoPropose: true,
    proposeDebounceMs: 2000,
    stageLog: (ev) => stageLogs.push(ev),
  });
  await new Promise<void>((resolve) => {
    apiServer.listen(0, "127.0.0.1", () => resolve());
  });
  const apiBaseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-help-click-profile-"));
  const videoDir = testInfo.outputPath("videos");
  fs.mkdirSync(videoDir, { recursive: true });
  const executablePath = await resolveChromeExecutable();

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const decidedScripts: ActionScript[] = [];

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
      if (req.url().includes("/hands/next") && response.status === 200) {
        try {
          const parsed = JSON.parse(body.toString("utf8")) as {
            kind?: string;
            script?: ActionScript;
          };
          if (parsed.kind === "decide" && parsed.script) {
            decidedScripts.push(parsed.script);
          }
        } catch {
          // ignore non-JSON
        }
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      await route.fulfill({ status: response.status, headers, body });
    } catch {
      await route.abort().catch(() => {});
    }
  });

  let page: import("@playwright/test").Page | undefined;
  let videoPath: string | undefined;

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    }
    expect(serviceWorker.url()).toContain("background.js");

    page = context.pages()[0] || (await context.newPage());
    await page.goto(`http://localhost:${appPort}/form`, { waitUntil: "load" });
    await page.waitForTimeout(300);

    const manualRows = [
      { item: "Printer Paper", note: "Bin A" },
      { item: "Staples Box", note: "Bin B" },
      { item: "Label Tape", note: "Bin C" },
    ];
    const nextRow = { item: "Binder Clips", note: "Bin D" };

    for (let i = 0; i < manualRows.length; i += 1) {
      const row = manualRows[i];
      await page.getByTestId("item-input").fill(row.item);
      await page.getByTestId("note-input").fill(row.note);

      const newTabPromise = context.waitForEvent("page", { timeout: 3000 }).catch(() => null);
      await page.getByTestId("help-link").click({ modifiers: ["ControlOrMeta"] });
      const helpTab = await newTabPromise;
      if (helpTab) {
        await helpTab.waitForLoadState("load").catch(() => {});
        await helpTab.close().catch(() => {});
      }
      await page.bringToFront();

      await page.getByTestId("save-entry-btn").click();
      await expect(page.locator("#saved-entries tr")).toHaveCount(i + 1);
    }

    const popup = page.locator('#__eyes_suggestion_host__[data-eyes-suggestion="click"]');
    await expect
      .poll(
        async () => {
          if (await popup.isVisible().catch(() => false)) return "popup";
          return stageLogs.some((ev) => ev.stage === "save_skill" && ev.runMode === "save_only")
            ? "saved"
            : "waiting";
        },
        { timeout: 60_000 },
      )
      .not.toBe("waiting");

    if (await popup.isVisible().catch(() => false)) {
      await popup.evaluate((host) => {
        (host.shadowRoot!.querySelector("[data-eyes-primary]") as HTMLButtonElement).click();
      });
    }

    // Wait for skill save / auto-run stage
    await expect
      .poll(
        () =>
          stageLogs.find(
            (ev) => ev.stage === "run" || (ev.stage === "save_skill" && ev.runMode === "save_only"),
          ) ?? null,
        { timeout: 15_000 },
      )
      .not.toBeNull();

    const latestRes = await fetch(`${apiBaseUrl}/script/latest`);
    expect(latestRes.status).toBe(200);
    const latestJson = (await latestRes.json()) as { ok: boolean; script: ActionScript };
    expect(latestJson.ok).toBe(true);
    const compiledScript =
      decidedScripts.length > 0 ? decidedScripts[decidedScripts.length - 1] : latestJson.script;
    const serializedSteps = JSON.stringify(compiledScript.steps);
    expect(serializedSteps).not.toContain("help-missing");
    expect(compiledScript.steps.some((s) => s.action === "navigate")).toBe(false);

    const autoRan = stageLogs.some((ev) => ev.stage === "run" && !ev.skipped);
    if (!autoRan) {

      let fillIdx = 0;
      const resolvedSteps = latestJson.script.steps.map((step) => {
        if (
          (step.action === "fill" || step.action === "insertText") &&
          typeof step.value === "string"
        ) {
          const val = fillIdx === 0 ? nextRow.item : nextRow.note;
          fillIdx += 1;
          if (/\{\{[^}]+\}\}/.test(step.value)) {
            return { ...step, value: step.value.replace(/\{\{[^}]+\}\}/g, val) };
          }
        }
        return step;
      });

      const runRes = await fetch(`${apiBaseUrl}/hands/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: { ...latestJson.script, steps: resolvedSteps } }),
      });
      expect(runRes.status).toBe(200);
      const runJson = (await runRes.json()) as { ok: boolean };
      expect(runJson.ok).toBe(true);
    }

    // Assert no error page, all 3 existing rows remain, and the next row (#4) is saved
    await expect(page.locator("#saved-entries tr")).toHaveCount(4, { timeout: 15_000 });
    expect(page.url()).toContain(`http://localhost:${appPort}/form`);
    expect(page.url()).not.toContain("/help-missing");
    expect(context.pages().some((p) => p.url().includes("/help-missing"))).toBe(false);
    await expect(page.locator("h1")).toHaveText("Inventory Entry Form");

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#saved-entries tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? ""),
      ),
    );
    expect(rows.slice(0, 3)).toEqual([
      ["1", manualRows[0].item, manualRows[0].note],
      ["2", manualRows[1].item, manualRows[1].note],
      ["3", manualRows[2].item, manualRows[2].note],
    ]);
    expect(rows[3]?.[0]).toBe("4");
    expect(rows[3]?.[1]?.length).toBeGreaterThan(0);
    expect(rows[3]?.[2]?.length).toBeGreaterThan(0);
    expect(rows[3]?.[1]).not.toBe("undefined");
    expect(rows[3]?.[2]).not.toBe("undefined");

    videoPath = await page.video()?.path();
  } finally {
    if (prevUseVertexAi === undefined) {
      delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    } else {
      process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertexAi;
    }
    if (prevPipeline === undefined) {
      delete process.env.BRAIN_PIPELINE;
    } else {
      process.env.BRAIN_PIPELINE = prevPipeline;
    }
    await context.close().catch(() => {});
    if (videoPath && fs.existsSync(videoPath)) {
      expect(fs.statSync(videoPath).size).toBeGreaterThan(0);
      await testInfo.attach("help-click-replay-video", {
        path: videoPath,
        contentType: "video/webm",
      });
    }
    apiServer.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      apiServer.close((err) => (err ? reject(err) : resolve()));
    });
    appServer.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      appServer.close((err) => (err ? reject(err) : resolve()));
    });
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(tracesDir, { recursive: true, force: true });
  }
});
