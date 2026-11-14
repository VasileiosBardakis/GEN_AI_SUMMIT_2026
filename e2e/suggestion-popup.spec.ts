import { expect, test } from "@playwright/test";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChromeExecutable } from "../scripts/lib/chrome.mjs";
import { startDemoServer } from "../scripts/lib/static-server.mjs";

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

test("shows Eyes AI suggestion popup with conditional MP4 and always-shown DAG flows", async () => {
  const demoServer = await startDemoServer({ dir: demoDir, port: 0 });
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

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    }
    expect(serviceWorker.url()).toContain("background.js");

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(demoServer.url, { waitUntil: "load" });

    const popup = page.locator("#__eyes_suggestion_host__");

    // 1. Free-text output repetition: 3 pastes (waiting >300ms before clear so change/blur don't double-count)
    await dispatchPaste(page, 'textarea[name="customer_reply"]', SAMPLE_REPLY);
    await page.waitForTimeout(350);
    await page.locator("#clear-reply").click();
    await expect(popup).toHaveCount(0);

    await dispatchPaste(page, 'textarea[name="customer_reply"]', SAMPLE_REPLY);
    await page.waitForTimeout(350);
    await page.locator("#clear-reply").click();
    await expect(popup).toHaveCount(0);

    await dispatchPaste(page, 'textarea[name="customer_reply"]', SAMPLE_REPLY);
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute("data-eyes-suggestion", "text");

    const textPopupState = await popup.evaluate((host) => {
      const shadow = host.shadowRoot!;
      return {
        product: shadow.querySelector(".product")?.textContent?.trim(),
        hasBrandMark: Boolean(shadow.querySelector("[data-eyes-brand-mark]")),
        hasAiBadge: Boolean(shadow.querySelector(".top .ai")),
        hasEyebrow: Boolean(shadow.querySelector(".eyebrow")),
        headerText: shadow.querySelector(".top")?.textContent?.replace(/\s+/g, " ").trim(),
        hasLoopArc: Boolean(shadow.querySelector(".loop-arc")),
        headline: shadow.querySelector("h2")?.textContent?.trim(),
        hasReplay: Boolean(shadow.querySelector("[data-eyes-replay], video")),
        userFlowHead: shadow.querySelector('[data-eyes-flow="user"] .flow-head')?.textContent?.trim(),
        proposedFlowHead: shadow.querySelector('[data-eyes-flow="proposed"] .flow-head')?.textContent?.trim(),
        userNodes: Array.from(shadow.querySelectorAll('[data-eyes-flow="user"] .flow-node')).map(
          (n) => n.textContent?.trim()
        ),
        proposedNodes: Array.from(
          shadow.querySelectorAll('[data-eyes-flow="proposed"] .flow-node')
        ).map((n) => n.textContent?.trim()),
      };
    });

    expect(textPopupState.product).toBe("Eyes");
    expect(textPopupState.hasBrandMark).toBe(true);
    expect(textPopupState.hasAiBadge).toBe(false);
    expect(textPopupState.hasEyebrow).toBe(false);
    expect(textPopupState.headerText).not.toContain("AI");
    expect(textPopupState.hasLoopArc).toBe(true);
    expect(textPopupState.headline).toContain("snippet");
    expect(textPopupState.hasReplay).toBe(false);
    expect(textPopupState.userFlowHead).toContain("Your flow");
    expect(textPopupState.proposedFlowHead).toContain("Eyes flow");
    expect(textPopupState.userNodes.length).toBe(4);
    expect(textPopupState.proposedNodes.length).toBe(4);

    // Dismiss the text suggestion popup via Shadow DOM button
    await popup.evaluate((host) => {
      (host.shadowRoot!.querySelector("[data-eyes-dismiss]") as HTMLButtonElement).click();
    });
    await expect(popup).toHaveCount(0);

    // 2. Automatable repeated click: 3 clicks on "Copy reference" -> shows Playwright sandbox MP4 + both DAG flows
    const copyBtn = page.locator("#copy-invoice");
    await copyBtn.click();
    await expect(popup).toHaveCount(0);
    await copyBtn.click();
    await expect(popup).toHaveCount(0);
    await copyBtn.click();

    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute("data-eyes-suggestion", "click");

    // Wait for video element to load and decode metadata from chrome-extension://<id>/dist/replay-demo.mp4
    await expect
      .poll(() =>
        popup.evaluate((host) => {
          const video = host.shadowRoot?.querySelector("video");
          return video ? { readyState: video.readyState, width: video.videoWidth, hasError: Boolean(video.error) } : null;
        })
      )
      .toMatchObject({ hasError: false });
    await expect
      .poll(() =>
        popup.evaluate((host) => host.shadowRoot?.querySelector("video")?.videoWidth ?? 0)
      )
      .toBeGreaterThan(0);

    const popupBox = await popup.boundingBox();
    const viewport = page.viewportSize();
    expect(popupBox).not.toBeNull();
    if (popupBox && viewport) {
      expect(popupBox.x).toBeGreaterThanOrEqual(0);
      expect(popupBox.y).toBeGreaterThanOrEqual(0);
      expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(viewport.width);
      expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(viewport.height);
    }

    const clickPopupState = await popup.evaluate((host) => {
      const shadow = host.shadowRoot!;
      const video = shadow.querySelector("video");
      return {
        product: shadow.querySelector(".product")?.textContent?.trim(),
        hasAiBadge: Boolean(shadow.querySelector(".top .ai")),
        headerText: shadow.querySelector(".top")?.textContent?.replace(/\s+/g, " ").trim(),
        headline: shadow.querySelector("h2")?.textContent?.trim(),
        videoSrc: video?.getAttribute("src") ?? "",
        replayCaption: shadow.querySelector(".replay-caption")?.textContent?.replace(/\s+/g, " ").trim(),
        userFlowHead: shadow.querySelector('[data-eyes-flow="user"] .flow-head')?.textContent?.trim(),
        proposedFlowHead: shadow.querySelector('[data-eyes-flow="proposed"] .flow-head')?.textContent?.trim(),
        userNodes: Array.from(shadow.querySelectorAll('[data-eyes-flow="user"] .flow-node')).map(
          (n) => n.textContent?.trim()
        ),
        proposedNodes: Array.from(
          shadow.querySelectorAll('[data-eyes-flow="proposed"] .flow-node')
        ).map((n) => n.textContent?.trim()),
      };
    });

    expect(clickPopupState.product).toBe("Eyes");
    expect(clickPopupState.hasAiBadge).toBe(false);
    expect(clickPopupState.headerText).not.toContain("AI");
    expect(clickPopupState.headline).toBe('Automate "Copy reference"?');
    expect(clickPopupState.videoSrc).toMatch(/^chrome-extension:\/\/.*\/dist\/replay-demo\.mp4$/);
    expect(clickPopupState.replayCaption).toBe("Automation replay");
    expect(clickPopupState.userFlowHead).toContain("Your flow");
    expect(clickPopupState.proposedFlowHead).toContain("Eyes flow");
    expect(clickPopupState.userNodes.length).toBe(4);
    expect(clickPopupState.proposedNodes.length).toBe(3);

    // Click "Trial it live" and verify confirmation state
    await popup.evaluate((host) => {
      (host.shadowRoot!.querySelector("[data-eyes-primary]") as HTMLButtonElement).click();
    });
    const successText = await popup.evaluate((host) =>
      host.shadowRoot?.querySelector("[data-eyes-success]")?.textContent?.replace(/\s+/g, " ").trim()
    );
    expect(successText).toContain("Trial started.");
  } finally {
    await context.close().catch(() => {});
    await demoServer.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});
