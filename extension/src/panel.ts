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
import type { FlowNode } from "./suggestion.ts";
import type { ActionScript, BindingValue, DomStep, Locator, Step, StepResult } from "./types.ts";

const SERVER_URL = "http://localhost:8787";

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

async function executeDomStepInPage(step: DomStep): Promise<StepResult> {
  function escapeValue(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return value.replace(/["\\]/g, "\\$&");
  }

  function collapseWs(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function isVisible(element: Element): boolean {
    if (element instanceof HTMLInputElement && element.type.toLowerCase() === "hidden") {
      return false;
    }
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return typeof element.getClientRects === "function" && element.getClientRects().length > 0;
  }

  const TAG_ROLES: Record<string, string> = {
    button: "button",
    summary: "button",
    a: "link",
    select: "combobox",
    textarea: "textbox",
    td: "gridcell",
    th: "gridcell",
    option: "option",
  };
  const INPUT_ROLES: Record<string, string> = {
    checkbox: "checkbox",
    radio: "radio",
    search: "searchbox",
    button: "button",
    submit: "button",
    reset: "button",
  };
  const TEXT_NAMED_ROLES = new Set(["button", "link", "menuitem", "tab", "option"]);
  const TEXTBOX_EQUIVALENTS = new Set(["textbox", "searchbox"]);

  function implicitRole(element: Element): string {
    const explicit = element.getAttribute("role")?.trim().toLowerCase();
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      const inputType = (element.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLES[inputType] ?? "textbox";
    }
    return TAG_ROLES[tag] ?? "";
  }

  function roleMatches(actual: string, wanted: string): boolean {
    return actual === wanted || (TEXTBOX_EQUIVALENTS.has(actual) && TEXTBOX_EQUIVALENTS.has(wanted));
  }

  function cleanLabelNode(label: HTMLElement): string {
    const clone = label.cloneNode(true) as HTMLElement;
    for (const nested of Array.from(
      clone.querySelectorAll("input, select, textarea, button, datalist, script, style")
    )) {
      nested.remove();
    }
    return collapseWs(clone.textContent ?? "");
  }

  function accessibleNames(element: Element): string[] {
    const names: string[] = [];
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) names.push(collapseWs(ariaLabel));

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => collapseWs(document.getElementById(id)?.textContent ?? ""))
        .filter(Boolean)
        .join(" ");
      if (joined) names.push(joined);
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      if (element.labels && element.labels.length > 0) {
        const labelText = Array.from(element.labels)
          .map((label) => cleanLabelNode(label))
          .filter(Boolean)
          .join(" ");
        if (labelText) names.push(labelText);
      }
      if (
        element instanceof HTMLInputElement &&
        /^(submit|button|reset)$/i.test(element.type) &&
        element.value
      ) {
        names.push(collapseWs(element.value));
      }
      const placeholder = element.getAttribute("placeholder");
      if (placeholder) names.push(collapseWs(placeholder));
    }

    const title = element.getAttribute("title");
    if (title) names.push(collapseWs(title));

    const role = implicitRole(element);
    if (
      !(element instanceof HTMLSelectElement) &&
      (TEXT_NAMED_ROLES.has(role) || element.tagName.toLowerCase() === "label")
    ) {
      const text = collapseWs(element.textContent ?? "");
      if (text) names.push(text);
    }

    return names.filter(Boolean);
  }

  function resolveAria(raw: string, root: ParentNode): Element[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("[")) {
      try {
        return Array.from(root.querySelectorAll(trimmed));
      } catch {
        return [];
      }
    }

    const roleSyntax = /^([a-z]+)\[\s*name\s*=\s*["']([\s\S]*?)["']\s*\]$/i.exec(trimmed);
    const wantedRole = roleSyntax ? roleSyntax[1].toLowerCase() : null;
    const wantedName = collapseWs(
      roleSyntax ? roleSyntax[2].replace(/\\(["'\\])/g, "$1") : trimmed
    );
    if (!wantedName) return [];
    const wantedLower = wantedName.toLowerCase();

    const candidates = Array.from(
      root.querySelectorAll(
        'input, textarea, select, button, a, summary, [role], [aria-label], [aria-labelledby], [contenteditable="true"]'
      )
    ).filter((el) => !wantedRole || roleMatches(implicitRole(el), wantedRole));

    const exact: Element[] = [];
    const partial: Element[] = [];
    for (const candidate of candidates) {
      const names = accessibleNames(candidate).map((n) => n.toLowerCase());
      if (names.some((n) => n === wantedLower)) {
        exact.push(candidate);
      } else if (names.some((n) => n.includes(wantedLower))) {
        partial.push(candidate);
      }
    }
    return [...exact, ...partial];
  }

  function isInteractiveControl(element: Element): boolean {
    return element.matches(
      'button, a, input, select, textarea, summary, label, option, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="radio"], [role="checkbox"]'
    );
  }

  function resolveText(raw: string, root: ParentNode): Element[] {
    const wanted = collapseWs(raw);
    if (!wanted) return [];
    const wantedLower = wanted.toLowerCase();

    const submitInputs = Array.from(
      root.querySelectorAll('input[type="submit"], input[type="button"], input[type="reset"]')
    ).filter((el) => {
      const val = collapseWs((el as HTMLInputElement).value);
      return val === wanted || val.toLowerCase() === wantedLower;
    });

    const allNodes = Array.from(root.querySelectorAll("*"));
    let textMatched = allNodes.filter((el) => collapseWs(el.textContent ?? "") === wanted);
    if (textMatched.length === 0) {
      textMatched = allNodes.filter(
        (el) => collapseWs(el.textContent ?? "").toLowerCase() === wantedLower
      );
    }

    const matchedSet = new Set(textMatched);
    textMatched.sort((a, b) => {
      const aInteractive = isInteractiveControl(a) ? 0 : 1;
      const bInteractive = isInteractiveControl(b) ? 0 : 1;
      if (aInteractive !== bInteractive) return aInteractive - bInteractive;
      const aHasChild = Array.from(a.children).some((c) => matchedSet.has(c)) ? 1 : 0;
      const bHasChild = Array.from(b.children).some((c) => matchedSet.has(c)) ? 1 : 0;
      return aHasChild - bHasChild;
    });

    return [...submitInputs, ...textMatched];
  }

  function toLocatorList(target: Locator | Locator[]): Locator[] {
    return Array.isArray(target) ? target : [target];
  }

  function resolveAllForLocator(locator: Locator, root: ParentNode = document): Element[] {
    if (locator.kind === "css") return Array.from(root.querySelectorAll(locator.value));
    if (locator.kind === "xpath") {
      const snapshot = document.evaluate(
        locator.value,
        root as Node,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      const found: Element[] = [];
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const node = snapshot.snapshotItem(index);
        if (node instanceof Element) found.push(node);
      }
      return found;
    }
    if (locator.kind === "testid") {
      return Array.from(root.querySelectorAll(`[data-testid="${escapeValue(locator.value)}"]`));
    }
    if (locator.kind === "aria") {
      return resolveAria(locator.value, root);
    }
    return resolveText(locator.value, root);
  }

  function resolveAll(target: Locator | Locator[], root: ParentNode = document): Element[] {
    for (const locator of toLocatorList(target)) {
      const found = resolveAllForLocator(locator, root);
      if (found.length > 0) return found;
    }
    return [];
  }

  function resolve(target: Locator | Locator[], root: ParentNode = document): Element | null {
    for (const locator of toLocatorList(target)) {
      const found = resolveAllForLocator(locator, root);
      const match = found.find(isVisible) ?? found[0] ?? null;
      if (match) return match;
    }
    return null;
  }

  function unwrapControl(element: Element): Element {
    if (element instanceof HTMLLabelElement && element.control) {
      return element.control;
    }
    return element;
  }

  function readValue(rawElement: Element): string {
    const element = unwrapControl(rawElement);
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return element.value;
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return element.innerText;
    }
    return (element.textContent ?? "").trim();
  }

  function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function insertIntoEditable(element: HTMLElement, value: string): void {
    element.focus();
    const selection = window.getSelection();
    if (selection) {
      const hasRangeInside =
        selection.rangeCount > 0 &&
        element.contains(selection.getRangeAt(0).commonAncestorContainer);
      if (!hasRangeInside) {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    const inserted = document.execCommand("insertText", false, value);
    if (!inserted) {
      element.textContent = `${element.textContent ?? ""}${value}`;
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })
      );
    }
  }

  function insertText(element: Element, value: string): void {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      const existingNorm = element.value.trim().toLowerCase();
      const incomingNorm = value.trim().toLowerCase();
      if (
        existingNorm.length > 0 &&
        incomingNorm.length > 0 &&
        incomingNorm.startsWith(existingNorm)
      ) {
        setNativeValue(element, value);
      } else {
        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? element.value.length;
        setNativeValue(element, `${element.value.slice(0, start)}${value}${element.value.slice(end)}`);
      }
      const caret = element.value.length;
      try {
        element.setSelectionRange(caret, caret);
      } catch {
        // ignore
      }
      return;
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      insertIntoEditable(element, value);
      return;
    }
    throw new Error("Target is not editable");
  }

  function click(element: Element): void {
    if (element instanceof HTMLElement) {
      element.click();
      return;
    }
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function selectOption(rawElement: Element, value: string): void {
    const element = unwrapControl(rawElement);
    if (!(element instanceof HTMLSelectElement)) throw new Error("Target is not a select");
    const wanted = collapseWs(value);
    const wantedLower = wanted.toLowerCase();
    const options = Array.from(element.options);
    const matched =
      options.find((opt) => opt.value === value) ??
      options.find((opt) => opt.value.toLowerCase() === wantedLower) ??
      options.find((opt) => collapseWs(opt.label || opt.textContent || "").toLowerCase() === wantedLower) ??
      options.find((opt) =>
        collapseWs(opt.label || opt.textContent || "").toLowerCase().includes(wantedLower)
      );
    if (!matched) throw new Error(`Option not found: ${value}`);
    element.value = matched.value;
    matched.selected = true;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  const winFlag = window as unknown as { __EYES_SUPPRESS_SYNTHETIC__?: boolean };
  const prevSuppress = winFlag.__EYES_SUPPRESS_SYNTHETIC__;
  winFlag.__EYES_SUPPRESS_SYNTHETIC__ = true;
  try {
    switch (step.action) {
      case "click": {
        const element = resolve(step.target);
        if (!element) throw new Error("Target not found");
        click(element);
        return { ok: true, url: location.href };
      }
      case "fill": {
        const rawElement = resolve(step.target);
        if (!rawElement) throw new Error("Target not found");
        const element = unwrapControl(rawElement);
        if (
          element instanceof HTMLInputElement &&
          (element.type === "checkbox" || element.type === "radio")
        ) {
          if (element.type === "radio") {
            if (!element.checked) click(element);
          } else {
            const wantChecked = !/^(false|0|off|no|unchecked)$/i.test(step.value.trim());
            if (element.checked !== wantChecked) click(element);
          }
          return { ok: true, url: location.href, value: String(element.checked) };
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          setNativeValue(element, step.value);
        } else if (element instanceof HTMLElement && element.isContentEditable) {
          element.textContent = "";
          insertIntoEditable(element, step.value);
        } else {
          throw new Error("Target is not fillable");
        }
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "insertText": {
        let active: Element | null = document.activeElement;
        while (active && active.shadowRoot && active.shadowRoot.activeElement) {
          active = active.shadowRoot.activeElement;
        }
        const remembered = (window as unknown as { __HANDS_LAST_EDITABLE__?: Element | null })
          .__HANDS_LAST_EDITABLE__;
        const lastEditable = remembered && remembered.isConnected ? remembered : null;
        const element = (step.target ? resolve(step.target) : null) ?? lastEditable ?? active;
        if (!element) throw new Error("No target and nothing focused");
        insertText(element, step.value);
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "select": {
        const element = resolve(step.target);
        if (!element) throw new Error("Target not found");
        selectOption(element, step.value);
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "waitFor": {
        const deadline = Date.now() + (step.timeoutMs ?? 5000);
        while (Date.now() < deadline) {
          if (resolve(step.target)) return { ok: true, url: location.href };
          await wait(100);
        }
        throw new Error("Timed out waiting for target");
      }
      case "readText":
      case "readValue": {
        const element = resolve(step.target);
        if (!element) throw new Error("Target not found");
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "extractList": {
        const roots = resolveAll(step.target);
        if (roots.length === 0) throw new Error("Target not found");
        const items = roots.map((row) => {
          if (!step.fields) return { text: readValue(row) };
          const item: Record<string, string> = {};
          for (const [name, locator] of Object.entries(step.fields)) {
            const field = resolve(locator, row);
            item[name] = field ? readValue(field) : "";
          }
          return item;
        });
        return { ok: true, url: location.href, items };
      }
      default:
        throw new Error(`Unsupported step: ${(step as { action?: string }).action ?? "unknown"}`);
    }
  } catch (error) {
    return {
      ok: false,
      url: location.href,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    winFlag.__EYES_SUPPRESS_SYNTHETIC__ = prevSuppress;
  }
}

function lookupBinding(vars: Record<string, unknown>, path: string): unknown {
  let current: unknown = vars;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function substituteString(value: string, vars: Record<string, unknown>): unknown {
  const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
  if (whole) return lookupBinding(vars, whole[1]);
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    const found = lookupBinding(vars, path);
    return found === undefined ? "" : String(found);
  });
}

function substituteStepValue<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === "string") return substituteString(value, vars) as T;
  if (Array.isArray(value)) return value.map((item) => substituteStepValue(item, vars)) as T;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const isForEach = obj.action === "forEach";
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      result[key] = isForEach && key === "steps" ? child : substituteStepValue(child, vars);
    }
    return result as T;
  }
  return value;
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
      step = substituteStepValue(rawStep, { ...bindings, ...scope }) as Step;
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
        const matches = allTabs.filter(
          (t) => t.id !== undefined && tabMatchesHost(t.url, step.host)
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
        await chromeApi.tabs?.update?.(match.id, { active: true });
        if (match.windowId !== undefined) {
          await chromeApi.windows?.update?.(match.windowId, { focused: true });
        }
        currentTabId = match.id;
        results.push({ ok: true, tab: step.host });
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
        func: executeDomStepInPage,
        args: [step],
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

      const res = await sendBgMessage({ kind: "HANDS_RUN_SCRIPT", script: target.script });
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

async function loadServerEntries(): Promise<LibraryEntryWithStats[]> {
  try {
    const resp = await fetch(`${SERVER_URL}/library`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      ok?: boolean;
      items?: LibraryEntryWithStats[];
    };
    if (data?.ok === false || !Array.isArray(data?.items)) return [];
    return data.items;
  } catch {
    return [];
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
