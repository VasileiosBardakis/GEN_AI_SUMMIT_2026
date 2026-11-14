import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Event } from "../shared/contract.ts";
import type { DomStep, StepResult } from "../extension/src/types.ts";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { createServer } from "../server/src/app.ts";
import { implementForLibrary } from "../server/src/hands/implementor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

async function setupLiveHarness() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gen-e2e-realsites-"));
  const server: http.Server = createServer({
    tracesDir: path.join(tmpDir, "traces"),
    dataDir: path.join(tmpDir, "data"),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const contentJs = await readFile(path.join(rootDir, "extension/dist/content.js"), "utf8");
  const executeJs = (
    await readFile(path.join(rootDir, "extension/dist/hands/execute.js"), "utf8")
  ).replace(/export\s+async\s+function\s+executeStep/, "async function executeStep");

  const executablePath = fs.existsSync(chromium.executablePath())
    ? undefined
    : await resolveChromeExecutable();
  const browser = await chromium.launch({ headless: true, executablePath });
  const context: BrowserContext = await browser.newContext({ bypassCSP: true });

  const capturedEvents: Event[] = [];
  let pendingPost: Promise<unknown> = Promise.resolve();
  await context.exposeFunction("__EYES_COLLECT__", (evt: Event) => {
    capturedEvents.push(evt);
    pendingPost = pendingPost.then(() =>
      fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([evt]),
      }).catch(() => {}),
    );
  });

  await context.addInitScript({
    content: `${contentJs}\n${executeJs}\nwindow.__executeStep = executeStep;`,
  });

  return {
    baseUrl,
    capturedEvents,
    flushEvents: () => pendingPost,
    context,
    cleanup: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}

async function runDecideAndExecuteOnPage(page: Page, baseUrl: string): Promise<void> {
  const decideCmdRes = await fetch(`${baseUrl}/hands/next?waitMs=4000`);
  expect(decideCmdRes.status).toBe(200);
  const decideCmd = (await decideCmdRes.json()) as {
    id: string;
    kind: string;
    name: string;
    solution: string;
    script: { steps: DomStep[] };
  };
  expect(decideCmd.kind).toBe("decide");

  const shown = await page.evaluate(
    (payload) => {
      const w = window as unknown as {
        __deciderOut?: { ok: boolean; decision?: string };
        __HANDS_ON_MESSAGE__?: (
          msg: unknown,
          sender: unknown,
          sendResponse: (res: { ok: boolean; decision?: string }) => void,
        ) => boolean;
      };
      if (!w.__HANDS_ON_MESSAGE__) return false;
      return w.__HANDS_ON_MESSAGE__(
        {
          kind: "EYES_SHOW_DECIDER",
          name: payload.name,
          solution: payload.solution,
          script: payload.script,
        },
        {},
        (res) => {
          w.__deciderOut = res;
        },
      );
    },
    { name: decideCmd.name, solution: decideCmd.solution, script: decideCmd.script },
  );
  expect(shown).toBe(true);

  const popup = page.locator("#__eyes_suggestion_host__");
  await expect(popup).toBeVisible();
  await popup.evaluate((host) => {
    (host.shadowRoot!.querySelector("[data-eyes-primary]") as HTMLButtonElement).click();
  });

  await fetch(`${baseUrl}/hands/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: decideCmd.id, ok: true, decision: "approved" }),
  });

  const runCmdRes = await fetch(`${baseUrl}/hands/next?waitMs=4000`);
  expect(runCmdRes.status).toBe(200);
  const runCmd = (await runCmdRes.json()) as { id: string; script: { steps: DomStep[] } };

  const results: StepResult[] = [];
  for (const step of runCmd.script.steps) {
    const res = await page.evaluate(
      (s) =>
        (
          window as unknown as { __executeStep: (step: DomStep) => Promise<StepResult> }
        ).__executeStep(s),
      step,
    );
    expect(res.ok, `Step ${JSON.stringify(step)} failed: ${res.error ?? ""}`).toBe(true);
    results.push(res);
  }

  await fetch(`${baseUrl}/hands/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: runCmd.id, ok: true, results }),
  });
}

test("Real government address form (GOV.UK Design System): <label for> recall + multi-field aria fill", async () => {
  test.setTimeout(45_000);
  const harness = await setupLiveHarness();
  try {
    const entry = await implementForLibrary(
      "Fill Address line 1, Town or city, and Postcode on the GOV.UK address form.",
      {
        name: "Fill UK office address",
        context: {
          app: "design-system.service.gov.uk",
          url: "https://design-system.service.gov.uk/patterns/addresses/multiple/index.html",
          title: "Addresses – GOV.UK Design System",
        },
        generate: async () => ({
          description: "Fills standard UK office address fields.",
          kind: "workflow",
          script: {
            steps: [
              {
                action: "fill",
                target: { kind: "aria", value: 'textbox[name="Address line 1"]' },
                value: "10 Whitehall",
              },
              {
                action: "fill",
                target: { kind: "aria", value: "Town or city" },
                value: "London",
              },
              {
                action: "fill",
                target: { kind: "aria", value: "Postcode" },
                value: "SW1A 2AA",
              },
            ],
          },
          eyes: {
            intent: "fill_uk_office_address",
            scope: {
              apps: ["design-system.service.gov.uk"],
              urlPatterns: ["/patterns/addresses/*"],
              pageHints: ["address"],
            },
            targetHints: {
              roles: ["textbox"],
              labelContains: ["address line 1"],
              locators: [],
            },
            textHints: { prefixHints: [], minCharsBeforeMatch: 0 },
            guards: {
              fieldEmptyOnly: true,
              requireClipboard: false,
              cooldownMs: 30_000,
              minSignals: 2,
            },
          },
        }),
      },
    );

    const saveRes = await fetch(`${harness.baseUrl}/library`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    expect(saveRes.status).toBe(200);

    const page = await harness.context.newPage();
    await page.goto(
      "https://design-system.service.gov.uk/patterns/addresses/multiple/index.html",
      { waitUntil: "domcontentloaded", timeout: 20_000 },
    );

    // Clicking the real <label for="address-line-1"> input triggers Eyes capture -> recall -> /decide -> Hands
    await page.locator("#address-line-1").click();
    await harness.flushEvents();

    const capturedAddrClick = harness.capturedEvents.find(
      (e) => e.type === "click" && e.target?.label === "Address line 1",
    );
    expect(capturedAddrClick).toBeDefined();

    await runDecideAndExecuteOnPage(page, harness.baseUrl);

    await expect(page.locator("#address-line-1")).toHaveValue("10 Whitehall");
    await expect(page.locator("#address-town")).toHaveValue("London");
    await expect(page.locator("#address-postcode")).toHaveValue("SW1A 2AA");
  } finally {
    await harness.cleanup();
  }
});

test("Real UK government service (gov.uk/check-uk-visa): <select> human label + submit navigation + radio group", async () => {
  test.setTimeout(45_000);
  const harness = await setupLiveHarness();
  try {
    const page = await harness.context.newPage();
    await page.goto("https://www.gov.uk/check-uk-visa/y", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    await page.locator("select#response").focus();
    await harness.flushEvents();

    const selectFocusEvt = harness.capturedEvents.find(
      (e) => e.type === "focus" && e.target?.tag === "select",
    );
    expect(selectFocusEvt?.target?.role).toBe("combobox");
    expect(selectFocusEvt?.target?.label).toContain("nationality");

    // Step 1: Select visible label "Australia" (option value is lowercase "australia") via accessible label
    const selectRes = await page.evaluate(() =>
      (
        window as unknown as { __executeStep: (step: DomStep) => Promise<StepResult> }
      ).__executeStep({
        action: "select",
        target: { kind: "aria", value: 'combobox[name="nationality"]' },
        value: "Australia",
      }),
    );
    expect(selectRes).toMatchObject({ ok: true, value: "australia" });
    await expect(page.locator("select#response")).toHaveValue("australia");

    // Step 2: Click "Continue" via text locator and navigate to the radio-button step
    const navPromise = page.waitForURL("**/check-uk-visa/y/australia*", { timeout: 15_000 });
    const clickContinue = await page.evaluate(() =>
      (
        window as unknown as { __executeStep: (step: DomStep) => Promise<StepResult> }
      ).__executeStep({
        action: "click",
        target: { kind: "text", value: "Continue" },
      }),
    );
    expect(clickContinue.ok).toBe(true);
    await navPromise;

    // Step 3: On step 2, select radio option via accessible label ("Yes" / first radio)
    const firstRadioLabel = await page
      .locator('input[type="radio"]')
      .first()
      .evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? "");
    expect(firstRadioLabel.length).toBeGreaterThan(0);

    const radioRes = await page.evaluate((labelText) =>
      (
        window as unknown as { __executeStep: (step: DomStep) => Promise<StepResult> }
      ).__executeStep({
        action: "fill",
        target: { kind: "aria", value: `radio[name=${JSON.stringify(labelText)}]` },
        value: "true",
      }),
      firstRadioLabel,
    );
    expect(radioRes).toMatchObject({ ok: true, value: "true" });
    await expect(page.locator('input[type="radio"]').first()).toBeChecked();

    // Step 4: On gov.uk/search/all, first input[name="keywords"] in DOM is hidden in collapsed header;
    // Hands must skip the hidden duplicate and fill the visible page search input.
    await page.goto("https://www.gov.uk/search/all", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const kwFill = await page.evaluate(() =>
      (
        window as unknown as { __executeStep: (step: DomStep) => Promise<StepResult> }
      ).__executeStep({
        action: "fill",
        target: { kind: "css", value: 'input[name="keywords"]' },
        value: "corporation tax registration",
      }),
    );
    expect(kwFill).toMatchObject({ ok: true, value: "corporation tax registration" });
    await expect(page.locator('input[name="keywords"]:visible')).toHaveValue(
      "corporation tax registration",
    );
  } finally {
    await harness.cleanup();
  }
});

test("Real GitHub data-entry layout (github.com/search/advanced): nameless inputs, duplicate selects, recall + Hands", async () => {
  test.setTimeout(45_000);
  const harness = await setupLiveHarness();
  try {
    const entry = await implementForLibrary(
      "Fill From these owners with octokit, In these repositories with octokit/rest.js, and select TypeScript in Written in this language on GitHub Advanced Search.",
      {
        name: "GitHub Octokit TypeScript filter",
        context: {
          app: "github.com",
          url: "https://github.com/search/advanced",
          title: "GitHub Advanced Search",
        },
        generate: async () => ({
          description: "Fills owner, repo, and language filters on GitHub Advanced Search.",
          kind: "workflow",
          script: {
            steps: [
              {
                action: "fill",
                target: { kind: "aria", value: "From these owners" },
                value: "octokit",
              },
              {
                action: "fill",
                target: { kind: "aria", value: "In these repositories" },
                value: "octokit/rest.js",
              },
              {
                action: "select",
                target: { kind: "aria", value: 'combobox[name="Written in this language"]' },
                value: "TypeScript",
              },
            ],
          },
          eyes: {
            intent: "github_octokit_filter",
            scope: {
              apps: ["github.com"],
              urlPatterns: ["/search/advanced"],
              pageHints: ["github", "search"],
            },
            targetHints: {
              roles: ["textbox"],
              labelContains: ["from these owners"],
              locators: [],
            },
            textHints: { prefixHints: [], minCharsBeforeMatch: 0 },
            guards: {
              fieldEmptyOnly: true,
              requireClipboard: false,
              cooldownMs: 30_000,
              minSignals: 2,
            },
          },
        }),
      },
    );

    const saveRes = await fetch(`${harness.baseUrl}/library`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    expect(saveRes.status).toBe(200);

    const page = await harness.context.newPage();
    await page.goto("https://github.com/search/advanced", {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });

    await page.locator("#search_from").click();
    await harness.flushEvents();

    await runDecideAndExecuteOnPage(page, harness.baseUrl);

    await expect(page.locator("#search_from")).toHaveValue("octokit");
    await expect(page.locator("#search_repos")).toHaveValue("octokit/rest.js");
    await expect(page.locator("#search_language")).toHaveValue("TypeScript");
  } finally {
    await harness.cleanup();
  }
});
