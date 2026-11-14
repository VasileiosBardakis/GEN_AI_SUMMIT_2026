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
