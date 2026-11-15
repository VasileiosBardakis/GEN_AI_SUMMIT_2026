import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type Page } from "@playwright/test";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { startDemoServer } from "../scripts/lib/static-server.mjs";
import { createServer } from "../server/src/app.ts";
import { readLibrary } from "../server/src/hands/library.ts";
import type { GeminiClient } from "../server/src/llm/gemini.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");
const demoDir = path.join(rootDir, "apps", "demo");
const videosDir = path.join(rootDir, "test-results", "videos");

type PromptStepLine = {
  stepIndex: number;
  action: string;
  app: string;
  label?: string;
  role?: string;
  tag?: string;
  hasTarget?: boolean;
  value?: string;
  key?: string;
  url?: string;
};

function parsePromptSteps(prompt: string): PromptStepLine[] {
  const steps: PromptStepLine[] = [];
  for (const line of prompt.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{"stepIndex":')) continue;
    try {
      steps.push(JSON.parse(trimmed) as PromptStepLine);
    } catch {
      // ignore non-step lines
    }
  }
  return steps;
}

function findLastStep(
  steps: readonly PromptStepLine[],
  predicate: (s: PromptStepLine) => boolean,
): PromptStepLine {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (predicate(steps[i])) return steps[i];
  }
  throw new Error("Expected step not found in compiler prompt");
}

function makeDeterministicMockGemini(): GeminiClient {
  return {
    async generateText() {
      throw new Error("unexpected generateText call");
    },
    async generateJson<T>(
      prompt: string,
      schema: Parameters<GeminiClient["generateJson"]>[1],
    ): Promise<T> {
      const steps = parsePromptSteps(prompt);
      let payload: unknown;

      if (prompt.includes("Hex Code") && prompt.includes("Hex Label") && prompt.includes("Hex Note")) {
        const hexCode = findLastStep(steps, (s) => s.action === "fill" && s.label === "Hex Code");
        const hexLabel = findLastStep(steps, (s) => s.action === "fill" && s.label === "Hex Label");
        const hexNote = findLastStep(steps, (s) => s.action === "fill" && s.label === "Hex Note");
        const submitBtn = findLastStep(
          steps,
          (s) => s.action === "click" && s.label === "Save Swatch",
        );

        payload = {
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Save hex swatch entry",
          reason: "Fills Hex Code, Hex Label, and Hex Note via Tab and submits the swatch.",
          risk: "low",
          runMode: "save_only",
          params: [{ name: "hex_code" }, { name: "hex_label" }, { name: "hex_note" }],
          steps: [
            { action: "fill", stepIndex: hexCode.stepIndex, value: "{{hex_code}}" },
            { action: "fill", stepIndex: hexLabel.stepIndex, value: "{{hex_label}}" },
            { action: "fill", stepIndex: hexNote.stepIndex, value: "{{hex_note}}" },
            { action: "click", stepIndex: submitBtn.stepIndex },
          ],
        };
      } else if (prompt.includes("Route Tier") && prompt.includes("Notify recipient")) {
        const selectStep = findLastStep(
          steps,
          (s) => s.action === "fill" && (s.label === "Route Tier" || s.tag === "select"),
        );
        const checkStep = findLastStep(
          steps,
          (s) => s.action === "fill" && s.label === "Notify recipient",
        );
        const enterFill = findLastStep(
          steps,
          (s) => s.action === "fill" && Boolean(s.label?.includes("Dispatch Note")),
        );
        const enterKey = findLastStep(
          steps,
          (s) => s.action === "key" && s.key === "Enter",
        );

        payload = {
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Dispatch route entry",
          reason: "Selects route tier, enables notification, fills note, and presses Enter.",
          risk: "low",
          runMode: "save_only",
          params: [{ name: "route_tier" }, { name: "dispatch_note" }],
          steps: [
            { action: "select", stepIndex: selectStep.stepIndex, value: "{{route_tier}}" },
            { action: "fill", stepIndex: checkStep.stepIndex, value: "true" },
            { action: "fill", stepIndex: enterFill.stepIndex, value: "{{dispatch_note}}" },
            { action: "key", stepIndex: enterKey.stepIndex, key: "Enter" },
          ],
        };
      } else if (prompt.includes("Recipient Email") && prompt.includes("Wire funds")) {
        expect(prompt).not.toContain("@");
        expect(prompt).not.toContain("[REDACTED:");
        expect(prompt).toContain("__PII_EMAIL_1__");

        const emailStep = findLastStep(
          steps,
          (s) => s.action === "fill" && s.label === "Recipient Email",
        );
        const amountStep = findLastStep(
          steps,
          (s) => s.action === "fill" && Boolean(s.label?.includes("Wire Amount")),
        );
        const wireBtn = findLastStep(
          steps,
          (s) => s.action === "click" && s.label === "Wire funds",
        );

        payload = {
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Wire funds to recipient",
          reason: "Fills recipient email and wire amount, then pauses before Wire funds.",
          risk: "high",
          runMode: "save_only",
          params: [{ name: "wire_amount" }],
          steps: [
            { action: "fill", stepIndex: emailStep.stepIndex, value: "__PII_EMAIL_1__" },
            { action: "fill", stepIndex: amountStep.stepIndex, value: "{{wire_amount}}" },
            { action: "click", stepIndex: wireBtn.stepIndex },
          ],
        };
      } else {
        throw new Error(`Unexpected prompt in mock Gemini:\n${prompt}`);
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`Mock schema failure: ${parsed.error.message}`);
      }
      return parsed.data as T;
    },
  };
}

async function launchHarness(opts: {
  gemini?: GeminiClient;
  iris?: () => Promise<{ worthAutomating: boolean; pauseBeforeSubmit: boolean }>;
  siteCooldownMs?: number;
  proposeDebounceMs?: number;
}) {
  fs.mkdirSync(videosDir, { recursive: true });
  const demoServer = await startDemoServer({ dir: demoDir, port: 0 });
  const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-v2-unseen-traces-"));
  const dataDir = path.join(tracesDir, "data");
  const apiServer: http.Server = createServer({
    pipeline: "v2",
    tracesDir,
    dataDir,
    autoPropose: true,
    proposeDebounceMs: opts.proposeDebounceMs ?? 0,
    ...(opts.siteCooldownMs !== undefined ? { siteCooldownMs: opts.siteCooldownMs } : {}),
    gemini: opts.gemini,
    iris: opts.iris,
  });
  await new Promise<void>((resolve) => {
    apiServer.listen(0, "127.0.0.1", () => resolve());
  });
  const apiBaseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-v2-unseen-profile-"));
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
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      await route.fulfill({ status: response.status, headers, body });
    } catch {
      await route.abort().catch(() => {});
    }
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 10_000 });
  }
  expect(sw.url()).toContain("background.js");

  const page = context.pages()[0] || (await context.newPage());

  const cleanup = async (): Promise<string | undefined> => {
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
  };

  return {
    demoUrl: demoServer.url,
    apiBaseUrl,
    dataDir,
    tracesDir,
    context,
    page,
    cleanup,
  };
}

function assertNonEmptyWebm(videoPath: string | undefined): void {
  expect(videoPath).toBeTruthy();
  expect(videoPath!.endsWith(".webm")).toBe(true);
  expect(path.resolve(videoPath!)).toContain(path.resolve(videosDir));
  expect(fs.existsSync(videoPath!)).toBe(true);
  expect(fs.statSync(videoPath!).size).toBeGreaterThan(0);
}

async function getPopupPrimaryLabel(page: Page): Promise<string> {
  const popup = page.locator("#__eyes_suggestion_host__");
  return popup.evaluate((host) => {
    return host.shadowRoot?.querySelector("[data-eyes-primary]")?.textContent?.trim() ?? "";
  });
}

async function clickPopupPrimary(page: Page): Promise<void> {
  const popup = page.locator("#__eyes_suggestion_host__");
  await popup.evaluate((host) => {
    (host.shadowRoot!.querySelector("[data-eyes-primary]") as HTMLButtonElement).click();
  });
}

async function fillPopupParam(page: Page, name: string, value: string): Promise<void> {
  const popup = page.locator("#__eyes_suggestion_host__");
  await popup.evaluate(
    (host, { paramName, paramValue }) => {
      const input = host.shadowRoot?.querySelector(
        `[data-eyes-param="${paramName}"]`,
      ) as HTMLInputElement | null;
      if (!input) throw new Error(`Missing popup param input ${paramName}`);
      input.value = paramValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { paramName: name, paramValue: value },
  );
}

async function runFlow1TabForm(page: Page, demoUrl: string, dataDir: string): Promise<void> {
  await page.goto(`${demoUrl}unseen-form.html`, { waitUntil: "load" });
  await page.waitForTimeout(300);

  const randomHexRows = Array.from({ length: 3 }, (_, idx) => {
    const hex = `#${Math.floor(0x100000 + Math.random() * 0x8fffff).toString(16)}`;
    return { hex, label: `Swatch-${idx + 1}`, note: `Token-${idx + 1}` };
  });

  for (let i = 0; i < randomHexRows.length; i += 1) {
    const row = randomHexRows[i];
    await page.getByTestId("hex-code").click();
    await page.getByTestId("hex-code").fill(row.hex);
    await page.keyboard.press("Tab");
    await page.keyboard.type(row.label);
    await page.keyboard.press("Tab");
    await page.keyboard.type(row.note);
    await page.getByTestId("tab-submit-btn").click();
    await expect(page.getByTestId("tab-submission-row")).toHaveCount(i + 1);
  }

  const popup = page.locator("#__eyes_suggestion_host__");
  await expect
    .poll(async () => (await readLibrary(dataDir).catch(() => [])).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);
  await expect(popup).toHaveCount(0);

  // Save-only must not double-submit
  await page.waitForTimeout(400);
  await expect(page.getByTestId("tab-submission-row")).toHaveCount(3);

  // Immediately start Move 1 on empty field 1
  await page.getByTestId("hex-code").click();
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => getPopupPrimaryLabel(page), { timeout: 10_000 }).toBe("Run");

  const replayHex = `#${Math.floor(0x100000 + Math.random() * 0x8fffff).toString(16)}`;
  const hasHexCodeParam = await popup.evaluate((host) =>
    Boolean(host.shadowRoot?.querySelector('[data-eyes-param="hex_code"]')),
  );
  if (hasHexCodeParam) {
    await fillPopupParam(page, "hex_code", replayHex);
  }

  await clickPopupPrimary(page);

  await expect(page.getByTestId("tab-submission-row")).toHaveCount(4, { timeout: 10_000 });
  const row4Cells = await page
    .getByTestId("tab-submission-row")
    .nth(3)
    .locator("td")
    .allTextContents();
  expect(row4Cells).toHaveLength(3);
  if (hasHexCodeParam) {
    expect(row4Cells[0]).toBe(replayHex);
  } else {
    expect(row4Cells[0]).toMatch(/^#[0-9a-f]{6}$/i);
  }
  expect(row4Cells[1].length).toBeGreaterThan(0);
  expect(row4Cells[2].length).toBeGreaterThan(0);
}

async function runFlow2ComboForm(page: Page, demoUrl: string, dataDir: string): Promise<void> {
  await page.goto(`${demoUrl}unseen-form.html`, { waitUntil: "load" });
  await page.waitForTimeout(300);

  const entries = [
    { tier: "express", note: "batch-one" },
    { tier: "priority", note: "batch-two" },
    { tier: "express", note: "batch-three" },
  ];

  for (let i = 0; i < entries.length; i += 1) {
    if (i === 1) {
      // 1 stray click outside the form
      await page.getByTestId("stray-banner").click();
    }
    const item = entries[i];
    await page.getByTestId("combo-select").selectOption(item.tier);
    await page.getByTestId("combo-check").check();
    await page.getByTestId("combo-enter").click();
    await page.getByTestId("combo-enter").fill(item.note);
    await page.getByTestId("combo-enter").press("Enter");
    await expect(page.getByTestId("combo-submission-row")).toHaveCount(i + 1);
  }

  const popup = page.locator("#__eyes_suggestion_host__");
  await expect
    .poll(async () => (await readLibrary(dataDir).catch(() => [])).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);
  await expect(popup).toHaveCount(0);

  const savedEntries = await readLibrary(dataDir);
  expect(JSON.stringify(savedEntries[0].script)).not.toContain("stray-banner");
  await expect(page.getByTestId("combo-submission-row")).toHaveCount(3);

  // Start Move 1 on select -> recall -> Run
  await page.getByTestId("combo-select").click();
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => getPopupPrimaryLabel(page), { timeout: 10_000 }).toBe("Run");

  const hasNoteParam = await popup.evaluate((host) =>
    Boolean(host.shadowRoot?.querySelector('[data-eyes-param="dispatch_note"]')),
  );
  if (hasNoteParam) {
    await fillPopupParam(page, "dispatch_note", "replayed-note");
  }

  await clickPopupPrimary(page);

  await expect(page.getByTestId("combo-submission-row")).toHaveCount(4, { timeout: 10_000 });
  const row4 = page.getByTestId("combo-submission-row").nth(3);
  await expect(row4).toHaveAttribute("data-select", /^(standard|express|priority)$/);
  await expect(row4).toHaveAttribute("data-checked", "true");
  const noteVal = await row4.getAttribute("data-note");
  expect(noteVal && noteVal.length > 0).toBe(true);
}

async function runFlow3RiskyForm(page: Page, demoUrl: string, dataDir: string): Promise<void> {
  await page.goto(`${demoUrl}unseen-risky.html`, { waitUntil: "load" });
  await page.waitForTimeout(300);

  const privateEmail = "alice.vance@private-vault.example";
  const amounts = ["1250.00", "2400.00", "3100.00"];

  for (let i = 0; i < amounts.length; i += 1) {
    await page.getByTestId("recipient-email").click();
    await page.getByTestId("recipient-email").fill(privateEmail);
    await page.getByTestId("wire-amount").click();
    await page.getByTestId("wire-amount").fill(amounts[i]);
    await page.getByTestId("wire-funds-btn").click();
    await expect(page.getByTestId("wire-status-item")).toHaveCount(i + 1);
  }

  const popup = page.locator("#__eyes_suggestion_host__");
  await expect
    .poll(async () => (await readLibrary(dataDir).catch(() => [])).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);
  await expect(popup).toHaveCount(0);

  const saved = await readLibrary(dataDir);
  expect(JSON.stringify(saved)).not.toContain(privateEmail);
  const riskyEntry = saved.find((entry) =>
    entry.eyes.scope.urlPatterns.some((pat) => pat.includes("unseen-risky")),
  );
  expect(riskyEntry).toBeDefined();
  expect(riskyEntry!.script.pauseBeforeSubmit).toBe(true);
  await expect(page.getByTestId("wire-status-item")).toHaveCount(3);

  // Move 1 recall on recipient-email
  await page.getByTestId("recipient-email").click();
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => getPopupPrimaryLabel(page), { timeout: 10_000 }).toBe("Run");

  await clickPopupPrimary(page);

  // Verify local email restoration, highlight + watch pause bar, and NO wire submission
  await expect(page.getByTestId("recipient-email")).toHaveValue(privateEmail, { timeout: 10_000 });
  await expect(page.locator("#__eyes_watch_highlight__")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-eyes-highlighted="true"]')).toHaveAttribute(
    "data-testid",
    "wire-funds-btn",
  );

  const watchBarHost = page.locator("#__eyes_watch_bar__");
  await expect(watchBarHost).toBeVisible({ timeout: 10_000 });
  const pauseText = await watchBarHost.evaluate((host) => {
    const bar = host.shadowRoot?.querySelector("[data-eyes-watch-bar]");
    const pause = host.shadowRoot?.querySelector("[data-eyes-watch-pause]");
    return {
      hasBar: Boolean(bar),
      pauseText: pause?.textContent?.trim() ?? "",
    };
  });
  expect(pauseText.hasBar).toBe(true);
  expect(pauseText.pauseText.length).toBeGreaterThan(0);
  await expect(page.getByTestId("wire-status-item")).toHaveCount(3);

  // Click Stop in watch bar -> clears overlay cleanly without submitting
  await watchBarHost.evaluate((host) => {
    (host.shadowRoot!.querySelector("[data-eyes-watch-stop]") as HTMLButtonElement).click();
  });
  await expect(page.locator("#__eyes_watch_bar__")).toHaveCount(0);
  await expect(page.locator("#__eyes_watch_highlight__")).toHaveCount(0);
  await expect(page.locator('[data-eyes-highlighted="true"]')).toHaveCount(0);
  await expect(page.getByTestId("wire-status-item")).toHaveCount(3);
}

test.describe("GEN-78: Real-browser unseen workflows (BRAIN_PIPELINE=v2)", () => {
  let prevPipeline: string | undefined;

  test.beforeEach(() => {
    prevPipeline = process.env.BRAIN_PIPELINE;
    process.env.BRAIN_PIPELINE = "v2";
  });

  test.afterEach(() => {
    if (prevPipeline === undefined) {
      delete process.env.BRAIN_PIPELINE;
    } else {
      process.env.BRAIN_PIPELINE = prevPipeline;
    }
  });

  test("deterministic Flow 1: 3-field Tab form saves as save_only, recalls on move 1, and fills all 3 fields with .webm video", async () => {
    test.setTimeout(60_000);
    const harness = await launchHarness({
      proposeDebounceMs: 500,
      gemini: makeDeterministicMockGemini(),
      iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
    });
    let videoPath: string | undefined;
    try {
      await runFlow1TabForm(harness.page, harness.demoUrl, harness.dataDir);
    } finally {
      videoPath = await harness.cleanup();
    }
    assertNonEmptyWebm(videoPath);
  });

  test("deterministic Flow 2: select + checkbox + Enter with 1 stray click saves, recalls, and replays cleanly with .webm video", async () => {
    test.setTimeout(60_000);
    const harness = await launchHarness({
      proposeDebounceMs: 500,
      gemini: makeDeterministicMockGemini(),
      iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
    });
    let videoPath: string | undefined;
    try {
      await runFlow2ComboForm(harness.page, harness.demoUrl, harness.dataDir);
    } finally {
      videoPath = await harness.cleanup();
    }
    assertNonEmptyWebm(videoPath);
  });

  test("deterministic Flow 3: private email restores locally on replay, pauses before Wire funds, and Stop halts cleanly with .webm video", async () => {
    test.setTimeout(60_000);
    const harness = await launchHarness({
      gemini: makeDeterministicMockGemini(),
      iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: true }),
    });
    let videoPath: string | undefined;
    try {
      await runFlow3RiskyForm(harness.page, harness.demoUrl, harness.dataDir);
    } finally {
      videoPath = await harness.cleanup();
    }
    assertNonEmptyWebm(videoPath);
  });

  test("live-model suite (Vertex AI Gemini): unseen Tab form + risky PII pause & Stop", async () => {
    test.skip(!process.env.GOOGLE_CLOUD_PROJECT, "GOOGLE_CLOUD_PROJECT must be set");
    test.setTimeout(120_000);

    const prevUseVertexAi = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENAI_USE_VERTEXAI) {
      process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
    }

    let videoPath1: string | undefined;
    let videoPath3: string | undefined;
    let passed = false;
    const h1 = await launchHarness({
      proposeDebounceMs: 500,
      gemini: { timeoutMs: 12_000 },
    });
    try {
      await runFlow1TabForm(h1.page, h1.demoUrl, h1.dataDir);
    } finally {
      videoPath1 = await h1.cleanup();
    }

    const h3 = await launchHarness({
      proposeDebounceMs: 500,
      gemini: { timeoutMs: 12_000 },
    });
    try {
      await runFlow3RiskyForm(h3.page, h3.demoUrl, h3.dataDir);
      passed = true;
    } finally {
      videoPath3 = await h3.cleanup();
      if (prevUseVertexAi === undefined) {
        delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      } else {
        process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertexAi;
      }
      console.log(
        `[v2-unseen-live] status=${passed ? "PASS" : "FAIL"} video1=${videoPath1 ?? "none"} video3=${videoPath3 ?? "none"}`,
      );
    }
    assertNonEmptyWebm(videoPath1);
    assertNonEmptyWebm(videoPath3);
  });
});
