import { executeStep } from "./hands/execute.js";
import type { V2DomStep } from "./hands/execute.js";
import type { ActionScript, BindingValue, Locator, ScriptParam, StepResult } from "./types.js";
import type { Event } from "@gen/shared";
import type { LibraryEntry } from "@gen/shared/schema.ts";
import { rememberLocalPii, restoreLocalPiiText, sanitizeUrl } from "./privacy.ts";
import { createSuggestionEngine, type SuggestionEngine, type TextCluster } from "./suggestion.ts";
import {
  createDefaultOptimizations,
  LIBRARY_STORAGE_KEY,
  libraryEntryToOptimization,
  mergeServerAndLocalOptimizations,
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

type V2Step =
  | V2DomStep
  | { action: "navigate"; url: string; optional?: boolean }
  | { action: "wait"; ms: number; optional?: boolean }
  | { action: "switchTab"; host?: string; url?: string; optional?: boolean }
  | {
      action: "forEach";
      items: Record<string, string>[] | string;
      steps: V2Step[];
      optional?: boolean;
    };

type V2ActionScript = {
  name?: string;
  steps: V2Step[];
  pauseBeforeSubmit?: boolean;
  runMode?: "run_remaining" | "save_only";
  params?: ScriptParam[];
  pageSummary?: unknown;
};

interface ChromeRuntimeMessage {
  kind?: string;
  event?: Event;
  localPii?: Record<string, string>;
  script?: V2ActionScript;
  id?: string;
  item?: OptimizationItem;
  recordRun?: boolean;
  name?: string;
  solution?: string;
  context?: Record<string, unknown>;
  value?: string;
  scopeKey?: string;
  appHost?: string;
}

interface ChromeTab {
  id?: number;
  url?: string;
  title?: string;
  status?: string;
  active?: boolean;
  windowId?: number;
  lastAccessed?: number;
}

interface ChromeApi {
  runtime?: {
    onMessage?: {
      addListener: (
        cb: (
          msg: ChromeRuntimeMessage,
          sender: { tab?: { id?: number; url?: string }; frameId?: number },
          sendResponse: (res?: unknown) => void
        ) => boolean
      ) => void;
    };
  };
  tabs?: {
    get: (tabId: number) => Promise<ChromeTab>;
    query?: (queryInfo: { active?: boolean; currentWindow?: boolean; url?: string }) => Promise<ChromeTab[]>;
    create?: (createProperties: { url?: string; active?: boolean }) => Promise<ChromeTab>;
    update?: (tabId: number, updateProperties: { url?: string; active?: boolean }) => Promise<ChromeTab>;
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
      removeListener?: (
        cb: (tabId: number, changeInfo: { status?: string; url?: string }, tab: ChromeTab) => void
      ) => void;
    };
  };
  windows?: {
    update?: (windowId: number, updateInfo: { focused?: boolean }) => Promise<unknown>;
  };
  scripting?: {
    executeScript?: {
      <TArgs extends unknown[], TResult>(injection: {
        target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
        func: (...args: TArgs) => TResult | Promise<TResult>;
        args?: TArgs;
      }): Promise<Array<{ frameId?: number; result?: Awaited<TResult> }>>;
      (injection: {
        target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
        files: string[];
      }): Promise<Array<{ frameId?: number; result?: unknown }>>;
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
let lastApprovedDecideTabId: number | undefined;
const lastFieldFrameByTab = new Map<number, number>();
const eventQueue: Event[] = [];
const recentEvents: Event[] = [];
const countsByType: Record<string, number> = {};
let totalEvents = 0;
let totalBytes = 0;
const startedAt = Date.now();

const COMMIT_EVENT_TYPES = new Set<Event["type"]>([
  "click",
  "copy",
  "paste",
  "change",
  "submit",
  "tab_switch",
]);

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
  if (COMMIT_EVENT_TYPES.has(evt.type) || eventQueue.length >= MAX_BATCH_SIZE) {
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

const flushTimer = setInterval(() => {
  void flushQueue();
}, BATCH_INTERVAL_MS);
(flushTimer as unknown as { unref?: () => void }).unref?.();

function getChromeApi(): ChromeApi | undefined {
  return (globalThis as Record<string, unknown>).chrome as ChromeApi | undefined;
}

const chromeApi = getChromeApi();

const TEXT_CLUSTERS_STORAGE_KEY = "eyes_text_clusters_v1";
const LOCAL_PII_STORAGE_KEY = "eyes_local_pii_v1";
export const BROWSER_SESSION_ID = "sess_browser_" + Math.random().toString(36).slice(2, 10);

const bgLocalPiiByHash = new Map<string, string>();
let localPiiLoaded = false;

async function ensureLocalPiiLoaded(): Promise<void> {
  if (localPiiLoaded) return;
  localPiiLoaded = true;
  try {
    const stored = await getChromeApi()?.storage?.local?.get(LOCAL_PII_STORAGE_KEY);
    const raw = stored?.[LOCAL_PII_STORAGE_KEY];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [h, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "string" && h) {
          bgLocalPiiByHash.set(h, v);
          rememberLocalPii(h, v);
        }
      }
    }
  } catch {
    // ignore storage read error
  }
}

function recordLocalPiiEntries(entries?: Record<string, string>): void {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;
  let changed = false;
  for (const [hash, rawVal] of Object.entries(entries)) {
    if (typeof rawVal === "string" && hash && bgLocalPiiByHash.get(hash) !== rawVal) {
      bgLocalPiiByHash.set(hash, rawVal);
      rememberLocalPii(hash, rawVal);
      changed = true;
    }
  }
  if (changed) {
    const obj = Object.fromEntries(bgLocalPiiByHash.entries());
    void getChromeApi()?.storage?.local?.set({ [LOCAL_PII_STORAGE_KEY]: obj }).catch(() => {});
  }
}

async function resolveLocalPiiByHash(hash: string): Promise<string | undefined> {
  const cached = bgLocalPiiByHash.get(hash);
  if (cached !== undefined) return cached;
  await ensureLocalPiiLoaded();
  return bgLocalPiiByHash.get(hash);
}

type RunControl = {
  aborted: boolean;
  waiters: Set<() => void>;
};

let activeRunControl: RunControl | null = null;

export function stopHandsRun(): void {
  if (!activeRunControl) return;
  activeRunControl.aborted = true;
  for (const wake of activeRunControl.waiters) {
    wake();
  }
  activeRunControl.waiters.clear();
}

let cachedLibrary: OptimizationItem[] | null = null;
const serverEntriesById = new Map<string, LibraryEntry>();
let persistentSuggestionEngine: SuggestionEngine | null = null;
let suggestionEngineInit: Promise<SuggestionEngine> | null = null;

async function getPersistentSuggestionEngine(): Promise<SuggestionEngine> {
  if (persistentSuggestionEngine) return persistentSuggestionEngine;
  if (suggestionEngineInit) return suggestionEngineInit;
  suggestionEngineInit = (async () => {
    let initialTextClusters: TextCluster[] = [];
    try {
      const stored = await getChromeApi()?.storage?.local?.get(TEXT_CLUSTERS_STORAGE_KEY);
      const raw = stored?.[TEXT_CLUSTERS_STORAGE_KEY];
      if (Array.isArray(raw)) {
        initialTextClusters = raw as TextCluster[];
      }
    } catch {
      // ignore storage read error
    }
    persistentSuggestionEngine = createSuggestionEngine({
      minTextLength: 6,
      initialTextClusters,
      onTextClustersChange: (clusters) => {
        void getChromeApi()?.storage?.local
          ?.set({ [TEXT_CLUSTERS_STORAGE_KEY]: clusters })
          .catch(() => {});
      },
    });
    return persistentSuggestionEngine;
  })();
  return suggestionEngineInit;
}

async function readLocalLibraryRaw(): Promise<OptimizationItem[]> {
  if (cachedLibrary) return cachedLibrary;
  try {
    const stored = await getChromeApi()?.storage?.local?.get(LIBRARY_STORAGE_KEY);
    const raw = stored?.[LIBRARY_STORAGE_KEY];
    if (Array.isArray(raw) && raw.length > 0) {
      cachedLibrary = raw as OptimizationItem[];
      return cachedLibrary;
    }
  } catch {
    // ignore storage read error
  }
  return [];
}

async function fetchServerLibrary(): Promise<LibraryEntry[] | null> {
  try {
    const resp = await fetch(`${SERVER_URL}/library`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { ok?: boolean; items?: LibraryEntry[] };
    if (!data.ok || !Array.isArray(data.items)) return null;
    serverEntriesById.clear();
    for (const entry of data.items) {
      serverEntriesById.set(entry.id, entry);
    }
    return data.items;
  } catch {
    return null;
  }
}

async function loadLibrary(syncServer = false): Promise<OptimizationItem[]> {
  const localRaw = await readLocalLibraryRaw();
  if (syncServer) {
    const serverEntries = await fetchServerLibrary();
    if (serverEntries !== null) {
      const merged = mergeServerAndLocalOptimizations(serverEntries, localRaw);
      await saveLibrary(merged);
      return merged;
    }
  }
  if (localRaw.length > 0) return localRaw;
  const defaults = createDefaultOptimizations();
  await saveLibrary(defaults);
  return defaults;
}

async function saveLibrary(items: OptimizationItem[]): Promise<OptimizationItem[]> {
  cachedLibrary = items;
  try {
    await getChromeApi()?.storage?.local?.set({ [LIBRARY_STORAGE_KEY]: items });
  } catch {
    // ignore storage write error
  }
  return items;
}

export async function resolveTargetTabId(
  senderTab?: number | { id?: number; url?: string },
  senderUrl?: string,
): Promise<number | undefined> {
  const tabId = typeof senderTab === "number" ? senderTab : senderTab?.id;
  const tabUrl = typeof senderTab === "number" ? senderUrl : senderTab?.url;
  if (tabId !== undefined) {
    if (typeof senderTab === "number" && tabUrl === undefined) {
      return tabId;
    }
    if (isRunnablePageUrl(tabUrl)) {
      return tabId;
    }
  }
  const api = getChromeApi();
  if (api?.tabs?.query) {
    try {
      const currentTabs = await api.tabs.query({ active: true, currentWindow: true });
      const currentMatch = currentTabs.find((t) => t.id !== undefined && isRunnablePageUrl(t.url));
      if (currentMatch?.id !== undefined) return currentMatch.id;

      const anyActive = await api.tabs.query({ active: true });
      const anyMatch = anyActive.find((t) => t.id !== undefined && isRunnablePageUrl(t.url));
      if (anyMatch?.id !== undefined) return anyMatch.id;
    } catch {
      // ignore tab query errors
    }
  }
  return lastActiveTab?.tabId;
}

async function runOptimizationOnTab(
  item: OptimizationItem,
  tabId?: number
): Promise<{ ok: boolean; appliedToPage: boolean; note: string }> {
  const api = getChromeApi();
  if (item.snippetText) {
    if (tabId !== undefined && api?.tabs?.sendMessage) {
      const frameId = lastFieldFrameByTab.get(tabId);
      try {
        const res = (await api.tabs.sendMessage(
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

export function handleRuntimeMessage(
  msg: ChromeRuntimeMessage,
  sender: { tab?: { id?: number; url?: string }; frameId?: number },
  sendResponse: (res?: unknown) => void,
): boolean {
  if (getChromeApi()?.runtime?.onMessage) {
    void pollHandsBridge();
  }
  if (msg?.kind === "EYES_EVENT" && msg.event) {
    if (msg.localPii) {
      recordLocalPiiEntries(msg.localPii);
    }
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      lastActiveTab = {
        tabId,
        app: msg.event.app,
        url: msg.event.url,
        title: msg.event.window,
      };
    }
    const stampedMeta =
      tabId !== undefined || msg.event.meta
        ? {
            ...(msg.event.meta ?? {}),
            ...(tabId !== undefined ? { tabId } : {}),
          }
        : undefined;
    const stampedEvent: Event = {
      ...msg.event,
      session: BROWSER_SESSION_ID,
      ...(stampedMeta ? { meta: stampedMeta } : {}),
    };
    recordEvent(stampedEvent);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.kind === "EYES_RECORD_TEXT" && typeof msg.value === "string") {
    const value = msg.value;
    const appHost = typeof msg.appHost === "string" ? msg.appHost : "browser";
    const scopeKey = typeof msg.scopeKey === "string" ? msg.scopeKey : "";
    const fullScope = `${appHost}::${scopeKey}`;
    void getPersistentSuggestionEngine()
      .then((engine) => {
        const suggestion = engine.recordText(value, fullScope);
        sendResponse({ ok: true, suggestion });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.kind === "EYES_GET_LIBRARY") {
    void loadLibrary(true).then((items) => sendResponse({ ok: true, items }));
    return true;
  }
  if (msg?.kind === "EYES_UPSERT_OPTIMIZATION" && msg.item) {
    const incoming = msg.item;
    void loadLibrary()
      .then((items) => saveLibrary(upsertOptimizationItem(items, incoming)))
      .then((items) => sendResponse({ ok: true, items }));
    return true;
  }
  if (msg?.kind === "EYES_AUTO_SAVE_LIBRARY" && msg.script && typeof msg.solution === "string") {
    const payload = {
      name: msg.name,
      solution: msg.solution,
      script: msg.script,
      context: msg.context,
    };
    void flushQueue()
      .then(() =>
        fetch(`${SERVER_URL}/library/auto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      )
      .then(async (resp) => {
        const data = (await resp.json().catch(() => ({ ok: resp.ok }))) as {
          ok?: boolean;
          entry?: LibraryEntry;
        };
        if (data.ok && data.entry) {
          serverEntriesById.set(data.entry.id, data.entry);
          const items = await readLocalLibraryRaw();
          await saveLibrary(
            upsertOptimizationItem(items, libraryEntryToOptimization(data.entry), {
              forceActivate: true,
            })
          );
        }
        sendResponse(data);
      })
      .catch(() => {
        sendResponse({ ok: false });
      });
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
    void (async () => {
      const items = await loadLibrary();
      let nextStatus: "active" | "paused" | undefined;
      const updated = await saveLibrary(
        items.map((item) => {
          if (item.id !== targetId) return item;
          nextStatus = item.status === "active" ? "paused" : "active";
          return { ...item, status: nextStatus };
        })
      );
      const serverEntry = serverEntriesById.get(targetId);
      if (serverEntry && nextStatus) {
        const synced = { ...serverEntry, status: nextStatus, updatedAt: Date.now() };
        serverEntriesById.set(targetId, synced);
        await fetch(`${SERVER_URL}/library`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(synced),
        }).catch(() => {});
      }
      sendResponse({ ok: true, items: updated });
    })();
    return true;
  }
  if (msg?.kind === "EYES_DISMISS_OPTIMIZATION" && msg.id) {
    const targetId = msg.id;
    void (async () => {
      const items = await loadLibrary();
      const updated = await saveLibrary(items.filter((item) => item.id !== targetId));
      serverEntriesById.delete(targetId);
      await fetch(`${SERVER_URL}/library/${encodeURIComponent(targetId)}`, {
        method: "DELETE",
      }).catch(() => {});
      sendResponse({ ok: true, items: updated });
    })();
    return true;
  }
  if (msg?.kind === "EYES_RUN_OPTIMIZATION" && (msg.id || msg.item)) {
    const targetId = msg.id ?? msg.item?.id;
    const fallbackItem = msg.item;
    void (async () => {
      const items = await loadLibrary();
      const found =
        (targetId ? items.find((item) => item.id === targetId) : undefined) ?? fallbackItem;
      if (!found) {
        sendResponse({ ok: false, error: "Optimization not found", items });
        return;
      }
      const tabId = await resolveTargetTabId(sender.tab);
      const exec = await runOptimizationOnTab(found, tabId);
      if (!exec.ok) {
        sendResponse({ ok: false, error: exec.note, items });
        return;
      }
      const baseItems =
        targetId && !items.some((item) => item.id === targetId)
          ? upsertOptimizationItem(items, found, { forceActivate: true })
          : items;
      const updated = targetId
        ? await saveLibrary(recordOptimizationRun(baseItems, targetId))
        : items;
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
  if (msg?.kind === "HANDS_STOP_RUN") {
    stopHandsRun();
    if (sender.tab?.id !== undefined) {
      void sendWatchMessage(sender.tab.id, { kind: "EYES_WATCH_STOP" });
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.kind === "HANDS_RUN_SCRIPT" && msg.script) {
    const targetScript = msg.script;
    void resolveActiveTabId(sender.tab)
      .then((tabId) => {
        if (tabId === undefined) throw new Error("No active tab");
        return runActionScript(tabId, targetScript);
      })
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Hands script failed",
        })
      );
    return true;
  }
  if (msg?.kind === "HANDS_RUN_SERVER_SCRIPT") {
    void resolveActiveTabId(sender.tab)
      .then(async (tabId) => {
        if (tabId === undefined) throw new Error("No active tab");
        const fetched = await fetchAndRunLatestScript(tabId);
        if (!fetched) throw new Error("No compiled action script on server");
        return fetched;
      })
      .then((data) => sendResponse({ ok: true, script: data.script, results: data.results }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Hands server script failed",
        })
      );
    return true;
  }
  if (msg?.kind === "HANDS_RUN_DEMO") {
    void resolveActiveTabId(sender.tab)
      .then((tabId) => {
        if (tabId === undefined) throw new Error("No active tab");
        return runActionScript(tabId, DEMO_SCRIPT);
      })
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
}

if (chromeApi?.runtime?.onMessage) {
  chromeApi.runtime.onMessage.addListener(handleRuntimeMessage);
}

if (chromeApi?.tabs?.onActivated) {
  const tabsApi = chromeApi.tabs;
  chromeApi.tabs.onActivated.addListener((activeInfo) => {
    void (async () => {
      try {
        const tab = await tabsApi.get(activeInfo.tabId);
        if (!tab?.url || !isRunnablePageUrl(tab.url)) return;
        const cleanUrl = sanitizeUrl(tab.url).url;
        const host = new URL(tab.url).hostname || "local-page";
        const prevApp = lastActiveTab?.app;
        lastActiveTab = { tabId: activeInfo.tabId, app: host, url: cleanUrl, title: tab.title };

        recordEvent({
          v: 1,
          id: uuid(),
          ts: Date.now(),
          session: BROWSER_SESSION_ID,
          source: "browser",
          app: host,
          window: tab.title,
          url: cleanUrl,
          type: "tab_switch",
          meta: {
            tabId: activeInfo.tabId,
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
  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab?.url && isRunnablePageUrl(tab.url)) {
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
        session: BROWSER_SESSION_ID,
        source: "browser",
        app: host,
        window: tab.title,
        url: cleanUrl,
        type: "nav",
        meta: { tabId },
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
  void pollHandsBridge();
}

function isRunnablePageUrl(url?: string): boolean {
  return Boolean(url && /^(https?|file):/i.test(url));
}

export async function resolveActiveTabId(
  senderTab?: number | { id?: number; url?: string },
  senderUrl?: string,
): Promise<number | undefined> {
  return resolveTargetTabId(senderTab, senderUrl);
}

async function resolveOpenRunnableTab(): Promise<{ id?: number; url?: string }> {
  const api = getChromeApi();
  if (api?.tabs?.query) {
    try {
      const currentTabs = await api.tabs.query({ active: true, currentWindow: true });
      const currentMatch = currentTabs.find((t) => t.id !== undefined && isRunnablePageUrl(t.url));
      if (currentMatch) return { id: currentMatch.id, url: currentMatch.url };

      const anyActive = await api.tabs.query({ active: true });
      const anyMatch = anyActive.find((t) => t.id !== undefined && isRunnablePageUrl(t.url));
      if (anyMatch) return { id: anyMatch.id, url: anyMatch.url };
    } catch {
      // ignore tab query errors
    }
  }
  if (lastActiveTab) {
    return { id: lastActiveTab.tabId, url: lastActiveTab.url };
  }
  return {};
}

async function sendWatchMessage(tabId: number, message: Record<string, unknown>): Promise<void> {
  const api = getChromeApi();
  if (!api?.tabs?.sendMessage) return;
  try {
    await Promise.resolve(api.tabs.sendMessage(tabId, message, { frameId: 0 }));
  } catch {
    // ignore missing content script in tab or tests
  }
}

function tryHostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function normalizeUrlPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function normalizeLoopbackHost(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower === "127.0.0.1" || lower === "::1" || lower === "[::1]") return "localhost";
  if (lower.startsWith("127.0.0.1:")) return `localhost${lower.slice("127.0.0.1".length)}`;
  if (lower.startsWith("[::1]:")) return `localhost${lower.slice("[::1]".length)}`;
  return lower;
}

function urlsMatchForPrecheck(stepUrl: string, openTabUrl: string): boolean {
  if (stepUrl === openTabUrl) return true;
  try {
    const openParsed = new URL(openTabUrl);
    if (stepUrl.startsWith("/")) {
      return normalizeUrlPath(stepUrl) === normalizeUrlPath(openParsed.pathname);
    }
    const stepParsed = new URL(stepUrl);
    if (
      stepParsed.protocol !== openParsed.protocol ||
      normalizeLoopbackHost(stepParsed.host) !== normalizeLoopbackHost(openParsed.host)
    ) {
      return false;
    }
    if (normalizeUrlPath(stepParsed.pathname) !== normalizeUrlPath(openParsed.pathname)) {
      return false;
    }
    if (stepParsed.search && stepParsed.search !== openParsed.search) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function stepLocatorsForPrecheck(step: {
  target?: Locator | Locator[];
  targets?: Locator[];
  locators?: Locator[];
}): Locator[] {
  const raw: Locator[] = [];
  if (Array.isArray(step.locators)) raw.push(...step.locators);
  if (Array.isArray(step.target)) raw.push(...step.target);
  else if (step.target) raw.push(step.target);
  if (Array.isArray(step.targets)) raw.push(...step.targets);

  const out: Locator[] = [];
  const seen = new Set<string>();
  for (const loc of raw) {
    if (!loc || typeof loc.kind !== "string" || typeof loc.value !== "string") continue;
    if (!loc.value.trim() || loc.value.includes("{{")) continue;
    const key = `${loc.kind}:${loc.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loc);
  }
  return out;
}

type PrecheckStepInput = V2Step & {
  index?: number;
  url?: string;
  host?: string;
  locators?: Locator[];
};

type PrecheckTargetItem = {
  index: number;
  action: string;
  locators: Locator[];
  step: PrecheckStepInput;
};

function collectMatchingPrecheckSteps(
  steps: PrecheckStepInput[],
  openTabUrl: string,
  initialUrl?: string,
): PrecheckTargetItem[] {
  const collected: PrecheckTargetItem[] = [];
  let contextUrl = initialUrl;
  let contextHost = initialUrl ? tryHostFromUrl(initialUrl) : undefined;
  let seqIndex = 0;

  const walk = (list: PrecheckStepInput[]): void => {
    for (const step of list) {
      const currentIdx = typeof step.index === "number" ? step.index : seqIndex;
      seqIndex += 1;

      if (step.action === "navigate") {
        contextUrl = step.url;
        contextHost = tryHostFromUrl(step.url);
        continue;
      }
      if (step.action === "switchTab") {
        contextUrl = step.url;
        contextHost = step.host ?? (step.url ? tryHostFromUrl(step.url) : undefined);
        continue;
      }
      if (step.action === "forEach") {
        walk(step.steps as PrecheckStepInput[]);
        continue;
      }

      const locators = stepLocatorsForPrecheck(step);
      if (locators.length === 0) continue;

      const effectiveUrl = step.url ?? contextUrl;
      const effectiveHost = step.host ?? contextHost;
      let matches = true;
      if (effectiveUrl) {
        matches = urlsMatchForPrecheck(effectiveUrl, openTabUrl);
      } else if (effectiveHost) {
        matches = tabMatchesHost(openTabUrl, effectiveHost);
      }

      if (matches) {
        collected.push({ index: currentIdx, action: step.action, locators, step });
      }
    }
  };

  walk(steps);
  return collected;
}

export interface HandsCommand {
  id?: string;
  kind?: "run" | "decide" | "precheck";
  name?: string;
  solution?: string;
  script?: V2ActionScript;
  steps?: PrecheckStepInput[];
  url?: string;
  pauseBeforeSubmit?: boolean;
  runMode?: "run" | "run_remaining" | "save_only";
  params?: ScriptParam[] | Record<string, string>;
  paramValues?: Record<string, string>;
  primaryLabel?: string;
  pauseNotice?: string;
}

export async function handleHandsCommand(
  cmd: HandsCommand,
  serverUrl = SERVER_URL,
): Promise<void> {
  const api = getChromeApi();

  if (cmd.id && cmd.kind === "decide" && cmd.script && typeof cmd.solution === "string") {
    const decideId = cmd.id;
    const decideName = cmd.name ?? cmd.script.name;
    const decideSolution = cmd.solution;
    const decideScript = cmd.script;
    const pauseBeforeSubmit =
      typeof cmd.pauseBeforeSubmit === "boolean"
        ? cmd.pauseBeforeSubmit
        : decideScript.pauseBeforeSubmit;
    const rawRunMode = cmd.runMode ?? decideScript.runMode;
    const runMode =
      rawRunMode === "save_only"
        ? "save_only"
        : rawRunMode === "run" || rawRunMode === "run_remaining"
          ? "run"
          : undefined;
    const rawParams = Array.isArray(cmd.params)
      ? cmd.params
      : Array.isArray(decideScript.params)
        ? decideScript.params
        : undefined;
    console.log("[eyes-bg] received decide command", decideId, decideName);
    void (async () => {
      let payload: {
        id: string;
        ok: boolean;
        decision?: "approved" | "dismissed";
        params?: Record<string, string>;
        error?: string;
      };
      try {
        const tabId = await resolveActiveTabId();
        console.log("[eyes-bg] decide target tabId =", tabId);
        if (tabId === undefined) throw new Error("No active web tab open");
        if (!api?.tabs?.sendMessage) {
          throw new Error("chrome.tabs.sendMessage unavailable");
        }
        let resolvedParams: ScriptParam[] | undefined;
        if (rawParams && rawParams.length > 0) {
          resolvedParams = await Promise.all(
            rawParams.map(async (p) => {
              if (p.piiHash) {
                const localVal = await resolveLocalPiiByHash(p.piiHash);
                if (localVal !== undefined) {
                  return { ...p, example: localVal };
                }
              }
              return p;
            }),
          );
        }
        const msgPayload = {
          kind: "EYES_SHOW_DECIDER",
          name: decideName,
          solution: decideSolution,
          script: decideScript,
          ...(pauseBeforeSubmit !== undefined ? { pauseBeforeSubmit } : {}),
          ...(runMode !== undefined ? { runMode } : {}),
          ...(resolvedParams ? { params: resolvedParams } : {}),
          ...(cmd.primaryLabel ? { primaryLabel: cmd.primaryLabel } : {}),
          ...(cmd.pauseNotice ? { pauseNotice: cmd.pauseNotice } : {}),
        };
        let res:
          | {
              ok?: boolean;
              decision?: "approved" | "dismissed";
              params?: Record<string, string>;
              error?: string;
            }
          | undefined;
        try {
          res = (await api.tabs.sendMessage(tabId, msgPayload, { frameId: 0 })) as
            | {
                ok?: boolean;
                decision?: "approved" | "dismissed";
                params?: Record<string, string>;
                error?: string;
              }
            | undefined;
        } catch (sendErr) {
          console.warn("[eyes-bg] sendMessage failed, injecting content.js and retrying:", sendErr);
          if (api.scripting?.executeScript) {
            await api.scripting.executeScript({
              target: { tabId, allFrames: false },
              files: ["dist/content.js"],
            } as unknown as Parameters<NonNullable<NonNullable<ChromeApi["scripting"]>["executeScript"]>>[0]);
            res = (await api.tabs.sendMessage(tabId, msgPayload, { frameId: 0 })) as
              | {
                  ok?: boolean;
                  decision?: "approved" | "dismissed";
                  params?: Record<string, string>;
                  error?: string;
                }
              | undefined;
          } else {
            throw sendErr;
          }
        }
        console.log("[eyes-bg] decider response from tab:", res);
        if (!res?.ok || (res.decision !== "approved" && res.decision !== "dismissed")) {
          throw new Error(res?.error ?? "Decider prompt failed");
        }
        if (res.decision === "approved") {
          lastApprovedDecideTabId = tabId;
        }
        payload = {
          id: decideId,
          ok: true,
          decision: res.decision,
          ...(res.params ? { params: res.params } : {}),
        };
      } catch (err) {
        console.error("[eyes-bg] decide error:", err);
        payload = {
          id: decideId,
          ok: false,
          error: err instanceof Error ? err.message : "Decider failed",
        };
      }
      await fetch(`${serverUrl}/hands/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch((err) => console.error("[eyes-bg] failed to post decide result:", err));
    })();
    return;
  }

  if (cmd.id && cmd.kind === "precheck") {
    const precheckId = cmd.id;
    let payload: {
      id: string;
      ok: boolean;
      results?: Array<{
        index: number;
        action: string;
        ok: boolean;
        matchCount: number;
        unique: boolean;
        matchedLocator?: Locator;
        error?: string;
      }>;
      error?: string;
    };
    try {
      const openTab = await resolveOpenRunnableTab();
      if (openTab.id === undefined || !openTab.url) {
        throw new Error("No active web tab open");
      }
      if (!api?.tabs?.sendMessage) {
        throw new Error("chrome.tabs.sendMessage unavailable");
      }
      const steps = (cmd.steps ?? cmd.script?.steps ?? []) as PrecheckStepInput[];
      const targets = collectMatchingPrecheckSteps(steps, openTab.url, cmd.url);
      const results: NonNullable<typeof payload.results> = [];
      for (const item of targets) {
        let res = (await Promise.resolve(
          api.tabs.sendMessage(
            openTab.id,
            { kind: "EYES_PRECHECK_STEP", locators: item.locators, step: item.step },
            { frameId: 0 },
          ),
        ).catch(() => undefined)) as
          | {
              ok?: boolean;
              matchCount?: number;
              unique?: boolean;
              matchedLocator?: Locator;
              error?: string;
            }
          | undefined;

        if (!res && api.scripting?.executeScript) {
          await api.scripting.executeScript({
            target: { tabId: openTab.id, allFrames: false },
            files: ["dist/content.js"],
          } as unknown as Parameters<NonNullable<NonNullable<ChromeApi["scripting"]>["executeScript"]>>[0]);
          res = (await Promise.resolve(
            api.tabs.sendMessage(
              openTab.id,
              { kind: "EYES_PRECHECK_STEP", locators: item.locators, step: item.step },
              { frameId: 0 },
            ),
          ).catch(() => undefined)) as typeof res;
        }

        results.push({
          index: item.index,
          action: item.action,
          ok: Boolean(res?.ok),
          matchCount: res?.matchCount ?? 0,
          unique: Boolean(res?.unique),
          ...(res?.matchedLocator ? { matchedLocator: res.matchedLocator } : {}),
          ...(res?.error ? { error: res.error } : {}),
        });
      }
      payload = { id: precheckId, ok: true, results };
    } catch (err) {
      payload = {
        id: precheckId,
        ok: false,
        error: err instanceof Error ? err.message : "Precheck failed",
      };
    }
    await fetch(`${serverUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => console.error("[eyes-bg] failed to post precheck result:", err));
    return;
  }

  if (cmd.id && cmd.script) {
    console.log("[eyes-bg] received run command", cmd.id, "steps=", cmd.script.steps.length);
    let payload: { id: string; ok: boolean; results?: StepResult[]; error?: string };
    try {
      const preferredTabId = lastApprovedDecideTabId;
      lastApprovedDecideTabId = undefined;
      const tabId = await resolveActiveTabId(preferredTabId);
      console.log("[eyes-bg] run target tabId =", tabId);
      if (tabId === undefined) throw new Error("No active web tab open");
      const initialParams =
        cmd.paramValues ??
        (cmd.params && !Array.isArray(cmd.params) ? cmd.params : undefined);
      const results = await runActionScript(tabId, cmd.script, initialParams);
      console.log("[eyes-bg] runActionScript results:", results);
      payload = { id: cmd.id, ok: true, results };
    } catch (err) {
      console.error("[eyes-bg] run error:", err);
      payload = {
        id: cmd.id,
        ok: false,
        error: err instanceof Error ? err.message : "Hands execution failed",
      };
    }
    await fetch(`${serverUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => console.error("[eyes-bg] failed to post run result:", err));
  }
}

export async function pollHandsBridgeOnce(serverUrl = SERVER_URL): Promise<boolean> {
  const resp = await fetch(`${serverUrl}/hands/next`);
  if (resp.status !== 200) return false;
  const cmd = (await resp.json()) as HandsCommand;
  await handleHandsCommand(cmd, serverUrl);
  return true;
}

let handsBridgeRunning = false;

async function pollHandsBridge(): Promise<void> {
  if (handsBridgeRunning) return;
  handsBridgeRunning = true;
  try {
    while (true) {
      try {
        const handled = await pollHandsBridgeOnce(SERVER_URL);
        if (handled) continue;
      } catch {
        // Server offline or unreachable
      }
      await sleep(1000);
    }
  } finally {
    handsBridgeRunning = false;
  }
}

export async function fetchLatestScript(
  serverUrl = SERVER_URL,
): Promise<ActionScript | null> {
  let resp: Response;
  try {
    resp = await fetch(`${serverUrl}/script/latest`);
  } catch {
    return null;
  }
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`Server returned HTTP ${resp.status} for /script/latest`);
  }
  const data = (await resp.json()) as { ok?: boolean; script?: ActionScript; error?: string };
  if (!data.ok || !data.script) {
    throw new Error(data.error ?? "Invalid /script/latest payload");
  }
  return data.script;
}

async function fetchAndRunLatestScript(
  tabId: number,
): Promise<{ script: ActionScript; results: StepResult[] } | null> {
  const script = await fetchLatestScript();
  if (!script) return null;
  const results = await runActionScript(tabId, script);
  return { script, results };
}

export async function runActionScript(
  tabId: number,
  script: V2ActionScript | ActionScript,
  initialParams?: Record<string, string>,
): Promise<StepResult[]> {
  const v2Script = script as V2ActionScript;
  const bindings: Record<string, BindingValue> = {};
  if (Array.isArray(v2Script.params)) {
    for (const p of v2Script.params) {
      if (!p || typeof p.name !== "string") continue;
      if (p.piiHash) {
        const localVal = await resolveLocalPiiByHash(p.piiHash);
        if (localVal !== undefined) {
          bindings[p.name] = localVal;
          continue;
        }
      }
      if (typeof p.example === "string") {
        bindings[p.name] = p.example;
      }
    }
  }
  if (initialParams) {
    for (const [k, v] of Object.entries(initialParams)) {
      if (typeof v === "string" && (v.length > 0 || !(k in bindings))) {
        bindings[k] = v;
      }
    }
  }
  await ensureLocalPiiLoaded();
  const runControl: RunControl = { aborted: false, waiters: new Set() };
  activeRunControl = runControl;
  let currentTabId = tabId;
  let paused = false;
  try {
    const outcome = await runStepsInternal(tabId, v2Script.steps, bindings, {}, {
      scriptName: v2Script.name,
      pauseBeforeSubmit: Boolean(v2Script.pauseBeforeSubmit),
      pageSummary: v2Script.pageSummary,
      runControl,
      isTopLevel: true,
    });
    currentTabId = outcome.currentTabId;
    paused = outcome.paused;
    return outcome.results;
  } finally {
    if (activeRunControl === runControl) {
      activeRunControl = null;
    }
    if (!paused) {
      await sendWatchMessage(currentTabId, { kind: "EYES_WATCH_STOP" });
    }
  }
}

function isExactHostMatch(url: string | undefined, targetHost: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const want = targetHost.trim().toLowerCase();
    const got = want.includes(":") ? parsed.host.toLowerCase() : parsed.hostname.toLowerCase();
    return got === want;
  } catch {
    return false;
  }
}

export function tabMatchesHost(url: string | undefined, targetHost: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const want = normalizeLoopbackHost(targetHost);
    if (!want) return false;
    const got = normalizeLoopbackHost(want.includes(":") ? parsed.host : parsed.hostname);
    return got === want;
  } catch {
    return false;
  }
}

export function scoreTabUrlMatch(tabUrl: string | undefined, targetUrl: string): number {
  if (!tabUrl) return 0;
  if (tabUrl === targetUrl) return 4;
  try {
    const tabParsed = new URL(tabUrl);
    if (targetUrl.startsWith("/")) {
      const targetPath = normalizeUrlPath(targetUrl.split("?")[0]);
      if (normalizeUrlPath(tabParsed.pathname) === targetPath) return 2;
      if (tabParsed.pathname.startsWith(targetPath)) return 1;
      return 0;
    }
    const targetParsed = new URL(targetUrl);
    if (tabParsed.href.replace(/#.*$/, "") === targetParsed.href.replace(/#.*$/, "")) return 4;
    if (normalizeLoopbackHost(tabParsed.host) !== normalizeLoopbackHost(targetParsed.host)) {
      return 0;
    }
    if (
      normalizeUrlPath(tabParsed.pathname) === normalizeUrlPath(targetParsed.pathname) &&
      tabParsed.search === targetParsed.search
    ) {
      return 3;
    }
    if (normalizeUrlPath(tabParsed.pathname) === normalizeUrlPath(targetParsed.pathname)) {
      return targetParsed.search ? 0 : 2;
    }
    if (tabUrl.startsWith(targetUrl)) return 1;
    return 0;
  } catch {
    return tabUrl.startsWith(targetUrl) ? 1 : 0;
  }
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val && typeof val === "object" && !Array.isArray(val));
}

function normalizeListItem(item: unknown): Record<string, unknown> {
  if (!isPlainObject(item)) return { value: String(item ?? "") };
  const cells = item.cells;
  if (Array.isArray(cells)) {
    const mapped: Record<string, unknown> = { ...item };
    const texts: string[] = [];
    cells.forEach((cell, idx) => {
      const text = isPlainObject(cell) && typeof cell.text === "string" ? cell.text : String(cell ?? "");
      texts.push(text);
      if (!(`col${idx}` in mapped)) mapped[`col${idx}`] = text;
    });
    if (!("text" in mapped)) mapped.text = texts.join(" ");
    return mapped;
  }
  return item;
}

function extractPageSummaryList(pageSummary: unknown): unknown[] | undefined {
  if (Array.isArray(pageSummary)) return pageSummary;
  if (!isPlainObject(pageSummary)) return undefined;
  if (isPlainObject(pageSummary.source) && Array.isArray(pageSummary.source.rows)) {
    return pageSummary.source.rows;
  }
  if (Array.isArray(pageSummary.rows)) return pageSummary.rows;
  if (Array.isArray(pageSummary.items)) return pageSummary.items;
  if (Array.isArray(pageSummary.containers)) {
    for (const container of pageSummary.containers) {
      if (isPlainObject(container)) {
        if (Array.isArray(container.rows)) return container.rows;
        if (Array.isArray(container.items)) return container.items;
      }
    }
  }
  return undefined;
}

function resolveForEachItems(
  rawItems: Record<string, string>[] | string,
  bindings: Record<string, BindingValue>,
  scope: Record<string, unknown>,
  pageSummary?: unknown,
): Record<string, unknown>[] {
  if (Array.isArray(rawItems)) {
    return rawItems.map(normalizeListItem);
  }
  if (typeof rawItems === "string") {
    const candidates: unknown[] = [
      bindings[rawItems],
      scope[rawItems],
      lookup(
        {
          ...bindings,
          ...scope,
          ...(pageSummary !== undefined ? { pageSummary } : {}),
        },
        rawItems,
      ),
    ];
    if (
      rawItems === "pageSummary" ||
      rawItems === "pageSummary.source.rows" ||
      rawItems === "pageSummary.rows" ||
      rawItems === "pageSummary.items" ||
      rawItems === "rows" ||
      rawItems === "items"
    ) {
      candidates.push(extractPageSummaryList(pageSummary ?? bindings.pageSummary ?? scope.pageSummary));
    }
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.map(normalizeListItem);
      }
    }
  }
  throw new Error(`No array binding: ${String(rawItems)}`);
}

type RunContext = {
  scriptName?: string;
  pauseBeforeSubmit: boolean;
  pageSummary?: unknown;
  runControl: RunControl;
  isTopLevel: boolean;
};

function stepLocatorsForWatch(step: V2DomStep): Locator[] {
  const out: Locator[] = [];
  if ("target" in step && step.target) {
    if (Array.isArray(step.target)) out.push(...step.target);
    else out.push(step.target);
  }
  if ("targets" in step && Array.isArray(step.targets)) {
    out.push(...step.targets);
  }
  return out;
}

async function runStepsInternal(
  tabId: number,
  steps: V2Step[],
  bindings: Record<string, BindingValue>,
  scope: Record<string, unknown>,
  ctx: RunContext,
): Promise<{ results: StepResult[]; currentTabId: number; paused: boolean }> {
  const results: StepResult[] = [];
  let currentTabId = tabId;

  let lastClickIndex = -1;
  if (ctx.pauseBeforeSubmit && ctx.isTopLevel) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i]?.action === "click") {
        lastClickIndex = i;
        break;
      }
    }
    if (lastClickIndex === -1) {
      for (let i = steps.length - 1; i >= 0; i -= 1) {
        const s = steps[i];
        if (s?.action === "pressKey" && (s.key === "Enter" || s.value === "Enter")) {
          lastClickIndex = i;
          break;
        }
      }
    }
  }

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    if (ctx.runControl.aborted) {
      throw new Error("Run stopped by user");
    }

    const rawStep = steps[stepIndex];
    let step: V2Step;
    try {
      step = substitute(rawStep, { ...bindings, ...scope }) as V2Step;
    } catch (error) {
      if (rawStep.optional) continue;
      throw error;
    }
    if ("value" in step && typeof step.value === "string") {
      step = { ...step, value: restoreLocalPiiText(step.value, bgLocalPiiByHash) };
    }

    if (
      ctx.pauseBeforeSubmit &&
      ctx.isTopLevel &&
      stepIndex === lastClickIndex &&
      (step.action === "click" || step.action === "pressKey")
    ) {
      const locators = stepLocatorsForWatch(step);
      await sendWatchMessage(currentTabId, {
        kind: "EYES_WATCH_STEP",
        name: ctx.scriptName,
        stepIndex,
        totalSteps: steps.length,
        target: locators[0],
        locators,
        pauseBeforeSubmit: true,
        pauseNotice: "Paused before submit — you click the final button.",
      });
      return { results, currentTabId, paused: true };
    }

    try {
      const tabsApi = getChromeApi()?.tabs ?? (typeof chrome !== "undefined" ? chrome.tabs : undefined);
      const windowsApi =
        getChromeApi()?.windows ?? (typeof chrome !== "undefined" ? chrome.windows : undefined);

      if (step.action === "navigate") {
        lastFieldFrameByTab.delete(currentTabId);
        const currentTab = tabsApi?.get
          ? await tabsApi.get(currentTabId).catch(() => undefined)
          : undefined;
        if (
          currentTab?.url &&
          (scoreTabUrlMatch(currentTab.url, step.url) >= 3 ||
            urlsMatchForPrecheck(step.url, currentTab.url))
        ) {
          results.push({ ok: true, url: currentTab.url });
          continue;
        }
        await tabsApi?.update?.(currentTabId, { url: step.url });
        await waitForTabLoad(currentTabId);
        const updatedTab = tabsApi?.get
          ? await tabsApi.get(currentTabId).catch(() => undefined)
          : undefined;
        if (updatedTab?.url?.startsWith("chrome-error://")) {
          throw new Error(`Navigation failed for ${step.url} (error page)`);
        }
        results.push({ ok: true, url: step.url });
        continue;
      }

      if (step.action === "wait") {
        await abortableSleep(step.ms, ctx.runControl);
        results.push({ ok: true, url: "" });
        continue;
      }

      if (step.action === "switchTab") {
        const allTabs = (await tabsApi?.query?.({})) ?? [];
        if (step.url) {
          const urlMatches = allTabs
            .map((t) => ({ tab: t, score: scoreTabUrlMatch(t.url, step.url!) }))
            .filter((entry) => entry.tab.id !== undefined && entry.score > 0);
          urlMatches.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const accessDiff = (b.tab.lastAccessed ?? 0) - (a.tab.lastAccessed ?? 0);
            if (accessDiff !== 0) return accessDiff;
            if (Boolean(a.tab.active) !== Boolean(b.tab.active)) return a.tab.active ? -1 : 1;
            return 0;
          });
          const match = urlMatches[0]?.tab;
          if (match?.id !== undefined) {
            await tabsApi?.update?.(match.id, { active: true });
            if (match.windowId !== undefined && windowsApi?.update) {
              await windowsApi.update(match.windowId, { focused: true });
            }
            currentTabId = match.id;
            results.push({
              ok: true,
              tab: step.host ?? tryHostFromUrl(step.url) ?? step.url,
              url: match.url ?? step.url,
            });
            continue;
          }
          if (tabsApi?.create) {
            const created = await tabsApi.create({ url: step.url, active: true });
            if (created?.id === undefined) {
              throw new Error(`Failed to open tab for ${step.url}`);
            }
            if (created.windowId !== undefined && windowsApi?.update) {
              await windowsApi.update(created.windowId, { focused: true });
            }
            if (created.status !== "complete") {
              await waitForTabLoad(created.id);
            }
            currentTabId = created.id;
            results.push({
              ok: true,
              tab: step.host ?? tryHostFromUrl(step.url) ?? step.url,
              url: created.url ?? step.url,
            });
            continue;
          }
          throw new Error(`No open tab for ${step.url}`);
        }

        const targetHost = step.host ?? "";
        const matches = allTabs.filter(
          (t) => t.id !== undefined && tabMatchesHost(t.url, targetHost),
        );
        matches.sort((a, b) => {
          const exactDiff =
            Number(isExactHostMatch(b.url, targetHost)) -
            Number(isExactHostMatch(a.url, targetHost));
          if (exactDiff !== 0) return exactDiff;
          const accessDiff = (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
          if (accessDiff !== 0) return accessDiff;
          if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
          return 0;
        });
        const match = matches[0];
        if (match?.id === undefined) {
          throw new Error(`No open tab for ${targetHost}`);
        }
        await tabsApi?.update?.(match.id, { active: true });
        if (match.windowId !== undefined && windowsApi?.update) {
          await windowsApi.update(match.windowId, { focused: true });
        }
        currentTabId = match.id;
        results.push({ ok: true, tab: targetHost });
        continue;
      }

      if (step.action === "forEach") {
        const items = resolveForEachItems(step.items, bindings, scope, ctx.pageSummary);
        for (const item of items) {
          if (ctx.runControl.aborted) {
            throw new Error("Run stopped by user");
          }
          const nested = await runStepsInternal(
            currentTabId,
            step.steps,
            bindings,
            {
              ...scope,
              ...item,
              item,
            },
            {
              ...ctx,
              isTopLevel: false,
            },
          );
          results.push(...nested.results);
          currentTabId = nested.currentTabId;
          if (nested.paused) {
            return { results, currentTabId, paused: true };
          }
        }
        continue;
      }

      const watchLocators = stepLocatorsForWatch(step);
      await sendWatchMessage(currentTabId, {
        kind: "EYES_WATCH_STEP",
        name: ctx.scriptName,
        stepIndex,
        totalSteps: steps.length,
        target: watchLocators[0],
        locators: watchLocators,
      });

      const result = await executeDomStep(currentTabId, step);
      if (ctx.runControl.aborted) {
        throw new Error("Run stopped by user");
      }
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
      if (ctx.runControl.aborted) throw error;
      if (step.optional) continue;
      throw error;
    }
  }

  return { results, currentTabId, paused: false };
}

async function executeDomStep(tabId: number, step: V2DomStep): Promise<StepResult> {
  const api = getChromeApi();
  const knownFrameId = lastFieldFrameByTab.get(tabId);
  const hasTarget =
    ("target" in step && Boolean(step.target)) ||
    ("targets" in step && Boolean(step.targets?.length)) ||
    ("within" in step && Boolean(step.within));
  const target =
    knownFrameId !== undefined && !hasTarget
      ? { tabId, frameIds: [knownFrameId] }
      : { tabId };

  const invokeExecuteScript = async () => {
    if (api?.scripting?.executeScript) {
      return api.scripting.executeScript({
        target,
        func: executeStep,
        args: [step],
      });
    }
    if (typeof chrome !== "undefined" && chrome.scripting?.executeScript) {
      return chrome.scripting.executeScript({
        target,
        func: executeStep,
        args: [step],
      });
    }
    throw new Error("chrome.scripting.executeScript unavailable");
  };

  let injections: Array<{ frameId?: number; result?: StepResult }>;
  try {
    injections = await invokeExecuteScript();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Frame with ID 0 is showing error page")) {
      throw error;
    }
    const tabsApi = api?.tabs ?? (typeof chrome !== "undefined" ? chrome.tabs : undefined);
    let tab = tabsApi?.get ? await tabsApi.get(tabId).catch(() => undefined) : undefined;
    if (tab?.status === "loading") {
      await waitForTabLoad(tabId);
      try {
        injections = await invokeExecuteScript();
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        if (!retryMessage.includes("Frame with ID 0 is showing error page")) {
          throw retryError;
        }
        tab = tabsApi?.get ? await tabsApi.get(tabId).catch(() => undefined) : undefined;
        const urlInfo = tab?.url ? ` (${tab.url})` : "";
        throw new Error(
          `Tab is showing error page${urlInfo}: Frame with ID 0 is showing error page`,
        );
      }
    } else {
      const urlInfo = tab?.url ? ` (${tab.url})` : "";
      throw new Error(
        `Tab is showing error page${urlInfo}: Frame with ID 0 is showing error page`,
      );
    }
  }

  const [injection] = injections;
  if (!injection?.result) throw new Error("Executor returned no result");
  return injection.result;
}

export function substitute<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === "string") return substituteString(value, vars) as T;
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars)) as T;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const isForEach = obj.action === "forEach";
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      if (key === "bind" || (isForEach && key === "steps")) {
        result[key] = child;
      } else {
        result[key] = substitute(child, vars);
      }
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

function abortableSleep(ms: number, runControl: RunControl): Promise<void> {
  if (runControl.aborted) {
    return Promise.reject(new Error("Run stopped by user"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const wake = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runControl.waiters.delete(wake);
      if (runControl.aborted) reject(new Error("Run stopped by user"));
      else resolve();
    };
    const timer = setTimeout(wake, ms);
    runControl.waiters.add(wake);
  });
}

function waitForTabLoad(tabId: number): Promise<void> {
  const tabsApi = getChromeApi()?.tabs ?? (typeof chrome !== "undefined" ? chrome.tabs : undefined);
  if (!tabsApi?.onUpdated || !tabsApi?.get) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tabsApi.onUpdated?.removeListener?.(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (updatedTabId: number, changeInfo: ChromeTab): void => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for page load")), 30000);
    tabsApi.onUpdated!.addListener(listener);
    void tabsApi
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish();
      })
      .catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error("Failed to read tab"));
      });
  });
}
