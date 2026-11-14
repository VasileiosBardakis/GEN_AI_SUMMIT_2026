import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import type { DomStep, StepResult } from "../extension/src/types.ts";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { createServer } from "../server/src/app.ts";
import { implementSolution } from "../server/src/hands/implementor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("E2E: POST /implement -> POST /hands/run -> executeStep fills demo form", async () => {
  const tracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-e2e-hands-"));
  const server: http.Server = createServer({
    tracesDir,
    implement: (solution, opts) =>
      implementSolution(solution, {
        ...opts,
        generate: async () => ({
          steps: [
            {
              action: "fill",
              target: { kind: "css", value: 'input[name="company_name"]' },
              value: "Acme Robotics",
            },
            {
              action: "fill",
              target: { kind: "css", value: 'input[name="owner_email"]' },
              value: "ops@acme.example",
            },
          ],
        }),
      }),
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const executablePath = fs.existsSync(chromium.executablePath())
    ? undefined
    : await resolveChromeExecutable();
  const browser = await chromium.launch({ headless: true, executablePath });

  try {
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const postRes = await fetch(`${baseUrl}/implement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Supplier profile",
        solution: "Fill company name with Acme Robotics and email with ops@acme.example",
      }),
    });
    expect(postRes.status).toBe(200);
    const { script } = (await postRes.json()) as { script: { steps: DomStep[] } };
    expect(script.steps).toHaveLength(2);

    const page = await browser.newPage();
    const demoHtml = await readFile(path.join(rootDir, "apps/demo/index.html"), "utf8");
    const executeJs = (
      await readFile(path.join(rootDir, "extension/dist/hands/execute.js"), "utf8")
    ).replace(/export\s+async\s+function\s+executeStep/, "async function executeStep");

    await page.setContent(demoHtml);
    await page.addScriptTag({ content: `${executeJs}\nwindow.__executeStep = executeStep;` });

    const runPromise = fetch(`${baseUrl}/hands/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script }),
    });

    const nextRes = await fetch(`${baseUrl}/hands/next?waitMs=2000`);
    expect(nextRes.status).toBe(200);
    const cmd = (await nextRes.json()) as { id: string; script: { steps: DomStep[] } };

    const results: StepResult[] = [];
    for (const step of cmd.script.steps) {
      const result = await page.evaluate(
        (s) =>
          (
            window as unknown as { __executeStep: (step: DomStep) => Promise<StepResult> }
          ).__executeStep(s),
        step,
      );
      expect(result.ok).toBe(true);
      results.push(result);
    }

    await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cmd.id, ok: true, results }),
    });

    const runRes = await runPromise;
    expect(runRes.status).toBe(200);
    await expect(page.locator('input[name="company_name"]')).toHaveValue("Acme Robotics");
    await expect(page.locator('input[name="owner_email"]')).toHaveValue("ops@acme.example");
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tracesDir, { recursive: true, force: true });
  }
});

test("E2E: POST /decide -> EYES_SHOW_DECIDER renders popup -> Trial it live approves", async () => {
  const tracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-e2e-decide-"));
  const server: http.Server = createServer({ tracesDir });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const executablePath = fs.existsSync(chromium.executablePath())
    ? undefined
    : await resolveChromeExecutable();
  const browser = await chromium.launch({ headless: true, executablePath });

  try {
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const script = {
      name: "Supplier profile",
      steps: [
        {
          action: "fill" as const,
          target: { kind: "css" as const, value: 'input[name="company_name"]' },
          value: "Acme Robotics",
        },
      ],
    };

    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const demoHtml = await readFile(path.join(rootDir, "apps/demo/index.html"), "utf8");
    const contentJs = await readFile(path.join(rootDir, "extension/dist/content.js"), "utf8");

    await page.setContent(demoHtml);
    await page.addScriptTag({ content: contentJs });
    expect(pageErrors).toEqual([]);

    const decidePromise = fetch(`${baseUrl}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Supplier profile",
        solution: "Fill company name with Acme Robotics",
        script,
      }),
    });

    const nextRes = await fetch(`${baseUrl}/hands/next?waitMs=2000`);
    expect(nextRes.status).toBe(200);
    const cmd = (await nextRes.json()) as {
      id: string;
      kind: string;
      name: string;
      solution: string;
      script: typeof script;
    };
    expect(cmd.kind).toBe("decide");

    const started = await page.evaluate((payload) => {
      const w = window as unknown as {
        __deciderResult?: { ok: boolean; decision?: string };
        __HANDS_ON_MESSAGE__?: (
          msg: unknown,
          sender: unknown,
          sendResponse: (res: { ok: boolean; decision?: string }) => void
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
          w.__deciderResult = res;
        }
      );
    }, { name: cmd.name, solution: cmd.solution, script: cmd.script });
    expect(started).toBe(true);

    const popup = page.locator("#__eyes_suggestion_host__");
    await expect(popup).toBeVisible();
    await popup.evaluate((host) => {
      (host.shadowRoot!.querySelector("[data-eyes-primary]") as HTMLButtonElement).click();
    });

    const uiDecision = await page.evaluate(
      () => (window as unknown as { __deciderResult?: { ok: boolean; decision?: string } }).__deciderResult
    );
    expect(uiDecision).toEqual({ ok: true, decision: "approved" });

    await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cmd.id, ok: true, decision: uiDecision.decision }),
    });

    const decideRes = await decidePromise;
    expect(decideRes.status).toBe(200);
    expect(await decideRes.json()).toEqual({
      id: cmd.id,
      ok: true,
      decision: "approved",
    });
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tracesDir, { recursive: true, force: true });
  }
});
