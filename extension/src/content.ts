import type { Event, EventMeta, EventType } from "@gen/shared";
import { executeStep } from "./hands/execute.ts";
import { extractGridContext, extractMenuContext, extractTarget } from "./locators.ts";
import { inspectElementPrivacy, sanitizeUrl, sanitizeValue } from "./privacy.ts";
import { buildDeciderSuggestion, createSuggestionEngine } from "./suggestion.ts";
import type { FlowNode, Suggestion } from "./suggestion.ts";
import { suggestionToOptimization } from "./library.ts";
import type { ActionScript } from "./types.ts";

export type WatcherMode = "all_raw" | "all_throttled" | "semantic";

export interface WatcherConfig {
  mode: WatcherMode;
  endpoint: string;
  batchMs: number;
  maxBatchSize: number;
  clickReplayUrl?: string;
}

interface TypingSession {
  el: HTMLElement;
  startedAt: number;
  lastKeyAt: number;
  keystrokeCount: number;
  backspaceCount: number;
  lastInputType?: string;
  initialValue: string;
}

interface GlobalEyesWindow {
  __EYES_WATCHER_ACTIVE__?: boolean;
  __EYES_CONFIG__?: Partial<WatcherConfig>;
  __EYES_COLLECT__?: (e: Event) => void;
  __EYES_FLUSH__?: () => Promise<void>;
  __HANDS_LAST_EDITABLE__?: HTMLElement | null;
  __HANDS_LAST_CSS__?: string | null;
  __HANDS_CLEANUP__?: () => void;
  __HANDS_CHROME_RUNTIME__?: unknown;
  __HANDS_ON_MESSAGE__?: (
    message: unknown,
    sender: unknown,
    sendResponse: (res?: unknown) => void
  ) => boolean;
}

const SESSION_ID = (() => {
  try {
    if (typeof sessionStorage === "undefined") return "sess_default";
    const existing = sessionStorage.getItem("__eyes_session__");
    if (existing) return existing;
    const created = "sess_" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("__eyes_session__", created);
    return created;
  } catch {
    return "sess_default";
  }
})();

function getConfig(): WatcherConfig {
  const win = (typeof window !== "undefined" ? window : {}) as unknown as GlobalEyesWindow;
  return {
    mode: win.__EYES_CONFIG__?.mode ?? "all_throttled",
    endpoint: win.__EYES_CONFIG__?.endpoint ?? "http://localhost:8787/events",
    batchMs: win.__EYES_CONFIG__?.batchMs ?? 250,
    maxBatchSize: win.__EYES_CONFIG__?.maxBatchSize ?? 50,
  };
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "evt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
}

const SUGGESTION_HOST_ID = "__eyes_suggestion_host__";

function extensionAssetUrl(assetPath: string): string | undefined {
  const chromeGlobal = (globalThis as Record<string, unknown>).chrome as
    | { runtime?: { id?: string; getURL?: (path: string) => string } }
    | undefined;
  if (chromeGlobal?.runtime?.id && typeof chromeGlobal.runtime.getURL === "function") {
    return chromeGlobal.runtime.getURL(assetPath);
  }
  return undefined;
}

const suggestionEngine = createSuggestionEngine({
  clickReplayUrl:
    extensionAssetUrl("dist/replay-demo.mp4") ?? getConfig().clickReplayUrl,
});
const committedTextByElement = new WeakMap<HTMLElement, string>();
let lastSuggestionShownAt = 0;

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
  const arrowSvg = `
    <svg class="flow-arrow" viewBox="0 0 14 10" width="12" height="10" aria-hidden="true">
      <path d="M1 5h10M8.5 2.5L11.5 5l-3 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
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

function renderFlows(suggestion: Suggestion): string {
  const hasLoop = suggestion.flows.user.some((node) => node.kind === "loop");
  const loopArc = hasLoop
    ? `
      <svg class="loop-arc" viewBox="0 0 360 16" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 318 1 C 318 12, 308 13, 294 13 L 52 13 C 40 13, 34 11, 34 3" fill="none" stroke="#B7AEA0" stroke-width="1.1" stroke-dasharray="3 2.5"/>
        <path d="M 31 6 L 34 2 L 37 6" fill="none" stroke="#9C9385" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `
    : "";

  return `
    <div class="dag-canvas">
      <div class="flow" data-eyes-flow="user">
        <div class="flow-head">
          <span>Your flow</span>
          <span class="flow-sub">Manual cycle</span>
        </div>
        <div class="flow-track">${renderFlowNodes(suggestion.flows.user)}</div>
        ${loopArc}
      </div>
      <div class="dag-divider"></div>
      <div class="flow" data-eyes-flow="proposed">
        <div class="flow-head">
          <span class="flow-head-eyes">Eyes flow</span>
          <span class="flow-sub">Single pass</span>
        </div>
        <div class="flow-track">${renderFlowNodes(suggestion.flows.proposed)}</div>
      </div>
    </div>
  `;
}

function renderReplay(suggestion: Suggestion): string {
  if (suggestion.kind === "text" || !suggestion.videoUrl) return "";
  return `
    <div class="replay" data-eyes-replay>
      <video src="${escapeHtml(suggestion.videoUrl)}" autoplay muted loop playsinline preload="metadata"></video>
      <div class="replay-bar">
        <span class="replay-caption">Automation replay</span>
      </div>
    </div>
  `;
}

function isEyesUiTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-eyes-ui]"));
}

function sendLibraryMessage(message: unknown): void {
  const chromeGlobal = (globalThis as Record<string, unknown>).chrome as
    | { runtime?: { id?: string; sendMessage?: (msg: unknown) => void } }
    | undefined;
  if (chromeGlobal?.runtime?.id && typeof chromeGlobal.runtime.sendMessage === "function") {
    try {
      chromeGlobal.runtime.sendMessage(message);
    } catch {
      // ignore invalidated runtime
    }
  }
}

interface ShowSuggestionOptions {
  onDecision?: (decision: "approved" | "dismissed") => void;
  script?: ActionScript;
  force?: boolean;
}

function showSuggestion(
  suggestion: Suggestion | null,
  options: ShowSuggestionOptions = {}
): void {
  if (!suggestion) return;
  if (typeof document === "undefined" || !document.documentElement) return;
  if (window.top !== window.self) return;

  const existing = document.getElementById(SUGGESTION_HOST_ID);
  if (existing && !options.force && Date.now() - lastSuggestionShownAt < 800) return;
  existing?.remove();
  lastSuggestionShownAt = Date.now();

  let settled = false;
  const resolveDecision = (decision: "approved" | "dismissed"): void => {
    if (settled) return;
    settled = true;
    console.log("[eyes-content] decider decision:", decision, suggestion.id);
    options.onDecision?.(decision);
  };

  const appHost = typeof location !== "undefined" ? location.hostname || "Browser" : "Browser";
  if (!options.onDecision) {
    const suggestedItem = suggestionToOptimization(suggestion, { app: appHost, status: "suggested" });
    if (options.script) suggestedItem.script = options.script;
    sendLibraryMessage({
      kind: "EYES_UPSERT_OPTIMIZATION",
      item: suggestedItem,
    });
  }

  const host = document.createElement("div");
  host.id = SUGGESTION_HOST_ID;
  host.setAttribute("data-eyes-ui", "true");
  host.setAttribute("data-eyes-suggestion", suggestion.kind);
  host.style.position = "fixed";
  host.style.top = "12px";
  host.style.right = "12px";
  host.style.bottom = "auto";
  host.style.left = "auto";
  host.style.display = "flex";
  host.style.flexDirection = "column";
  host.style.width = "min(336px, calc(100% - 24px))";
  host.style.maxWidth = "calc(100% - 24px)";
  host.style.maxHeight = "calc(100% - 24px)";
  host.style.margin = "0";
  host.style.padding = "0";
  host.style.border = "0";
  host.style.boxSizing = "border-box";
  host.style.transform = "none";
  host.style.zIndex = "2147483647";

  const shadow = host.attachShadow({ mode: "open" });
  const previewClass = suggestion.kind === "text" ? "snippet" : "keycap";
  const eyesMark = `
    <svg class="eyes-mark" data-eyes-brand-mark viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M2 10c2.2-3.6 5-5.4 8-5.4s5.8 1.8 8 5.4c-2.2 3.6-5 5.4-8 5.4S4.2 13.6 2 10Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="10" cy="10" r="2.3" fill="currentColor"/>
    </svg>
  `;

  const primaryButtonLabel = suggestion.kind === "text" ? "Insert" : "Run";
  const successTitle = suggestion.kind === "text" ? "Inserted." : "Running.";
  const successSubtitle =
    suggestion.kind === "text"
      ? "Text pasted into the active field."
      : "Eyes is executing this shortcut now.";

  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        display: flex;
        flex-direction: column;
        --shell: #f1ede4;
        --canvas: #faf8f4;
        --surface-node: #fcfbf8;
        --surface-graph: #f3efe7;
        --surface-eyes: #f4e8d8;
        --ink: #1a1917;
        --ink-2: #57524b;
        --ink-muted: #7b756d;
        --brown: #8a5a2b;
        --brown-border: #ccb08d;
        --line: #e2dcd0;
        --line-strong: #d0c8b9;
        --ok: #2e6b43;
      }
      *, *::before, *::after { box-sizing: border-box; }
      .card {
        display: flex;
        flex-direction: column;
        flex: 0 1 auto;
        width: 100%;
        max-width: 100%;
        min-height: 0;
        max-height: calc(100vh - 24px);
        max-height: calc(100dvh - 24px);
        overflow: hidden;
        border: 1px solid rgba(26, 25, 23, 0.14);
        border-radius: 10px;
        background: var(--canvas);
        color: var(--ink);
        box-shadow: 0 16px 36px rgba(26, 25, 23, 0.16), 0 2px 6px rgba(26, 25, 23, 0.08);
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 12px;
        line-height: 1.38;
        -webkit-font-smoothing: antialiased;
        animation: eyes-in 190ms cubic-bezier(.2, .8, .2, 1);
      }
      @keyframes eyes-in {
        from { opacity: 0; transform: translateY(-6px) scale(.99); }
        to { opacity: 1; transform: none; }
      }
      .top {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 10px;
        border-bottom: 1px solid var(--line);
        background: var(--shell);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .eyes-mark {
        color: var(--ink);
        flex: 0 0 auto;
      }
      .product {
        color: var(--ink);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: -0.015em;
      }
      .top-right {
        display: flex;
        align-items: center;
      }
      .close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--ink-muted);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
      }
      .close:hover {
        background: rgba(26, 25, 23, 0.06);
        color: var(--ink);
      }
      .content {
        flex: 1 1 auto;
        min-height: 0;
        padding: 10px 12px;
        overflow-y: auto;
        overflow-x: hidden;
      }
      .head-block {
        margin-bottom: 8px;
      }
      h2 {
        margin: 0 0 2px;
        color: var(--ink);
        font-size: 13.5px;
        font-weight: 600;
        line-height: 1.28;
        letter-spacing: -0.015em;
        overflow-wrap: anywhere;
      }
      p {
        margin: 0;
        color: var(--ink-2);
        font-size: 11.5px;
        overflow-wrap: anywhere;
      }
      .preview {
        margin-bottom: 8px;
        max-width: 100%;
      }
      .preview.snippet {
        padding: 6px 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--shell);
        color: var(--ink-2);
        font-size: 11px;
        line-height: 1.35;
        max-height: 54px;
        overflow-y: auto;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .preview.keycap {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 3px 7px;
        border: 1px solid var(--line-strong);
        border-radius: 5px;
        background: var(--surface-node);
        box-shadow: 0 1px 0 var(--line-strong);
        color: var(--ink);
        font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        font-size: 11px;
        font-weight: 500;
      }
      .replay {
        margin-bottom: 8px;
        overflow: hidden;
        border: 1px solid #2d2a26;
        border-radius: 7px;
        background: #171614;
      }
      .replay video {
        display: block;
        width: 100%;
        max-height: 118px;
        aspect-ratio: 16 / 9;
        object-fit: contain;
        background: #171614;
      }
      .replay-bar {
        display: flex;
        align-items: center;
        padding: 4px 8px;
        border-top: 1px solid #2b2824;
        color: #b8b0a4;
        font-size: 10px;
      }
      .dag-canvas {
        padding: 7px 8px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background-color: var(--surface-graph);
        background-image: radial-gradient(#d8d1c5 0.9px, transparent 0.9px);
        background-size: 11px 11px;
        overflow: hidden;
      }
      .flow-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-bottom: 5px;
        color: var(--ink-2);
        font-size: 9.5px;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .flow-head-eyes {
        color: var(--brown);
      }
      .flow-sub {
        color: var(--ink-muted);
        font-weight: 500;
        letter-spacing: 0.02em;
        text-transform: none;
      }
      .flow-track {
        display: flex;
        align-items: stretch;
        gap: 2px;
        min-width: 0;
        max-width: 100%;
      }
      .flow-node {
        flex: 1 1 0;
        min-width: 0;
        overflow: hidden;
        padding: 4px 5px;
        border: 1px solid var(--line-strong);
        border-radius: 5px;
        background: var(--surface-node);
        box-shadow: 0 1px 1px rgba(26, 25, 23, 0.04);
      }
      .flow-node.eyes-step {
        border-color: var(--brown-border);
        background: var(--surface-eyes);
      }
      .flow-node.loop {
        border-style: dashed;
        background: rgba(250, 248, 244, 0.65);
      }
      .flow-node.done {
        border-color: var(--line-strong);
        background: var(--surface-node);
      }
      .flow-kind {
        display: flex;
        align-items: center;
        gap: 3px;
        margin-bottom: 1px;
        color: var(--ink-muted);
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.02em;
        white-space: nowrap;
        overflow: hidden;
      }
      .flow-node.eyes-step .flow-kind {
        color: var(--brown);
      }
      .flow-node.done .flow-kind {
        color: var(--ok);
      }
      .flow-label {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        overflow-wrap: anywhere;
        word-break: break-word;
        color: var(--ink);
        font-size: 9.5px;
        line-height: 1.2;
      }
      .flow-arrow {
        flex: 0 0 auto;
        align-self: center;
        width: 10px;
        height: 8px;
        color: #9e968b;
      }
      .loop-arc {
        display: block;
        width: 100%;
        height: 12px;
        margin-top: 2px;
      }
      .dag-divider {
        height: 1px;
        margin: 6px 0;
        background: var(--line);
      }
      .footer {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 6px 8px;
        margin-top: 9px;
      }
      .meta {
        color: var(--ink-muted);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 5px;
        margin-left: auto;
        flex-shrink: 0;
      }
      button {
        border-radius: 5px;
        font: inherit;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
      }
      .primary {
        padding: 5px 10px;
        border: 1px solid var(--ink);
        background: var(--ink);
        color: var(--canvas);
        box-shadow: 0 1px 2px rgba(26, 25, 23, 0.16);
      }
      .primary:hover {
        background: #2f2d29;
      }
      .ghost {
        padding: 5px 8px;
        border: 1px solid var(--line-strong);
        background: var(--surface-node);
        color: var(--ink-2);
      }
      .ghost:hover {
        background: var(--shell);
        color: var(--ink);
      }
      .success {
        display: grid;
        gap: 3px;
        padding: 12px;
      }
      .success[hidden] { display: none; }
      .success strong {
        color: var(--ink);
        font-weight: 600;
      }
      .success span {
        color: var(--ink-2);
        font-size: 11.5px;
      }
    </style>
    <section class="card" aria-live="polite" aria-label="Eyes workflow suggestion">
      <header class="top">
        <div class="brand">
          ${eyesMark}
          <span class="product">Eyes</span>
        </div>
        <div class="top-right">
          <button class="close" type="button" data-eyes-dismiss aria-label="Dismiss suggestion">&times;</button>
        </div>
      </header>
      <div class="content" data-eyes-content>
        <div class="head-block">
          <h2>${escapeHtml(suggestion.headline)}</h2>
          <p>${escapeHtml(suggestion.detail)}</p>
        </div>
        <div class="preview ${previewClass}">${escapeHtml(suggestion.preview)}</div>
        ${renderReplay(suggestion)}
        ${renderFlows(suggestion)}
        <div class="footer">
          <div class="meta">${escapeHtml(suggestion.meta)}</div>
          <div class="actions">
            <button class="ghost" type="button" data-eyes-dismiss>Not now</button>
            <button class="primary" type="button" data-eyes-primary>${primaryButtonLabel}</button>
          </div>
        </div>
      </div>
      <div class="success" data-eyes-success hidden>
        <strong>${successTitle}</strong>
        <span>${successSubtitle}</span>
      </div>
    </section>
  `;

  const dismiss = (): void => {
    resolveDecision("dismissed");
    host.remove();
  };
  for (const button of Array.from(shadow.querySelectorAll("[data-eyes-dismiss]"))) {
    button.addEventListener("click", dismiss);
  }
  shadow.querySelector("[data-eyes-primary]")?.addEventListener("click", () => {
    const activeItem = suggestionToOptimization(suggestion, { app: appHost, status: "active" });
    if (options.script) activeItem.script = options.script;
    sendLibraryMessage({
      kind: "EYES_ACTIVATE_OPTIMIZATION",
      id: suggestion.id,
      item: activeItem,
      recordRun: true,
    });
    resolveDecision("approved");
    const content = shadow.querySelector<HTMLElement>("[data-eyes-content]");
    const success = shadow.querySelector<HTMLElement>("[data-eyes-success]");
    if (content) content.hidden = true;
    if (success) success.hidden = false;
    setTimeout(() => host.remove(), 2200);
  });
  shadow.querySelector("video")?.addEventListener("error", () => {
    shadow.querySelector("[data-eyes-replay]")?.remove();
  });

  document.documentElement.appendChild(host);
}

function clearCommittedTextIfChanged(
  element: HTMLElement | null,
  rawValue: string | undefined,
  privacyCheck: ReturnType<typeof inspectElementPrivacy>
): void {
  if (!element) return;
  const committed = committedTextByElement.get(element);
  if (committed === undefined) return;
  const { value } = sanitizeValue(rawValue ?? "", privacyCheck);
  if (value !== committed) {
    committedTextByElement.delete(element);
  }
}

function autoSaveRepeatedSnippet(element: HTMLElement, suggestion: Suggestion): void {
  const snippetText = (suggestion.snippetText ?? suggestion.preview).trim();
  if (!snippetText) return;

  const appHost = typeof location !== "undefined" ? location.hostname || "Browser" : "Browser";
  const shortPreview =
    snippetText.length > 34 ? `${snippetText.slice(0, 34).trim()}...` : snippetText;
  const name = `Insert "${shortPreview}"`;
  const solution = `Insert '${snippetText}' into the currently focused field.`;
  const script: ActionScript = {
    name,
    steps: [{ action: "insertText", value: snippetText }],
  };

  const activeItem = suggestionToOptimization(suggestion, { app: appHost, status: "active" });
  activeItem.title = name;
  activeItem.description = solution;
  activeItem.solution = solution;
  activeItem.script = script;
  sendLibraryMessage({
    kind: "EYES_ACTIVATE_OPTIMIZATION",
    id: activeItem.id,
    item: activeItem,
  });

  const { target } = extractTarget(element);
  const locators = (target?.locators ?? []).filter(
    (loc): loc is { kind: "testid" | "aria" | "css" | "text"; value: string } =>
      loc.kind === "testid" || loc.kind === "aria" || loc.kind === "css" || loc.kind === "text"
  );
  const cleanUrl =
    typeof location !== "undefined" ? sanitizeUrl(location.href).url : undefined;

  sendLibraryMessage({
    kind: "EYES_AUTO_SAVE_LIBRARY",
    name,
    solution,
    script,
    context: {
      app: appHost,
      ...(cleanUrl ? { url: cleanUrl } : {}),
      ...(typeof document !== "undefined" && document.title ? { title: document.title } : {}),
      ...(target?.label ? { targetLabel: target.label } : {}),
      ...(target?.role ? { targetRole: target.role } : {}),
      ...(locators.length > 0 ? { locators } : {}),
    },
  });
}

function recordCommittedText(
  element: HTMLElement | null,
  rawValue: string | undefined,
  privacyCheck: ReturnType<typeof inspectElementPrivacy>,
  force = false
): void {
  if ((window as { __EYES_SUPPRESS_SYNTHETIC__?: boolean }).__EYES_SUPPRESS_SYNTHETIC__) return;
  if (!element || !rawValue) return;

  const { value, privacy } = sanitizeValue(rawValue, privacyCheck);
  if (!value || privacy.redacted) return;

  if (!force && committedTextByElement.get(element) === value) return;
  committedTextByElement.set(element, value);

  const detected = suggestionEngine.recordText(value);
  if (detected) {
    autoSaveRepeatedSnippet(element, detected);
  }
}

function getElementValue(el: HTMLElement | null): string | undefined {
  if (!el) return undefined;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return el.value;
  }
  if (
    el.isContentEditable ||
    el.getAttribute("role") === "gridcell" ||
    el.getAttribute("role") === "textbox"
  ) {
    return (el.innerText || el.textContent || "").trim();
  }
  return undefined;
}

const fallbackBatchQueue: Event[] = [];
let fallbackFlushTimer: ReturnType<typeof setTimeout> | null = null;
let activeFlushPromise: Promise<void> | null = null;

async function drainFallbackQueue(): Promise<void> {
  while (fallbackBatchQueue.length > 0) {
    const batch = fallbackBatchQueue.splice(0, 250);
    const { endpoint } = getConfig();
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
    } catch {
      // Server unreachable
    }
  }
}

async function flushFallbackQueue(): Promise<void> {
  if (fallbackFlushTimer) {
    clearTimeout(fallbackFlushTimer);
    fallbackFlushTimer = null;
  }
  if (activeFlushPromise) {
    await activeFlushPromise;
  }
  if (fallbackBatchQueue.length > 0) {
    activeFlushPromise = drainFallbackQueue().finally(() => {
      activeFlushPromise = null;
    });
    await activeFlushPromise;
  }
}

function dispatchEventToBackend(evt: Event): void {
  const win = (typeof window !== "undefined" ? window : {}) as unknown as GlobalEyesWindow;
  if (typeof win.__EYES_COLLECT__ === "function") {
    win.__EYES_COLLECT__(evt);
    return;
  }

  const chromeGlobal = (globalThis as Record<string, unknown>).chrome as
    | { runtime?: { id?: string; sendMessage?: (msg: unknown) => void } }
    | undefined;

  if (chromeGlobal?.runtime?.id && typeof chromeGlobal.runtime.sendMessage === "function") {
    try {
      chromeGlobal.runtime.sendMessage({ kind: "EYES_EVENT", event: evt });
      return;
    } catch {
      // fall through to direct HTTP batching
    }
  }

  const cfg = getConfig();
  fallbackBatchQueue.push(evt);
  if (fallbackBatchQueue.length >= cfg.maxBatchSize) {
    void flushFallbackQueue();
  } else if (!fallbackFlushTimer) {
    fallbackFlushTimer = setTimeout(() => {
      void flushFallbackQueue();
    }, cfg.batchMs);
  }
}

export function setupEventListeners(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const win = window as unknown as GlobalEyesWindow;
  if (win.__EYES_WATCHER_ACTIVE__) return;
  win.__EYES_WATCHER_ACTIVE__ = true;
  win.__EYES_FLUSH__ = flushFallbackQueue;

  let lastPointerDownTs = Date.now();
  let lastFocusInTs = Date.now();
  let lastHoveredElement: EventTarget | null = null;
  let lastMouseMoveTs = 0;
  let lastScrollTs = 0;
  let lastWheelTs = 0;
  let lastSelectionTs = 0;
  const typingSessions = new WeakMap<HTMLElement, TypingSession>();

  function emit(
    type: EventType,
    rawTarget: EventTarget | null,
    rawValue?: string,
    extraMeta?: EventMeta,
    clipboard?: Event["clipboard"]
  ): void {
    if ((window as { __EYES_SUPPRESS_SYNTHETIC__?: boolean }).__EYES_SUPPRESS_SYNTHETIC__) return;
    if (isEyesUiTarget(rawTarget)) return;

    const { element, target } = extractTarget(rawTarget);
    const privacyCheck = inspectElementPrivacy(element);
    const { value, privacy } = sanitizeValue(rawValue, privacyCheck);
    const { url } = sanitizeUrl(typeof location !== "undefined" ? location.href : undefined);

    const grid = extractGridContext(element, value);
    const menu =
      type === "click" || type === "contextmenu" || type === "mouseup"
        ? extractMenuContext(element)
        : undefined;

    const meta: EventMeta = {
      ...extraMeta,
    };
    if (grid) meta.grid = { ...grid, ...extraMeta?.grid };
    if (menu) meta.menu = { ...menu, ...extraMeta?.menu };
    if (privacy.redacted || privacy.piiTypes || privacy.valueHash) {
      meta.privacy = privacy;
    }

    const evt: Event = {
      v: 1,
      id: uuid(),
      ts: Date.now(),
      session: SESSION_ID,
      source: "browser",
      app: typeof location !== "undefined" ? location.hostname || "local-page" : "unknown",
      window: typeof document !== "undefined" ? document.title : undefined,
      url,
      type,
      target,
      value,
      clipboard,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    };

    dispatchEventToBackend(evt);
  }

  // ---------------------------------------------------------------------------
  // 1. Mouse / Pointer / Drag / Context Menu Events
  // ---------------------------------------------------------------------------
  document.addEventListener(
    "mousedown",
    (e: MouseEvent) => {
      lastPointerDownTs = Date.now();
      if (getConfig().mode === "semantic") return;
      emit("mousedown", e.target, undefined, {
        button: e.button,
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
      });
    },
    true
  );

  document.addEventListener(
    "mouseup",
    (e: MouseEvent) => {
      const dwellMs = Math.max(0, Date.now() - lastPointerDownTs);
      if (getConfig().mode !== "semantic") {
        emit("mouseup", e.target, undefined, {
          button: e.button,
          clientX: Math.round(e.clientX),
          clientY: Math.round(e.clientY),
          dwellMs: dwellMs < 30000 ? dwellMs : undefined,
        });
      }
      const sel = window.getSelection()?.toString().trim() || "";
      if (sel.length >= 2) {
        emit("select", e.target, sel);
      }
    },
    true
  );

  document.addEventListener(
    "mousemove",
    (e: MouseEvent) => {
      const mode = getConfig().mode;
      if (mode === "semantic") return;
      const now = Date.now();
      if (mode === "all_throttled") {
        const targetChanged = e.target !== lastHoveredElement;
        if (!targetChanged && now - lastMouseMoveTs < 200) return;
      }
      lastHoveredElement = e.target;
      lastMouseMoveTs = now;
      emit("mousemove", e.target, undefined, {
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
      });
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "click",
    (e: MouseEvent) => {
      const dwellMs = Math.max(0, Date.now() - lastPointerDownTs);
      const editable = resolveEditableField(e.target);
      emit("click", e.target, editable ? getElementValue(editable) : undefined, {
        button: e.button,
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
        dwellMs: dwellMs < 15000 ? dwellMs : undefined,
      });
    },
    true
  );

  document.addEventListener(
    "dblclick",
    (e: MouseEvent) => {
      emit("dblclick", e.target, getElementValue(e.target as HTMLElement), {
        button: e.button,
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
      });
    },
    true
  );

  document.addEventListener(
    "auxclick",
    (e: MouseEvent) => {
      emit("auxclick", e.target, undefined, {
        button: e.button,
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
      });
    },
    true
  );

  document.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      emit("contextmenu", e.target, undefined, {
        button: e.button,
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
        menu: {
          trigger: e.button === 2 ? "right_click" : "context_key",
        },
      });
    },
    true
  );

  document.addEventListener(
    "dragstart",
    (e: DragEvent) => {
      emit("dragstart", e.target, getElementValue(e.target as HTMLElement), {
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
      });
    },
    true
  );

  document.addEventListener(
    "drop",
    (e: DragEvent) => {
      const droppedText = e.dataTransfer?.getData("text/plain") || undefined;
      emit("drop", e.target, droppedText, {
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
      });
    },
    true
  );

  // ---------------------------------------------------------------------------
  // 2. Keyboard Events (keydown, keyup, shortcuts, & typing stats)
  // ---------------------------------------------------------------------------
  function getModifiers(e: KeyboardEvent): string[] | undefined {
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.metaKey) mods.push("Meta");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    return mods.length > 0 ? mods : undefined;
  }

  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      const targetEl = (
        e.target instanceof HTMLElement ? e.target : document.activeElement
      ) as HTMLElement | null;
      const privacyCheck = inspectElementPrivacy(targetEl);

      if (targetEl) {
        let sess = typingSessions.get(targetEl);
        if (!sess) {
          sess = {
            el: targetEl,
            startedAt: Date.now(),
            lastKeyAt: Date.now(),
            keystrokeCount: 0,
            backspaceCount: 0,
            initialValue: getElementValue(targetEl) ?? "",
          };
          typingSessions.set(targetEl, sess);
        }
        sess.lastKeyAt = Date.now();
        if (e.key === "Backspace") sess.backspaceCount++;
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          sess.keystrokeCount++;
        }
      }

      // Redact key identity if typing inside a sensitive field (e.g. password/card)
      const safeKey =
        privacyCheck.isSensitiveField && e.key.length === 1 ? "[REDACTED]" : e.key;
      const safeCode =
        privacyCheck.isSensitiveField && e.key.length === 1 ? "[REDACTED]" : e.code;

      const mode = getConfig().mode;
      if (mode === "semantic") {
        const isShortcut = e.ctrlKey || e.metaKey || e.altKey || /^F([1-9]|1[0-2])$/.test(e.key);
        const isActionKey = [
          "Enter",
          "Tab",
          "Escape",
          "Delete",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
        ].includes(e.key);
        if (isShortcut || isActionKey) {
          emit("key", targetEl, undefined, {
            key: safeKey,
            code: safeCode,
            modifiers: getModifiers(e),
            repeat: e.repeat || undefined,
          });
        }
        return;
      }

      emit("keydown", targetEl, undefined, {
        key: safeKey,
        code: safeCode,
        modifiers: getModifiers(e),
        repeat: e.repeat || undefined,
      });
    },
    true
  );

  document.addEventListener(
    "keyup",
    (e: KeyboardEvent) => {
      if (getConfig().mode === "semantic") return;
      const targetEl = (
        e.target instanceof HTMLElement ? e.target : document.activeElement
      ) as HTMLElement | null;
      const privacyCheck = inspectElementPrivacy(targetEl);
      const safeKey =
        privacyCheck.isSensitiveField && e.key.length === 1 ? "[REDACTED]" : e.key;
      const safeCode =
        privacyCheck.isSensitiveField && e.key.length === 1 ? "[REDACTED]" : e.code;

      emit("keyup", targetEl, undefined, {
        key: safeKey,
        code: safeCode,
        modifiers: getModifiers(e),
      });
    },
    true
  );

  // ---------------------------------------------------------------------------
  // 3. Input / Form / Focus / Selection Events
  // ---------------------------------------------------------------------------
  document.addEventListener(
    "beforeinput",
    (e: globalThis.Event) => {
      if (getConfig().mode !== "all_raw") return;
      const ie = e as InputEvent;
      const targetEl = e.target instanceof HTMLElement ? e.target : null;
      const privacyCheck = inspectElementPrivacy(targetEl);
      const safeData = privacyCheck.isSensitiveField ? "[REDACTED]" : ie.data ?? undefined;
      emit("beforeinput", targetEl, safeData, {
        typing: {
          inputType: ie.inputType,
          data: safeData,
        },
      });
    },
    true
  );

  document.addEventListener(
    "input",
    (e: globalThis.Event) => {
      const targetEl = e.target instanceof HTMLElement ? e.target : null;
      if (!targetEl) return;
      const ie = e as InputEvent;
      const sess = typingSessions.get(targetEl);
      if (sess && ie.inputType) {
        sess.lastInputType = ie.inputType;
      }

      const privacyCheck = inspectElementPrivacy(targetEl);
      const currentVal = getElementValue(targetEl) ?? "";
      clearCommittedTextIfChanged(targetEl, currentVal, privacyCheck);
      if (getConfig().mode === "semantic") return;
      const durationMs = sess ? Math.max(1, Date.now() - sess.startedAt) : 1;
      const keystrokeCount = sess ? sess.keystrokeCount : 0;
      const isAutofill =
        ie.inputType === "insertReplacementText" ||
        (keystrokeCount <= 1 &&
          ie.inputType !== "insertFromPaste" &&
          currentVal.length >= 4 &&
          durationMs < 80);

      emit("input", targetEl, currentVal, {
        grid: sess?.initialValue ? { prevValue: sess.initialValue } : undefined,
        typing: {
          inputType: ie.inputType || "insertText",
          data: privacyCheck.isSensitiveField ? "[REDACTED]" : ie.data ?? undefined,
          keystrokeCount,
          backspaceCount: sess?.backspaceCount ?? 0,
          typingDurationMs: durationMs,
          isAutofill,
          autofillEligible: privacyCheck.autofillEligible,
          autocompleteAttr: privacyCheck.autocompleteAttr,
          inputName: targetEl.getAttribute("name") || undefined,
          inputTypeAttr: targetEl.getAttribute("type") || undefined,
        },
      });
    },
    true
  );

  document.addEventListener(
    "change",
    (e: globalThis.Event) => {
      const targetEl = e.target instanceof HTMLElement ? e.target : null;
      if (!targetEl) return;
      const sess = typingSessions.get(targetEl);
      const privacyCheck = inspectElementPrivacy(targetEl);
      const currentVal = getElementValue(targetEl) ?? "";
      emit("change", targetEl, currentVal, {
        grid: sess?.initialValue ? { prevValue: sess.initialValue } : undefined,
        typing: {
          inputType: sess?.lastInputType || "change",
          keystrokeCount: sess?.keystrokeCount ?? 0,
          backspaceCount: sess?.backspaceCount ?? 0,
          typingDurationMs: sess ? Math.max(1, Date.now() - sess.startedAt) : undefined,
          autofillEligible: privacyCheck.autofillEligible,
          autocompleteAttr: privacyCheck.autocompleteAttr,
          inputName: targetEl.getAttribute("name") || undefined,
          inputTypeAttr: targetEl.getAttribute("type") || undefined,
        },
      });
      recordCommittedText(targetEl, currentVal, privacyCheck);
    },
    true
  );

  document.addEventListener(
    "focus",
    (e: FocusEvent) => {
      lastFocusInTs = Date.now();
      const targetEl = e.target instanceof HTMLElement ? e.target : null;
      if (targetEl) {
        const currentVal = getElementValue(targetEl) ?? "";
        clearCommittedTextIfChanged(targetEl, currentVal, inspectElementPrivacy(targetEl));
        typingSessions.set(targetEl, {
          el: targetEl,
          startedAt: Date.now(),
          lastKeyAt: Date.now(),
          keystrokeCount: 0,
          backspaceCount: 0,
          initialValue: currentVal,
        });
      }
      if (getConfig().mode === "semantic") return;
      emit("focus", e.target, getElementValue(targetEl));
    },
    true
  );

  document.addEventListener(
    "blur",
    (e: FocusEvent) => {
      const targetEl = e.target instanceof HTMLElement ? e.target : null;
      const dwellMs = Math.max(0, Date.now() - lastFocusInTs);
      const sess = targetEl ? typingSessions.get(targetEl) : undefined;
      const currentVal = getElementValue(targetEl) ?? "";
      const privacyCheck = inspectElementPrivacy(targetEl);

      if (getConfig().mode === "semantic" && targetEl && sess) {
        if (currentVal !== sess.initialValue || sess.keystrokeCount > 0) {
          const durationMs = Math.max(1, Date.now() - sess.startedAt);
          const isAutofill =
            sess.lastInputType === "insertReplacementText" ||
            (sess.keystrokeCount <= 1 &&
              sess.lastInputType !== "insertFromPaste" &&
              Math.abs(currentVal.length - sess.initialValue.length) >= 4 &&
              durationMs < 80);
          emit("input", targetEl, currentVal, {
            subType: "blur_commit",
            grid: sess.initialValue ? { prevValue: sess.initialValue } : undefined,
            typing: {
              inputType: sess.lastInputType || "insertText",
              keystrokeCount: sess.keystrokeCount,
              backspaceCount: sess.backspaceCount,
              typingDurationMs: durationMs,
              isAutofill,
              autofillEligible: privacyCheck.autofillEligible,
              autocompleteAttr: privacyCheck.autocompleteAttr,
              inputName: targetEl.getAttribute("name") || undefined,
              inputTypeAttr: targetEl.getAttribute("type") || undefined,
            },
          });
          recordCommittedText(targetEl, currentVal, privacyCheck);
        }
        typingSessions.delete(targetEl);
        return;
      }

      emit("blur", e.target, currentVal, {
        dwellMs: dwellMs < 600000 ? dwellMs : undefined,
        grid: sess?.initialValue ? { prevValue: sess.initialValue } : undefined,
        typing: sess
          ? {
              inputType: sess.lastInputType || "insertText",
              keystrokeCount: sess.keystrokeCount,
              backspaceCount: sess.backspaceCount,
              typingDurationMs: Math.max(1, Date.now() - sess.startedAt),
              isAutofill:
                sess.lastInputType === "insertReplacementText" ||
                (sess.keystrokeCount <= 1 &&
                  sess.lastInputType !== "insertFromPaste" &&
                  Math.abs(currentVal.length - sess.initialValue.length) >= 4),
              autofillEligible: privacyCheck.autofillEligible,
              autocompleteAttr: privacyCheck.autocompleteAttr,
              inputName: targetEl?.getAttribute("name") || undefined,
              inputTypeAttr: targetEl?.getAttribute("type") || undefined,
            }
          : undefined,
      });
      if (targetEl && sess && (currentVal !== sess.initialValue || sess.keystrokeCount > 0)) {
        recordCommittedText(targetEl, currentVal, privacyCheck);
      }
      if (targetEl) typingSessions.delete(targetEl);
    },
    true
  );

  document.addEventListener(
    "selectionchange",
    () => {
      const mode = getConfig().mode;
      if (mode === "semantic") return;
      const now = Date.now();
      if (mode === "all_throttled" && now - lastSelectionTs < 200) return;
      lastSelectionTs = now;
      const sel = window.getSelection()?.toString().trim() || "";
      if (sel.length > 0) {
        emit("selectionchange", document.activeElement, sel);
      }
    },
    true
  );

  // ---------------------------------------------------------------------------
  // 4. Clipboard Events (copy, cut, paste)
  // ---------------------------------------------------------------------------
  document.addEventListener(
    "copy",
    (e: ClipboardEvent) => {
      const selText =
        e.clipboardData?.getData("text/plain") ||
        window.getSelection()?.toString() ||
        getElementValue(e.target as HTMLElement) ||
        "";
      const { value: cleanText, privacy } = sanitizeValue(
        selText,
        inspectElementPrivacy(e.target as Element)
      );
      const grid = extractGridContext(e.target as HTMLElement, cleanText);
      emit(
        "copy",
        e.target,
        cleanText,
        { privacy },
        {
          fromApp: location.hostname || "local-page",
          fromUrl: sanitizeUrl(location.href).url,
          fromCell: grid?.cellRef,
          text: cleanText,
          textHash: privacy.valueHash,
        }
      );
    },
    true
  );

  document.addEventListener(
    "cut",
    (e: ClipboardEvent) => {
      const selText =
        e.clipboardData?.getData("text/plain") ||
        window.getSelection()?.toString() ||
        getElementValue(e.target as HTMLElement) ||
        "";
      const { value: cleanText, privacy } = sanitizeValue(
        selText,
        inspectElementPrivacy(e.target as Element)
      );
      emit(
        "cut",
        e.target,
        cleanText,
        { privacy },
        {
          fromApp: location.hostname || "local-page",
          text: cleanText,
          textHash: privacy.valueHash,
        }
      );
    },
    true
  );

  document.addEventListener(
    "paste",
    (e: ClipboardEvent) => {
      const pastedText = e.clipboardData?.getData("text/plain") || "";
      const elCheck = inspectElementPrivacy(e.target as Element);
      const { value: cleanText, privacy } = sanitizeValue(pastedText, elCheck);
      emit(
        "paste",
        e.target,
        cleanText,
        { privacy },
        {
          toApp: location.hostname || "local-page",
          text: cleanText,
          textHash: privacy.valueHash,
        }
      );
      recordCommittedText(
        e.target instanceof HTMLElement ? e.target : null,
        cleanText,
        elCheck,
        true
      );
    },
    true
  );

  // ---------------------------------------------------------------------------
  // 5. Form Submit / Reset
  // ---------------------------------------------------------------------------
  document.addEventListener(
    "submit",
    (e: SubmitEvent) => {
      emit("submit", e.target);
    },
    true
  );

  document.addEventListener(
    "reset",
    (e: globalThis.Event) => {
      emit("reset", e.target);
    },
    true
  );

  // ---------------------------------------------------------------------------
  // 6. Scroll & Wheel Events
  // ---------------------------------------------------------------------------
  window.addEventListener(
    "scroll",
    () => {
      const mode = getConfig().mode;
      const now = Date.now();
      if (mode !== "all_raw" && now - lastScrollTs < 250) return;
      lastScrollTs = now;
      emit("scroll", document.documentElement, undefined, {
        scroll: {
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          deltaX: 0,
          deltaY: Math.round(window.scrollY),
        },
      });
    },
    { passive: true }
  );

  window.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      const mode = getConfig().mode;
      if (mode === "semantic") return;
      const now = Date.now();
      if (mode === "all_throttled" && now - lastWheelTs < 200) return;
      lastWheelTs = now;
      emit("wheel", e.target, undefined, {
        scroll: {
          deltaX: Math.round(e.deltaX),
          deltaY: Math.round(e.deltaY),
        },
      });
    },
    { passive: true }
  );

  // ---------------------------------------------------------------------------
  // 7. Navigation / Visibility / Window Focus Lifecycle
  // ---------------------------------------------------------------------------
  window.addEventListener("popstate", () => {
    emit("nav", document.body, location.href, { subType: "popstate" });
  });

  window.addEventListener("hashchange", () => {
    emit("nav", document.body, location.href, { subType: "hashchange" });
  });

  document.addEventListener("visibilitychange", () => {
    emit("visibilitychange", document.body, document.visibilityState);
  });

  window.addEventListener("focus", () => {
    if (getConfig().mode === "semantic") return;
    emit("window_focus", document.body);
  });

  window.addEventListener("blur", () => {
    if (getConfig().mode === "semantic") return;
    emit("window_blur", document.body);
  });

  // ---------------------------------------------------------------------------
  // 8. Authorization Flow & DOM Mutation Observer
  // ---------------------------------------------------------------------------
  function checkUrlForAuthFlow(): void {
    const href = location.href;
    if (
      /\/(oauth2?|authorize|consent|sso|login|signin)\b/i.test(href) ||
      /[?&](client_id|redirect_uri|response_type|scope)=/i.test(href)
    ) {
      const parsed = new URL(href);
      const scopes = parsed.searchParams.get("scope")?.split(/[\s,]+/).filter(Boolean);
      emit("auth_flow", document.body, undefined, {
        auth: {
          flowType: /consent|authorize|oauth/i.test(href) ? "oauth_authorize" : "sso_login",
          provider: location.hostname,
          clientId: parsed.searchParams.get("client_id") || undefined,
          scopes,
          isPopup: Boolean(window.opener),
        },
      });
    }
  }

  const observedNodes = new WeakSet<Node>();
  const observer = new MutationObserver((mutations) => {
    const mode = getConfig().mode;
    let addedCount = 0;
    let removedCount = 0;

    for (const m of mutations) {
      addedCount += m.addedNodes.length;
      removedCount += m.removedNodes.length;

      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof HTMLElement) || observedNodes.has(node)) continue;
        observedNodes.add(node);

        const role = node.getAttribute("role");
        const isDialog =
          role === "dialog" ||
          role === "alertdialog" ||
          node.tagName === "DIALOG" ||
          node.getAttribute("aria-modal") === "true" ||
          node.hasAttribute("data-auth-modal");
        const isMenu =
          role === "menu" ||
          node.classList.contains("context-menu") ||
          node.hasAttribute("data-context-menu");
        const isAlert = role === "alert" || role === "status" || node.hasAttribute("data-toast");

        if (isDialog) {
          const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
          if (
            /\b(authorize|allow access|grant permission|sign in with|oauth|permissions requested)\b/i.test(
              text
            )
          ) {
            emit("auth_flow", node, undefined, {
              auth: {
                flowType: "consent_dialog",
                provider: location.hostname,
              },
              uiChange: {
                kind: "dialog_open",
                summary: text.slice(0, 120),
              },
            });
          } else {
            emit("ui_change", node, undefined, {
              uiChange: {
                kind: "dialog_open",
                summary: text.slice(0, 120),
              },
            });
          }
        } else if (isMenu) {
          const items = Array.from(
            node.querySelectorAll('[role="menuitem"], [data-menu-item], li, button')
          )
            .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .slice(0, 8)
            .join(" | ");
          emit("ui_change", node, undefined, {
            uiChange: {
              kind: "context_menu_open",
              summary: items.slice(0, 140),
            },
          });
        } else if (isAlert) {
          const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
          if (text) {
            emit("ui_change", node, undefined, {
              uiChange: {
                kind: "toast_alert",
                summary: text.slice(0, 120),
              },
            });
          }
        }
      }
    }

    if (mode === "all_raw" && (addedCount > 0 || removedCount > 0)) {
      emit("dom_mutation", document.body, undefined, {
        uiChange: {
          kind: "dom_mutation",
          addedCount,
          removedCount,
          summary: `+${addedCount}/-${removedCount} nodes`,
        },
      });
    }
  });

  function startDomObservers(): void {
    emit("nav", document.body, location.href, { subType: "page_load" });
    checkUrlForAuthFlow();
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startDomObservers, { once: true });
  } else {
    startDomObservers();
  }
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "hidden",
  "image",
  "range",
  "color",
  "password",
]);

function resolveEditableField(raw: unknown): HTMLElement | null {
  if (!(raw instanceof HTMLElement)) return null;
  if (raw instanceof HTMLTextAreaElement) {
    return raw.disabled || raw.readOnly ? null : raw;
  }
  if (raw instanceof HTMLInputElement) {
    const inputType = (raw.getAttribute("type") || "text").toLowerCase();
    if (NON_TEXT_INPUT_TYPES.has(inputType) || raw.disabled || raw.readOnly) return null;
    return raw;
  }
  if (raw.isContentEditable) {
    const root = raw.closest<HTMLElement>(
      '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    );
    return root ?? raw;
  }
  return null;
}

function getDeepActiveElement(): Element | null {
  if (typeof document === "undefined") return null;
  let active: Element | null = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

function setupHandsTracker(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const win = window as unknown as GlobalEyesWindow;

  win.__HANDS_CLEANUP__?.();

  const chromeRuntime = (globalThis as Record<string, unknown>).chrome as
    | {
        runtime?: {
          id?: string;
          sendMessage?: (msg: unknown) => void;
          onMessage?: {
            addListener: (
              cb: (
                message: unknown,
                sender: unknown,
                sendResponse: (res?: unknown) => void
              ) => boolean
            ) => void;
          };
        };
      }
    | undefined;

  function recordCandidate(raw: unknown, notifyBackground: boolean): void {
    const editable = resolveEditableField(raw);
    if (!editable) return;
    win.__HANDS_LAST_EDITABLE__ = editable;
    const { target } = extractTarget(editable);
    win.__HANDS_LAST_CSS__ = target?.locators.find((locator) => locator.kind === "css")?.value ?? null;
    if (notifyBackground && chromeRuntime?.runtime?.id && chromeRuntime.runtime.sendMessage) {
      try {
        chromeRuntime.runtime.sendMessage({ kind: "HANDS_FIELD_FOCUSED" });
      } catch {
        // ignore invalidated runtime
      }
    }
  }

  const onFieldInteraction = (e: globalThis.Event): void => {
    const first = typeof e.composedPath === "function" ? e.composedPath()[0] : e.target;
    recordCandidate(first ?? e.target, true);
  };

  const trackedEvents = ["focusin", "pointerdown", "click", "input", "keydown"] as const;
  for (const evtName of trackedEvents) {
    document.addEventListener(evtName, onFieldInteraction, true);
  }

  win.__HANDS_CLEANUP__ = () => {
    for (const evtName of trackedEvents) {
      document.removeEventListener(evtName, onFieldInteraction, true);
    }
  };

  recordCandidate(getDeepActiveElement(), true);

  win.__HANDS_ON_MESSAGE__ = (message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    const msg = message as {
      kind?: string;
      text?: string;
      requireResponse?: boolean;
      name?: string;
      solution?: string;
      script?: ActionScript;
    };

    if (msg.kind === "EYES_SHOW_DECIDER") {
      console.log("[eyes-content] received EYES_SHOW_DECIDER", {
        isTop: window.top === window.self,
        name: msg.name,
        steps: msg.script?.steps?.length,
      });
      if (window.top !== window.self) return false;
      if (typeof msg.solution !== "string" || !msg.script || !Array.isArray(msg.script.steps)) {
        sendResponse({ ok: false, error: "Invalid decider payload" });
        return false;
      }
      const suggestion = buildDeciderSuggestion({
        name: typeof msg.name === "string" ? msg.name : "",
        solution: msg.solution,
        script: msg.script,
      });
      showSuggestion(suggestion, {
        force: true,
        script: msg.script,
        onDecision: (decision) => sendResponse({ ok: true, decision }),
      });
      return true;
    }

    if (msg.kind !== "HANDS_INSERT_LAST_FIELD" || typeof msg.text !== "string") return false;

    let targetEl: HTMLElement | null =
      win.__HANDS_LAST_EDITABLE__ && win.__HANDS_LAST_EDITABLE__.isConnected
        ? win.__HANDS_LAST_EDITABLE__
        : null;

    if (!targetEl) {
      targetEl = resolveEditableField(getDeepActiveElement());
    }
    if (!targetEl && win.__HANDS_LAST_CSS__) {
      try {
        targetEl = resolveEditableField(document.querySelector(win.__HANDS_LAST_CSS__));
      } catch {
        targetEl = null;
      }
    }

    if (!targetEl) {
      if (msg.requireResponse) {
        sendResponse({ ok: false, error: "No recent editable field found" });
      }
      return false;
    }

    win.__HANDS_LAST_EDITABLE__ = targetEl;
    void executeStep({ action: "insertText", value: msg.text }, targetEl)
      .then((result) => sendResponse(result))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Insert failed" })
      );
    return true;
  };

  if (chromeRuntime?.runtime?.onMessage && win.__HANDS_CHROME_RUNTIME__ !== chromeRuntime.runtime) {
    win.__HANDS_CHROME_RUNTIME__ = chromeRuntime.runtime;
    chromeRuntime.runtime.onMessage.addListener((message, sender, sendResponse) => {
      return win.__HANDS_ON_MESSAGE__
        ? win.__HANDS_ON_MESSAGE__(message, sender, sendResponse)
        : false;
    });
  }
}

setupHandsTracker();
setupEventListeners();
