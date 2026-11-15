import { executeStep } from "./hands/execute.ts";
import {
  computeLibrarySummary,
  formatDuration,
  formatRelativeTime,
  LIBRARY_STORAGE_KEY,
  mergeServerAndLocalOptimizations,
  recordOptimizationRun,
  type LibraryEntryWithStats,
  type OptimizationItem,
} from "./library.ts";
import type { ActionScript, BindingValue, DomStep, Step, StepResult } from "./types.ts";
import {
  DEFAULT_SERVER_URL,
  escapeHtml,
  isExactHostMatch,
  renderFlowNodes,
  scoreTabUrlMatch,
  substituteBindings,
  tabMatchesHost,
} from "./utils.ts";

const SERVER_URL = DEFAULT_SERVER_URL;

type FilterMode = "all" | "active" | "suggested";

interface LibraryResponse {
  ok?: boolean;
  items?: OptimizationItem[];
  appliedToPage?: boolean;
  note?: string;
  error?: string;
  results?: StepResult[];
}

interface ChromeTab {
  id?: number;
  url?: string;
  active?: boolean;
  windowId?: number;
  lastAccessed?: number;
  status?: string;
}

interface ChromePanelApi {
  runtime?: {
    lastError?: { message?: string };
    sendMessage?: (msg: unknown, cb: (res?: LibraryResponse) => void) => void;
  };
  tabs?: {
    getCurrent?: () => Promise<ChromeTab | undefined>;
    query?: (queryInfo: {
      url?: string | string[];
      active?: boolean;
      currentWindow?: boolean;
    }) => Promise<ChromeTab[]>;
    get?: (tabId: number) => Promise<ChromeTab>;
    update?: (
      tabId: number,
      updateProperties: { url?: string; active?: boolean }
    ) => Promise<ChromeTab>;
    onUpdated?: {
      addListener: (cb: (tabId: number, changeInfo: { status?: string }) => void) => void;
      removeListener: (cb: (tabId: number, changeInfo: { status?: string }) => void) => void;
    };
  };
  windows?: {
    update?: (windowId: number, updateInfo: { focused?: boolean }) => Promise<unknown>;
  };
  scripting?: {
    executeScript?: (injection: {
      target: { tabId: number; frameIds?: number[] };
      func: (step: DomStep) => Promise<StepResult>;
      args?: [DomStep];
    }) => Promise<Array<{ result?: StepResult }>>;
  };
  storage?: {
    local?: {
      get?: (keys?: string | string[] | null) => Promise<Record<string, unknown>>;
      set?: (items: Record<string, unknown>) => Promise<void>;
    };
    onChanged?: {
      addListener: (cb: (changes: Record<string, unknown>, areaName: string) => void) => void;
    };
  };
}

let allItems: OptimizationItem[] = [];
let lastServerEntries: LibraryEntryWithStats[] = [];
let latestLocalItems: OptimizationItem[] | null = null;
let currentFilter: FilterMode = "all";
let searchQuery = "";
const expandedFlows = new Set<string>();
const feedbackById = new Map<string, { text: string; tone: "ok" | "err" }>();

function getChromeApi(): ChromePanelApi | undefined {
  return (globalThis as Record<string, unknown>).chrome as ChromePanelApi | undefined;
}

function sendBgMessage(msg: unknown): Promise<LibraryResponse | undefined> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.runtime?.sendMessage) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    try {
      chromeApi.runtime!.sendMessage!(msg, (res) => {
        const lastError = chromeApi.runtime?.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message || "Extension background unavailable" });
          return;
        }
        resolve(res);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function resolveItemRunTarget(item: OptimizationItem): { url?: string; appHost?: string } {
  const appHost =
    item.eyes?.scope?.apps?.[0] ??
    (item.app && item.app !== "Browser" && item.app !== "Recent activity" ? item.app : undefined);
  for (const step of item.script?.steps ?? []) {
    if (
      (step.action === "switchTab" || step.action === "navigate") &&
      "url" in step &&
      typeof step.url === "string" &&
      /^https?:\/\//i.test(step.url)
    ) {
      return { url: step.url, ...(appHost ? { appHost } : {}) };
    }
  }
  for (const pat of item.eyes?.scope?.urlPatterns ?? []) {
    if (/^https?:\/\//i.test(pat) && !pat.includes("*")) {
      return { url: pat, ...(appHost ? { appHost } : {}) };
    }
  }
  return appHost ? { appHost } : {};
}

function renderDag(item: OptimizationItem, isOpen: boolean): string {
  if (!item.flows) return "";
  return `
    <div class="dag-canvas" data-dag-for="${escapeHtml(item.id)}" ${isOpen ? "" : "hidden"}>
      <div class="flow-head">
        <span>Your flow</span>
        <span class="flow-sub">Manual cycle</span>
      </div>
      <div class="flow-track">${renderFlowNodes(item.flows.user, "sm")}</div>
      <div class="dag-divider"></div>
      <div class="flow-head">
        <span class="flow-head-eyes">Eyes flow</span>
        <span class="flow-sub">Single pass</span>
      </div>
      <div class="flow-track">${renderFlowNodes(item.flows.proposed, "sm")}</div>
    </div>
  `;
}

function renderPreview(item: OptimizationItem): string {
  if (!item.preview && !item.shortcut) return "";
  if (item.kind === "snippet") {
    return `
      <div class="preview-row">
        ${item.preview ? `<div class="preview-snippet">${escapeHtml(item.preview)}</div>` : ""}
        ${item.shortcut ? `<kbd class="keycap">${escapeHtml(item.shortcut)}</kbd>` : ""}
      </div>
    `;
  }
  if (!item.preview || item.preview.trim() === item.title.trim()) {
    return "";
  }
  return `
    <div class="preview-row">
      <span class="keycap">${escapeHtml(item.preview)}</span>
    </div>
  `;
}

function filteredItems(): OptimizationItem[] {
  const query = searchQuery.trim().toLowerCase();
  return allItems.filter((item) => {
    if (currentFilter === "active" && item.status !== "active" && item.status !== "paused") {
      return false;
    }
    if (currentFilter === "suggested" && item.status !== "suggested") {
      return false;
    }
    if (!query) return true;
    const haystack = [item.title, item.description, item.app ?? "", item.preview ?? ""]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function render(): void {
  const summary = computeLibrarySummary(allItems);
  const sumSaved = document.getElementById("sum-saved");
  const sumRuns = document.getElementById("sum-runs");
  const sumActive = document.getElementById("sum-active");
  if (sumSaved) sumSaved.textContent = formatDuration(summary.totalTimeSavedSec);
  if (sumRuns) sumRuns.textContent = String(summary.totalRuns);
  if (sumActive) sumActive.textContent = String(summary.activeCount);

  const manualValEl = document.getElementById("meter-manual-val");
  const reclaimedValEl = document.getElementById("meter-reclaimed-val");
  const manualBarEl = document.getElementById("meter-manual-bar") as HTMLElement | null;
  const reclaimedBarEl = document.getElementById("meter-reclaimed-bar") as HTMLElement | null;
  const meterNoteEl = document.getElementById("meter-note");

  const manualSec = summary.totalManualSpentSec;
  const reclaimedSec = summary.totalTimeSavedSec;
  const scaleMax = Math.max(manualSec, reclaimedSec, 1);

  if (manualSec > 0 || reclaimedSec > 0) {
    const manualPct = manualSec > 0 ? Math.max(4, Math.round((manualSec / scaleMax) * 100)) : 0;
    const reclaimedPct = reclaimedSec > 0 ? Math.max(4, Math.round((reclaimedSec / scaleMax) * 100)) : 0;
    if (manualValEl) manualValEl.textContent = formatDuration(manualSec);
    if (reclaimedValEl) reclaimedValEl.textContent = formatDuration(reclaimedSec);
    if (manualBarEl) manualBarEl.style.width = `${manualPct}%`;
    if (reclaimedBarEl) reclaimedBarEl.style.width = `${reclaimedPct}%`;
    if (meterNoteEl) {
      if (reclaimedSec > manualSec) {
        meterNoteEl.textContent = `+${formatDuration(reclaimedSec - manualSec)} ahead of manual time spent`;
      } else if (reclaimedSec > 0) {
        meterNoteEl.textContent = `${formatDuration(manualSec - reclaimedSec)} left to break even on manual time`;
      } else {
        meterNoteEl.textContent = `${formatDuration(manualSec)} spent manually · ~${formatDuration(summary.potentialSavedPerRunSec)} saved per run`;
      }
    }
  } else {
    if (manualValEl) manualValEl.textContent = "0s";
    if (reclaimedValEl) reclaimedValEl.textContent = "0s";
    if (manualBarEl) manualBarEl.style.width = "0%";
    if (reclaimedBarEl) reclaimedBarEl.style.width = "0%";
    if (meterNoteEl) {
      meterNoteEl.textContent =
        summary.potentialSavedPerRunSec > 0
          ? `Ready to save ~${formatDuration(summary.potentialSavedPerRunSec)} per run`
          : "Run an automation to reclaim manual time";
    }
  }

  const countAll = document.getElementById("count-all");
  const countActive = document.getElementById("count-active");
  const countSuggested = document.getElementById("count-suggested");
  if (countAll) countAll.textContent = String(allItems.length);
  if (countActive) {
    countActive.textContent = String(
      allItems.filter((item) => item.status === "active" || item.status === "paused").length
    );
  }
  if (countSuggested) countSuggested.textContent = String(summary.suggestedCount);

  const list = document.getElementById("library-list");
  if (!list) return;

  const visible = filteredItems();
  if (visible.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <strong>${allItems.length === 0 ? "No optimizations saved yet" : "No matching optimizations"}</strong>
        <span>${
          allItems.length === 0
            ? "Eyes watches quietly for repeated replies and click sequences."
            : "Try clearing your search or switching tabs."
        }</span>
      </div>
    `;
    return;
  }

  list.innerHTML = visible
    .map((item) => {
      const isSuggested = item.status === "suggested";
      const isPaused = item.status === "paused";
      const isFlowOpen = expandedFlows.has(item.id);
      const feedback = feedbackById.get(item.id);
      const metaText = feedback
        ? feedback.text
        : isSuggested
          ? `${item.app ?? "Browser"} · Seen ${item.detectedCount ?? 3} times`
          : `${item.app ?? "Browser"} · ${formatRelativeTime(item.lastRunAt)}`;
      const metaClass = feedback ? ` ${feedback.tone}` : "";
      const primaryLabel = item.kind === "snippet" ? "Insert" : "Run";

      return `
        <article class="opt-card${isPaused ? " paused" : ""}" data-opt-id="${escapeHtml(item.id)}">
          <div class="opt-head">
            <div>
              <div class="opt-eyebrow">${item.kind === "snippet" ? "Snippet" : "Workflow"} · ${escapeHtml(item.app ?? "Browser")}</div>
              <h2 class="opt-title">${escapeHtml(item.title)}</h2>
              <p class="opt-desc">${escapeHtml(item.description)}</p>
            </div>
            ${
              isSuggested
                ? '<span class="suggested-tag">Ready</span>'
                : `<button class="switch" type="button" role="switch" aria-checked="${
                    item.status === "active" ? "true" : "false"
                  }" aria-label="Toggle ${escapeHtml(item.title)}" data-action="toggle" data-id="${escapeHtml(item.id)}"></button>`
            }
          </div>

          ${renderPreview(item)}

          <div class="opt-stats-line">
            <span>~${escapeHtml(formatDuration(item.timeSavedPerRunSec))}/run · <strong>${item.runCount}</strong> ${item.runCount === 1 ? "run" : "runs"}</span>
            <span class="${item.totalTimeSavedSec > 0 ? "saved" : ""}">${escapeHtml(formatDuration(item.totalTimeSavedSec))} saved</span>
          </div>

          ${renderDag(item, isFlowOpen)}

          <div class="opt-foot">
            <span class="opt-meta${metaClass}">${escapeHtml(metaText)}</span>
            <div class="opt-actions">
              ${
                item.flows
                  ? `<button class="btn ghost" type="button" data-action="flow" data-id="${escapeHtml(item.id)}">${
                      isFlowOpen ? "Hide flow" : "Flow"
                    }</button>`
                  : ""
              }
              ${
                isSuggested
                  ? `<button class="btn ghost" type="button" data-action="dismiss" data-id="${escapeHtml(item.id)}">Dismiss</button>
                     <button class="btn primary" type="button" data-action="activate" data-id="${escapeHtml(item.id)}">Add</button>`
                  : `<button class="btn primary" type="button" data-action="run" data-id="${escapeHtml(item.id)}">${primaryLabel}</button>`
              }
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function setFeedback(id: string, text: string, tone: "ok" | "err"): void {
  feedbackById.set(id, { text, tone });
  render();
  setTimeout(() => {
    if (feedbackById.get(id)?.text === text) {
      feedbackById.delete(id);
      render();
    }
  }, 2600);
}

async function copyFallback(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // ignore clipboard permission errors
  }
  return false;
}

function waitForTabLoad(chromeApi: ChromePanelApi, tabId: number): Promise<void> {
  const tabsApi = chromeApi.tabs;
  if (!tabsApi?.onUpdated || !tabsApi?.get) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tabsApi.onUpdated?.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (updatedTabId: number, changeInfo: { status?: string }): void => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for page load")), 30_000);
    tabsApi.onUpdated?.addListener(listener);
    void tabsApi
      .get?.(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish();
      })
      .catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error("Failed to read tab"));
      });
  });
}

async function runStepsInTab(
  chromeApi: ChromePanelApi,
  tabId: number,
  steps: Step[],
  bindings: Record<string, BindingValue>,
  scope: Record<string, unknown>
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let currentTabId = tabId;

  for (const rawStep of steps) {
    let step: Step;
    try {
      step = substituteBindings(rawStep, { ...bindings, ...scope }) as Step;
    } catch (error) {
      if (rawStep.optional) continue;
      throw error;
    }

    try {
      if (step.action === "navigate") {
        await chromeApi.tabs?.update?.(currentTabId, { url: step.url });
        await waitForTabLoad(chromeApi, currentTabId);
        results.push({ ok: true, url: step.url });
        continue;
      }

      if (step.action === "wait") {
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        results.push({ ok: true, url: "" });
        continue;
      }

      if (step.action === "switchTab") {
        const allTabs = (await chromeApi.tabs?.query?.({ url: ["http://*/*", "https://*/*"] })) ?? [];
        let match: ChromeTab | undefined;
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
          match = urlMatches[0]?.tab;
        }
        if (!match) {
          const matches = allTabs.filter(
            (t) => t.id !== undefined && tabMatchesHost(t.url, step.host)
          );
          matches.sort((a, b) => {
            const exactDiff =
              Number(isExactHostMatch(b.url, step.host)) -
              Number(isExactHostMatch(a.url, step.host));
            if (exactDiff !== 0) return exactDiff;
            const accessDiff = (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
            if (accessDiff !== 0) return accessDiff;
            if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
            return 0;
          });
          match = matches[0];
        }
        if (match?.id === undefined) {
          throw new Error(`No open tab for ${step.url ?? step.host}`);
        }
        await chromeApi.tabs?.update?.(match.id, { active: true });
        if (match.windowId !== undefined) {
          await chromeApi.windows?.update?.(match.windowId, { focused: true });
        }
        currentTabId = match.id;
        results.push({
          ok: true,
          tab: step.host,
          ...(match.url || step.url ? { url: match.url ?? step.url } : {}),
        });
        continue;
      }

      if (step.action === "forEach") {
        const items = Array.isArray(step.items) ? step.items : bindings[step.items];
        if (!Array.isArray(items)) throw new Error(`No array binding: ${step.items}`);
        for (const item of items) {
          const nested = await runStepsInTab(chromeApi, currentTabId, step.steps, bindings, {
            ...scope,
            ...item,
            item,
          });
          results.push(...nested);
        }
        continue;
      }

      if (!chromeApi.scripting?.executeScript) {
        throw new Error("chrome.scripting.executeScript unavailable");
      }
      const injections = await chromeApi.scripting.executeScript({
        target: { tabId: currentTabId },
        func: executeStep as unknown as (step: DomStep) => Promise<StepResult>,
        args: [step as unknown as DomStep],
      });
      const result = injections?.[0]?.result;
      if (!result) throw new Error("Executor returned no result");
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

async function runActionScriptInTab(
  chromeApi: ChromePanelApi,
  tabId: number,
  script: ActionScript
): Promise<StepResult[]> {
  return runStepsInTab(chromeApi, tabId, script.steps, {}, {});
}

async function handleAction(action: string, id: string): Promise<void> {
  const target = allItems.find((item) => item.id === id);
  if (!target) return;

  if (action === "flow") {
    if (expandedFlows.has(id)) expandedFlows.delete(id);
    else expandedFlows.add(id);
    render();
    return;
  }

  if (action === "toggle") {
    const nextStatus: OptimizationItem["status"] =
      target.status === "active" ? "paused" : "active";
    const res = await sendBgMessage({ kind: "EYES_TOGGLE_OPTIMIZATION", id });
    if (res?.items) {
      allItems = mergeServerAndLocalOptimizations(lastServerEntries, res.items);
    }
    allItems = allItems.map((item) =>
      item.id === id ? { ...item, status: nextStatus } : item
    );
    await saveLocalLibrary(allItems);
    render();
    return;
  }

  if (action === "activate") {
    const activated: OptimizationItem = { ...target, status: "active" };
    const res = await sendBgMessage({
      kind: "EYES_ACTIVATE_OPTIMIZATION",
      id,
      item: activated,
    });
    if (res?.items) {
      allItems = mergeServerAndLocalOptimizations(lastServerEntries, res.items);
    }
    if (allItems.some((item) => item.id === id)) {
      allItems = allItems.map((item) => (item.id === id ? activated : item));
    } else {
      allItems = [activated, ...allItems];
    }
    await saveLocalLibrary(allItems);
    setFeedback(id, "Added to library", "ok");
    return;
  }

  if (action === "dismiss") {
    lastServerEntries = lastServerEntries.filter((entry) => entry.id !== id);
    const res = await sendBgMessage({ kind: "EYES_DISMISS_OPTIMIZATION", id });
    if (res?.items) {
      allItems = mergeServerAndLocalOptimizations(lastServerEntries, res.items);
    }
    allItems = allItems.filter((item) => item.id !== id);
    await saveLocalLibrary(allItems);
    render();
    return;
  }

  if (action === "run") {
    if (target.script) {
      const chromeApi = getChromeApi();
      let currentTab: ChromeTab | undefined;
      if (chromeApi?.tabs?.getCurrent) {
        try {
          currentTab = await chromeApi.tabs.getCurrent();
        } catch {
          currentTab = undefined;
        }
      }

      if (currentTab?.id !== undefined) {
        const tabs = chromeApi?.tabs?.query
          ? await chromeApi.tabs.query({ url: ["http://*/*", "https://*/*"] })
          : [];
        const httpTabs = tabs
          .filter((tab) => tab.id !== undefined && tab.id !== currentTab?.id)
          .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
        const activeHttpTab = httpTabs[0];
        if (activeHttpTab?.id === undefined) {
          if (target.snippetText && (await copyFallback(target.snippetText))) {
            allItems = recordOptimizationRun(allItems, id);
            await saveLocalLibrary(allItems);
            setFeedback(id, `Copied · +${formatDuration(target.timeSavedPerRunSec)} saved`, "ok");
            return;
          }
          setFeedback(id, "Open matching page to run", "err");
          return;
        }
        try {
          await runActionScriptInTab(chromeApi!, activeHttpTab.id, target.script);
          allItems = recordOptimizationRun(allItems, id);
          await saveLocalLibrary(allItems);
          setFeedback(id, `+${formatDuration(target.timeSavedPerRunSec)} saved`, "ok");
        } catch (err) {
          if (target.snippetText && (await copyFallback(target.snippetText))) {
            allItems = recordOptimizationRun(allItems, id);
            await saveLocalLibrary(allItems);
            setFeedback(id, `Copied · +${formatDuration(target.timeSavedPerRunSec)} saved`, "ok");
            return;
          }
          setFeedback(
            id,
            err instanceof Error ? err.message : "Open matching page to run",
            "err"
          );
        }
        return;
      }

      const runTarget = resolveItemRunTarget(target);
      const res = await sendBgMessage({
        kind: "HANDS_RUN_SCRIPT",
        script: target.script,
        ...(runTarget.url ? { url: runTarget.url } : {}),
        ...(runTarget.appHost ? { appHost: runTarget.appHost } : {}),
      });
      if (res && !res.ok) {
        if (target.snippetText && (await copyFallback(target.snippetText))) {
          allItems = recordOptimizationRun(allItems, id);
          await saveLocalLibrary(allItems);
          setFeedback(id, `Copied · +${formatDuration(target.timeSavedPerRunSec)} saved`, "ok");
          return;
        }
        setFeedback(id, res.error ?? "Open matching page to run", "err");
        return;
      }
      if (!res && target.snippetText) {
        await copyFallback(target.snippetText);
      }
      allItems = recordOptimizationRun(allItems, id);
      await saveLocalLibrary(allItems);
      setFeedback(id, `+${formatDuration(target.timeSavedPerRunSec)} saved`, "ok");
      return;
    }

    if (target.snippetText) {
      await copyFallback(target.snippetText);
    }
    allItems = recordOptimizationRun(allItems, id);
    await saveLocalLibrary(allItems);
    setFeedback(id, `+${formatDuration(target.timeSavedPerRunSec)} saved`, "ok");
  }
}

async function loadServerEntriesOrNull(): Promise<LibraryEntryWithStats[] | null> {
  try {
    const resp = await fetch(`${SERVER_URL}/library`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      ok?: boolean;
      items?: LibraryEntryWithStats[];
    };
    if (data?.ok === false || !Array.isArray(data?.items)) return null;
    return data.items;
  } catch {
    return null;
  }
}

async function loadServerEntries(): Promise<LibraryEntryWithStats[]> {
  return (await loadServerEntriesOrNull()) ?? [];
}

let refreshInFlight = false;
async function refreshFromServer(): Promise<void> {
  if (refreshInFlight || document.hidden) return;
  refreshInFlight = true;
  try {
    const entries = await loadServerEntriesOrNull();
    if (!entries) return;
    lastServerEntries = entries;
    const nextItems = mergeServerAndLocalOptimizations(entries, latestLocalItems ?? []);
    if (JSON.stringify(nextItems) !== JSON.stringify(allItems)) {
      allItems = nextItems;
      render();
    }
  } finally {
    refreshInFlight = false;
  }
}

async function loadLocalLibrary(): Promise<OptimizationItem[]> {
  const chromeApi = getChromeApi();
  if (chromeApi?.storage?.local?.get) {
    try {
      const stored = await chromeApi.storage.local.get(LIBRARY_STORAGE_KEY);
      const raw = stored?.[LIBRARY_STORAGE_KEY];
      if (Array.isArray(raw)) {
        return raw as OptimizationItem[];
      }
      return [];
    } catch {
      // fall through to runtime message
    }
  }
  const res = await sendBgMessage({ kind: "EYES_GET_LIBRARY" });
  return Array.isArray(res?.items) ? res.items : [];
}

async function saveLocalLibrary(items: OptimizationItem[]): Promise<void> {
  latestLocalItems = items;
  const chromeApi = getChromeApi();
  if (!chromeApi?.storage?.local?.set) return;
  try {
    await chromeApi.storage.local.set({ [LIBRARY_STORAGE_KEY]: items });
  } catch {
    // ignore storage write error
  }
}

async function init(): Promise<void> {
  const chromeApi = getChromeApi();
  chromeApi?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const updated = changes[LIBRARY_STORAGE_KEY] as
      | { newValue?: OptimizationItem[] }
      | undefined;
    if (Array.isArray(updated?.newValue)) {
      latestLocalItems = updated.newValue;
      allItems = mergeServerAndLocalOptimizations(lastServerEntries, updated.newValue);
      render();
    }
  });

  const [serverEntries, localItems] = await Promise.all([
    loadServerEntries(),
    loadLocalLibrary(),
  ]);
  lastServerEntries = serverEntries;
  const effectiveLocal = latestLocalItems ?? localItems;
  latestLocalItems = effectiveLocal;
  allItems = mergeServerAndLocalOptimizations(serverEntries, effectiveLocal);
  render();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void refreshFromServer();
  });

  setInterval(() => {
    void refreshFromServer();
  }, 2000);
}

document.querySelectorAll<HTMLButtonElement>(".filter-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const filter = tab.dataset.filter as FilterMode | undefined;
    if (!filter) return;
    currentFilter = filter;
    document.querySelectorAll<HTMLButtonElement>(".filter-tab").forEach((btn) => {
      const active = btn.dataset.filter === filter;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    render();
  });
});

document.getElementById("library-search")?.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  searchQuery = input.value;
  render();
});

document.getElementById("library-list")?.addEventListener("click", (event) => {
  const target = event.target as Element | null;
  const button = target?.closest<HTMLElement>("[data-action][data-id]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action && id) {
    void handleAction(action, id);
  }
});

void init();
