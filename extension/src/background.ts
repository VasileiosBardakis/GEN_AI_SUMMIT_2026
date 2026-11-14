import { executeStep } from "./hands/execute.js";
import type { ActionScript, BindingValue, DomStep, Step, StepResult } from "./types.js";
import type { Event } from "@gen/shared";
import type { LibraryEntry } from "@gen/shared/schema.ts";
import { sanitizeUrl } from "./privacy.ts";
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

interface ChromeRuntimeMessage {
  kind?: string;
  event?: Event;
  script?: ActionScript;
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
let lastApprovedDecideTabId: number | undefined;
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

const flushTimer = setInterval(() => {
  void flushQueue();
}, BATCH_INTERVAL_MS);
(flushTimer as unknown as { unref?: () => void }).unref?.();

const chromeApi = (globalThis as Record<string, unknown>).chrome as ChromeApi | undefined;

const TEXT_CLUSTERS_STORAGE_KEY = "eyes_text_clusters_v1";
const BROWSER_SESSION_ID = "sess_browser_" + Math.random().toString(36).slice(2, 10);

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
      const stored = await chromeApi?.storage?.local?.get(TEXT_CLUSTERS_STORAGE_KEY);
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
        void chromeApi?.storage?.local
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
    const stored = await chromeApi?.storage?.local?.get(LIBRARY_STORAGE_KEY);
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
    void pollHandsBridge();
    if (msg?.kind === "EYES_EVENT" && msg.event) {
      if (sender.tab?.id !== undefined) {
        lastActiveTab = {
          tabId: sender.tab.id,
          app: msg.event.app,
          url: msg.event.url,
          title: msg.event.window,
        };
      }
      recordEvent(msg.event);
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
      const targetScript = msg.script;
      void resolveActiveTabId(sender.tab?.id)
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
      void resolveActiveTabId(sender.tab?.id)
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
      void resolveActiveTabId(sender.tab?.id)
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
  });
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

async function resolveActiveTabId(senderTabId?: number): Promise<number | undefined> {
  if (senderTabId !== undefined) return senderTabId;
  if (typeof chrome !== "undefined" && chrome.tabs?.query) {
    const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentMatch = currentTabs.find((t) => t.id !== undefined && isRunnablePageUrl(t.url));
    if (currentMatch?.id !== undefined) return currentMatch.id;

    const anyActive = await chrome.tabs.query({ active: true });
    const anyMatch = anyActive.find((t) => t.id !== undefined && isRunnablePageUrl(t.url));
    if (anyMatch?.id !== undefined) return anyMatch.id;
  }
  return lastActiveTab?.tabId;
}

let handsBridgeRunning = false;

async function pollHandsBridge(): Promise<void> {
  if (handsBridgeRunning) return;
  handsBridgeRunning = true;
  try {
    while (true) {
      try {
        const resp = await fetch(`${SERVER_URL}/hands/next`);
        if (resp.status === 200) {
          const cmd = (await resp.json()) as {
            id?: string;
            kind?: "run" | "decide";
            name?: string;
            solution?: string;
            script?: ActionScript;
          };
          if (cmd.id && cmd.kind === "decide" && cmd.script && typeof cmd.solution === "string") {
            const decideId = cmd.id;
            const decideName = cmd.name ?? cmd.script.name;
            const decideSolution = cmd.solution;
            const decideScript = cmd.script;
            console.log("[eyes-bg] received decide command", decideId, decideName);
            void (async () => {
              let payload: {
                id: string;
                ok: boolean;
                decision?: "approved" | "dismissed";
                error?: string;
              };
              try {
                const tabId = await resolveActiveTabId();
                console.log("[eyes-bg] decide target tabId =", tabId);
                if (tabId === undefined) throw new Error("No active web tab open");
                if (!chromeApi?.tabs?.sendMessage) {
                  throw new Error("chrome.tabs.sendMessage unavailable");
                }
                const msgPayload = {
                  kind: "EYES_SHOW_DECIDER",
                  name: decideName,
                  solution: decideSolution,
                  script: decideScript,
                };
                let res: { ok?: boolean; decision?: "approved" | "dismissed"; error?: string } | undefined;
                try {
                  res = (await chromeApi.tabs.sendMessage(tabId, msgPayload, { frameId: 0 })) as
                    | { ok?: boolean; decision?: "approved" | "dismissed"; error?: string }
                    | undefined;
                } catch (sendErr) {
                  console.warn("[eyes-bg] sendMessage failed, injecting content.js and retrying:", sendErr);
                  if (typeof chrome !== "undefined" && chrome.scripting?.executeScript) {
                    await chrome.scripting.executeScript({
                      target: { tabId, allFrames: false },
                      files: ["dist/content.js"],
                    });
                    res = (await chromeApi.tabs.sendMessage(tabId, msgPayload, { frameId: 0 })) as
                      | { ok?: boolean; decision?: "approved" | "dismissed"; error?: string }
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
                payload = { id: decideId, ok: true, decision: res.decision };
              } catch (err) {
                console.error("[eyes-bg] decide error:", err);
                payload = {
                  id: decideId,
                  ok: false,
                  error: err instanceof Error ? err.message : "Decider failed",
                };
              }
              await fetch(`${SERVER_URL}/hands/result`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              }).catch((err) => console.error("[eyes-bg] failed to post decide result:", err));
            })();
          } else if (cmd.id && cmd.script) {
            console.log("[eyes-bg] received run command", cmd.id, "steps=", cmd.script.steps.length);
            let payload: { id: string; ok: boolean; results?: StepResult[]; error?: string };
            try {
              const preferredTabId = lastApprovedDecideTabId;
              lastApprovedDecideTabId = undefined;
              const tabId = await resolveActiveTabId(preferredTabId);
              console.log("[eyes-bg] run target tabId =", tabId);
              if (tabId === undefined) throw new Error("No active web tab open");
              const results = await runActionScript(tabId, cmd.script);
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
            await fetch(`${SERVER_URL}/hands/result`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }).catch((err) => console.error("[eyes-bg] failed to post run result:", err));
          }
          continue;
        }
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

export async function runActionScript(tabId: number, script: ActionScript): Promise<StepResult[]> {
  const bindings: Record<string, BindingValue> = {};
  return runSteps(tabId, script.steps, bindings, {});
}

function tabMatchesHost(url: string | undefined, targetHost: string): boolean {
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

async function runSteps(
  tabId: number,
  steps: Step[],
  bindings: Record<string, BindingValue>,
  scope: Record<string, unknown>,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let currentTabId = tabId;

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
        await chrome.tabs.update(currentTabId, { url: step.url });
        await waitForTabLoad(currentTabId);
        results.push({ ok: true, url: step.url });
        continue;
      }

      if (step.action === "wait") {
        await sleep(step.ms);
        results.push({ ok: true, url: "" });
        continue;
      }

      if (step.action === "switchTab") {
        const allTabs = await chrome.tabs.query({});
        const matches = allTabs.filter(
          (t) => t.id !== undefined && tabMatchesHost(t.url, step.host),
        );
        matches.sort((a, b) => {
          const accessDiff = (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
          if (accessDiff !== 0) return accessDiff;
          if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
          return 0;
        });
        const match = matches[0];
        if (match?.id === undefined) {
          throw new Error(`No open tab for ${step.host}`);
        }
        await chrome.tabs.update(match.id, { active: true });
        if (match.windowId !== undefined && chrome.windows?.update) {
          await chrome.windows.update(match.windowId, { focused: true });
        }
        currentTabId = match.id;
        results.push({ ok: true, tab: step.host });
        continue;
      }

      if (step.action === "forEach") {
        const items = Array.isArray(step.items) ? step.items : bindings[step.items];
        if (!Array.isArray(items)) throw new Error(`No array binding: ${step.items}`);
        for (const item of items) {
          const nested = await runSteps(currentTabId, step.steps, bindings, {
            ...scope,
            ...item,
            item,
          });
          results.push(...nested);
        }
        continue;
      }

      const result = await executeDomStep(currentTabId, step);
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

export function substitute<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === "string") return substituteString(value, vars) as T;
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars)) as T;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const isForEach = obj.action === "forEach";
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      result[key] = isForEach && key === "steps" ? child : substitute(child, vars);
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
