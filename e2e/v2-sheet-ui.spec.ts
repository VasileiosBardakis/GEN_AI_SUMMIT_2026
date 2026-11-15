import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { startDemoServer } from "../scripts/lib/static-server.mjs";
import { createServer } from "../server/src/app.ts";
import type { ActionScript } from "../server/src/hands/types.ts";
import type { GeminiClient } from "../server/src/llm/gemini.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");
const demoDir = path.join(rootDir, "apps", "demo");
const videosDir = path.join(rootDir, "test-results", "videos");

type ParsedPromptStep = {
  stepIndex: number;
  action: string;
  label?: string;
  value?: string;
};

type ParsedPromptTarget = {
  targetId: string;
  description: string;
};

type ParsedPromptList = {
  listId: string;
  containerTargetId?: string;
  items: Array<Record<string, string> & { itemId: string }>;
};

function parsePromptSections(prompt: string): {
  steps: ParsedPromptStep[];
  targets: ParsedPromptTarget[];
  lists: ParsedPromptList[];
} {
  const steps: ParsedPromptStep[] = [];
  const targets: ParsedPromptTarget[] = [];
  const lists: ParsedPromptList[] = [];

  let section: "steps" | "containers" | "targets" | "lists" | "other" = "other";
  for (const rawLine of prompt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "Steps:") {
      section = "steps";
      continue;
    }
    if (line.startsWith("PageSummary Containers")) {
      section = "containers";
      continue;
    }
    if (line === "PageSummary Targets:") {
      section = "targets";
      continue;
    }
    if (line === "PageSummary Lists:") {
      section = "lists";
      continue;
    }
    if (!line) {
      if (section !== "other") section = "other";
      continue;
    }
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (section === "steps") {
        steps.push(obj as ParsedPromptStep);
      } else if (section === "containers") {
        targets.push({
          targetId: String(obj.withinId ?? ""),
          description: String(obj.description ?? ""),
        });
      } else if (section === "targets") {
        targets.push(obj as ParsedPromptTarget);
      } else if (section === "lists") {
        lists.push(obj as ParsedPromptList);
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  return { steps, targets, lists };
}

function createSheetMockGemini(): GeminiClient {
  const rejectIncomplete = {
    suggest: false,
    offerAt2: false,
    kind: "workflow",
    name: "Incomplete client cycle",
    reason: "Waiting for two completed client lookup cycles",
    risk: "low",
    runMode: "save_only",
    params: [],
    steps: [],
  };

  return {
    async generateText() {
      throw new Error("Unexpected generateText call");
    },
    async generateJson<T>(
      prompt: string,
      schema: Parameters<GeminiClient["generateJson"]>[1],
    ): Promise<T> {
      const { steps, targets, lists } = parsePromptSections(prompt);

      const copySteps = steps.filter((s) => s.action === "copy");
      const pasteOrFillSteps = steps.filter(
        (s) => s.action === "paste" || s.action === "fill",
      );
      const submitSteps = steps.filter((s) => s.action === "submit");
      const backClicks = steps.filter(
        (s) => s.action === "click" && s.label === "Back to list",
      );

      const lastSubmitIdx = submitSteps.at(-1)?.stepIndex ?? -1;
      const lastBackIdx = backClicks.at(-1)?.stepIndex ?? -1;
      const hasTwoCompletedCycles =
        copySteps.length >= 2 &&
        pasteOrFillSteps.length >= 2 &&
        submitSteps.length >= 2 &&
        backClicks.length >= 2 &&
        lastBackIdx > lastSubmitIdx;

      if (!hasTwoCompletedCycles || lists.length === 0) {
        const parsed = schema.safeParse(rejectIncomplete);
        if (!parsed.success) {
          throw new Error(parsed.error.message ?? "Mock incomplete schema failure");
        }
        return parsed.data as T;
      }

      const openIdx = steps.find(
        (s) => s.action === "click" && s.label === "Open",
      )?.stepIndex;
      const tabSheetIdx = steps.find(
        (s) => s.action === "click" && s.label === "Sheet",
      )?.stepIndex;
      const copyIdx = copySteps[0]?.stepIndex;
      const tabClientsIdx = steps.find(
        (s) => s.action === "click" && s.label === "Clients",
      )?.stepIndex;
      const fillIdx = steps.find(
        (s) => s.action === "fill" || s.action === "paste",
      )?.stepIndex;
      const saveIdx = steps.find(
        (s) => s.action === "click" && s.label === "Save",
      )?.stepIndex;
      const backIdx = backClicks[0]?.stepIndex;

      const clientListTarget = targets.find((t) =>
        t.description.includes("client-list"),
      );
      const sheetTableTarget = targets.find((t) =>
        t.description.includes("sheet-table"),
      );

      const clientList = lists.find(
        (l) => l.containerTargetId === clientListTarget?.targetId,
      );
      const sheetList = lists.find(
        (l) => l.containerTargetId === sheetTableTarget?.targetId,
      );

      const copiedValues = new Set(
        copySteps.map((s) => s.value?.trim()).filter(Boolean),
      );

      let remainingItemIds: string[] = [];
      let nameField = "col1";

      if (clientList) {
        const pending = clientList.items.filter(
          (it) => !String(it.col2 ?? "").startsWith("Saved:"),
        );
        remainingItemIds = pending.map((it) => it.itemId);
      } else if (sheetList) {
        remainingItemIds = sheetList.items
          .filter((it) => !copiedValues.has(String(it.col2 ?? "").trim()))
          .map((it) => it.itemId);
      } else if (lists[0]) {
        const sample = lists[0].items[0] ?? {};
        if ("clientName" in sample) nameField = "clientName";
        remainingItemIds = lists[0].items.slice(2).map((it) => it.itemId);
      }

      if (
        openIdx === undefined ||
        tabSheetIdx === undefined ||
        copyIdx === undefined ||
        tabClientsIdx === undefined ||
        fillIdx === undefined ||
        saveIdx === undefined ||
        backIdx === undefined ||
        !clientListTarget ||
        !sheetTableTarget ||
        remainingItemIds.length === 0
      ) {
        const parsed = schema.safeParse(rejectIncomplete);
        if (!parsed.success) {
          throw new Error(parsed.error.message ?? "Mock incomplete schema failure");
        }
        return parsed.data as T;
      }

      const payload = {
        suggest: true,
        offerAt2: true,
        kind: "workflow",
        name: "Sync client lookup rates from Sheet",
        reason:
          "Opens each pending client, looks up its rate in Sheet, and saves it",
        risk: "low",
        runMode: "run_remaining",
        params: [{ name: "clientName" }, { name: "lookupValue" }],
        steps: [
          {
            action: "forEach",
            itemIds: remainingItemIds,
            steps: [
              {
                action: "click",
                withinId: clientListTarget.targetId,
                withinTextParam: nameField,
                stepIndex: openIdx,
              },
              { action: "click", stepIndex: tabSheetIdx },
              {
                action: "readText",
                withinId: sheetTableTarget.targetId,
                withinTextParam: nameField,
                stepIndex: copyIdx,
                bind: "lookupValue",
              },
              { action: "click", stepIndex: tabClientsIdx },
              { action: "fill", stepIndex: fillIdx, value: "{{lookupValue}}" },
              { action: "click", stepIndex: saveIdx },
              { action: "click", stepIndex: backIdx },
            ],
          },
        ],
      };

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `Mock Gemini schema error: ${parsed.error.message ?? "invalid"}`,
        );
      }
      return parsed.data as T;
    },
  };
}

interface SheetHarness {
  page: Page;
  context: BrowserContext;
  apiBaseUrl: string;
  sheetUrl: string;
  decidedScripts: ActionScript[];
  cleanup: () => Promise<string | undefined>;
}

async function startSheetHarness({
  useLiveModel,
}: {
  useLiveModel: boolean;
}): Promise<SheetHarness> {
  fs.mkdirSync(videosDir, { recursive: true });

  const demoServer = await startDemoServer({ dir: demoDir, port: 0 });
  const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-v2-sheet-traces-"));
  const dataDir = path.join(tracesDir, "data");
  const mockGemini = createSheetMockGemini();

  const apiServer: http.Server = createServer({
    tracesDir,
    dataDir,
    pipeline: "v2",
    autoPropose: true,
    proposeDebounceMs: 0,
    ...(useLiveModel
      ? {}
      : {
          gemini: mockGemini,
          iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
        }),
  });

  await new Promise<void>((resolve) => {
    apiServer.listen(0, "127.0.0.1", () => resolve());
  });
  const apiAddr = apiServer.address() as AddressInfo;
  const apiBaseUrl = `http://127.0.0.1:${apiAddr.port}`;

  const profileDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eyes-v2-sheet-profile-"),
  );
  const executablePath = await resolveChromeExecutable();

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videosDir, size: { width: 1280, height: 720 } },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

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

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", {
      timeout: 10_000,
    });
  }
  expect(serviceWorker.url()).toContain("background.js");

  const page = context.pages()[0] || (await context.newPage());
  const sheetUrl = `http://localhost:${demoServer.port}/sheet.html`;
  await page.goto(sheetUrl, { waitUntil: "load" });
  await page.waitForTimeout(300);

  return {
    page,
    context,
    apiBaseUrl,
    sheetUrl,
    decidedScripts,
    cleanup: async () => {
      let videoPath: string | undefined;
      try {
        videoPath = await page.video()?.path();
      } catch {
        videoPath = undefined;
      }
      await context.close().catch(() => {});
      apiServer.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        apiServer.close((err) => (err ? reject(err) : resolve()));
      });
      await demoServer.close();
      fs.rmSync(profileDir, { recursive: true, force: true });
      fs.rmSync(tracesDir, { recursive: true, force: true });
      return videoPath;
    },
  };
}

async function performClientCycle(page: Page, clientIndex: number): Promise<void> {
  await page.getByTestId(`open-client-${clientIndex}`).click();
  await page.getByTestId("tab-sheet").click();
  await page.getByTestId(`copy-sheet-value-${clientIndex}`).click();
  await page.getByTestId("tab-clients").click();
  await page.getByTestId("client-value-input").focus();
  await page.keyboard.press("ControlOrMeta+V");
  await page.getByTestId("save-client-btn").click();
  await page.getByTestId("back-to-list-btn").click();
}

test("BRAIN_PIPELINE=v2 sheet.html client loop runs remaining clients via within exact-text lookup and records video (mock Gemini)", async () => {
  test.setTimeout(60_000);
  const testInfo = test.info();
  const harness = await startSheetHarness({ useLiveModel: false });

  try {
    const { page, decidedScripts } = harness;

    await performClientCycle(page, 1);
    await performClientCycle(page, 2);

    const popup = page.locator(
      '#__eyes_suggestion_host__[data-eyes-suggestion="click"]',
    );
    await expect(popup).toBeVisible({ timeout: 20_000 });

    const primaryLabel = await popup.evaluate((host) => {
      const btn = host.shadowRoot?.querySelector(
        "[data-eyes-primary]",
      ) as HTMLButtonElement | null;
      return btn?.textContent?.trim() ?? "";
    });
    expect(primaryLabel).toBe("Run");

    expect(decidedScripts.length).toBeGreaterThanOrEqual(1);
    const compiled = decidedScripts[decidedScripts.length - 1];
    expect(compiled.runMode).toBe("run_remaining");
    const serialized = JSON.stringify(compiled.steps);
    expect(serialized).toContain("forEach");
    expect(serialized).toContain("within");
    expect(serialized).toMatch(/\{\{[^}]+\}\}/);

    await popup.evaluate((host) => {
      (
        host.shadowRoot!.querySelector(
          "[data-eyes-primary]",
        ) as HTMLButtonElement
      ).click();
    });

    await expect(page.getByTestId("client-status-1")).toHaveText(
      "Saved: RATE-1042",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("client-status-2")).toHaveText(
      "Saved: RATE-2085",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("client-status-3")).toHaveText(
      "Saved: RATE-3190",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("client-status-4")).toHaveText(
      "Saved: RATE-4418",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("client-list")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("#__eyes_watch_bar__")).toHaveCount(0, {
      timeout: 15_000,
    });
  } finally {
    const videoPath = await harness.cleanup();
    expect(videoPath).toBeDefined();
    expect(videoPath!.startsWith(videosDir)).toBe(true);
    expect(fs.existsSync(videoPath!)).toBe(true);
    expect(fs.statSync(videoPath!).size).toBeGreaterThan(0);
    await testInfo.attach("v2-sheet-ui-mock-video", {
      path: videoPath!,
      contentType: "video/webm",
    });
  }
});

test("BRAIN_PIPELINE=v2 sheet.html client loop against live Gemini + Iris completes remaining clients", async () => {
  test.skip(true, "removed by f35b69c / GEN-114");
  test.skip(
    !process.env.GOOGLE_CLOUD_PROJECT,
    "GOOGLE_CLOUD_PROJECT must be set for live Gemini + Iris E2E test",
  );
  test.setTimeout(90_000);
  const testInfo = test.info();

  const prevUseVertexAi = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";

  const harness = await startSheetHarness({ useLiveModel: true });

  try {
    const { page, decidedScripts } = harness;

    await performClientCycle(page, 1);
    await performClientCycle(page, 2);

    const popup = page.locator(
      '#__eyes_suggestion_host__[data-eyes-suggestion="click"]',
    );
    await expect(popup).toBeVisible({ timeout: 60_000 });

    const primaryLabel = await popup.evaluate((host) => {
      const btn = host.shadowRoot?.querySelector(
        "[data-eyes-primary]",
      ) as HTMLButtonElement | null;
      return btn?.textContent?.trim() ?? "";
    });
    expect(primaryLabel).toBe("Run");

    expect(decidedScripts.length).toBeGreaterThanOrEqual(1);
    const compiled = decidedScripts[decidedScripts.length - 1];
    expect(compiled.runMode).toBe("run_remaining");
    expect(JSON.stringify(compiled.steps)).toContain("forEach");

    await popup.evaluate((host) => {
      (
        host.shadowRoot!.querySelector(
          "[data-eyes-primary]",
        ) as HTMLButtonElement
      ).click();
    });

    await expect(page.getByTestId("client-status-1")).toHaveText(
      "Saved: RATE-1042",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("client-status-2")).toHaveText(
      "Saved: RATE-2085",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("client-status-3")).toHaveText(
      "Saved: RATE-3190",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("client-status-4")).toHaveText(
      "Saved: RATE-4418",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("client-list")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("#__eyes_watch_bar__")).toHaveCount(0, {
      timeout: 20_000,
    });
  } finally {
    if (prevUseVertexAi === undefined) {
      delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    } else {
      process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertexAi;
    }
    const videoPath = await harness.cleanup();
    if (videoPath && fs.existsSync(videoPath)) {
      expect(fs.statSync(videoPath).size).toBeGreaterThan(0);
      await testInfo.attach("v2-sheet-ui-live-video", {
        path: videoPath,
        contentType: "video/webm",
      });
    }
  }
});
