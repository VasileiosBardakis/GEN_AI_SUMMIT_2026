import { expect, test } from "@playwright/test";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { startDemoServer } from "../scripts/lib/static-server.mjs";
import { createServer } from "../server/src/app.ts";
import { listSessions, readEvents } from "../server/src/trace.ts";
import type { Event } from "../shared/contract.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");
const demoDir = path.join(rootDir, "apps", "demo");

const SAMPLE_REPLY =
  "Hi, thanks for your order. It ships Friday and tracking will follow shortly.";

async function dispatchPaste(
  page: import("@playwright/test").Page,
  selector: string,
  text: string
): Promise<void> {
  await page.locator(selector).evaluate((el, pasted) => {
    const textarea = el as HTMLTextAreaElement;
    textarea.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", pasted);
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    textarea.dispatchEvent(pasteEvent);
    textarea.value = pasted;
    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertFromPaste",
        data: pasted,
      })
    );
  }, text);
}

test("silently saves repeated snippets and only prompts to actually insert when focused again", async () => {
  const demoServer = await startDemoServer({ dir: demoDir, port: 0 });
  const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-e2e-traces-"));
  const dataDir = path.join(tracesDir, "data");
  const apiServer: http.Server = createServer({ tracesDir, dataDir, autoPropose: false });
  const [defaultHandler] = apiServer.listeners("request") as Array<
    (req: http.IncomingMessage, res: http.ServerResponse) => void
  >;
  apiServer.removeAllListeners("request");
  apiServer.on("request", async (req, res) => {
    if (req.method === "GET" && req.url?.split("?")[0] === "/events") {
      const sessions = await listSessions(tracesDir);
      const events = (
        await Promise.all(sessions.map((s) => readEvents(tracesDir, s.session)))
      ).flat();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, events }));
      return;
    }
    defaultHandler(req, res);
  });
  await new Promise<void>((resolve) => {
    apiServer.listen(0, "127.0.0.1", () => resolve());
  });
  const apiAddr = apiServer.address() as AddressInfo;
  const apiBaseUrl = `http://127.0.0.1:${apiAddr.port}`;

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-e2e-"));
  const executablePath = await resolveChromeExecutable();

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: true,
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

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    }
    expect(serviceWorker.url()).toContain("background.js");

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(demoServer.url, { waitUntil: "load" });

    const popup = page.locator("#__eyes_suggestion_host__");

    // 1. Repeat a reply 3 times: silently saves to library, does NOT ask user to save it
    await dispatchPaste(page, 'textarea[name="customer_reply"]', SAMPLE_REPLY);
    await page.waitForTimeout(350);
    await page.locator("#clear-reply").click();
    await expect(popup).toHaveCount(0);

    await dispatchPaste(page, 'textarea[name="customer_reply"]', SAMPLE_REPLY);
    await page.waitForTimeout(350);
    await page.locator("#clear-reply").click();
    await expect(popup).toHaveCount(0);

    await dispatchPaste(page, 'textarea[name="customer_reply"]', SAMPLE_REPLY);
    await page.waitForTimeout(400);
    await expect(popup).toHaveCount(0);

    // 2. Repeated clicks also never prompt to save
    const copyBtn = page.locator("#copy-invoice");
    await copyBtn.click();
    await copyBtn.click();
    await copyBtn.click();
    await expect(popup).toHaveCount(0);

    // Confirm snippet was silently saved to server library as active
    await expect
      .poll(async () => {
        const res = await fetch(`${apiBaseUrl}/library`);
        const json = (await res.json()) as { items?: Array<{ status: string; kind: string }> };
        return json.items?.length ?? 0;
      })
      .toBeGreaterThanOrEqual(1);

    // 3. Clicking an unrelated input on the same page must NOT trigger recall
    await page.locator('input[name="company_name"]').click();
    await page.waitForTimeout(450);
    await expect(popup).toHaveCount(0);

    // 4. Clear reply and immediately click empty target field -> prompts to actually Insert
    await page.locator("#clear-reply").click();
    await expect(page.locator('textarea[name="customer_reply"]')).toHaveValue("");
    await page.locator('textarea[name="customer_reply"]').click();

    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect(popup).toHaveAttribute("data-eyes-suggestion", "text");

    const popupState = await popup.evaluate((host) => {
      const shadow = host.shadowRoot!;
      return {
        product: shadow.querySelector(".product")?.textContent?.trim(),
        hasBrandMark: Boolean(shadow.querySelector("[data-eyes-brand-mark]")),
        hasAiBadge: Boolean(shadow.querySelector(".top .ai")),
        headerText: shadow.querySelector(".top")?.textContent?.replace(/\s+/g, " ").trim(),
        headline: shadow.querySelector("h2")?.textContent?.trim(),
        primaryText: shadow.querySelector("[data-eyes-primary]")?.textContent?.trim(),
        userFlowHead: shadow.querySelector('[data-eyes-flow="user"] .flow-head')?.textContent?.trim(),
        proposedFlowHead: shadow.querySelector('[data-eyes-flow="proposed"] .flow-head')?.textContent?.trim(),
      };
    });

    expect(popupState.product).toBe("Eyes");
    expect(popupState.hasBrandMark).toBe(true);
    expect(popupState.hasAiBadge).toBe(false);
    expect(popupState.headerText).not.toContain("AI");
    expect(popupState.headline).not.toContain("Save");
    expect(popupState.primaryText).toBe("Insert");
    expect(popupState.userFlowHead).toContain("Your flow");
    expect(popupState.proposedFlowHead).toContain("Eyes flow");

    const viewport = page.viewportSize();
    const popupBox = await popup.boundingBox();
    expect(popupBox).not.toBeNull();
    if (popupBox && viewport) {
      expect(popupBox.x).toBeGreaterThanOrEqual(0);
      expect(popupBox.y).toBeGreaterThanOrEqual(0);
      expect(popupBox.y).toBeLessThanOrEqual(24);
      expect(popupBox.width).toBeLessThanOrEqual(336);
      expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(viewport.width);
      expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(viewport.height);
    }

    // 4. Approving executes insertText directly into the focused textarea
    await popup.evaluate((host) => {
      (host.shadowRoot!.querySelector("[data-eyes-primary]") as HTMLButtonElement).click();
    });
    await expect(page.locator('textarea[name="customer_reply"]')).toHaveValue(SAMPLE_REPLY, {
      timeout: 10_000,
    });

    // 5. Clearing & re-focusing after accept suggests again without a 60s lockout
    await page.waitForTimeout(1100);
    await page.locator("#clear-reply").click();
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await popup.evaluate((host) => {
      (host.shadowRoot!.querySelector("[data-eyes-dismiss]") as HTMLButtonElement).click();
    });
    await expect(popup).toHaveCount(0);

    // 6. Short values (<20 chars) + "Company name" vs "Payment notes":
    //    - no cross-field contamination from "name" attribute selectors
    //    - clicking another field (City) before Insert still pastes into Payment notes
    await page
      .locator('input[name="notes"]')
      .evaluate((el) => el.setAttribute("placeholder", "Invoice notes"));
    for (let i = 0; i < 3; i += 1) {
      await dispatchPaste(page, 'input[name="company_name"]', "Nikolaidis logistics");
      await page.waitForTimeout(250);
      await page.locator('input[name="company_name"]').fill("");
    }
    for (let i = 0; i < 3; i += 1) {
      await dispatchPaste(page, 'input[name="notes"]', "Invoice ref 4820");
      await page.waitForTimeout(250);
      await page.locator('input[name="notes"]').fill("");
    }

    await expect
      .poll(async () => {
        const res = await fetch(`${apiBaseUrl}/library`);
        const json = (await res.json()) as { items?: Array<{ name: string }> };
        return (
          Boolean(json.items?.some((item) => item.name.includes("Invoice ref 4820"))) &&
          Boolean(json.items?.some((item) => item.name.includes("Nikolaidis logistics")))
        );
      })
      .toBe(true);

    const notesInput = page.locator('input[name="notes"]');
    await notesInput.click();
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() =>
        popup.evaluate((host) => host.shadowRoot?.querySelector("h2")?.textContent?.trim() ?? "")
      )
      .toContain("Invoice ref 4820");

    // Move focus to City (which has no snippet), then click Insert -> must fill Payment notes, NOT City
    await page.locator('input[name="city"]').click();
    await popup.evaluate((host) => {
      (host.shadowRoot!.querySelector("[data-eyes-primary]") as HTMLButtonElement).click();
    });
    await expect(notesInput).toHaveValue("Invoice ref 4820", { timeout: 10_000 });
    await expect(page.locator('input[name="city"]')).toHaveValue("");

    // Typed email addresses are masked before storage and never persisted in raw form
    const emailInput = page.locator('input[name="owner_email"]');
    await emailInput.click();
    await emailInput.pressSequentially("alice@example.com");
    await page.locator('input[name="city"]').click();

    await expect
      .poll(async () => {
        const res = await fetch(`${apiBaseUrl}/events`);
        const json = (await res.json()) as { events?: Event[] };
        const allEvents = json.events ?? [];
        const emailEvent = allEvents.find(
          (evt) =>
            evt.meta?.typing?.inputName === "owner_email" &&
            typeof evt.value === "string" &&
            /^\[REDACTED:EMAIL#h_[0-9a-f]+\]$/.test(evt.value)
        );
        return {
          matched: Boolean(
            emailEvent &&
              emailEvent.meta?.privacy?.redacted === true &&
              emailEvent.meta?.privacy?.piiTypes?.includes("email")
          ),
          leakedRawEmail: allEvents.some((evt) => JSON.stringify(evt).includes("alice@example.com")),
        };
      })
      .toEqual({ matched: true, leakedRawEmail: false });

    // 7. Switching directly between two empty fields with saved snippets smoothly replaces the popup
    await page.waitForTimeout(1100);
    await page.locator('input[name="company_name"]').click();
    await expect
      .poll(() =>
        popup.evaluate((host) => host.shadowRoot?.querySelector("h2")?.textContent?.trim() ?? "")
      )
      .toContain("Nikolaidis logistics");

    await page.locator('textarea[name="customer_reply"]').click();
    await expect
      .poll(() =>
        popup.evaluate((host) => host.shadowRoot?.querySelector("h2")?.textContent?.trim() ?? "")
      )
      .toContain("Hi, thanks for your order");

    // 8. Snippet repetition persists across full page reloads (not reset per page load)
    const RELOAD_SNIPPET = "Reload persistence test snippet 99";
    await dispatchPaste(page, 'input[name="city"]', RELOAD_SNIPPET);
    await page.waitForTimeout(250);
    await page.reload({ waitUntil: "load" });
    await dispatchPaste(page, 'input[name="city"]', RELOAD_SNIPPET);
    await page.waitForTimeout(250);
    await page.reload({ waitUntil: "load" });
    await dispatchPaste(page, 'input[name="city"]', RELOAD_SNIPPET);

    await expect
      .poll(async () => {
        const res = await fetch(`${apiBaseUrl}/library`);
        const json = (await res.json()) as { items?: Array<{ name: string }> };
        return Boolean(json.items?.some((item) => item.name.includes("Reload persistence test")));
      })
      .toBe(true);
  } finally {
    await context.close().catch(() => {});
    apiServer.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      apiServer.close((err) => (err ? reject(err) : resolve()));
    });
    await demoServer.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(tracesDir, { recursive: true, force: true });
  }
});
