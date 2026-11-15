import fs from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionScript, Step } from "./hands/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");
const executeTsPath = path.join(rootDir, "extension", "src", "hands", "execute.ts");
const fallbackDemoWebmPath = path.join(rootDir, "extension", "assets", "replay-demo.webm");

let cachedExecuteJs: string | null = null;

function getExecuteStepBundle(): string {
  if (cachedExecuteJs !== null) return cachedExecuteJs;
  const raw = fs.readFileSync(executeTsPath, "utf8");
  const stripped = stripTypeScriptTypes(raw, { mode: "strip" })
    .replace(/import\s+type\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?/g, "")
    .replace(/export\s+/g, "");
  cachedExecuteJs = `${stripped}
window.__EYES_WATCH_MODE__ = true;
window.__EYES_REPLAY_REQUIRE_VISIBLE__ = true;
window.__EYES_EXECUTE_STEP__ = executeStep;
window.__EYES_CLEAR_ANNOTATION__ = function() {
  try {
    var prev = document.querySelectorAll('[data-eyes-highlighted="true"]');
    for (var i = 0; i < prev.length; i++) {
      prev[i].removeAttribute("data-eyes-highlighted");
    }
    var box = document.getElementById("__eyes_watch_highlight__");
    if (box && box.parentNode) {
      box.parentNode.removeChild(box);
    }
  } catch (e) {}
};
window.__EYES_ANNOTATE_STEP__ = function(label) {
  try {
    var highlighted = document.querySelector('[data-eyes-highlighted="true"]');
    var box = document.getElementById("__eyes_watch_highlight__");
    var isValidTarget = Boolean(
      highlighted &&
      highlighted !== document.body &&
      highlighted !== document.documentElement &&
      highlighted.isConnected !== false
    );
    if (isValidTarget && typeof highlighted.scrollIntoView === "function") {
      highlighted.scrollIntoView({ block: "center", inline: "nearest" });
    }
    var rect =
      isValidTarget && typeof highlighted.getBoundingClientRect === "function"
        ? highlighted.getBoundingClientRect()
        : null;
    var hasVisibleRect = Boolean(
      rect &&
      rect.width > 0 &&
      rect.height > 0 &&
      (typeof highlighted.getClientRects !== "function" || highlighted.getClientRects().length > 0)
    );
    if (isValidTarget && hasVisibleRect && box && rect) {
      box.style.top = Math.max(0, rect.top - 4) + "px";
      box.style.left = Math.max(0, rect.left - 4) + "px";
      box.style.width = Math.max(0, rect.width + 8) + "px";
      box.style.height = Math.max(0, rect.height + 8) + "px";
      box.style.border = "2.5px solid #8a5a2b";
      box.style.background = "rgba(138, 90, 43, 0.14)";
      box.style.boxShadow = "0 0 0 3px rgba(138, 90, 43, 0.18)";
      box.style.transition = "none";
    } else {
      if (highlighted) highlighted.removeAttribute("data-eyes-highlighted");
      if (box && box.parentNode) box.parentNode.removeChild(box);
    }
    if (label && document.documentElement) {
      var banner = document.getElementById("__eyes_sandbox_banner__");
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "__eyes_sandbox_banner__";
        banner.setAttribute("data-eyes-ui", "true");
        banner.style.cssText =
          "position:fixed;bottom:10px;left:10px;z-index:2147483647;padding:5px 10px;" +
          "border-radius:6px;background:rgba(23,22,20,0.92);color:#faf8f4;" +
          "border:1px solid #8a5a2b;font:600 12px/1.3 system-ui,-apple-system,sans-serif;" +
          "box-shadow:0 4px 12px rgba(0,0,0,0.28);pointer-events:none;";
        document.documentElement.appendChild(banner);
      }
      banner.textContent = label;
    }
  } catch (e) {}
};
`;
  return cachedExecuteJs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHttpUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

function isReachableReplayUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    // Skip synthetic test-only domains (.local, .example, .invalid, .test)
    if (
      host.endsWith(".local") ||
      host.endsWith(".example") ||
      host.endsWith(".invalid") ||
      host.endsWith(".test")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function substituteVars<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
      const resolved = vars[key];
      if (typeof resolved === "string" || typeof resolved === "number") {
        return String(resolved);
      }
      return key;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteVars(item, vars)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteVars(v, vars);
    }
    return out as T;
  }
  return value;
}

function describeStepLabel(step: Step): string {
  switch (step.action) {
    case "fill":
    case "insertText": {
      const val = typeof step.value === "string" ? step.value.trim() : "";
      const shortVal = val.length > 28 ? `${val.slice(0, 28)}...` : val;
      return shortVal ? `Fill "${shortVal}"` : "Fill field";
    }
    case "select":
      return `Select "${step.value}"`;
    case "click": {
      const locs = Array.isArray(step.target) ? step.target : step.target ? [step.target] : [];
      const textLoc = locs.find((l) => l.kind === "text" || l.kind === "aria");
      if (textLoc) {
        const cleaned = textLoc.value.replace(/^[a-z]+\[name=["']?|["']?\]$/gi, "").trim();
        if (cleaned) return `Click "${cleaned.slice(0, 28)}"`;
      }
      return "Click target";
    }
    case "pressKey":
      return `Press ${step.key}`;
    case "readText":
    case "readValue":
      return `Copy ${step.bind}`;
    default:
      return step.action;
  }
}

function normalizeHostKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/:\d+$/, "");
}

function stripWwwPrefix(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

function hostsMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const la = a.trim().toLowerCase();
  const lb = b.trim().toLowerCase();
  if (la === lb) return true;
  const na = normalizeHostKey(la);
  const nb = normalizeHostKey(lb);
  if (na === nb) return true;
  return stripWwwPrefix(na) === stripWwwPrefix(nb);
}

function extractUrlHost(rawUrl?: string): string | undefined {
  if (!isHttpUrl(rawUrl)) return undefined;
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function synthesizeHostOriginUrl(host: string): string | undefined {
  const trimmed = host.trim();
  if (!trimmed) return undefined;
  const bare = normalizeHostKey(trimmed);
  if (!bare.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    return undefined;
  }
  const candidate = `https://${trimmed}/`;
  return isReachableReplayUrl(candidate) ? candidate : undefined;
}

function findUrlForHost(
  host: string,
  hostUrls?: ReadonlyMap<string, string>,
  fallbackUrl?: string,
): string | undefined {
  const targetLower = host.trim().toLowerCase();
  if (!targetLower) return undefined;
  if (hostUrls) {
    const exact = hostUrls.get(targetLower);
    if (isHttpUrl(exact) && isReachableReplayUrl(exact)) return exact;
    const noPort = normalizeHostKey(targetLower);
    const exactNoPort = hostUrls.get(noPort);
    if (isHttpUrl(exactNoPort) && isReachableReplayUrl(exactNoPort)) return exactNoPort;
    for (const [key, value] of hostUrls.entries()) {
      if (hostsMatch(key, targetLower) && isHttpUrl(value) && isReachableReplayUrl(value)) {
        return value;
      }
    }
  }
  if (
    isHttpUrl(fallbackUrl) &&
    isReachableReplayUrl(fallbackUrl) &&
    hostsMatch(extractUrlHost(fallbackUrl), targetLower)
  ) {
    return fallbackUrl;
  }
  return undefined;
}

function findInitialUrl(
  steps: Step[],
  hostUrls?: ReadonlyMap<string, string>,
  fallbackUrl?: string,
): string | undefined {
  const first = steps[0];
  if (!first) return undefined;
  if (first.action === "navigate") {
    return isHttpUrl(first.url) && isReachableReplayUrl(first.url) ? first.url : undefined;
  }
  if (first.action === "switchTab") {
    if (isHttpUrl(first.url) && isReachableReplayUrl(first.url)) {
      return first.url;
    }
    if (first.host) {
      return (
        findUrlForHost(first.host, hostUrls, fallbackUrl) ??
        synthesizeHostOriginUrl(first.host)
      );
    }
    return undefined;
  }
  if (first.action === "forEach") {
    return findInitialUrl(first.steps, hostUrls, fallbackUrl);
  }
  if (isHttpUrl(fallbackUrl) && isReachableReplayUrl(fallbackUrl)) {
    return fallbackUrl;
  }
  return undefined;
}

type ReplayPage = {
  url: () => string;
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  evaluate: <R, A = unknown>(fn: string | ((arg: A) => R | Promise<R>), arg?: A) => Promise<R>;
  waitForLoadState?: (
    state?: "load" | "domcontentloaded" | "networkidle",
    opts?: { timeout?: number },
  ) => Promise<void>;
  video: () => { path: () => Promise<string> } | null;
};

type PlaywrightBrowser = {
  newContext: (opts: Record<string, unknown>) => Promise<{
    addInitScript: (script: { content: string }) => Promise<void>;
    newPage: () => Promise<ReplayPage>;
    close: () => Promise<void>;
  }>;
  close: () => Promise<void>;
};

async function waitForRenderedFrame(page: ReplayPage, settleMs = 0): Promise<void> {
  await Promise.race([
    page
      .evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          }),
      )
      .catch(() => {}),
    sleep(220),
  ]);
  if (settleMs > 0) {
    await sleep(settleMs);
  }
}

function countVisualSteps(steps: Step[]): number {
  let count = 0;
  for (const step of steps) {
    if (step.action === "forEach") {
      count += countVisualSteps(step.steps);
    } else if (step.action !== "navigate" && step.action !== "switchTab" && step.action !== "wait") {
      count += 1;
    }
  }
  return count;
}

let sharedBrowserPromise: Promise<PlaywrightBrowser | null> | null = null;

function resolveFallbackChromePath(): string | undefined {
  const candidates: string[] = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter((r): r is string => Boolean(r));
    for (const root of roots) {
      candidates.push(
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(root, "Chromium", "Application", "chrome.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

async function getSharedBrowser(): Promise<PlaywrightBrowser | null> {
  if (sharedBrowserPromise) return sharedBrowserPromise;
  sharedBrowserPromise = (async () => {
    try {
      const { chromium } = await import("@playwright/test");
      const defaultExec = chromium.executablePath();
      const executablePath = fs.existsSync(defaultExec)
        ? undefined
        : resolveFallbackChromePath();
      const browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
      return browser as unknown as PlaywrightBrowser;
    } catch (err) {
      console.error("[replay-video] failed to launch Playwright browser:", err);
      sharedBrowserPromise = null;
      return null;
    }
  })();
  return sharedBrowserPromise;
}

export function warmReplayBrowser(): void {
  void getSharedBrowser();
}

export interface RecordReplayOptions {
  hostUrls?: ReadonlyMap<string, string>;
  fallbackUrl?: string;
}

const VIDEO_WIDTH = 320;
const VIDEO_HEIGHT = 180;
const VIEWPORT_WIDTH = 640;
const VIEWPORT_HEIGHT = 360;

export async function recordScriptReplay(
  script: ActionScript,
  options: RecordReplayOptions = {},
): Promise<Buffer | null> {
  const steps = script.steps ?? [];
  if (steps.length === 0) return null;
  const firstStep = steps[0];
  if (
    steps.length === 1 &&
    firstStep?.action === "insertText" &&
    !("target" in firstStep && firstStep.target)
  ) {
    return null;
  }

  const initialUrl = findInitialUrl(steps, options.hostUrls, options.fallbackUrl);
  if (!initialUrl) return null;

  const browser = await getSharedBrowser();
  if (!browser) return null;

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "eyes-sandbox-replay-"));
  let context: Awaited<ReturnType<PlaywrightBrowser["newContext"]>> | null = null;

  try {
    context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      recordVideo: { dir: tmpDir, size: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT } },
      permissions: ["clipboard-read", "clipboard-write"],
    });

    await context.addInitScript({ content: getExecuteStepBundle() });

    const page = await context.newPage();
    const video = page.video();
    if (!video) return null;

    const bindings: Record<string, unknown> = {};
    if (Array.isArray(script.params)) {
      for (const param of script.params) {
        if (!param || typeof param.name !== "string") continue;
        bindings[param.name] =
          typeof param.example === "string" && param.example.trim().length > 0
            ? param.example
            : param.name;
      }
    }

    const formSnapshotsByUrl = new Map<string, Array<{ idx: number; value: string; checked?: boolean }>>();

    const saveFormSnapshot = async (): Promise<void> => {
      const currentUrl = page.url();
      if (!isHttpUrl(currentUrl)) return;
      try {
        const snap = await page.evaluate(() => {
          const controls = Array.from(document.querySelectorAll("input, textarea, select"));
          return controls.map((el, idx) => ({
            idx,
            value: (el as HTMLInputElement).value ?? "",
            checked: (el as HTMLInputElement).checked,
          }));
        });
        formSnapshotsByUrl.set(currentUrl, snap);
      } catch {
        // ignore
      }
    };

    const restoreFormSnapshot = async (url: string): Promise<void> => {
      const snap = formSnapshotsByUrl.get(url);
      if (!snap || snap.length === 0) return;
      try {
        await page.evaluate((entries: Array<{ idx: number; value: string; checked?: boolean }>) => {
          const controls = Array.from(document.querySelectorAll("input, textarea, select"));
          for (const entry of entries) {
            const el = controls[entry.idx] as HTMLInputElement | undefined;
            if (!el) continue;
            if (typeof entry.value === "string" && entry.value.length > 0) {
              el.value = entry.value;
            }
            if (typeof entry.checked === "boolean") {
              el.checked = entry.checked;
            }
          }
        }, snap);
      } catch {
        // ignore
      }
    };

    const visualStepCount = Math.max(1, countVisualSteps(steps));
    const paceScale = visualStepCount > 8 ? 8 / visualStepCount : 1;
    const navSettleMs = 150;
    const preStepSettleMs = Math.max(100, Math.round(160 * paceScale));
    const postReadSettleMs = Math.max(100, Math.round(160 * paceScale));
    const postActionSettleMs = Math.max(140, Math.round(240 * paceScale));
    const endSettleMs = 260;

    const navigateTo = async (targetUrl: string): Promise<boolean> => {
      if (!isHttpUrl(targetUrl) || !isReachableReplayUrl(targetUrl)) return false;
      if (page.url() === targetUrl) return true;
      await saveFormSnapshot();
      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 3500 });
        await restoreFormSnapshot(page.url());
        await waitForRenderedFrame(page, navSettleMs);
        return true;
      } catch {
        return false;
      }
    };

    const firstIsNav =
      steps[0]?.action === "navigate" || steps[0]?.action === "switchTab";
    if (!firstIsNav) {
      const ok = await navigateTo(initialUrl);
      if (!ok) return null;
    }

    const clearAnnotationOnPage = async (): Promise<void> => {
      await page
        .evaluate(() => {
          const w = window as unknown as { __EYES_CLEAR_ANNOTATION__?: () => void };
          w.__EYES_CLEAR_ANNOTATION__?.();
        })
        .catch(() => {});
    };

    let shownSteps = 0;
    let skippedSteps = 0;

    // Show the step label with no outline (used when the target cannot be resolved).
    const showLabelOnly = async (stepLabel: string): Promise<void> => {
      await page
        .evaluate((lbl: string) => {
          const w = window as unknown as {
            __EYES_CLEAR_ANNOTATION__?: () => void;
            __EYES_ANNOTATE_STEP__?: (l: string) => void;
          };
          w.__EYES_CLEAR_ANNOTATION__?.();
          w.__EYES_ANNOTATE_STEP__?.(lbl);
        }, stepLabel)
        .catch(() => {});
      skippedSteps += 1;
      await waitForRenderedFrame(page, preStepSettleMs);
    };

    const runStepList = async (
      stepList: Step[],
      scope: Record<string, unknown>,
    ): Promise<boolean> => {
      for (const rawStep of stepList) {
        const step = substituteVars(rawStep, { ...bindings, ...scope });

        if (step.action === "navigate") {
          const ok = await navigateTo(step.url);
          if (!ok) return false;
          continue;
        }

        if (step.action === "switchTab") {
          if (isHttpUrl(step.url)) {
            if (!isReachableReplayUrl(step.url)) return false;
            const ok = await navigateTo(step.url);
            if (!ok) return false;
          } else if (
            isHttpUrl(page.url()) &&
            hostsMatch(extractUrlHost(page.url()), step.host)
          ) {
            // Already on the target host (e.g., previous link click navigated here)
          } else {
            const candidateUrl =
              findUrlForHost(step.host, options.hostUrls, options.fallbackUrl) ??
              synthesizeHostOriginUrl(step.host);
            if (!candidateUrl) return false;
            const ok = await navigateTo(candidateUrl);
            if (!ok) return false;
          }
          continue;
        }

        if (step.action === "wait") {
          await sleep(Math.min(Math.max(step.ms || 80, 40), 180));
          continue;
        }

        if (step.action === "forEach") {
          let items: Record<string, string>[] = [];
          if (Array.isArray(step.items)) {
            items = step.items;
          } else if (typeof step.items === "string" && Array.isArray(bindings[step.items])) {
            items = bindings[step.items] as Record<string, string>[];
          }
          const previewItems = items.slice(0, 1);
          if (previewItems.length === 0) {
            if (!(await runStepList(step.steps, scope))) return false;
          } else {
            for (const item of previewItems) {
              if (!(await runStepList(step.steps, { ...scope, ...item, item }))) {
                return false;
              }
            }
          }
          continue;
        }

        if (!isHttpUrl(page.url())) {
          return false;
        }

        await page.waitForLoadState?.("domcontentloaded", { timeout: 2000 }).catch(() => {});

        const label = describeStepLabel(step);
        const resolveTimeoutMs =
          "timeoutMs" in step && typeof step.timeoutMs === "number"
            ? step.timeoutMs
            : step.optional
              ? 600
              : 1500;

        // 1. Resolve target with the exact same resolver as the step and outline only that element
        const preRes = await page
          .evaluate(
            async ({ s, stepLabel }: { s: unknown; stepLabel: string }) => {
              const w = window as unknown as {
                __EYES_CLEAR_ANNOTATION__?: () => void;
                __EYES_EXECUTE_STEP__?: (arg: unknown) => Promise<{ ok?: boolean }>;
                __EYES_ANNOTATE_STEP__?: (lbl: string) => void;
              };
              w.__EYES_CLEAR_ANNOTATION__?.();
              if (!w.__EYES_EXECUTE_STEP__) return { ok: false };
              const resolved = await w.__EYES_EXECUTE_STEP__(s);
              if (!resolved?.ok) {
                w.__EYES_CLEAR_ANNOTATION__?.();
                return { ok: false };
              }
              w.__EYES_ANNOTATE_STEP__?.(stepLabel);
              return resolved;
            },
            {
              s: { ...(step as object), resolveOnly: true, timeoutMs: resolveTimeoutMs },
              stepLabel: label,
            },
          )
          .catch(() => ({ ok: false as const }));

        if (!preRes.ok) {
          // Unresolved target: skip this step but keep it visible as a label.
          await showLabelOnly(label);
          continue;
        }

        await waitForRenderedFrame(page, preStepSettleMs);

        // 2. Execute the actual step on the page (waitFor already verified above)
        let navigatedDuringExec = false;
        const res =
          step.action === "waitFor"
            ? preRes
            : await page
                .evaluate(
                  async ({ s, stepLabel }: { s: unknown; stepLabel: string }) => {
                    const w = window as unknown as {
                      __EYES_CLEAR_ANNOTATION__?: () => void;
                      __EYES_EXECUTE_STEP__?: (arg: unknown) => Promise<{
                        ok?: boolean;
                        value?: string;
                        items?: Record<string, string>[];
                      }>;
                      __EYES_ANNOTATE_STEP__?: (lbl: string) => void;
                    };
                    const out = w.__EYES_EXECUTE_STEP__
                      ? await w.__EYES_EXECUTE_STEP__(s)
                      : { ok: false };
                    if (!out?.ok) {
                      w.__EYES_CLEAR_ANNOTATION__?.();
                      return out;
                    }
                    w.__EYES_ANNOTATE_STEP__?.(stepLabel);
                    return out;
                  },
                  { s: step, stepLabel: label },
                )
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  if (
                    (step.action === "click" || step.action === "pressKey") &&
                    (msg.includes("Execution context was destroyed") ||
                      msg.includes("Cannot find context"))
                  ) {
                    navigatedDuringExec = true;
                    return { ok: true as const };
                  }
                  return { ok: false as const };
                });

        if (!res.ok) {
          await showLabelOnly(label);
          continue;
        }
        shownSteps += 1;

        if (navigatedDuringExec) {
          await page.waitForLoadState?.("domcontentloaded", { timeout: 2500 }).catch(() => {});
        }

        if (
          (step.action === "readText" || step.action === "readValue") &&
          "value" in res &&
          typeof res.value === "string"
        ) {
          bindings[step.bind] = res.value;
        } else if (step.action === "extractList" && "items" in res && Array.isArray(res.items)) {
          bindings[step.bind] = res.items;
        }

        const postSettleMs =
          step.action === "readText" || step.action === "readValue"
            ? postReadSettleMs
            : postActionSettleMs;
        await waitForRenderedFrame(page, postSettleMs);
      }
      return true;
    };

    await runStepList(steps, {});
    if (shownSteps === 0) return null;
    if (skippedSteps > 0) {
      console.warn(`[replay-video] ${skippedSteps} step(s) shown label-only, ${shownSteps} outlined (target not found)`);
    }
    await waitForRenderedFrame(page, endSettleMs);

    await context.close();
    context = null;

    const videoPath = await video.path();
    const info = await stat(videoPath);
    if (info.size < 512) return null;
    return await readFile(videoPath);
  } catch (err) {
    console.error("[replay-video] failed to record script replay:", err);
    return null;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function readFallbackDemoVideo(): Promise<Buffer | null> {
  try {
    return await readFile(fallbackDemoWebmPath);
  } catch {
    return null;
  }
}
