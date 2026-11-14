import { executeStep } from "./hands/execute.js";
import type { ActionScript, BindingValue, DomStep, Step, StepResult } from "./types.js";
import type { Event } from "@gen/shared";
import { sanitizeUrl } from "./privacy.ts";
import {
  createDefaultOptimizations,
  LIBRARY_STORAGE_KEY,
  recordOptimizationRun,
  upsertOptimizationItem,
  type OptimizationItem,
} from "./library.ts";

const SERVER_URL = "http://localhost:8787";
const BATCH_INTERVAL_MS = 300;
const MAX_BATCH_SIZE = 40;

const DEMO_SCRIPT: ActionScript = {
  name: "Demo",
  steps: [
    { action: "insertText", value: "Step 1: Hello" },
    { action: "wait", ms: 300 },
    { action: "insertText", value: " -> Step 2: from Hands" },
  ],
};

interface ClipboardState {
  fromApp: string;
  fromUrl?: string;
  fromCell?: string;
  text?: string;
  textHash?: string;
  copiedAt: number;
}

interface ChromeRuntimeMessage {
  kind?: string;
  event?: Event;
  script?: ActionScript;
  id?: string;
  item?: OptimizationItem;
  recordRun?: boolean;
}

interface ChromeTab {
  id?: number;
  url?: string;
  title?: string;
}

interface ChromeApi {
  runtime?: {
    onMessage?: {
      addListener: (
        cb: (
          msg: ChromeRuntimeMessage,
          sender: { tab?: { id?: number }; frameId?: number },
          sendResponse: (res?: unknown) => void
        ) => boolean
      ) => void;
    };
  };
  tabs?: {
    get: (tabId: number) => Promise<ChromeTab>;
    query?: (queryInfo: { active?: boolean; currentWindow?: boolean }) => Promise<ChromeTab[]>;
    sendMessage?: (
      tabId: number,
      message: unknown,
      options?: { frameId?: number }
    ) => Promise<unknown>;
    onActivated?: {
      addListener: (cb: (activeInfo: { tabId: number; windowId: number }) => void) => void;
    };
    onUpdated?: {
      addListener: (
        cb: (tabId: number, changeInfo: { status?: string; url?: string }, tab: ChromeTab) => void
      ) => void;
    };
  };
  sidePanel?: {
    setPanelBehavior?: (opts: { openPanelOnActionClick: boolean }) => Promise<void>;
  };
  storage?: {
    local?: {
      get: (keys?: string | string[] | null) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
    };
  };
}

let lastClipboard: ClipboardState | null = null;
let lastActiveTab: { tabId: number; app: string; url?: string; title?: string } | null = null;
const lastFieldFrameByTab = new Map<number, number>();
const eventQueue: Event[] = [];
const recentEvents: Event[] = [];
const countsByType: Record<string, number> = {};
let totalEvents = 0;
let totalBytes = 0;
const startedAt = Date.now();

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "evt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
}

export function recordEvent(evt: Event): void {
  if ((evt.type === "copy" || evt.type === "cut") && evt.clipboard) {
    lastClipboard = {
      fromApp: evt.clipboard.fromApp || evt.app,
      fromUrl: evt.clipboard.fromUrl || evt.url,
      fromCell: evt.clipboard.fromCell,
      text: evt.clipboard.text,
      textHash: evt.clipboard.textHash,
      copiedAt: evt.ts,
    };
  } else if (evt.type === "paste" && lastClipboard) {
    evt.clipboard = {
      fromApp: lastClipboard.fromApp,
      fromUrl: lastClipboard.fromUrl,
      fromCell: lastClipboard.fromCell,
      toApp: evt.app,
      text: evt.clipboard?.text || lastClipboard.text,
      textHash: evt.clipboard?.textHash || lastClipboard.textHash,
      timeSinceCopyMs: Math.max(0, evt.ts - lastClipboard.copiedAt),
    };
  }

  const serialized = JSON.stringify(evt);
  totalEvents++;
  totalBytes += serialized.length + 1;
  countsByType[evt.type] = (countsByType[evt.type] || 0) + 1;

  recentEvents.push(evt);
  if (recentEvents.length > 100) recentEvents.shift();

  eventQueue.push(evt);
  if (eventQueue.length >= MAX_BATCH_SIZE) {
    void flushQueue();
  }
}

export async function flushQueue(): Promise<void> {
  if (eventQueue.length === 0) return;
  const batch = eventQueue.splice(0, eventQueue.length);
  try {
    await fetch(`${SERVER_URL}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
  } catch {
    // Server offline or unreachable
  }
}

setInterval(() => {
  void flushQueue();
}, BATCH_INTERVAL_MS);

const chromeApi = (globalThis as Record<string, unknown>).chrome as ChromeApi | undefined;

let cachedLibrary: OptimizationItem[] | null = null;

async function loadLibrary(): Promise<OptimizationItem[]> {
  if (cachedLibrary) return cachedLibrary;
  try {
    const stored = await chromeApi?.storage?.local?.get(LIBRARY_STORAGE_KEY);
    const raw = stored?.[LIBRARY_STORAGE_KEY];
    if (Array.isArray(raw) && raw.length > 0) {
      cachedLibrary = raw as OptimizationItem[];
      return cachedLibrary;
    }
  } catch {
    // ignore storage read error
  }
  const defaults = createDefaultOptimizations();
  await saveLibrary(defaults);
  return defaults;
}

async function saveLibrary(items: OptimizationItem[]): Promise<OptimizationItem[]> {
  cachedLibrary = items;
  try {
    await chromeApi?.storage?.local?.set({ [LIBRARY_STORAGE_KEY]: items });
  } catch {
    // ignore storage write error
  }
  return items;
}

async function resolveTargetTabId(senderTabId?: number): Promise<number | undefined> {
  if (senderTabId !== undefined) return senderTabId;
  try {
    const activeTabs = await chromeApi?.tabs?.query?.({ active: true, currentWindow: true });
    const active = activeTabs?.[0];
    if (active?.id !== undefined && active.url && /^(https?|file):/i.test(active.url)) {
      return active.id;
    }
  } catch {
    // ignore tab query errors
  }
  return lastActiveTab?.tabId;
}

async function runOptimizationOnTab(
  item: OptimizationItem,
  tabId?: number
): Promise<{ ok: boolean; appliedToPage: boolean; note: string }> {
  if (item.snippetText) {
    if (tabId !== undefined && chromeApi?.tabs?.sendMessage) {
      const frameId = lastFieldFrameByTab.get(tabId);
      try {
        const res = (await chromeApi.tabs.sendMessage(
          tabId,
          { kind: "HANDS_INSERT_LAST_FIELD", text: item.snippetText, requireResponse: true },
          frameId !== undefined ? { frameId } : undefined
        )) as { ok?: boolean } | undefined;
        if (res?.ok) {
          return { ok: true, appliedToPage: true, note: "Inserted into active field" };
        }
      } catch {
        // fall through to clipboard fallback in panel
      }
    }
    return { ok: true, appliedToPage: false, note: "Copied to clipboard" };
  }

  if (item.script) {
    if (tabId === undefined) {
      return { ok: false, appliedToPage: false, note: "Open a matching page to run this flow" };
    }
    try {
      await runActionScript(tabId, item.script);
      return { ok: true, appliedToPage: true, note: "Completed on current page" };
    } catch {
      return { ok: false, appliedToPage: false, note: "Open a matching page to run this flow" };
    }
  }

  return { ok: true, appliedToPage: false, note: "Completed" };
}

if (chromeApi?.runtime?.onMessage) {
  chromeApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.kind === "EYES_EVENT" && msg.event) {
      recordEvent(msg.event);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.kind === "EYES_GET_LIBRARY") {
      void loadLibrary().then((items) => sendResponse({ ok: true, items }));
      return true;
    }
    if (msg?.kind === "EYES_UPSERT_OPTIMIZATION" && msg.item) {
      const incoming = msg.item;
      void loadLibrary()
        .then((items) => saveLibrary(upsertOptimizationItem(items, incoming)))
        .then((items) => sendResponse({ ok: true, items }));
      return true;
    }
    if (msg?.kind === "EYES_ACTIVATE_OPTIMIZATION" && (msg.id || msg.item)) {
      const incoming = msg.item;
      const targetId = msg.id ?? incoming?.id;
      const shouldRecordRun = Boolean(msg.recordRun);
      void loadLibrary()
        .then((items) => {
          let next = incoming
            ? upsertOptimizationItem(items, incoming, { forceActivate: true })
            : items.map((item) =>
                item.id === targetId ? { ...item, status: "active" as const } : item
              );
          if (shouldRecordRun && targetId) {
            next = recordOptimizationRun(next, targetId);
          }
          return saveLibrary(next);
        })
        .then((items) => sendResponse({ ok: true, items }));
      return true;
    }
    if (msg?.kind === "EYES_TOGGLE_OPTIMIZATION" && msg.id) {
      const targetId = msg.id;
      void loadLibrary()
        .then((items) =>
          saveLibrary(
            items.map((item) => {
              if (item.id !== targetId) return item;
              return {
                ...item,
                status: item.status === "active" ? ("paused" as const) : ("active" as const),
              };
            })
          )
        )
        .then((items) => sendResponse({ ok: true, items }));
      return true;
    }
    if (msg?.kind === "EYES_DISMISS_OPTIMIZATION" && msg.id) {
      const targetId = msg.id;
      void loadLibrary()
        .then((items) => saveLibrary(items.filter((item) => item.id !== targetId)))
        .then((items) => sendResponse({ ok: true, items }));
      return true;
    }
    if (msg?.kind === "EYES_RUN_OPTIMIZATION" && msg.id) {
      const targetId = msg.id;
      void (async () => {
        const items = await loadLibrary();
        const found = items.find((item) => item.id === targetId);
        if (!found) {
          sendResponse({ ok: false, error: "Optimization not found", items });
          return;
        }
        const tabId = await resolveTargetTabId(sender.tab?.id);
        const exec = await runOptimizationOnTab(found, tabId);
        if (!exec.ok) {
          sendResponse({ ok: false, error: exec.note, items });
          return;
        }
        const updated = await saveLibrary(recordOptimizationRun(items, targetId));
        sendResponse({
          ok: true,
          appliedToPage: exec.appliedToPage,
          note: exec.note,
          items: updated,
        });
      })();
      return true;
    }
    if (msg?.kind === "HANDS_FIELD_FOCUSED") {
      if (sender.tab?.id !== undefined && sender.frameId !== undefined) {
        lastFieldFrameByTab.set(sender.tab.id, sender.frameId);
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.kind === "HANDS_RUN_SCRIPT" && msg.script) {
      const tabId = sender.tab?.id ?? lastActiveTab?.tabId;
      if (tabId === undefined) {
        sendResponse({ ok: false, error: "No active tab" });
        return false;
      }
      void runActionScript(tabId, msg.script)
        .then((results) => sendResponse({ ok: true, results }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "Hands script failed",
          })
        );
      return true;
    }
    if (msg?.kind === "HANDS_RUN_DEMO") {
      const tabId = sender.tab?.id ?? lastActiveTab?.tabId;
      if (tabId === undefined) {
        sendResponse({ ok: false, error: "No active tab" });
        return false;
      }
      void runActionScript(tabId, DEMO_SCRIPT)
        .then((results) => sendResponse({ ok: true, results }))
        .catch((error: unknown) =>
          sendResponse({ ok: false, error: error instanceof Error ? error.message : "Hands demo failed" })
        );
      return true;
    }
    if (msg?.kind === "EYES_GET_STATS") {
      const elapsedMin = Math.max(0.01, (Date.now() - startedAt) / 60000);
      sendResponse({
        totalEvents,
        totalBytes,
        eventsPerMin: Math.round(totalEvents / elapsedMin),
        bytesPerMin: Math.round(totalBytes / elapsedMin),
        countsByType,
        recentEvents: recentEvents.slice(-25),
      });
      return false;
    }
    return false;
  });
}

if (chromeApi?.tabs?.onActivated) {
  const tabsApi = chromeApi.tabs;
  chromeApi.tabs.onActivated.addListener((activeInfo) => {
    void (async () => {
      try {
        const tab = await tabsApi.get(activeInfo.tabId);
        if (!tab?.url || tab.url.startsWith("chrome://")) return;
        const cleanUrl = sanitizeUrl(tab.url).url;
        const host = new URL(tab.url).hostname || "local-page";
        const prevApp = lastActiveTab?.app;
        lastActiveTab = { tabId: activeInfo.tabId, app: host, url: cleanUrl, title: tab.title };

        recordEvent({
          v: 1,
          id: uuid(),
          ts: Date.now(),
          session: "sess_browser",
          source: "browser",
          app: host,
          window: tab.title,
          url: cleanUrl,
          type: "tab_switch",
          meta: {
            subType: prevApp && prevApp !== host ? "cross_app_switch" : "same_app_switch",
            fromApp: prevApp,
            toApp: host,
          },
        });
      } catch {
        // ignore tab lookup errors
      }
    })();
  });
}

if (chromeApi?.tabs?.onUpdated) {
  chromeApi.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab?.url && !tab.url.startsWith("chrome://")) {
      const cleanUrl = sanitizeUrl(tab.url).url;
      let host = "local-page";
      try {
        host = new URL(tab.url).hostname || "local-page";
      } catch {
        // ignore
      }
      recordEvent({
        v: 1,
        id: uuid(),
        ts: Date.now(),
        session: "sess_browser",
        source: "browser",
        app: host,
        window: tab.title,
        url: cleanUrl,
        type: "nav",
      });
    }
  });
}

if (chromeApi?.sidePanel?.setPanelBehavior) {
  chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

function injectHandsIntoOpenTabs(): void {
  if (typeof chrome === "undefined" || !chrome.tabs?.query || !chrome.scripting?.executeScript) {
    return;
  }
  void chrome.tabs
    .query({})
    .then((tabs) => {
      for (const tab of tabs) {
        if (tab.id === undefined || !tab.url || !/^(https?|file):/i.test(tab.url)) continue;
        void chrome.scripting
          .executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ["dist/content.js"],
          })
          .catch(() => {
            // Restricted or discarded tab
          });
      }
    })
    .catch(() => {});
}

if (typeof chrome !== "undefined") {
  chrome.runtime?.onInstalled?.addListener(() => {
    injectHandsIntoOpenTabs();
  });
  injectHandsIntoOpenTabs();
}

async function runActionScript(tabId: number, script: ActionScript): Promise<StepResult[]> {
  const bindings: Record<string, BindingValue> = {};
  return runSteps(tabId, script.steps, bindings, {});
}

async function runSteps(
  tabId: number,
  steps: Step[],
  bindings: Record<string, BindingValue>,
  scope: Record<string, unknown>,
): Promise<StepResult[]> {
  const results: StepResult[] = [];

  for (const rawStep of steps) {
    let step: Step;
    try {
      step = substitute(rawStep, { ...bindings, ...scope }) as Step;
    } catch (error) {
      if (rawStep.optional) continue;
      throw error;
    }

    try {
      if (step.action === "navigate") {
        await chrome.tabs.update(tabId, { url: step.url });
        await waitForTabLoad(tabId);
        results.push({ ok: true, url: step.url });
        continue;
      }

      if (step.action === "wait") {
        await sleep(step.ms);
        results.push({ ok: true, url: "" });
        continue;
      }

      if (step.action === "forEach") {
        const items = Array.isArray(step.items) ? step.items : bindings[step.items];
        if (!Array.isArray(items)) throw new Error(`No array binding: ${step.items}`);
        for (const item of items) {
          const nested = await runSteps(tabId, step.steps, bindings, { ...scope, ...item, item });
          results.push(...nested);
        }
        continue;
      }

      const result = await executeDomStep(tabId, step);
      results.push(result);
      if (!result.ok) {
        if (step.optional) continue;
        throw new Error(result.error ?? "Step failed");
      }

      if (step.action === "readText" || step.action === "readValue") {
        bindings[step.bind] = result.value ?? "";
      }

      if (step.action === "extractList") {
        bindings[step.bind] = result.items ?? [];
      }
    } catch (error) {
      if (step.optional) continue;
      throw error;
    }
  }

  return results;
}

async function executeDomStep(tabId: number, step: DomStep): Promise<StepResult> {
  const knownFrameId = lastFieldFrameByTab.get(tabId);
  const target =
    knownFrameId !== undefined && !("target" in step && step.target)
      ? { tabId, frameIds: [knownFrameId] }
      : { tabId };
  const [injection] = await chrome.scripting.executeScript({
    target,
    func: executeStep,
    args: [step],
  });
  if (!injection?.result) throw new Error("Executor returned no result");
  return injection.result;
}

function substitute<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === "string") return substituteString(value, vars) as T;
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars)) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = substitute(child, vars);
    }
    return result as T;
  }
  return value;
}

function substituteString(value: string, vars: Record<string, unknown>): unknown {
  const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
  if (whole) return lookup(vars, whole[1]);
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    const found = lookup(vars, path);
    return found === undefined ? "" : String(found);
  });
}

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let current: unknown = vars;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for page load")), 30000);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish();
      })
      .catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error("Failed to read tab"));
      });
  });
}
