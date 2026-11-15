import fs from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import type { DomStep, StepResult } from "../extension/src/types.ts";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { createServer } from "../server/src/app.ts";
import type { ActionScript } from "../server/src/hands/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");

const SEARCH_FORM_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Catalog Search</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; padding: 32px; }
    main { max-width: 640px; margin: 0 auto; display: grid; gap: 20px; }
    section { background: #111c33; border: 1px solid #1e293b; border-radius: 10px; padding: 20px; }
    h1, h2 { margin: 0 0 12px; }
    form { display: flex; gap: 10px; }
    input { flex: 1; background: #0b1325; border: 1px solid #334155; color: #e2e8f0; border-radius: 6px; padding: 10px 12px; font: inherit; }
    ul { margin: 0; padding-left: 20px; display: grid; gap: 6px; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Catalog Search</h1>
      <form id="search-form" data-testid="search-form">
        <input
          id="search-input"
          name="q"
          type="search"
          aria-label="Search catalog"
          placeholder="Search catalog..."
          data-testid="search-input"
        />
      </form>
    </section>
    <section>
      <h2>Submitted Searches</h2>
      <ul id="search-results" data-testid="search-results"></ul>
    </section>
  </main>
  <script>
    const form = document.getElementById("search-form");
    const input = document.getElementById("search-input");
    const results = document.getElementById("search-results");
    const storageKey = "__enter_search_queries__";
    const loadQueries = () => {
      try {
        return JSON.parse(sessionStorage.getItem(storageKey) || "[]");
      } catch {
        return [];
      }
    };
    const renderQueries = (queries) => {
      results.innerHTML = "";
      for (const query of queries) {
        const li = document.createElement("li");
        li.setAttribute("data-testid", "submitted-query");
        li.textContent = query;
        results.appendChild(li);
      }
    };
    window.__submittedQueries = loadQueries();
    renderQueries(window.__submittedQueries);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = input.value.trim();
      window.__submittedQueries.push(query);
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(window.__submittedQueries));
      } catch {
        // ignore
      }
      renderQueries(window.__submittedQueries);
      input.value = "";
    });
  </script>
</body>
</html>`;

test("executeStep fill + pressKey(Enter) submits <form> search page with query (and skips when keydown prevents default)", async () => {
  const executablePath = fs.existsSync(chromium.executablePath())
    ? undefined
    : await resolveChromeExecutable();
  const browser = await chromium.launch({ headless: true, executablePath });

  try {
    const page = await browser.newPage();
    const executeJs = (
      await readFile(path.join(rootDir, "extension/dist/hands/execute.js"), "utf8")
    ).replace(/export\s+async\s+function\s+executeStep/, "async function executeStep");

    await page.setContent(SEARCH_FORM_HTML);
    await page.addScriptTag({ content: `${executeJs}\nwindow.__executeStep = executeStep;` });

    const fillRes = await page.evaluate(() =>
      (
        window as unknown as { __executeStep: (step: DomStep) => Promise<StepResult> }
      ).__executeStep({
        action: "fill",
        target: { kind: "testid", value: "search-input" },
        value: "ergonomic keyboard",
      }),
    );
    expect(fillRes.ok).toBe(true);

    const pressRes = await page.evaluate(() =>
      (
        window as unknown as { __executeStep: (step: DomStep) => Promise<StepResult> }
      ).__executeStep({
        action: "pressKey",
        key: "Enter",
        target: { kind: "testid", value: "search-input" },
      } as unknown as DomStep),
    );
    expect(pressRes.ok).toBe(true);

    await expect(page.getByTestId("submitted-query")).toHaveText(["ergonomic keyboard"]);

    // Verify a cancelling keydown listener prevents form submission
    await page.evaluate(() => {
      const input = document.getElementById("search-input")!;
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
        }
      });
    });

    await page.evaluate(() =>
      (
        window as unknown as { __executeStep: (step: DomStep) => Promise<StepResult> }
      ).__executeStep({
        action: "fill",
        target: { kind: "testid", value: "search-input" },
        value: "cancelled query",
      }),
    );
    const cancelledPress = await page.evaluate(() =>
      (
        window as unknown as { __executeStep: (step: DomStep) => Promise<StepResult> }
      ).__executeStep({
        action: "pressKey",
        key: "Enter",
        target: { kind: "testid", value: "search-input" },
      } as unknown as DomStep),
    );
    expect(cancelledPress.ok).toBe(true);
    await expect(page.getByTestId("submitted-query")).toHaveText(["ergonomic keyboard"]);
  } finally {
    await browser.close();
  }
});

test("BRAIN_PIPELINE=v2 real-browser 3x search+Enter pops up and replays Enter", async () => {
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
    res.end(SEARCH_FORM_HTML);
  });
  await new Promise<void>((resolve) => {
    appServer.listen(0, "127.0.0.1", () => resolve());
  });
  const appPort = (appServer.address() as AddressInfo).port;

  const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-enter-search-traces-"));
  const dataDir = path.join(tracesDir, "data");
  const apiServer: http.Server = createServer({
    pipeline: "v2",
    tracesDir,
    dataDir,
    autoPropose: true,
    proposeDebounceMs: 500,
  });
  await new Promise<void>((resolve) => {
    apiServer.listen(0, "127.0.0.1", () => resolve());
  });
  const apiBaseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-enter-search-profile-"));
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
    await page.goto(`http://localhost:${appPort}/search`, { waitUntil: "load" });
    await page.waitForTimeout(300);

    const queries = ["laptop", "monitor", "keyboard"];
    for (let i = 0; i < queries.length; i += 1) {
      const input = page.getByTestId("search-input");
      await input.fill(queries[i]);
      await input.press("Enter");
      await expect(page.getByTestId("submitted-query")).toHaveCount(i + 1);
    }

    const popup = page.locator('#__eyes_suggestion_host__[data-eyes-suggestion="click"]');
    await expect
      .poll(
        async () => {
          if (await popup.isVisible().catch(() => false)) return "popup";
          const res = await fetch(`${apiBaseUrl}/library`);
          if (!res.ok) return "waiting";
          const json = (await res.json()) as { items?: unknown[] };
          return (json.items?.length ?? 0) >= 1 ? "saved" : "waiting";
        },
        { timeout: 60_000 },
      )
      .not.toBe("waiting");

    if (await popup.isVisible().catch(() => false)) {
      await popup.evaluate((host) => {
        (host.shadowRoot!.querySelector("[data-eyes-primary]") as HTMLButtonElement).click();
      });
    }

    await expect
      .poll(
        async () => {
          const res = await fetch(`${apiBaseUrl}/library`);
          if (!res.ok) return 0;
          const json = (await res.json()) as { items?: unknown[] };
          return json.items?.length ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);

    const libRes = await fetch(`${apiBaseUrl}/library`);
    const libJson = (await libRes.json()) as { items: Array<{ script: ActionScript }> };
    const compiledScript =
      decidedScripts.length > 0 ? decidedScripts[decidedScripts.length - 1] : libJson.items[0].script;
    const hasEnterPressKey = compiledScript.steps.some(
      (step) =>
        step.action === "pressKey" &&
        (step.key ?? "Enter") === "Enter" &&
        JSON.stringify("target" in step ? step.target : []).includes("search-input"),
    );
    expect(hasEnterPressKey).toBe(true);

    const currentRows = await page.getByTestId("submitted-query").count();
    if (currentRows === 3) {
      const savedScript = libJson.items[0].script;
      const replayScript: ActionScript = {
        ...savedScript,
        steps: savedScript.steps.map((step) => {
          if (step.action === "fill" && /\{\{[^}]+\}\}/.test(step.value)) {
            return { ...step, value: "webcam" };
          }
          return step;
        }),
      };

      const runRes = await fetch(`${apiBaseUrl}/hands/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: replayScript }),
      });
      expect(runRes.status).toBe(200);
      const runJson = (await runRes.json()) as { ok: boolean };
      expect(runJson.ok).toBe(true);
    }

    await expect(page.getByTestId("submitted-query")).toHaveCount(4, { timeout: 15_000 });
    const submitted = await page.getByTestId("submitted-query").allTextContents();
    expect(submitted.slice(0, 3)).toEqual(queries);
    expect(submitted[3].length).toBeGreaterThan(0);

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
      await testInfo.attach("enter-search-video", {
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
