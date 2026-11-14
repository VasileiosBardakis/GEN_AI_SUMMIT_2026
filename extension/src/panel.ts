import type { Report } from "@gen/shared";
import {
  computeLibrarySummary,
  createDefaultOptimizations,
  findingToOptimization,
  formatDuration,
  formatRelativeTime,
  recordOptimizationRun,
  upsertOptimizationItem,
  type OptimizationItem,
} from "./library.ts";
import type { FlowNode } from "./suggestion.ts";

const SERVER_URL = "http://localhost:8787";

type FilterMode = "all" | "active" | "suggested";

interface LibraryResponse {
  ok?: boolean;
  items?: OptimizationItem[];
  appliedToPage?: boolean;
  note?: string;
  error?: string;
}

interface ChromePanelApi {
  runtime?: {
    sendMessage?: (msg: unknown, cb: (res?: LibraryResponse) => void) => void;
  };
  storage?: {
    onChanged?: {
      addListener: (cb: (changes: Record<string, unknown>, areaName: string) => void) => void;
    };
  };
}

let allItems: OptimizationItem[] = [];
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
      chromeApi.runtime!.sendMessage!(msg, (res) => resolve(res));
    } catch {
      resolve(undefined);
    }
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function nodeKindIcon(kind: FlowNode["kind"]): string {
  switch (kind) {
    case "click":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 1.8l6.8 3.6-3.1 1-1.3 3.1-2.4-7.7Z"/></svg>';
    case "input":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2 3.5h8M2 6h6M2 8.5h4.5"/></svg>';
    case "tab":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="9" height="7" rx="1.2"/><path d="M1.5 5h9M5.5 2.5V5"/></svg>';
    case "paste":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="6.5" height="7.5" rx="1"/><path d="M4.5 3V2a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1v1"/></svg>';
    case "loop":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 4.5A3.8 3.8 0 0 0 3 3.4M2.5 7.5A3.8 3.8 0 0 0 9 8.6"/><path d="M9.7 2.4v2.2H7.5M2.3 9.6V7.4h2.2"/></svg>';
    case "ai":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true"><path d="M1.5 6c1.2-2 2.8-3 4.5-3s3.3 1 4.5 3c-1.2 2-2.8 3-4.5 3S2.7 8 1.5 6Z" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6" r="1.3" fill="currentColor"/></svg>';
    case "done":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4.3"/><path d="M4.2 6.1l1.2 1.2 2.5-2.5"/></svg>';
  }
}

function nodeKindTitle(kind: FlowNode["kind"]): string {
  switch (kind) {
    case "ai":
      return "Eyes";
    case "loop":
      return "Loop";
    default:
      return kind[0].toUpperCase() + kind.slice(1);
  }
}

function renderFlowNodes(nodes: FlowNode[]): string {
  const arrowSvg =
    '<svg class="flow-arrow" viewBox="0 0 14 10" width="11" height="9" aria-hidden="true"><path d="M1 5h10M8.5 2.5L11.5 5l-3 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>';
  return nodes
    .map((node, index) => {
      const arrow = index < nodes.length - 1 ? arrowSvg : "";
      const kindClass = node.kind === "ai" ? "eyes-step" : node.kind;
      return `
        <div class="flow-node ${kindClass}" title="${escapeHtml(node.label)}">
          <div class="flow-kind">${nodeKindIcon(node.kind)}<span>${escapeHtml(nodeKindTitle(node.kind))}</span></div>
          <div class="flow-label">${escapeHtml(node.label)}</div>
        </div>${arrow}
      `;
    })
    .join("");
}

function renderDag(item: OptimizationItem, isOpen: boolean): string {
  if (!item.flows) return "";
  return `
    <div class="dag-canvas" data-dag-for="${escapeHtml(item.id)}" ${isOpen ? "" : "hidden"}>
      <div class="flow-head">
        <span>Your flow</span>
        <span class="flow-sub">Manual cycle</span>
      </div>
      <div class="flow-track">${renderFlowNodes(item.flows.user)}</div>
      <div class="dag-divider"></div>
      <div class="flow-head">
        <span class="flow-head-eyes">Eyes flow</span>
        <span class="flow-sub">Single pass</span>
      </div>
      <div class="flow-track">${renderFlowNodes(item.flows.proposed)}</div>
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
  return `
    <div class="preview-row">
      <span class="keycap">${escapeHtml(item.preview ?? item.title)}</span>
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
              <h2 class="opt-title">${escapeHtml(item.title)}</h2>
              <p class="opt-desc">${escapeHtml(item.description)}</p>
            </div>
            ${
              isSuggested
                ? '<span class="suggested-tag"><span class="suggested-dot" aria-hidden="true"></span>Ready</span>'
                : `<button class="switch" type="button" role="switch" aria-checked="${
                    item.status === "active" ? "true" : "false"
                  }" aria-label="Toggle ${escapeHtml(item.title)}" data-action="toggle" data-id="${escapeHtml(item.id)}"></button>`
            }
          </div>

          ${renderPreview(item)}

          <div class="opt-metrics">
            <div class="metric-cell">
              <span class="metric-val">~${escapeHtml(formatDuration(item.timeSavedPerRunSec))}</span>
              <span class="metric-lbl">Saves / run</span>
            </div>
            <div class="metric-cell">
              <span class="metric-val">${item.runCount}</span>
              <span class="metric-lbl">${item.runCount === 1 ? "Run" : "Runs"}</span>
            </div>
            <div class="metric-cell">
              <span class="metric-val${item.totalTimeSavedSec > 0 ? " saved" : ""}">${escapeHtml(
                formatDuration(item.totalTimeSavedSec)
              )}</span>
              <span class="metric-lbl">Total saved</span>
            </div>
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
    const res = await sendBgMessage({ kind: "EYES_TOGGLE_OPTIMIZATION", id });
    if (res?.items) {
      allItems = res.items;
    } else {
      allItems = allItems.map((item) =>
        item.id === id
          ? { ...item, status: item.status === "active" ? "paused" : "active" }
          : item
      );
    }
    render();
    return;
  }

  if (action === "activate") {
    const res = await sendBgMessage({ kind: "EYES_ACTIVATE_OPTIMIZATION", id });
    if (res?.items) {
      allItems = res.items;
    } else {
      allItems = allItems.map((item) =>
        item.id === id ? { ...item, status: "active" } : item
      );
    }
    setFeedback(id, "Added to library", "ok");
    return;
  }

  if (action === "dismiss") {
    const res = await sendBgMessage({ kind: "EYES_DISMISS_OPTIMIZATION", id });
    if (res?.items) {
      allItems = res.items;
    } else {
      allItems = allItems.filter((item) => item.id !== id);
    }
    render();
    return;
  }

  if (action === "run") {
    const res = await sendBgMessage({ kind: "EYES_RUN_OPTIMIZATION", id });
    if (res) {
      if (res.items) allItems = res.items;
      if (res.ok) {
        if (!res.appliedToPage && target.snippetText) {
          await copyFallback(target.snippetText);
        }
        setFeedback(
          id,
          `${res.note ?? "Completed"} · +${formatDuration(target.timeSavedPerRunSec)} saved`,
          "ok"
        );
      } else {
        setFeedback(id, res.error ?? "Open matching page to run", "err");
      }
      return;
    }

    if (target.snippetText) {
      await copyFallback(target.snippetText);
    }
    allItems = recordOptimizationRun(allItems, id);
    setFeedback(id, `+${formatDuration(target.timeSavedPerRunSec)} saved`, "ok");
  }
}

async function syncServerFindings(): Promise<void> {
  try {
    const resp = await fetch(`${SERVER_URL}/report`);
    if (!resp.ok) return;
    const report = (await resp.json()) as Report;
    if (!Array.isArray(report.findings) || report.findings.length === 0) return;

    let changed = false;
    for (const finding of report.findings) {
      const converted = findingToOptimization(finding);
      if (!converted) continue;
      const exists = allItems.some((item) => item.id === converted.id);
      if (!exists) {
        allItems = upsertOptimizationItem(allItems, converted);
        changed = true;
        void sendBgMessage({ kind: "EYES_UPSERT_OPTIMIZATION", item: converted });
      }
    }
    if (changed) render();
  } catch {
    // ignore offline local server
  }
}

async function init(): Promise<void> {
  const res = await sendBgMessage({ kind: "EYES_GET_LIBRARY" });
  allItems = res?.items && res.items.length > 0 ? res.items : createDefaultOptimizations();
  render();
  void syncServerFindings();

  const chromeApi = getChromeApi();
  chromeApi?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const updated = changes.eyes_optimization_library_v1 as
      | { newValue?: OptimizationItem[] }
      | undefined;
    if (Array.isArray(updated?.newValue)) {
      allItems = updated.newValue;
      render();
    }
  });
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
