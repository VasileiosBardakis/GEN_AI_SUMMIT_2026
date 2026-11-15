import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import type { PreviewResult } from "../extension/src/exp/preview-run.ts";
import type { ActionScript, BindingValue } from "../extension/src/types.ts";
import { toLocatorList } from "../shared/schema.ts";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { startDemoServer } from "../scripts/lib/static-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const demoDir = path.join(rootDir, "apps", "demo");

test("E2E: previewRun checks #profile-form without mutating DOM and detects missing fields", async () => {
  const demoServer = await startDemoServer({ dir: demoDir, port: 0 });
  const executablePath = fs.existsSync(chromium.executablePath())
    ? undefined
    : await resolveChromeExecutable();
  const browser = await chromium.launch({ headless: true, executablePath });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(`${demoServer.url}index.html`, { waitUntil: "load" });

    const tsSource = await readFile(
      path.join(rootDir, "extension/src/exp/preview-run.ts"),
      "utf8",
    );
    const strippedJs = stripTypeScriptTypes(tsSource)
      .replace(
        /^import\s+\{\s*toLocatorList\s*\}\s+from\s+["']@gen\/shared\/schema\.ts["'];?\r?\n?/m,
        `const toLocatorList = ${toLocatorList.toString()};\n`,
      )
      .replace(/^export\s+(?=function|const|let|var)/gm, "");

    await page.addScriptTag({
      content: `${strippedJs}\nwindow.__previewRun = previewRun;\nwindow.__isSubmitElement = isSubmitElement;`,
    });
    expect(pageErrors).toEqual([]);

    const companyInput = page.locator('#profile-form input[name="company_name"]');
    const emailInput = page.locator('#profile-form input[name="owner_email"]');
    const formStatus = page.locator("#form-status");

    await expect(companyInput).toHaveValue("");
    await expect(emailInput).toHaveValue("");
    await expect(formStatus).toHaveText("");

    const cleanScript: ActionScript = {
      name: "Supplier profile",
      steps: [
        {
          action: "fill",
          target: { kind: "css", value: '#profile-form input[name="company_name"]' },
          value: "{{companyName}}",
        },
        {
          action: "fill",
          target: [
            { kind: "testid", value: "missing-owner-email-testid" },
            { kind: "css", value: '#profile-form input[name="owner_email"]' },
          ],
          value: "{{ownerEmail}}",
        },
        {
          action: "click",
          target: { kind: "css", value: '#profile-form button[type="submit"]' },
        },
      ],
    };

    const cleanResult = await page.evaluate(
      ({ script, bindings }) => {
        const w = window as unknown as {
          __previewRun: (
            s: ActionScript,
            opts?: { bindings?: Record<string, BindingValue> },
          ) => PreviewResult;
        };
        return w.__previewRun(script, { bindings });
      },
      {
        script: cleanScript,
        bindings: { companyName: "Nikolaidis Logistics SA", ownerEmail: "ops@example.com" },
      },
    );

    expect(cleanResult.ready).toBe(true);
    expect(cleanResult.found).toBe(2);
    expect(cleanResult.total).toBe(3);
    expect(cleanResult.summary).toBe("ready: 2 of 3 steps found");
    expect(cleanResult.steps).toEqual([
      { index: 0, action: "fill", status: "found" },
      { index: 1, action: "fill", status: "found" },
      {
        index: 2,
        action: "click",
        status: "skipped",
        reason: "Submit click skipped in dry-run preview",
      },
    ]);

    await expect(companyInput).toHaveValue("");
    await expect(emailInput).toHaveValue("");
    await expect(formStatus).toHaveText("");

    const missingScript: ActionScript = {
      name: "Broken profile",
      steps: [
        {
          action: "fill",
          target: { kind: "css", value: '#profile-form input[name="company_name"]' },
          value: "Nikolaidis Logistics SA",
        },
        {
          action: "fill",
          target: { kind: "css", value: '#profile-form input[name="nonexistent_field"]' },
          value: "value",
        },
      ],
    };

    const missingResult = await page.evaluate((script) => {
      const w = window as unknown as {
        __previewRun: (s: ActionScript) => PreviewResult;
      };
      return w.__previewRun(script);
    }, missingScript);

    expect(missingResult.ready).toBe(false);
    expect(missingResult.found).toBe(1);
    expect(missingResult.total).toBe(2);
    expect(missingResult.steps[0]).toEqual({ index: 0, action: "fill", status: "found" });
    expect(missingResult.steps[1].status).toBe("missing");
    expect(missingResult.steps[1].action).toBe("fill");
    expect(missingResult.steps[1].reason).toContain("nonexistent_field");
    expect(missingResult.summary).toContain("fill");
    expect(missingResult.summary).toContain("nonexistent_field");
  } finally {
    await browser.close().catch(() => {});
    await demoServer.close();
  }
});
