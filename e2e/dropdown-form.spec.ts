import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import type { ActionScript } from "../server/src/hands/types.ts";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { createServer } from "../server/src/app.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");

const DEMO_FORM_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ticket Triage — Dropdown Demo</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; padding: 32px; }
    main { max-width: 720px; margin: 0 auto; display: grid; gap: 20px; }
    section { background: #111c33; border: 1px solid #1e293b; border-radius: 10px; padding: 20px; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    label { display: grid; gap: 6px; font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
    select, input, button { font: inherit; }
    select, input { background: #0b1325; border: 1px solid #334155; color: #e2e8f0; border-radius: 6px; padding: 9px 10px; }
    button { background: #1d4ed8; border: 0; color: white; border-radius: 6px; padding: 9px 16px; cursor: pointer; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border: 1px solid #1e293b; padding: 8px 10px; text-align: left; }
    th { background: #0b1325; color: #94a3b8; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Ticket Triage Form</h1>
      <form id="ticket-form">
        <label for="priority-select">Priority
          <select id="priority-select" name="priority" data-testid="priority-select">
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        <label for="note-input">Note
          <input id="note-input" name="note" data-testid="note-input" type="text" placeholder="Enter triage note" />
        </label>
        <button type="submit" id="save-entry-btn" data-testid="save-entry-btn">Save Entry</button>
      </form>
    </section>

    <section>
      <h2>Saved Entries</h2>
      <table>
        <thead>
          <tr><th>Priority</th><th>Note</th></tr>
        </thead>
        <tbody id="saved-entries" data-testid="saved-entries"></tbody>
      </table>
    </section>
  </main>

  <script>
    const form = document.getElementById("ticket-form");
    const prioritySelect = document.getElementById("priority-select");
    const noteInput = document.getElementById("note-input");
    const savedEntries = document.getElementById("saved-entries");

    window.__runSelectEvents = [];
    window.__runInputEvents = [];

    prioritySelect.addEventListener("change", () => {
      window.__runSelectEvents.push(prioritySelect.value);
    });
    noteInput.addEventListener("input", () => {
      window.__runInputEvents.push(noteInput.value);
    });
    noteInput.addEventListener("change", () => {
      window.__runInputEvents.push(noteInput.value);
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const row = document.createElement("tr");
      const prioCell = document.createElement("td");
      prioCell.textContent = prioritySelect.value;
      const noteCell = document.createElement("td");
      noteCell.textContent = noteInput.value;
      row.appendChild(prioCell);
      row.appendChild(noteCell);
      savedEntries.appendChild(row);

      prioritySelect.value = "low";
      noteInput.value = "";
    });
  </script>
</body>
</html>`;

test("dropdown form 3-repeat workflow emits select step, shows Run popup, and replays <select> + <input>", async () => {
  const testInfo = test.info();
  test.skip(
    !process.env.GOOGLE_CLOUD_PROJECT,
    "GOOGLE_CLOUD_PROJECT must be set for real Gemini E2E test",
  );
  test.setTimeout(90_000);

  const prevUseVertexAi = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENAI_USE_VERTEXAI) {
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
  }

  const appServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DEMO_FORM_HTML);
  });
  await new Promise<void>((resolve) => {
    appServer.listen(0, "127.0.0.1", () => resolve());
  });
  const appPort = (appServer.address() as AddressInfo).port;

  const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-dropdown-traces-"));
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
  const apiBaseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-dropdown-profile-"));
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

  await context.route(
    (url) => url.hostname === "127.0.0.1" && url.port === "",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: DEMO_FORM_HTML,
      });
    },
  );

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
    await page.goto(`http://127.0.0.1:${appPort}/form`, { waitUntil: "load" });
    await page.waitForTimeout(300);

    const recordedNote = "Escalate to Tier 2";

    for (let rep = 1; rep <= 3; rep += 1) {
      await page.getByTestId("priority-select").selectOption("urgent");
      await page.getByTestId("note-input").fill(recordedNote);
      await page.getByTestId("save-entry-btn").click();
      await expect(page.locator("#saved-entries tr")).toHaveCount(rep);
    }

    const popup = page.locator('#__eyes_suggestion_host__[data-eyes-suggestion="click"]');
    await expect(popup).toBeVisible({ timeout: 60_000 });

    const primaryText = await popup.evaluate((host) => {
      return host.shadowRoot?.querySelector("[data-eyes-primary]")?.textContent?.trim() ?? "";
    });
    expect(primaryText).toBe("Run");

    // Verify Implementor produced an ActionScript containing a `select` step
    expect(decidedScripts.length).toBeGreaterThanOrEqual(1);
    const compiledScript = decidedScripts[decidedScripts.length - 1];
    const hasSelectStep = compiledScript.steps.some((step) => step.action === "select");
    expect(hasSelectStep).toBe(true);

    // Clear run trackers right before clicking Run
    await page.evaluate(() => {
      const w = window as unknown as {
        __runSelectEvents?: string[];
        __runInputEvents?: string[];
      };
      w.__runSelectEvents = [];
      w.__runInputEvents = [];
    });

    await popup.evaluate((host) => {
      (host.shadowRoot!.querySelector("[data-eyes-primary]") as HTMLButtonElement).click();
    });

    // Assert Run selected the recorded <select> option and filled the text field
    await expect
      .poll(
        async () => {
          return page!
            .evaluate(() => {
              const w = window as unknown as {
                __runSelectEvents?: string[];
                __runInputEvents?: string[];
              };
              const selectEl = document.getElementById("priority-select") as HTMLSelectElement | null;
              const noteEl = document.getElementById("note-input") as HTMLInputElement | null;
              if (!selectEl || !noteEl) return null;
              const rows = Array.from(document.querySelectorAll("#saved-entries tr")).map((tr) =>
                Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? ""),
              );
              return {
                selectedObserved:
                  Boolean(w.__runSelectEvents?.includes("urgent")) || selectEl.value === "urgent",
                filledObserved:
                  Boolean(w.__runInputEvents?.includes("Escalate to Tier 2")) ||
                  noteEl.value === "Escalate to Tier 2",
                rowCount: rows.length,
                lastRow: rows[rows.length - 1] ?? [],
              };
            })
            .catch(() => null);
        },
        { timeout: 15_000 },
      )
      .toMatchObject({
        selectedObserved: true,
        filledObserved: true,
      });

    const finalRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#saved-entries tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? ""),
      ),
    );
    if (finalRows.length > 0) {
      expect(finalRows[finalRows.length - 1]).toEqual(["urgent", recordedNote]);
    } else {
      await expect(page.getByTestId("priority-select")).toHaveValue("urgent");
      await expect(page.getByTestId("note-input")).toHaveValue(recordedNote);
    }

    videoPath = await page.video()?.path();
  } finally {
    if (prevUseVertexAi === undefined) {
      delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    } else {
      process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertexAi;
    }
    await context.close().catch(() => {});
    if (videoPath && fs.existsSync(videoPath)) {
      expect(fs.statSync(videoPath).size).toBeGreaterThan(0);
      await testInfo.attach("dropdown-form-video", {
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
