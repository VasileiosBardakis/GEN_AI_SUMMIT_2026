import { afterEach, describe, expect, it } from "vitest";
import type { Event as RecordedEvent } from "@gen/shared";
import { setupEventListeners } from "../src/content.ts";
import { executeStep } from "../src/hands/execute.ts";
import { extractGridContext, extractTarget } from "../src/locators.ts";

class FakeClassList {
  private set = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) {
      if (token) this.set.add(token);
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.set.delete(token);
  }

  contains(token: string): boolean {
    return this.set.has(token);
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.set.values();
  }
}

class FakeElement {
  nodeType = 1;
  tagName: string;
  id = "";
  value = "";
  type = "";
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  isContentEditable = false;
  isConnected = true;
  style: Record<string, string> = {};
  classList = new FakeClassList();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  ownerDocument: FakeDocument | null = null;
  labels: FakeElement[] = [];
  shadowRoot: { activeElement: FakeElement | null } | null = null;
  private ownText = "";
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(
    tagName: string,
    attrs: Record<string, string> = {},
    text = "",
    opts: { ownerDocument?: FakeDocument; value?: string; isContentEditable?: boolean } = {}
  ) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = opts.ownerDocument ?? null;
    for (const [k, v] of Object.entries(attrs)) {
      this.setAttribute(k, v);
    }
    this.ownText = text;
    if (opts.value !== undefined) this.value = opts.value;
    if (opts.isContentEditable !== undefined) this.isContentEditable = opts.isContentEditable;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === "id") this.id = value;
    if (name === "type") this.type = value;
    if (name === "value") this.value = value;
    if (name === "class") {
      this.classList = new FakeClassList();
      for (const cls of value.split(/\s+/).filter(Boolean)) {
        this.classList.add(cls);
      }
    }
    if (name === "contenteditable" && value !== "false") {
      this.isContentEditable = true;
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === "id") this.id = "";
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    if (!child.ownerDocument && this.ownerDocument) {
      child.ownerDocument = this.ownerDocument;
    }
    this.children.push(child);
    return child;
  }

  get textContent(): string {
    if (this.children.length === 0) return this.ownText;
    return [this.ownText, ...this.children.map((c) => c.textContent)]
      .filter(Boolean)
      .join(" ");
  }

  set textContent(val: string) {
    this.ownText = val;
    this.children = [];
  }

  get innerText(): string {
    return this.textContent;
  }

  contains(other: unknown): boolean {
    if (other === this) return true;
    for (const child of this.children) {
      if (child.contains(other)) return true;
    }
    return false;
  }

  getClientRects(): Array<{ top: number; left: number; width: number; height: number }> {
    if (this.style.display === "none" || this.style.visibility === "hidden") return [];
    return [{ top: 0, left: 0, width: 100, height: 24 }];
  }

  getBoundingClientRect(): { top: number; left: number; width: number; height: number } {
    return { top: 0, left: 0, width: 100, height: 24 };
  }

  focus(): void {
    if (this.ownerDocument) {
      this.ownerDocument.activeElement = this;
    }
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  dispatchEvent(ev: { type: string; target?: unknown; defaultPrevented?: boolean }): boolean {
    if (!ev.target) ev.target = this;
    const captureListeners = this.ownerDocument?.getCaptureListeners(ev.type) ?? [];
    for (const cb of captureListeners) {
      cb(ev);
    }
    for (const cb of this.listeners.get(ev.type) ?? []) {
      cb(ev);
    }
    return !ev.defaultPrevented;
  }

  private matchesSimple(sel: string): boolean {
    let remaining = sel.trim();
    if (!remaining) return false;

    const tagMatch = /^([a-z0-9]+)/i.exec(remaining);
    if (tagMatch) {
      if (this.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
      remaining = remaining.slice(tagMatch[1].length);
    }

    const idMatch = /#([a-z0-9_-]+)/i.exec(remaining);
    if (idMatch) {
      if (this.id !== idMatch[1]) return false;
      remaining = remaining.replace(idMatch[0], "");
    }

    const classMatches = Array.from(remaining.matchAll(/\.([a-z0-9_-]+)/gi));
    for (const cm of classMatches) {
      if (!this.classList.contains(cm[1])) return false;
      remaining = remaining.replace(cm[0], "");
    }

    const attrMatches = Array.from(
      remaining.matchAll(/\[([a-z0-9_-]+)(?:(\*?=)["']([^"']*)["'](?:\s+i)?)?\]/gi)
    );
    for (const am of attrMatches) {
      const attrName = am[1];
      const op = am[2];
      const expected = am[3];
      const actual = this.getAttribute(attrName);
      if (actual === null) return false;
      if (op === "=" && actual !== expected) return false;
      if (op === "*=" && !actual.toLowerCase().includes((expected ?? "").toLowerCase())) {
        return false;
      }
      remaining = remaining.replace(am[0], "");
    }

    return remaining.trim() === "";
  }

  matches(selector: string): boolean {
    const branches = selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const branch of branches) {
      const chain = branch.split(/\s+/).filter(Boolean);
      if (chain.length === 0) continue;
      if (!this.matchesSimple(chain[chain.length - 1]!)) continue;
      if (chain.length === 1) return true;
      let curr: FakeElement | null = this.parentElement;
      let idx = chain.length - 2;
      while (curr && idx >= 0) {
        if (curr.matchesSimple(chain[idx]!)) idx--;
        curr = curr.parentElement;
      }
      if (idx < 0) return true;
    }
    return false;
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    let curr: FakeElement | null = this.parentElement;
    while (curr) {
      if (curr.matches(selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  documentElement: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  readyState = "complete";
  visibilityState = "visible";
  title = "Budget 2026 - Google Sheets";
  private listeners = new Map<string, Array<{ cb: (ev: unknown) => void; capture: boolean }>>();

  constructor() {
    this.documentElement = new FakeElement("html", {}, "", { ownerDocument: this });
    this.body = new FakeElement("body", {}, "", { ownerDocument: this });
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, {}, "", { ownerDocument: this });
  }

  getElementById(id: string): FakeElement | null {
    return this.querySelector(`#${id}`);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }

  addEventListener(
    type: string,
    cb: (ev: unknown) => void,
    opts?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ cb, capture });
    this.listeners.set(type, list);
  }

  getCaptureListeners(type: string): Array<(ev: unknown) => void> {
    return (this.listeners.get(type) ?? []).filter((l) => l.capture).map((l) => l.cb);
  }

  dispatchEvent(ev: { type: string; target?: unknown; defaultPrevented?: boolean }): boolean {
    for (const entry of this.listeners.get(ev.type) ?? []) {
      entry.cb(ev);
    }
    return !ev.defaultPrevented;
  }
}

class FakeHTMLInputElement extends FakeElement {}

function buildSheetsDoc(opts: { cellRef?: string; sheetName?: string } = {}): {
  doc: FakeDocument;
  nameBox: FakeElement;
  formulaBar: FakeElement;
  cellInput: FakeElement;
  canvas: FakeElement;
  sheetTabName: FakeElement;
} {
  const doc = new FakeDocument();
  const nameBox = new FakeHTMLInputElement(
    "input",
    { id: "t-name-box", type: "text", "aria-label": "Name box" },
    "",
    { ownerDocument: doc, value: opts.cellRef ?? "B4" }
  );
  const formulaBar = new FakeElement(
    "div",
    { id: "t-formula-bar-input", contenteditable: "true", role: "textbox" },
    "",
    { ownerDocument: doc, isContentEditable: true }
  );
  const gridContainer = new FakeElement(
    "div",
    { id: "waffle-grid-container", class: "grid-container" },
    "",
    { ownerDocument: doc }
  );
  const canvas = new FakeElement("canvas", { class: "waffle-canvas" }, "", {
    ownerDocument: doc,
  });
  const cellInput = new FakeElement(
    "div",
    { class: "cell-input", contenteditable: "true" },
    "",
    { ownerDocument: doc, isContentEditable: true }
  );
  const activeTab = new FakeElement(
    "div",
    { class: "docs-sheet-active-tab", role: "tab", "aria-selected": "true" },
    "",
    { ownerDocument: doc }
  );
  const sheetTabName = new FakeElement(
    "span",
    { class: "docs-sheet-tab-name" },
    opts.sheetName ?? "Expenses",
    { ownerDocument: doc }
  );
  activeTab.appendChild(sheetTabName);
  gridContainer.appendChild(canvas);
  gridContainer.appendChild(cellInput);
  doc.body.appendChild(nameBox);
  doc.body.appendChild(formulaBar);
  doc.body.appendChild(gridContainer);
  doc.body.appendChild(activeTab);

  return { doc, nameBox, formulaBar, cellInput, canvas, sheetTabName };
}

function installGlobals(opts: {
  doc: FakeDocument;
  href?: string;
  topWindow?: Record<string, unknown>;
  frameElement?: FakeElement;
  mode?: "semantic" | "all_throttled" | "all_raw";
  collected?: RecordedEvent[];
}): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    location: g.location,
    HTMLElement: g.HTMLElement,
    HTMLInputElement: g.HTMLInputElement,
    Element: g.Element,
    Node: g.Node,
    KeyboardEvent: g.KeyboardEvent,
    Event: g.Event,
    InputEvent: g.InputEvent,
    MutationObserver: g.MutationObserver,
  };

  const href = opts.href ?? "https://docs.google.com/spreadsheets/d/abc123/edit";
  const parsedUrl = new URL(href);
  const fakeWindow: Record<string, unknown> = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection: () => ({ toString: () => "" }),
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    frameElement: opts.frameElement ?? null,
    location: {
      href,
      hostname: parsedUrl.hostname,
      pathname: parsedUrl.pathname,
    },
    __EYES_CONFIG__: {
      mode: opts.mode ?? "semantic",
      endpoint: "http://127.0.0.1:4321/events",
      batchMs: 50,
      maxBatchSize: 10,
    },
    __EYES_COLLECT__: (evt: RecordedEvent) => {
      opts.collected?.push(evt);
    },
  };
  fakeWindow.top = opts.topWindow ?? fakeWindow;

  class FakeKeyboardEvent {
    type: string;
    key: string;
    code: string;
    keyCode: number;
    which: number;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    bubbles: boolean;
    cancelable: boolean;
    defaultPrevented = false;

    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type;
      this.key = String(init.key ?? "");
      this.code = String(init.code ?? "");
      this.keyCode = Number(init.keyCode ?? 0);
      this.which = Number(init.which ?? 0);
      this.ctrlKey = Boolean(init.ctrlKey);
      this.shiftKey = Boolean(init.shiftKey);
      this.altKey = Boolean(init.altKey);
      this.metaKey = Boolean(init.metaKey);
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
    }

    preventDefault(): void {
      this.defaultPrevented = true;
    }
  }

  class FakeDomEvent {
    type: string;
    bubbles: boolean;
    cancelable: boolean;
    defaultPrevented = false;
    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
    }
  }

  g.window = fakeWindow;
  g.document = opts.doc;
  g.location = fakeWindow.location;
  g.HTMLElement = FakeElement;
  g.HTMLInputElement = FakeHTMLInputElement;
  g.Element = FakeElement;
  g.Node = FakeElement;
  g.KeyboardEvent = FakeKeyboardEvent;
  g.Event = FakeDomEvent;
  g.InputEvent = FakeDomEvent;
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };

  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  };
}

describe("Google Sheets extension adapter", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("(a) extractGridContext returns cellRef from #t-name-box and sheetName from .docs-sheet-active-tab .docs-sheet-tab-name for .cell-input and <canvas>", () => {
    const { doc, cellInput, canvas } = buildSheetsDoc({
      cellRef: "B4",
      sheetName: "Expenses",
    });
    restore = installGlobals({ doc });

    const cellGrid = extractGridContext(
      cellInput as unknown as HTMLElement,
      "=SUM(B2:B3)"
    );
    expect(cellGrid).toEqual({
      cellRef: "B4",
      rowIndex: undefined,
      colIndex: undefined,
      sheetName: "Expenses",
      isFormula: true,
      formulaFunc: "SUM",
    });

    const canvasGrid = extractGridContext(canvas as unknown as HTMLElement);
    expect(canvasGrid).toEqual({
      cellRef: "B4",
      rowIndex: undefined,
      colIndex: undefined,
      sheetName: "Expenses",
      isFormula: undefined,
      formulaFunc: undefined,
    });
  });

  it("extractGridContext checks top.document safely from a same-origin .docs-texteventtarget-iframe and falls back to document if cross-origin", () => {
    const { doc: topDoc } = buildSheetsDoc({
      cellRef: "C7",
      sheetName: "Q2 Ledger",
    });
    const iframeDoc = new FakeDocument();
    const iframeEditor = new FakeElement(
      "div",
      { contenteditable: "true" },
      "Ready",
      { ownerDocument: iframeDoc, isContentEditable: true }
    );
    iframeDoc.body.appendChild(iframeEditor);
    const frameElement = new FakeElement("iframe", {
      class: "docs-texteventtarget-iframe",
    });

    restore = installGlobals({
      doc: iframeDoc,
      frameElement,
      topWindow: {
        document: topDoc,
        location: { href: "https://docs.google.com/spreadsheets/d/abc123/edit" },
      },
    });

    expect(extractGridContext(iframeEditor as unknown as HTMLElement, "Ready")).toEqual({
      cellRef: "C7",
      rowIndex: undefined,
      colIndex: undefined,
      sheetName: "Q2 Ledger",
      isFormula: undefined,
      formulaFunc: undefined,
    });

    restore();
    restore = null;

    // Cross-origin top.document throws SecurityError: safely falls back to document
    const { doc: fallbackDoc, cellInput } = buildSheetsDoc({
      cellRef: "D9",
      sheetName: "Fallback",
    });
    const crossOriginTop: Record<string, unknown> = {};
    Object.defineProperty(crossOriginTop, "document", {
      get() {
        throw new Error("Blocked a frame with origin from accessing a cross-origin frame");
      },
    });
    restore = installGlobals({
      doc: fallbackDoc,
      topWindow: crossOriginTop,
    });

    expect(extractGridContext(cellInput as unknown as HTMLElement)).toEqual({
      cellRef: "D9",
      rowIndex: undefined,
      colIndex: undefined,
      sheetName: "Fallback",
      isFormula: undefined,
      formulaFunc: undefined,
    });
  });

  it("extractTarget prefers #t-name-box and #t-formula-bar-input CSS locators and avoids treating <canvas> or .cell-input as unique cell targets", () => {
    const { doc, nameBox, formulaBar, cellInput, canvas } = buildSheetsDoc();
    const formulaChild = new FakeElement("span", {}, "42.50", { ownerDocument: doc });
    formulaBar.appendChild(formulaChild);
    restore = installGlobals({ doc });

    const nameTarget = extractTarget(nameBox as unknown as EventTarget);
    expect(nameTarget.target?.locators[0]).toEqual({
      kind: "css",
      value: "#t-name-box",
    });

    const formulaTarget = extractTarget(formulaChild as unknown as EventTarget);
    expect(formulaTarget.target?.locators[0]).toEqual({
      kind: "css",
      value: "#t-formula-bar-input",
    });

    cellInput.textContent = "Typed Cell Value";
    const cellTarget = extractTarget(cellInput as unknown as EventTarget);
    expect(cellTarget.target?.locators).toEqual([]);

    const canvasTarget = extractTarget(canvas as unknown as EventTarget);
    expect(canvasTarget.target?.locators).toEqual([]);
  });

  it("(b) semantic-mode Enter on .cell-input emits an input event carrying the typed value and meta.grid.cellRef before clearing", () => {
    const collected: RecordedEvent[] = [];
    const { doc, cellInput, nameBox } = buildSheetsDoc({
      cellRef: "B4",
      sheetName: "Expenses",
    });
    restore = installGlobals({ doc, mode: "semantic", collected });
    setupEventListeners();

    cellInput.focus();
    cellInput.dispatchEvent({ type: "focus", target: cellInput });
    cellInput.textContent = "128.50";
    cellInput.dispatchEvent({
      type: "keydown",
      target: cellInput,
      key: "Enter",
      code: "Enter",
    } as unknown as { type: string; target?: unknown });

    // Simulate Sheets clearing the editor and moving to B5 immediately after Enter
    cellInput.textContent = "";
    nameBox.value = "B5";
    cellInput.dispatchEvent({ type: "blur", target: cellInput });

    const inputEvents = collected.filter((e) => e.type === "input");
    expect(inputEvents).toHaveLength(1);
    expect(inputEvents[0]?.value).toBe("128.50");
    expect(inputEvents[0]?.meta?.grid).toMatchObject({
      cellRef: "B4",
      sheetName: "Expenses",
    });

    const keyEvents = collected.filter((e) => e.type === "key");
    expect(keyEvents.some((e) => e.meta?.key === "Enter")).toBe(true);
  });

  it("semantic-mode Tab on [contenteditable] emits input event with meta.grid, and copy attaches meta.grid on the sheet surface", () => {
    const collected: RecordedEvent[] = [];
    const { doc, canvas, nameBox } = buildSheetsDoc({
      cellRef: "C2",
      sheetName: "Orders",
    });
    const ceEditor = new FakeElement(
      "div",
      { contenteditable: "true" },
      "ORD-7741",
      { ownerDocument: doc, isContentEditable: true }
    );
    doc.body.appendChild(ceEditor);
    restore = installGlobals({ doc, mode: "semantic", collected });
    setupEventListeners();

    ceEditor.dispatchEvent({
      type: "keydown",
      target: ceEditor,
      key: "Tab",
      code: "Tab",
    } as unknown as { type: string; target?: unknown });

    const inputEvt = collected.find((e) => e.type === "input");
    expect(inputEvt?.value).toBe("ORD-7741");
    expect(inputEvt?.meta?.grid).toMatchObject({
      cellRef: "C2",
      sheetName: "Orders",
    });

    nameBox.value = "A5";
    canvas.dispatchEvent({
      type: "copy",
      target: canvas,
      clipboardData: {
        getData: (fmt: string) => (fmt === "text/plain" ? "Copied Cell" : ""),
      },
    } as unknown as { type: string; target?: unknown });

    const copyEvt = collected.find((e) => e.type === "copy");
    expect(copyEvt?.value).toBe("Copied Cell");
    expect(copyEvt?.meta?.grid).toMatchObject({
      cellRef: "A5",
      sheetName: "Orders",
    });
    expect(copyEvt?.clipboard?.fromCell).toBe("A5");
  });

  it("(c) executeStep({ action: 'pressKey', key: 'Control+ArrowDown' }) dispatches keydown/keyup with ctrlKey: true and key: 'ArrowDown'", async () => {
    const { doc, canvas } = buildSheetsDoc();
    doc.activeElement = canvas;
    const dispatched: Array<{
      type: string;
      key?: string;
      code?: string;
      ctrlKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
    }> = [];
    canvas.addEventListener("keydown", (ev) => {
      const e = ev as typeof dispatched[number];
      dispatched.push({
        type: e.type,
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      });
    });
    canvas.addEventListener("keyup", (ev) => {
      const e = ev as typeof dispatched[number];
      dispatched.push({
        type: e.type,
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      });
    });

    restore = installGlobals({ doc });

    const res = await executeStep({ action: "pressKey", key: "Control+ArrowDown" });
    expect(res.ok).toBe(true);
    expect(dispatched).toEqual([
      {
        type: "keydown",
        key: "ArrowDown",
        code: "ArrowDown",
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      },
      {
        type: "keyup",
        key: "ArrowDown",
        code: "ArrowDown",
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      },
    ]);

    dispatched.length = 0;
    const enterRes = await executeStep({ action: "pressKey", key: "Enter" });
    expect(enterRes.ok).toBe(true);
    expect(dispatched.map((d) => ({ type: d.type, key: d.key, ctrlKey: d.ctrlKey }))).toEqual([
      { type: "keydown", key: "Enter", ctrlKey: false },
      { type: "keyup", key: "Enter", ctrlKey: false },
    ]);

    dispatched.length = 0;
    expect((await executeStep({ action: "pressKey", key: "Ctrl+ArrowUp" })).ok).toBe(true);
    expect((await executeStep({ action: "pressKey", key: "Shift+Tab" })).ok).toBe(true);
    expect((await executeStep({ action: "pressKey", key: "Alt+ArrowRight" })).ok).toBe(true);
    expect((await executeStep({ action: "pressKey", key: "Meta+ArrowLeft" })).ok).toBe(true);
    expect(dispatched.filter((d) => d.type === "keydown")).toEqual([
      {
        type: "keydown",
        key: "ArrowUp",
        code: "ArrowUp",
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      },
      {
        type: "keydown",
        key: "Tab",
        code: "Tab",
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        metaKey: false,
      },
      {
        type: "keydown",
        key: "ArrowRight",
        code: "ArrowRight",
        ctrlKey: false,
        shiftKey: false,
        altKey: true,
        metaKey: false,
      },
      {
        type: "keydown",
        key: "ArrowLeft",
        code: "ArrowLeft",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: true,
      },
    ]);
  });

  it("(d) executeStep({ action: 'insertText', target: { kind: 'css', value: '#t-name-box' }, value: 'B4' }) sets #t-name-box.value to 'B4' replacing prior value", async () => {
    const { doc, nameBox, cellInput } = buildSheetsDoc({ cellRef: "A1" });
    cellInput.textContent = "OldValue";
    restore = installGlobals({ doc });

    const res = await executeStep({
      action: "insertText",
      target: { kind: "css", value: "#t-name-box" },
      value: "B4",
    });
    expect(res.ok).toBe(true);
    expect(nameBox.value).toBe("B4");

    const cellRes = await executeStep({
      action: "insertText",
      target: { kind: "css", value: ".cell-input" },
      value: "NewValue",
    });
    expect(cellRes.ok).toBe(true);
    expect(cellInput.textContent).toBe("NewValue");
  });
});
