import type { Event, EventMeta, EventType } from "../../shared/contract.ts";
import { extractGridContext, extractMenuContext, extractTarget } from "./locators.ts";
import { inspectElementPrivacy, sanitizeUrl, sanitizeValue } from "./privacy.ts";

export type WatcherMode = "all_raw" | "all_throttled" | "semantic";

export interface WatcherConfig {
  mode: WatcherMode;
  endpoint: string;
  batchMs: number;
  maxBatchSize: number;
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
}

const SESSION_ID =
  typeof sessionStorage !== "undefined"
    ? (() => {
        try {
          const existing = sessionStorage.getItem("__eyes_session__");
          if (existing) return existing;
          const created = "sess_" + Math.random().toString(36).slice(2, 10);
          sessionStorage.setItem("__eyes_session__", created);
          return created;
        } catch {
          return "sess_default";
        }
      })()
    : "sess_default";

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
      emit("click", e.target, undefined, {
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

      if (getConfig().mode === "semantic") return;

      const privacyCheck = inspectElementPrivacy(targetEl);
      const currentVal = getElementValue(targetEl) ?? "";
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
    },
    true
  );

  document.addEventListener(
    "focus",
    (e: FocusEvent) => {
      lastFocusInTs = Date.now();
      const targetEl = e.target instanceof HTMLElement ? e.target : null;
      if (targetEl) {
        typingSessions.set(targetEl, {
          el: targetEl,
          startedAt: Date.now(),
          lastKeyAt: Date.now(),
          keystrokeCount: 0,
          backspaceCount: 0,
          initialValue: getElementValue(targetEl) ?? "",
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

setupEventListeners();
