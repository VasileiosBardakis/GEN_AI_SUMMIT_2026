import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../server/src/app.ts";
import { implementSolution } from "../../server/src/hands/implementor.ts";
import {
  BROWSER_SESSION_ID,
  fetchLatestScript,
  handleHandsCommand,
  handleRuntimeMessage,
  normalizeLoopbackHost,
  pollHandsBridgeOnce,
  recordEvent,
  resolveTargetTabId,
  runActionScript,
  scoreTabUrlMatch,
  stopHandsRun,
  substitute,
  tabMatchesHost,
} from "../src/background.ts";
import { precheckStepLocators } from "../src/content.ts";
import { executeStep, type V2DomStep } from "../src/hands/execute.ts";
import type { ActionScript, Step } from "../src/types.ts";

describe("Stage 5: extension hands helpers", () => {
  let tracesDir = "";
  let server: http.Server | null = null;
  const originalChrome = (globalThis as Record<string, unknown>).chrome;

  afterEach(async () => {
    if (originalChrome === undefined) {
      delete (globalThis as Record<string, unknown>).chrome;
    } else {
      (globalThis as Record<string, unknown>).chrome = originalChrome;
    }
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    }
    if (tracesDir) {
      await rm(tracesDir, { recursive: true, force: true });
      tracesDir = "";
    }
  });

  it("preserves forEach nested step placeholders until each loop item runs", () => {
    const loopStep: Step = {
      action: "forEach",
      items: "{{targetBinding}}",
      steps: [
        {
          action: "fill",
          target: { kind: "css", value: "input[name='id']" },
          value: "{{id}}",
        },
      ],
    };

    const substituted = substitute(loopStep, { targetBinding: "orders" });
    expect(substituted).toEqual({
      action: "forEach",
      items: "orders",
      steps: [
        {
          action: "fill",
          target: { kind: "css", value: "input[name='id']" },
          value: "{{id}}",
        },
      ],
    });
  });

  it("fetchLatestScript returns null on 404/offline and returns the compiled ActionScript after POST /implement", async () => {
    tracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-ext-hands-"));
    server = createServer({
      tracesDir,
      implement: (solution, opts) =>
        implementSolution(solution, {
          ...opts,
          generate: async () => ({
            steps: [{ action: "insertText", value: "Hello from server" }],
          }),
        }),
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    await expect(fetchLatestScript(baseUrl)).resolves.toBeNull();

    const postRes = await fetch(`${baseUrl}/implement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Greeting", solution: "Insert Hello from server" }),
    });
    expect(postRes.status).toBe(200);

    const script = await fetchLatestScript(baseUrl);
    expect(script).toEqual({
      name: "Greeting",
      steps: [{ action: "insertText", value: "Hello from server" }],
    });
  });

  it("switchTab switches currentTabId from tab 101 (portal.local) to tab 202 (erp.local) and fills with read value", async () => {
    const query = vi.fn(async () => [
      { id: 101, url: "https://portal.local/orders/1", windowId: 1, active: true, lastAccessed: 900 },
      { id: 201, url: "https://erp.local/old", windowId: 2, active: false, lastAccessed: 100 },
      { id: 202, url: "https://erp.local/entry", windowId: 2, active: false, lastAccessed: 500 },
    ]);
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const updateWindow = vi.fn(async () => ({}));
    const executeScript = vi.fn(
      async ({ target, args }: { target: { tabId: number }; args: [Step] }) => {
        const step = args[0];
        if (step.action === "readText") {
          return [{ frameId: 0, result: { ok: true, url: "https://portal.local/orders/1", value: "ORD-42" } }];
        }
        return [{ frameId: 0, result: { ok: true, url: `tab:${target.tabId}` } }];
      },
    );

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query, update: updateTab },
      windows: { update: updateWindow },
      scripting: { executeScript },
    };

    const script: ActionScript = {
      steps: [
        { action: "readText", target: { kind: "css", value: ".order-id" }, bind: "orderId" },
        { action: "switchTab", host: "erp.local" },
        { action: "fill", target: { kind: "css", value: 'input[name="id"]' }, value: "{{orderId}}" },
        {
          action: "forEach",
          items: [{ note: "priority" }],
          steps: [{ action: "fill", target: { kind: "css", value: 'input[name="note"]' }, value: "{{note}}" }],
        },
      ],
    };

    const results = await runActionScript(101, script);

    expect(query).toHaveBeenCalledWith({});
    expect(updateTab).toHaveBeenCalledWith(202, { active: true });
    expect(updateWindow).toHaveBeenCalledWith(2, { focused: true });
    expect(executeScript).toHaveBeenCalledTimes(3);
    expect(executeScript.mock.calls[0]?.[0].target.tabId).toBe(101);
    expect(executeScript.mock.calls[1]?.[0].target.tabId).toBe(202);
    expect(executeScript.mock.calls[1]?.[0].args[0]).toMatchObject({
      action: "fill",
      value: "ORD-42",
    });
    expect(executeScript.mock.calls[2]?.[0].target.tabId).toBe(202);
    expect(executeScript.mock.calls[2]?.[0].args[0]).toMatchObject({
      action: "fill",
      value: "priority",
    });
    expect(results[1]).toEqual({ ok: true, tab: "erp.local" });
  });

  it("switchTab throws when no open tab matches host and does not run later fill", async () => {
    const query = vi.fn(async () => [
      { id: 101, url: "https://portal.local/orders/1", windowId: 1, active: true },
    ]);
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const executeScript = vi.fn(async () => [
      { frameId: 0, result: { ok: true, url: "https://portal.local/orders/1", value: "ORD-42" } },
    ]);

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query, update: updateTab },
      scripting: { executeScript },
    };

    const script: ActionScript = {
      steps: [
        { action: "readText", target: { kind: "css", value: ".order-id" }, bind: "orderId" },
        { action: "switchTab", host: "erp.local" },
        { action: "fill", target: { kind: "css", value: 'input[name="id"]' }, value: "{{orderId}}" },
      ],
    };

    await expect(runActionScript(101, script)).rejects.toThrow("No open tab for erp.local");
    expect(updateTab).not.toHaveBeenCalled();
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("switchTab matches host:port when port is specified in step.host", async () => {
    const query = vi.fn(async () => [
      { id: 301, url: "http://127.0.0.1:4173/other", active: true },
      { id: 302, url: "http://127.0.0.1:5173/target", active: false },
    ]);
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const executeScript = vi.fn(async ({ target }: { target: { tabId: number } }) => [
      { frameId: 0, result: { ok: true, url: `tab:${target.tabId}` } },
    ]);

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query, update: updateTab },
      scripting: { executeScript },
    };

    const results = await runActionScript(301, {
      steps: [
        { action: "switchTab", host: "127.0.0.1:5173" },
        { action: "click", target: { kind: "css", value: "#go" } },
      ],
    });

    expect(updateTab).toHaveBeenCalledWith(302, { active: true });
    expect(executeScript.mock.calls[0]?.[0].target.tabId).toBe(302);
    expect(results[0]).toEqual({ ok: true, tab: "127.0.0.1:5173" });
  });
});

class FakeDomElement {
  nodeType = 1;
  tagName: string;
  id = "";
  value = "";
  checked = false;
  type = "";
  isContentEditable = false;
  style: Record<string, string> = {};
  children: FakeDomElement[] = [];
  parentElement: FakeDomElement | null = null;
  labels: FakeDomElement[] = [];
  options: Array<{ value: string; label: string; textContent: string; selected: boolean }> = [];
  shadowRoot: { activeElement: FakeDomElement | null } | null = null;
  isConnected = true;
  private ownText = "";
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  rect = { top: 10, left: 20, width: 100, height: 30 };

  constructor(tagName: string, attrs: Record<string, string> = {}, text = "") {
    this.tagName = tagName.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) {
      this.setAttribute(k, v);
    }
    this.ownText = text;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === "id") this.id = value;
    if (name === "type") this.type = value;
    if (name === "value") this.value = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === "id") this.id = "";
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  appendChild(child: FakeDomElement): FakeDomElement {
    child.parentElement = this;
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

  getClientRects(): unknown[] {
    if (this.style.display === "none" || this.style.visibility === "hidden") return [];
    return [this.rect];
  }

  getBoundingClientRect(): { top: number; left: number; width: number; height: number } {
    return this.rect;
  }

  focus(): void {
    if (fakeActiveDoc) fakeActiveDoc.activeElement = this;
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  dispatchEvent(ev: { type: string; defaultPrevented?: boolean }): boolean {
    for (const cb of this.listeners.get(ev.type) ?? []) {
      cb(ev);
    }
    if (ev.type && this.parentElement) {
      this.parentElement.dispatchEvent(ev);
    }
    return !ev.defaultPrevented;
  }

  click(): void {
    this.dispatchEvent({ type: "click" });
  }

  matches(selector: string): boolean {
    for (const part of selector.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (this.matchesSingle(part)) return true;
    }
    return false;
  }

  private matchesSingle(sel: string): boolean {
    if (sel === "*") return true;
    let remaining = sel.trim();
    const tagMatch = /^([a-z0-9]+)/i.exec(remaining);
    if (tagMatch) {
      if (this.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
      remaining = remaining.slice(tagMatch[1].length);
    }
    if (remaining.startsWith("#")) {
      const idMatch = /^#([a-z0-9_-]+)/i.exec(remaining);
      if (!idMatch || this.id !== idMatch[1]) return false;
      remaining = remaining.slice(idMatch[0].length);
    }
    const classMatches = [...remaining.matchAll(/\.([a-z0-9_-]+)/gi)];
    if (classMatches.length > 0) {
      const classes = (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
      for (const m of classMatches) {
        if (!classes.includes(m[1])) return false;
      }
      remaining = remaining.replace(/\.[a-z0-9_-]+/gi, "");
    }
    const attrMatches = [...remaining.matchAll(/\[([a-z0-9_-]+)(?:=["']([^"']*)["'])?\]/gi)];
    for (const m of attrMatches) {
      const actual = this.getAttribute(m[1]);
      if (actual === null) return false;
      if (m[2] !== undefined && actual !== m[2]) return false;
    }
    remaining = remaining.replace(/\[[^\]]*\]/g, "").trim();
    return remaining.length === 0;
  }

  closest(selector: string): FakeDomElement | null {
    if (this.matches(selector)) return this;
    let curr: FakeDomElement | null = this.parentElement;
    while (curr) {
      if (curr.matches(selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeDomElement[] {
    const out: FakeDomElement[] = [];
    const visit = (node: FakeDomElement): void => {
      for (const child of node.children) {
        if (matchesDescendant(child, selector, this)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

function matchesDescendant(
  el: FakeDomElement,
  selector: string,
  root: FakeDomElement,
): boolean {
  const branches = selector.split(",").map((s) => s.trim()).filter(Boolean);
  for (const branch of branches) {
    const tokens = branch.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && el.matches(tokens[0])) return true;
    if (tokens.length > 1 && el.matches(tokens[tokens.length - 1])) {
      let curr = el.parentElement;
      let idx = tokens.length - 2;
      while (curr && curr !== root.parentElement && idx >= 0) {
        if (curr.matches(tokens[idx])) idx -= 1;
        curr = curr.parentElement;
      }
      if (idx < 0) return true;
    }
  }
  return false;
}

class FakeDomInput extends FakeDomElement {
  constructor(attrs: Record<string, string> = {}) {
    super("input", attrs);
  }
}

let fakeActiveDoc: { activeElement: FakeDomElement | null } | null = null;

function installFakeDom(root: FakeDomElement, url = "http://127.0.0.1:4173/app.html") {
  const prev = {
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
    location: (globalThis as Record<string, unknown>).location,
    Element: (globalThis as Record<string, unknown>).Element,
    HTMLElement: (globalThis as Record<string, unknown>).HTMLElement,
    HTMLInputElement: (globalThis as Record<string, unknown>).HTMLInputElement,
  };

  const fakeDoc = {
    documentElement: root,
    body: root,
    activeElement: null as FakeDomElement | null,
    createElement: (tag: string) => new FakeDomElement(tag),
    getElementById: (id: string): FakeDomElement | null => {
      const find = (node: FakeDomElement): FakeDomElement | null => {
        if (node.id === id) return node;
        for (const child of node.children) {
          const hit = find(child);
          if (hit) return hit;
        }
        return null;
      };
      return find(root);
    },
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
  };
  fakeActiveDoc = fakeDoc;

  const fakeWin: Record<string, unknown> = {
    getComputedStyle: (el: FakeDomElement) => ({
      display: el.style.display ?? "block",
      visibility: el.style.visibility ?? "visible",
    }),
  };

  (globalThis as Record<string, unknown>).window = fakeWin;
  (globalThis as Record<string, unknown>).document = fakeDoc;
  (globalThis as Record<string, unknown>).location = { href: url };
  (globalThis as Record<string, unknown>).Element = FakeDomElement;
  (globalThis as Record<string, unknown>).HTMLElement = FakeDomElement;
  (globalThis as Record<string, unknown>).HTMLInputElement = FakeDomInput;

  return {
    fakeDoc,
    fakeWin,
    restore: () => {
      fakeActiveDoc = null;
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete (globalThis as Record<string, unknown>)[k];
        else (globalThis as Record<string, unknown>)[k] = v;
      }
    },
  };
}

describe("GEN-69: M2 Hands v2", () => {
  let mockServer: http.Server | null = null;
  let restoreDom: (() => void) | null = null;
  const originalChrome = (globalThis as Record<string, unknown>).chrome;
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    stopHandsRun();
    restoreDom?.();
    restoreDom = null;
    if (originalChrome === undefined) {
      delete (globalThis as Record<string, unknown>).chrome;
    } else {
      (globalThis as Record<string, unknown>).chrome = originalChrome;
    }
    globalThis.fetch = originalFetch;
    if (mockServer) {
      await new Promise<void>((resolve, reject) => {
        mockServer?.close((err) => (err ? reject(err) : resolve()));
      });
      mockServer = null;
    }
  });

  it("1. switchTab with url activates portal.html over same-host erp.html (and opens via tabs.create when missing)", async () => {
    const query = vi.fn(async () => [
      { id: 10, url: "http://127.0.0.1:4173/erp.html", windowId: 1, active: true, lastAccessed: 999 },
      { id: 20, url: "http://127.0.0.1:4173/portal.html", windowId: 1, active: false, lastAccessed: 100 },
    ]);
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const createTab = vi.fn(async ({ url }: { url?: string }) => ({
      id: 30,
      url,
      status: "complete",
    }));
    const updateWindow = vi.fn(async () => ({}));
    const executeScript = vi.fn(async ({ target }: { target: { tabId: number } }) => [
      { frameId: 0, result: { ok: true, url: `tab:${target.tabId}` } },
    ]);

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query, update: updateTab, create: createTab },
      windows: { update: updateWindow },
      scripting: { executeScript },
    };

    const results = await runActionScript(10, {
      steps: [
        {
          action: "switchTab",
          host: "127.0.0.1:4173",
          url: "http://127.0.0.1:4173/portal.html",
        } as unknown as Step,
        { action: "click", target: { kind: "css", value: "#submit" } },
        {
          action: "switchTab",
          url: "http://127.0.0.1:4173/invoice.html",
        } as unknown as Step,
        { action: "click", target: { kind: "css", value: "#new-tab-btn" } },
      ],
    });

    expect(updateTab).toHaveBeenCalledWith(20, { active: true });
    expect(createTab).toHaveBeenCalledWith({
      url: "http://127.0.0.1:4173/invoice.html",
      active: true,
    });
    expect(executeScript.mock.calls[0]?.[0].target.tabId).toBe(20);
    expect(executeScript.mock.calls[1]?.[0].target.tabId).toBe(30);
    expect(results[0]).toMatchObject({ ok: true, url: "http://127.0.0.1:4173/portal.html" });
    expect(results[2]).toMatchObject({ ok: true, url: "http://127.0.0.1:4173/invoice.html" });
  });

  it("2. fallback locator #2 and GEN-60 semantic text/role fallback succeed when primary misses, while 2-match ambiguity fails closed", async () => {
    const root = new FakeDomElement("body");
    const submitLink = new FakeDomElement("a", { href: "#submit", "data-testid": "real-submit" }, "Submit Order");
    let linkClicks = 0;
    submitLink.addEventListener("click", () => {
      linkClicks += 1;
    });
    const emailInput = new FakeDomInput({ type: "text", placeholder: "Work Email" });
    root.appendChild(submitLink);
    root.appendChild(emailInput);

    const dom = installFakeDom(root);
    restoreDom = dom.restore;

    // Fallback locator #2 succeeds when locator #1 misses
    const fallbackRes = await executeStep({
      action: "fill",
      target: [
        { kind: "testid", value: "missing-email-id" },
        { kind: "aria", value: 'textbox[name="Work Email"]' },
      ],
      value: "ops@example.com",
    });
    expect(fallbackRes.ok).toBe(true);
    expect(emailInput.value).toBe("ops@example.com");

    // GEN-60 semantic fallback: primary css misses, aria expects button[name="Submit Order"],
    // element on page is actually an <a> link with text "Submit Order"
    const semanticRes = await executeStep({
      action: "click",
      target: [
        { kind: "css", value: "#stale-button" },
        { kind: "aria", value: 'button[name="Submit Order"]' },
      ],
    });
    expect(semanticRes.ok).toBe(true);
    expect(linkClicks).toBe(1);

    // 2-match ambiguity fails closed with "Ambiguous target"
    const btn1 = new FakeDomElement("button", { class: "save-btn" }, "Save");
    const btn2 = new FakeDomElement("button", { class: "save-btn" }, "Save");
    root.appendChild(btn1);
    root.appendChild(btn2);

    const ambigCss = await executeStep({
      action: "click",
      target: { kind: "css", value: ".save-btn" },
    });
    expect(ambigCss.ok).toBe(false);
    expect(ambigCss.error).toBe("Ambiguous target");

    const ambigSemantic = await executeStep({
      action: "click",
      target: { kind: "aria", value: 'link[name="Save"]' },
    });
    expect(ambigSemantic.ok).toBe(false);
    expect(ambigSemantic.error).toBe("Ambiguous target");
  });

  it("3. within scopes { kind: 'text', value: '{{name}}' } inside a container and ignores identical text outside it (T10)", async () => {
    const root = new FakeDomElement("body");
    const outsidePanel = new FakeDomElement("div", { "data-testid": "sheet-panel" });
    const outsideText = new FakeDomElement("button", {}, "Nordic Freight Co");
    let outsideClicked = 0;
    outsideText.addEventListener("click", () => {
      outsideClicked += 1;
    });
    outsidePanel.appendChild(outsideText);

    const clientPanel = new FakeDomElement("div", { "data-testid": "client-list" });
    const insideRow = new FakeDomElement("div", { class: "row" });
    const insideText = new FakeDomElement("button", {}, "Nordic Freight Co");
    let insideClicked = 0;
    insideText.addEventListener("click", () => {
      insideClicked += 1;
    });
    insideRow.appendChild(insideText);
    clientPanel.appendChild(insideRow);

    root.appendChild(outsidePanel);
    root.appendChild(clientPanel);

    const dom = installFakeDom(root);
    restoreDom = dom.restore;

    const substitutedStep = substitute(
      {
        action: "click",
        within: { kind: "testid", value: "client-list" },
        target: { kind: "text", value: "{{name}}" },
      },
      { name: "Nordic Freight Co" },
    ) as V2DomStep;

    const res = await executeStep(substitutedStep);
    expect(res.ok).toBe(true);
    expect(insideClicked).toBe(1);
    expect(outsideClicked).toBe(0);
  });

  it("4. pauseBeforeSubmit halts before final click and HANDS_STOP_RUN aborts mid-script", async () => {
    const executedActions: string[] = [];
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const executeScript = vi.fn(
      async ({ args }: { target: { tabId: number }; args: [V2DomStep] }) => {
        const s = args[0];
        executedActions.push(s.action);
        if (s.action === "waitFor") {
          await new Promise((r) => setTimeout(r, 40));
        }
        return [{ frameId: 0, result: { ok: true, url: "http://127.0.0.1:4173/form" } }];
      },
    );

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { sendMessage },
      scripting: { executeScript },
    };

    // (a) pauseBeforeSubmit halts before the final click
    const pauseResults = await runActionScript(101, {
      name: "Submit Invoice",
      pauseBeforeSubmit: true,
      steps: [
        { action: "fill", target: { kind: "css", value: "#amount" }, value: "500" },
        { action: "click", target: { kind: "css", value: "#open-confirm" } },
        { action: "click", target: { kind: "css", value: "#final-submit" } },
      ],
    } as unknown as ActionScript);

    expect(executedActions).toEqual(["fill", "click"]);
    expect(pauseResults).toHaveLength(2);
    expect(sendMessage).toHaveBeenCalledWith(
      101,
      expect.objectContaining({
        kind: "EYES_WATCH_STEP",
        pauseBeforeSubmit: true,
        target: { kind: "css", value: "#final-submit" },
      }),
      { frameId: 0 },
    );

    // (b) HANDS_STOP_RUN aborts mid-script
    executedActions.length = 0;
    const runPromise = runActionScript(101, {
      steps: [
        { action: "fill", target: { kind: "css", value: "#a" }, value: "1" },
        { action: "wait", ms: 5000 },
        { action: "fill", target: { kind: "css", value: "#b" }, value: "2" },
      ],
    });

    await new Promise((r) => setTimeout(r, 15));
    const stopRes = vi.fn();
    handleRuntimeMessage({ kind: "HANDS_STOP_RUN" }, { tab: { id: 101 } }, stopRes);
    expect(stopRes).toHaveBeenCalledWith({ ok: true });

    await expect(runPromise).rejects.toThrow("Run stopped by user");
    expect(executedActions).toEqual(["fill"]);
  });

  it("5. extension-side precheck against mock HTTP /hands/next validates only steps on the open URL", async () => {
    const receivedResults: unknown[] = [];
    const precheckCmd = {
      id: "precheck-1",
      kind: "precheck",
      url: "http://127.0.0.1:4173/portal.html",
      script: {
        steps: [
          { action: "readText", target: { kind: "css", value: ".order-id" }, bind: "orderId" },
          {
            action: "switchTab",
            host: "127.0.0.1:4173",
            url: "http://127.0.0.1:4173/erp.html",
          },
          { action: "fill", target: { kind: "css", value: "#erp-order" }, value: "{{orderId}}" },
          {
            action: "click",
            url: "http://127.0.0.1:4173/portal.html",
            target: { kind: "testid", value: "portal-refresh" },
          },
        ],
      },
    };

    mockServer = http.createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/hands/next")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(precheckCmd));
        return;
      }
      if (req.method === "POST" && req.url === "/hands/result") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          receivedResults.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockServer?.listen(0, "127.0.0.1", () => resolve());
    });
    const baseUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;

    const sendMessage = vi.fn<
      (tabId: number, msg: unknown, opts?: unknown) => Promise<{
        ok: boolean;
        matchCount: number;
        unique: boolean;
      }>
    >(async () => ({
      ok: true,
      matchCount: 1,
      unique: true,
    }));

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => [
          { id: 55, url: "http://127.0.0.1:4173/portal.html", active: true },
        ]),
        sendMessage,
      },
    };

    const handled = await pollHandsBridgeOnce(baseUrl);
    expect(handled).toBe(true);

    // Only step 0 (entry step on portal.html) should be checked;
    // step 2 (#erp-order after switchTab to erp.html) has no open tab,
    // and step 3 (later step on already-checked portal.html) is skipped by entry-step precheck.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      kind: "EYES_PRECHECK_STEP",
      locators: [{ kind: "css", value: ".order-id" }],
    });

    expect(receivedResults).toHaveLength(1);
    expect(receivedResults[0]).toMatchObject({
      id: "precheck-1",
      ok: true,
      results: [
        { index: 0, action: "readText", ok: true, matchCount: 1, unique: true },
      ],
    });
  });

  it("6. resolveTargetTabId ignores chrome-extension:// sender tabs", async () => {
    const query = vi.fn(async ({ currentWindow }: { active?: boolean; currentWindow?: boolean }) => {
      if (currentWindow) {
        return [{ id: 99, url: "chrome-extension://abcdef/panel.html", active: true }];
      }
      return [
        { id: 99, url: "chrome-extension://abcdef/panel.html", active: true },
        { id: 205, url: "https://erp.local/orders", active: true },
      ];
    });

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query },
    };

    const resolved = await resolveTargetTabId({
      id: 99,
      url: "chrome-extension://abcdef/panel.html",
    });
    expect(resolved).toBe(205);

    const directWebTab = await resolveTargetTabId({
      id: 301,
      url: "https://portal.local/home",
    });
    expect(directWebTab).toBe(301);
  });

  it("supports pressKey, watch highlight, pageSummary forEach with tab threading, bind preservation, and commit event stamping/flushing", async () => {
    // 1) pressKey + watch highlight
    const root = new FakeDomElement("body");
    const watchBar = new FakeDomElement("div", { id: "__eyes_watch_bar__" });
    const searchInput = new FakeDomInput({ id: "search", type: "text" });
    const keyEvents: Array<{ type: string; key?: string; code?: string }> = [];
    searchInput.addEventListener("keydown", (ev) => {
      const e = ev as { type: string; key?: string; code?: string };
      keyEvents.push({ type: e.type, key: e.key, code: e.code });
    });
    searchInput.addEventListener("keyup", (ev) => {
      const e = ev as { type: string; key?: string; code?: string };
      keyEvents.push({ type: e.type, key: e.key, code: e.code });
    });
    root.appendChild(watchBar);
    root.appendChild(searchInput);

    const dom = installFakeDom(root);
    restoreDom = dom.restore;

    const pressRes = await executeStep({
      action: "pressKey",
      key: "Enter",
      target: { kind: "css", value: "#search" },
    });
    expect(pressRes.ok).toBe(true);
    expect(keyEvents).toEqual([
      { type: "keydown", key: "Enter", code: "Enter" },
      { type: "keyup", key: "Enter", code: "Enter" },
    ]);
    // 1b) pressKey Tab & Escape + serialized executeStep self-containment check
    const tabRes = await executeStep({
      action: "pressKey",
      key: "Tab",
      target: { kind: "css", value: "#search" },
    });
    expect(tabRes.ok).toBe(true);
    const escRes = await executeStep({
      action: "pressKey",
      key: "Escape",
    });
    expect(escRes.ok).toBe(true);
    expect(keyEvents.slice(2)).toEqual([
      { type: "keydown", key: "Tab", code: "Tab" },
      { type: "keyup", key: "Tab", code: "Tab" },
      { type: "keydown", key: "Escape", code: "Escape" },
      { type: "keyup", key: "Escape", code: "Escape" },
    ]);
    // Verify executeStep can be serialized via chrome.scripting.executeScript({ func: executeStep })
    const rehydrated = new Function(`return (${executeStep.toString()})`)() as typeof executeStep;
    const rehydratedRes = await rehydrated({
      action: "pressKey",
      key: "Enter",
      target: { kind: "css", value: "#search" },
    });
    expect(rehydratedRes.ok).toBe(true);
    expect(searchInput.getAttribute("data-eyes-highlighted")).toBe("true");
    expect(dom.fakeDoc.getElementById("__eyes_watch_highlight__")).not.toBeNull();

    // 2) substitute skips step.bind
    const readStep = substitute(
      { action: "readText", target: { kind: "css", value: ".id" }, bind: "orderId" },
      { orderId: "ORD-999" },
    );
    expect(readStep.bind).toBe("orderId");

    // 3) forEach over pageSummary list + currentTabId threading
    const query = vi.fn(async () => [
      { id: 10, url: "https://portal.local/list" },
      { id: 20, url: "https://erp.local/entry" },
    ]);
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const executeScript = vi.fn(
      async ({ target, args }: { target: { tabId: number }; args: [V2DomStep] }) => [
        { frameId: 0, result: { ok: true, url: `tab:${target.tabId}`, value: JSON.stringify(args[0]) } },
      ],
    );
    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query, update: updateTab },
      scripting: { executeScript },
    };

    await runActionScript(10, {
      pageSummary: {
        source: {
          rows: [
            { cells: [{ text: "SKU-1" }, { text: "10" }], locators: [] },
            { cells: [{ text: "SKU-2" }, { text: "20" }], locators: [] },
          ],
        },
      },
      steps: [
        {
          action: "forEach",
          items: "pageSummary.source.rows",
          steps: [
            { action: "switchTab", host: "erp.local" },
            { action: "fill", target: { kind: "css", value: "#sku" }, value: "{{col0}}" },
            { action: "switchTab", host: "portal.local" },
          ],
        },
      ],
    } as unknown as ActionScript);

    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls[0]?.[0].target.tabId).toBe(20);
    expect(executeScript.mock.calls[0]?.[0].args[0]).toMatchObject({ value: "SKU-1" });
    expect(executeScript.mock.calls[1]?.[0].target.tabId).toBe(20);
    expect(executeScript.mock.calls[1]?.[0].args[0]).toMatchObject({ value: "SKU-2" });

    // 4) EYES_EVENT stamping + immediate commit flush
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sendRes = vi.fn();
    handleRuntimeMessage(
      {
        kind: "EYES_EVENT",
        event: {
          v: 1,
          id: "evt-1",
          ts: Date.now(),
          session: "content_sess_old",
          source: "browser",
          app: "portal.local",
          type: "click",
        },
      },
      { tab: { id: 77, url: "https://portal.local" } },
      sendRes,
    );

    expect(sendRes).toHaveBeenCalledWith({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const postedBody = JSON.parse(
      ((fetchMock.mock.calls[0] as unknown[] | undefined)?.[1] as { body: string }).body,
    ) as Array<{ session: string; meta?: { tabId?: number } }>;
    expect(postedBody[0]?.session).toBe(BROWSER_SESSION_ID);
    expect(postedBody[0]?.meta?.tabId).toBe(77);

    // recordEvent directly flushes on commit types
    recordEvent({
      v: 1,
      id: "evt-2",
      ts: Date.now(),
      session: BROWSER_SESSION_ID,
      source: "browser",
      app: "portal.local",
      type: "submit",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("EYES_RUN_OPTIMIZATION falls back to msg.item when msg.id is absent from local library", async () => {
    const executeScript = vi.fn(async ({ target }: { target: { tabId: number } }) => [
      { frameId: 0, result: { ok: true, url: `tab:${target.tabId}` } },
    ]);
    const storageSet = vi.fn(async () => {});
    const storageGet = vi.fn(async () => ({}));

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => [{ id: 404, url: "https://portal.local/orders", active: true }]),
      },
      scripting: { executeScript },
      storage: { local: { get: storageGet, set: storageSet } },
    };

    const response = await new Promise<Record<string, unknown>>((resolve) => {
      handleRuntimeMessage(
        {
          kind: "EYES_RUN_OPTIMIZATION",
          id: "server-only-opt-999",
          item: {
            id: "server-only-opt-999",
            title: "Server-only flow",
            description: "Loaded from server",
            kind: "workflow",
            status: "active",
            timeSavedPerRunSec: 20,
            runCount: 0,
            totalTimeSavedSec: 0,
            createdAt: Date.now(),
            script: {
              steps: [{ action: "click", target: { kind: "css", value: "#apply" } }],
            },
          },
        },
        { tab: { id: 99, url: "chrome-extension://panel/panel.html" } },
        (res) => resolve((res ?? {}) as Record<string, unknown>),
      );
    });

    expect(response.ok).toBe(true);
    expect(response.appliedToPage).toBe(true);
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0]?.[0].target.tabId).toBe(404);
  });

  it("executeStep selects recorded option on <select> for both action: 'select' and fallback action: 'fill'", async () => {
    const root = new FakeDomElement("body");
    const selectEl = new FakeDomElement("select", { id: "priority", name: "priority" });
    selectEl.options = [
      { value: "low", label: "Low", textContent: "Low", selected: true },
      { value: "medium", label: "Medium", textContent: "Medium", selected: false },
      { value: "high", label: "High Priority", textContent: "High Priority", selected: false },
    ];
    selectEl.value = "low";

    const changeEvents: string[] = [];
    selectEl.addEventListener("change", () => {
      changeEvents.push(selectEl.value);
    });

    const nonFillableDiv = new FakeDomElement("div", { id: "readonly-box" }, "Static");
    root.appendChild(selectEl);
    root.appendChild(nonFillableDiv);

    const dom = installFakeDom(root);
    restoreDom = dom.restore;

    const selectRes = await executeStep({
      action: "select",
      target: { kind: "css", value: "#priority" },
      value: "medium",
    });
    expect(selectRes.ok).toBe(true);
    expect(selectRes.value).toBe("medium");
    expect(selectEl.value).toBe("medium");
    expect(selectEl.options[1]?.selected).toBe(true);

    const fillFallbackRes = await executeStep({
      action: "fill",
      target: { kind: "css", value: "#priority" },
      value: "High Priority",
    });
    expect(fillFallbackRes.ok).toBe(true);
    expect(fillFallbackRes.value).toBe("high");
    expect(selectEl.value).toBe("high");
    expect(selectEl.options[2]?.selected).toBe(true);
    expect(changeEvents).toEqual(["medium", "high"]);

    const divFillRes = await executeStep({
      action: "fill",
      target: { kind: "css", value: "#readonly-box" },
      value: "anything",
    });
    expect(divFillRes.ok).toBe(false);
    expect(divFillRes.error).toBe("Target is not fillable");
  });

  it("switchTab with host='127.0.0.1' and url='http://127.0.0.1:4173/erp.html' keeps 127.0.0.1 distinct from localhost, activates http://127.0.0.1:4173/erp.html over http://localhost:4173/portal.html, and replays fill on row 4", async () => {
    expect(normalizeLoopbackHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeLoopbackHost("127.0.0.1:4173")).toBe("127.0.0.1:4173");
    expect(normalizeLoopbackHost("localhost:4173")).toBe("localhost:4173");
    expect(tabMatchesHost("http://127.0.0.1:4173/erp.html", "localhost")).toBe(false);
    expect(tabMatchesHost("http://127.0.0.1:4173/erp.html", "127.0.0.1")).toBe(true);
    expect(tabMatchesHost("http://127.0.0.1:4173/erp.html", "127.0.0.1:4173")).toBe(true);
    expect(tabMatchesHost("http://127.0.0.1:4173/erp.html", "127.0.0.1:5173")).toBe(false);
    expect(
      scoreTabUrlMatch("http://127.0.0.1:4173/erp.html", "http://localhost:4173/erp.html"),
    ).toBe(0);
    expect(
      scoreTabUrlMatch("http://127.0.0.1:4173/erp.html", "http://127.0.0.1:4173/erp.html"),
    ).toBe(4);
    expect(
      scoreTabUrlMatch("http://localhost:4173/portal.html", "http://localhost:4173/erp.html"),
    ).toBe(0);

    const query = vi.fn(async () => [
      {
        id: 10,
        url: "http://localhost:4173/portal.html",
        windowId: 1,
        active: true,
        lastAccessed: 999,
      },
      {
        id: 20,
        url: "http://127.0.0.1:4173/erp.html",
        windowId: 1,
        active: false,
        lastAccessed: 100,
      },
    ]);
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const updateWindow = vi.fn(async () => ({}));
    const executeScript = vi.fn(
      async ({ target, args }: { target: { tabId: number }; args: [V2DomStep] }) => [
        {
          frameId: 0,
          result: { ok: true, url: `tab:${target.tabId}`, value: JSON.stringify(args[0]) },
        },
      ],
    );

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query, update: updateTab },
      windows: { update: updateWindow },
      scripting: { executeScript },
    };

    const results = await runActionScript(10, {
      steps: [
        {
          action: "forEach",
          items: [{ invoiceId: "INV-2026-004", vendor: "Northwind Freight" }],
          steps: [
            {
              action: "switchTab",
              host: "127.0.0.1",
              url: "http://127.0.0.1:4173/erp.html",
            },
            {
              action: "fill",
              target: { kind: "testid", value: "erp-invoice-id" },
              value: "{{invoiceId}}",
            },
            {
              action: "fill",
              target: { kind: "testid", value: "erp-vendor" },
              value: "{{vendor}}",
            },
          ],
        },
      ],
    } as unknown as ActionScript);

    expect(updateTab).toHaveBeenCalledWith(20, { active: true });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls[0]?.[0].target.tabId).toBe(20);
    expect(executeScript.mock.calls[0]?.[0].args[0]).toMatchObject({
      action: "fill",
      value: "INV-2026-004",
    });
    expect(executeScript.mock.calls[1]?.[0].target.tabId).toBe(20);
    expect(executeScript.mock.calls[1]?.[0].args[0]).toMatchObject({
      action: "fill",
      value: "Northwind Freight",
    });
    expect(results[0]).toMatchObject({
      ok: true,
      tab: "127.0.0.1",
      url: "http://127.0.0.1:4173/erp.html",
    });
  });

  it("skips tabs.update and waitForTabLoad on navigate when tabs.get returns a matching URL (scoreTabUrlMatch >= 3)", async () => {
    const getTab = vi.fn(async (tabId: number) => ({
      id: tabId,
      url: "http://127.0.0.1:4173/form",
      status: "complete",
    }));
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const addListener = vi.fn();
    const removeListener = vi.fn();
    const executeScript = vi.fn(async ({ target }: { target: { tabId: number } }) => [
      { frameId: 0, result: { ok: true, url: `tab:${target.tabId}` } },
    ]);

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        get: getTab,
        update: updateTab,
        onUpdated: { addListener, removeListener },
      },
      scripting: { executeScript },
    };

    const results = await runActionScript(101, {
      steps: [
        { action: "navigate", url: "http://127.0.0.1:4173/form/" },
        { action: "click", target: { kind: "css", value: "#save-btn" } },
      ],
    });

    expect(getTab).toHaveBeenCalledWith(101);
    expect(updateTab).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
    expect(results[0]).toEqual({ ok: true, url: "http://127.0.0.1:4173/form" });
    expect(executeScript).toHaveBeenCalledTimes(1);

    // When tabs.get returns a non-matching URL, tabs.update IS called
    getTab.mockResolvedValueOnce({
      id: 101,
      url: "http://127.0.0.1:4173/other",
      status: "complete",
    });
    getTab.mockResolvedValueOnce({
      id: 101,
      url: "http://127.0.0.1:4173/form",
      status: "complete",
    });
    const navResults = await runActionScript(101, {
      steps: [{ action: "navigate", url: "http://127.0.0.1:4173/form" }],
    });

    expect(updateTab).toHaveBeenCalledWith(101, { url: "http://127.0.0.1:4173/form" });
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(navResults[0]).toEqual({ ok: true, url: "http://127.0.0.1:4173/form" });
  });

  it("pressKey(Enter) on an input inside <form> calls requestSubmit/submit when keydown is not cancelled, and skips when preventDefault() is called", async () => {
    const root = new FakeDomElement("body");

    // Case 1: form with requestSubmit()
    const formWithRequestSubmit = new FakeDomElement("form", { id: "search-form-1" }) as FakeDomElement & {
      requestSubmit: ReturnType<typeof vi.fn>;
      submit: ReturnType<typeof vi.fn>;
    };
    formWithRequestSubmit.requestSubmit = vi.fn();
    formWithRequestSubmit.submit = vi.fn();
    const input1 = new FakeDomInput({ id: "search-1", type: "search" }) as FakeDomInput & {
      form?: FakeDomElement;
    };
    input1.form = formWithRequestSubmit;
    const keySequence1: string[] = [];
    input1.addEventListener("keydown", () => keySequence1.push("keydown"));
    input1.addEventListener("keyup", () => keySequence1.push("keyup"));
    formWithRequestSubmit.appendChild(input1);
    root.appendChild(formWithRequestSubmit);

    // Case 2: form without requestSubmit() falls back to submit()
    const formFallback = new FakeDomElement("form", { id: "search-form-2" }) as FakeDomElement & {
      submit: ReturnType<typeof vi.fn>;
    };
    formFallback.submit = vi.fn();
    const input2 = new FakeDomInput({ id: "search-2", type: "text" });
    formFallback.appendChild(input2);
    root.appendChild(formFallback);

    // Case 3: keydown listener calls preventDefault() -> form submission skipped
    const formCancelled = new FakeDomElement("form", { id: "search-form-3" }) as FakeDomElement & {
      requestSubmit: ReturnType<typeof vi.fn>;
      submit: ReturnType<typeof vi.fn>;
    };
    formCancelled.requestSubmit = vi.fn();
    formCancelled.submit = vi.fn();
    const input3 = new FakeDomInput({ id: "search-3", type: "text" }) as FakeDomInput & {
      form?: FakeDomElement;
    };
    input3.form = formCancelled;
    const keySequence3: string[] = [];
    input3.addEventListener("keydown", (ev) => {
      keySequence3.push("keydown");
      (ev as { preventDefault: () => void }).preventDefault();
    });
    input3.addEventListener("keyup", () => keySequence3.push("keyup"));
    formCancelled.appendChild(input3);
    root.appendChild(formCancelled);

    const dom = installFakeDom(root);
    restoreDom = dom.restore;

    const res1 = await executeStep({
      action: "pressKey",
      key: "Enter",
      target: { kind: "css", value: "#search-1" },
    });
    expect(res1.ok).toBe(true);
    expect(formWithRequestSubmit.requestSubmit).toHaveBeenCalledTimes(1);
    expect(formWithRequestSubmit.submit).not.toHaveBeenCalled();
    expect(keySequence1).toEqual(["keydown", "keyup"]);

    const res2 = await executeStep({
      action: "pressKey",
      key: "Enter",
      target: { kind: "css", value: "#search-2" },
    });
    expect(res2.ok).toBe(true);
    expect(formFallback.submit).toHaveBeenCalledTimes(1);

    const res3 = await executeStep({
      action: "pressKey",
      key: "Enter",
      target: { kind: "css", value: "#search-3" },
    });
    expect(res3.ok).toBe(true);
    expect(formCancelled.requestSubmit).not.toHaveBeenCalled();
    expect(formCancelled.submit).not.toHaveBeenCalled();
    expect(keySequence3).toEqual(["keydown", "keyup"]);
  });

  it("within [container, text] scopes to the matching table row in executeStep and precheckStepLocators", async () => {
    const root = new FakeDomElement("body");

    const clientSection = new FakeDomElement("section", { "data-testid": "client-list" });
    const clientTbody = new FakeDomElement("tbody");
    const cRow1 = new FakeDomElement("tr", { "data-testid": "client-row-1" });
    cRow1.appendChild(new FakeDomElement("td", {}, "Nordic Freight Co"));
    const cBtn1 = new FakeDomElement("button", { "data-testid": "open-client-1" }, "Open");
    let clicked1 = 0;
    cBtn1.addEventListener("click", () => {
      clicked1 += 1;
    });
    const cBtn1Cell = new FakeDomElement("td");
    cBtn1Cell.appendChild(cBtn1);
    cRow1.appendChild(cBtn1Cell);

    const cRow2 = new FakeDomElement("tr", { "data-testid": "client-row-2" });
    cRow2.appendChild(new FakeDomElement("td", {}, "Boreal Timber SA"));
    const cBtn2 = new FakeDomElement("button", { "data-testid": "open-client-2" }, "Open");
    let clicked2 = 0;
    cBtn2.addEventListener("click", () => {
      clicked2 += 1;
    });
    const cBtn2Cell = new FakeDomElement("td");
    cBtn2Cell.appendChild(cBtn2);
    cRow2.appendChild(cBtn2Cell);

    clientTbody.appendChild(cRow1);
    clientTbody.appendChild(cRow2);
    clientSection.appendChild(clientTbody);

    const sheetSection = new FakeDomElement("table", { "data-testid": "sheet-table" });
    const sheetTbody = new FakeDomElement("tbody");
    const sRow2 = new FakeDomElement("tr", { "data-testid": "sheet-row-2" });
    sRow2.appendChild(new FakeDomElement("td", {}, "Boreal Timber SA"));
    sRow2.appendChild(new FakeDomElement("td", { "data-col": "lookup" }, "RATE-3190"));
    const sBtn2 = new FakeDomElement("button", {}, "Open");
    let sheetClicked = 0;
    sBtn2.addEventListener("click", () => {
      sheetClicked += 1;
    });
    const sBtn2Cell = new FakeDomElement("td");
    sBtn2Cell.appendChild(sBtn2);
    sRow2.appendChild(sBtn2Cell);
    sheetTbody.appendChild(sRow2);
    sheetSection.appendChild(sheetTbody);

    root.appendChild(clientSection);
    root.appendChild(sheetSection);

    const dom = installFakeDom(root);
    restoreDom = dom.restore;

    const withinLocs = [
      { kind: "testid" as const, value: "client-list" },
      { kind: "text" as const, value: "Boreal Timber SA" },
    ];
    const targetLocs = [
      { kind: "aria" as const, value: 'button[name="Open"]' },
      { kind: "text" as const, value: "Open" },
    ];

    const precheck = precheckStepLocators(targetLocs, withinLocs);
    expect(precheck).toEqual({
      matchCount: 1,
      unique: true,
      matchedLocator: { kind: "aria", value: 'button[name="Open"]' },
    });

    const clickRes = await executeStep({
      action: "click",
      within: withinLocs,
      target: targetLocs,
    });
    expect(clickRes.ok).toBe(true);
    expect(clicked1).toBe(0);
    expect(clicked2).toBe(1);
    expect(sheetClicked).toBe(0);

    const readRes = await executeStep({
      action: "readText",
      within: [
        { kind: "testid", value: "sheet-table" },
        { kind: "text", value: "Boreal Timber SA" },
      ],
      target: { kind: "css", value: 'td[data-col="lookup"]' },
      bind: "rate",
    });
    expect(readRes.ok).toBe(true);
    expect(readRes.value).toBe("RATE-3190");
  });

  it("matches non-testid attributes (data-test/data-qa), ARIA treeitem/checkbox/switch text, and submit/aria-labelledby in precheckStepLocators and executeStep", async () => {
    const root = new FakeDomElement("body");
    const qaBtn = new FakeDomElement("button", { "data-qa": "portal-continue" }, "Continue");
    let qaClicks = 0;
    qaBtn.addEventListener("click", () => {
      qaClicks += 1;
    });

    const termsCheck = new FakeDomElement("div", { role: "checkbox" }, "Accept terms");
    let checkClicks = 0;
    termsCheck.addEventListener("click", () => {
      checkClicks += 1;
    });

    const notifySwitch = new FakeDomElement("button", { role: "switch" }, "Email alerts");
    let switchClicks = 0;
    notifySwitch.addEventListener("click", () => {
      switchClicks += 1;
    });

    const treeNode = new FakeDomElement("li", { role: "treeitem" }, "Municipality of Athens");
    let treeClicks = 0;
    treeNode.addEventListener("click", () => {
      treeClicks += 1;
    });

    const lbl = new FakeDomElement("label", { id: "afm-lbl" }, "AFM Number");
    const afmInput = new FakeDomInput({ id: "afm", "aria-labelledby": "afm-lbl" });
    const submitInput = new FakeDomInput({ type: "submit", value: "Search Registry" });

    root.appendChild(qaBtn);
    root.appendChild(termsCheck);
    root.appendChild(notifySwitch);
    root.appendChild(treeNode);
    root.appendChild(lbl);
    root.appendChild(afmInput);
    root.appendChild(submitInput);

    const dom = installFakeDom(root);
    restoreDom = dom.restore;

    expect(precheckStepLocators([{ kind: "testid", value: "portal-continue" }])).toMatchObject({
      matchCount: 1,
      unique: true,
    });
    expect(precheckStepLocators([{ kind: "aria", value: 'textbox[name="AFM Number"]' }])).toMatchObject({
      matchCount: 1,
      unique: true,
    });
    expect(precheckStepLocators([{ kind: "aria", value: 'button[name="Search Registry"]' }])).toMatchObject({
      matchCount: 1,
      unique: true,
    });
    expect(precheckStepLocators([{ kind: "aria", value: 'checkbox[name="Accept terms"]' }])).toMatchObject({
      matchCount: 1,
      unique: true,
    });

    expect((await executeStep({ action: "click", target: { kind: "testid", value: "portal-continue" } })).ok).toBe(true);
    expect((await executeStep({ action: "click", target: { kind: "aria", value: 'checkbox[name="Accept terms"]' } })).ok).toBe(true);
    expect((await executeStep({ action: "click", target: { kind: "aria", value: 'switch[name="Email alerts"]' } })).ok).toBe(true);
    expect((await executeStep({ action: "click", target: { kind: "aria", value: 'treeitem[name="Municipality of Athens"]' } })).ok).toBe(true);
    expect(qaClicks).toBe(1);
    expect(checkClicks).toBe(1);
    expect(switchClicks).toBe(1);
    expect(treeClicks).toBe(1);
  });

  it("handleHandsCommand forwards step.within on precheck (substituting forEach.items[0]) and script.runMode on decide", async () => {
    const sendMessage = vi.fn(async (_tabId: number, msg: Record<string, unknown>) => {
      if (msg.kind === "EYES_PRECHECK_STEP") {
        return { ok: true, matchCount: 1, unique: true };
      }
      return { ok: true, decision: "approved" };
    });

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => [{ id: 77, url: "http://127.0.0.1:5173/sheet.html", active: true }]),
        sendMessage,
      },
    };

    const postedResults: unknown[] = [];
    mockServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/hands/result") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          postedResults.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      mockServer?.listen(0, "127.0.0.1", () => resolve());
    });
    const baseUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;

    await handleHandsCommand(
      {
        id: "pre-within-1",
        kind: "precheck",
        url: "http://127.0.0.1:5173/sheet.html",
        script: {
          steps: [
            {
              action: "forEach",
              items: [{ col1: "Boreal Timber SA" }],
              steps: [
                {
                  action: "click",
                  within: [
                    { kind: "testid", value: "client-list" },
                    { kind: "text", value: "{{col1}}" },
                  ],
                  target: [{ kind: "aria", value: 'button[name="Open"]' }],
                },
              ],
            },
          ],
        },
      },
      baseUrl,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      77,
      expect.objectContaining({
        kind: "EYES_PRECHECK_STEP",
        within: [
          { kind: "testid", value: "client-list" },
          { kind: "text", value: "Boreal Timber SA" },
        ],
      }),
      { frameId: 0 },
    );

    await handleHandsCommand(
      {
        id: "decide-runmode-1",
        kind: "decide",
        name: "Sync",
        solution: "Sync sheet",
        script: {
          name: "Sync",
          runMode: "run_remaining",
          steps: [{ action: "click", target: { kind: "testid", value: "open-client-3" } }],
        },
      },
      baseUrl,
    );

    await vi.waitFor(() => {
      expect(postedResults).toHaveLength(2);
    });

    expect(sendMessage).toHaveBeenCalledWith(
      77,
      expect.objectContaining({
        kind: "EYES_SHOW_DECIDER",
        runMode: "run",
      }),
      { frameId: 0 },
    );
  });

  it("forwards save_only runMode and params in decide, resolves local PII by piiHash, seeds bindings, and matches loopback tabs", async () => {
    const receivedDecideMsgs: unknown[] = [];
    const postedResults: unknown[] = [];
    const executedSteps: V2DomStep[] = [];

    mockServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/hands/result") {
        let raw = "";
        req.on("data", (c) => {
          raw += c;
        });
        req.on("end", () => {
          postedResults.push(JSON.parse(raw));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      mockServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = mockServer.address() as AddressInfo;
    const serverUrl = `http://127.0.0.1:${addr.port}`;

    const sendMessage = vi.fn(async (_tabId: number, msg: unknown) => {
      const m = msg as { kind?: string };
      if (m.kind === "EYES_SHOW_DECIDER") {
        receivedDecideMsgs.push(msg);
        return {
          ok: true,
          decision: "approved",
          params: { hex_code: "#ff00aa", recipient_email: "alice@local.example" },
        };
      }
      return { ok: true };
    });

    const executeScript = vi.fn(
      async ({ args }: { target: { tabId: number }; args: [V2DomStep] }) => {
        executedSteps.push(args[0]);
        return [{ frameId: 0, result: { ok: true, url: "http://127.0.0.1:4173/unseen-form.html" } }];
      },
    );

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => [
          { id: 701, url: "http://127.0.0.1:4173/unseen-form.html", active: true, windowId: 1 },
        ]),
        update: vi.fn(async () => ({})),
        sendMessage,
      },
      windows: { update: vi.fn(async () => ({})) },
      scripting: { executeScript },
    };

    // Store local PII hash via EYES_EVENT without touching server
    const evtRes = vi.fn();
    handleRuntimeMessage(
      {
        kind: "EYES_EVENT",
        localPii: { h_deadbeef: "alice@local.example" },
        event: {
          v: 1,
          id: "evt-pii-1",
          ts: Date.now(),
          session: "sess_test",
          source: "browser",
          app: "127.0.0.1",
          type: "input",
          value: "[REDACTED:EMAIL#h_deadbeef]",
        },
      } as unknown as Parameters<typeof handleRuntimeMessage>[0],
      { tab: { id: 701, url: "http://127.0.0.1:4173/unseen-form.html" } },
      evtRes,
    );
    expect(evtRes).toHaveBeenCalledWith({ ok: true });

    await handleHandsCommand(
      {
        id: "dec-save-only-1",
        kind: "decide",
        name: "Submit hex row",
        solution: "Fill 3 fields and save.",
        script: {
          name: "Submit hex row",
          runMode: "save_only",
          params: [
            { name: "hex_code", example: "#112233" },
            { name: "recipient_email", piiHash: "h_deadbeef" },
          ],
          steps: [
            { action: "switchTab", host: "127.0.0.1" },
            { action: "fill", target: { kind: "testid", value: "hex-code" }, value: "{{hex_code}}" },
            {
              action: "fill",
              target: { kind: "testid", value: "recipient-email" },
              value: "{{recipient_email}}",
            },
          ],
        },
      },
      serverUrl,
    );

    await vi.waitFor(() => {
      expect(postedResults).toHaveLength(1);
    });

    expect(receivedDecideMsgs[0]).toMatchObject({
      kind: "EYES_SHOW_DECIDER",
      runMode: "save_only",
      params: [
        { name: "hex_code", example: "#112233" },
        { name: "recipient_email", piiHash: "h_deadbeef", example: "alice@local.example" },
      ],
    });
    expect(postedResults[0]).toEqual({
      id: "dec-save-only-1",
      ok: true,
      decision: "approved",
      params: { hex_code: "#ff00aa", recipient_email: "alice@local.example" },
    });

    // Run with switchTab host: "127.0.0.1" and matching url against 127.0.0.1 tab + param seeding from piiHash & example
    await runActionScript(701, {
      name: "Submit hex row",
      params: [
        { name: "hex_code", example: "#112233" },
        { name: "recipient_email", piiHash: "h_deadbeef" },
      ],
      steps: [
        { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:4173/unseen-form.html" },
        { action: "fill", target: { kind: "testid", value: "hex-code" }, value: "{{hex_code}}" },
        {
          action: "fill",
          target: { kind: "testid", value: "recipient-email" },
          value: "{{recipient_email}}",
        },
      ],
    });

    expect(executedSteps).toHaveLength(2);
    expect((executedSteps[0] as { value?: string }).value).toBe("#112233");
    expect((executedSteps[1] as { value?: string }).value).toBe("alice@local.example");
  });

  it("switchTab prefers step.url over step.host, keeps 127.0.0.1 vs localhost distinct, and keeps different ports distinct", async () => {
    const updatedTabs: Array<{ tabId: number; props: { active?: boolean } }> = [];
    const tabs = [
      { id: 10, url: "http://localhost:4173/portal.html", windowId: 1, active: true, lastAccessed: 900 },
      { id: 20, url: "http://127.0.0.1:4173/erp.html", windowId: 1, active: false, lastAccessed: 800 },
      { id: 30, url: "http://127.0.0.1:5173/erp.html", windowId: 1, active: false, lastAccessed: 950 },
      { id: 40, url: "http://127.0.0.1:4173/other.html", windowId: 1, active: false, lastAccessed: 990 },
    ];
    const executeScript = vi.fn(async ({ target }: { target: { tabId: number } }) => [
      { frameId: 0, result: { ok: true, url: `tab:${target.tabId}` } },
    ]);

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => tabs),
        update: vi.fn(async (tabId: number, props: { active?: boolean }) => {
          updatedTabs.push({ tabId, props });
          return { id: tabId, ...props };
        }),
      },
      windows: { update: vi.fn(async () => ({})) },
      scripting: { executeScript },
    };

    // 1. Prefers step.url (exact erp.html on 127.0.0.1:4173) over more recently accessed other.html or :5173
    const res1 = await runActionScript(10, {
      steps: [
        {
          action: "switchTab",
          host: "127.0.0.1",
          url: "http://127.0.0.1:4173/erp.html",
        },
        { action: "click", target: { kind: "testid", value: "save" } },
      ],
    });
    expect(res1[0]).toMatchObject({ ok: true, url: "http://127.0.0.1:4173/erp.html" });
    expect(updatedTabs[0]).toEqual({ tabId: 20, props: { active: true } });
    expect(executeScript.mock.calls[0]?.[0].target.tabId).toBe(20);

    // 2. Keeps 127.0.0.1 vs localhost distinct (switchTab host: "localhost" must not match 127.0.0.1:5173, only localhost:4173)
    updatedTabs.length = 0;
    const res2 = await runActionScript(20, {
      steps: [
        { action: "switchTab", host: "localhost" },
        { action: "click", target: { kind: "testid", value: "portal-btn" } },
      ],
    });
    expect(res2[0]).toEqual({ ok: true, tab: "localhost" });
    expect(updatedTabs[0]).toEqual({ tabId: 10, props: { active: true } });

    // 3. Throws when only 127.0.0.1 tab exists for a requested localhost:5173 or unused port
    await expect(
      runActionScript(10, {
        steps: [{ action: "switchTab", host: "localhost:5173" }],
      }),
    ).rejects.toThrow("No open tab for localhost:5173");

    await expect(
      runActionScript(10, {
        steps: [{ action: "switchTab", host: "127.0.0.1:6173" }],
      }),
    ).rejects.toThrow("No open tab for 127.0.0.1:6173");

    // 4. Keeps different ports distinct when step.url specifies port 5173
    updatedTabs.length = 0;
    const res4 = await runActionScript(10, {
      steps: [
        {
          action: "switchTab",
          host: "127.0.0.1",
          url: "http://127.0.0.1:5173/erp.html",
        },
      ],
    });
    expect(res4[0]).toMatchObject({ ok: true, url: "http://127.0.0.1:5173/erp.html" });
    expect(updatedTabs[0]).toEqual({ tabId: 30, props: { active: true } });
  });
});

describe("GEN-99: navigate frame reset and chrome-error guards", () => {
  const originalChrome = (globalThis as Record<string, unknown>).chrome;

  afterEach(() => {
    stopHandsRun();
    if (originalChrome === undefined) {
      delete (globalThis as Record<string, unknown>).chrome;
    } else {
      (globalThis as Record<string, unknown>).chrome = originalChrome;
    }
  });

  it("clears lastFieldFrameByTab on navigate so subsequent targetless steps run against top frame", async () => {
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId, status: "complete" }));
    const getTab = vi.fn(async () => ({
      id: 101,
      url: "http://localhost:4173/form.html",
      status: "complete",
    }));
    const executeScript = vi.fn(
      async ({ target }: { target: { tabId: number; frameIds?: number[] } }) => [
        { frameId: 0, result: { ok: true, url: `tab:${target.tabId}` } },
      ],
    );

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { update: updateTab, get: getTab },
      scripting: { executeScript },
    };

    const sendRes = vi.fn();
    handleRuntimeMessage(
      { kind: "HANDS_FIELD_FOCUSED" },
      { tab: { id: 101, url: "http://localhost:4173/prev.html" }, frameId: 7 },
      sendRes,
    );
    expect(sendRes).toHaveBeenCalledWith({ ok: true });

    await runActionScript(101, {
      steps: [
        { action: "insertText", value: "in-iframe" },
        { action: "navigate", url: "http://localhost:4173/form.html" },
        { action: "insertText", value: "after-nav" },
      ],
    });

    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls[0]?.[0].target).toEqual({ tabId: 101, frameIds: [7] });
    expect(executeScript.mock.calls[1]?.[0].target).toEqual({ tabId: 101 });
  });

  it("throws a descriptive error when navigate lands on chrome-error://chromewebdata/", async () => {
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const getTab = vi.fn(async () => ({
      id: 101,
      url: "chrome-error://chromewebdata/",
      status: "complete",
    }));
    const executeScript = vi.fn();

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { update: updateTab, get: getTab },
      scripting: { executeScript },
    };

    await expect(
      runActionScript(101, {
        steps: [
          { action: "navigate", url: "http://localhost/missing" },
          { action: "click", target: { kind: "css", value: "#submit" } },
        ],
      }),
    ).rejects.toThrow("Navigation failed for http://localhost/missing (error page)");

    expect(executeScript).not.toHaveBeenCalled();
  });

  it("surfaces a clear error including tab.url when executeScript hits Frame with ID 0 is showing error page", async () => {
    const getTab = vi.fn(async () => ({
      id: 101,
      url: "chrome-error://chromewebdata/",
      status: "complete",
    }));
    const executeScript = vi.fn(async () => {
      throw new Error("Frame with ID 0 is showing error page");
    });

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { get: getTab },
      scripting: { executeScript },
    };

    await expect(
      runActionScript(101, {
        steps: [{ action: "click", target: { kind: "css", value: "#submit" } }],
      }),
    ).rejects.toThrow(/chrome-error:\/\/chromewebdata\//);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("retries executeScript once after waitForTabLoad when Frame with ID 0 error occurs while loading", async () => {
    let tabState: { id: number; url: string; status: string } = {
      id: 101,
      url: "http://localhost:4173/form.html",
      status: "loading",
    };
    const listeners = new Set<
      (tabId: number, changeInfo: { status?: string; url?: string }, tab: { id: number; url?: string; status?: string }) => void
    >();
    const getTab = vi.fn(async () => tabState);
    const onUpdated = {
      addListener: vi.fn((cb) => {
        listeners.add(cb);
      }),
      removeListener: vi.fn((cb) => {
        listeners.delete(cb);
      }),
    };
    const executeScript = vi
      .fn()
      .mockRejectedValueOnce(new Error("Frame with ID 0 is showing error page"))
      .mockResolvedValueOnce([
        { frameId: 0, result: { ok: true, url: "http://localhost:4173/form.html" } },
      ]);

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { get: getTab, onUpdated },
      scripting: { executeScript },
    };

    const runPromise = runActionScript(101, {
      steps: [{ action: "click", target: { kind: "css", value: "#submit" } }],
    });

    await new Promise((r) => setTimeout(r, 10));
    tabState = { id: 101, url: "http://localhost:4173/form.html", status: "complete" };
    for (const cb of listeners) {
      cb(101, { status: "complete" }, tabState);
    }

    const results = await runPromise;
    expect(results).toEqual([{ ok: true, url: "http://localhost:4173/form.html" }]);
    expect(executeScript).toHaveBeenCalledTimes(2);
  });
});

describe("GEN-95: offer popup tab targeting and Run flow-start tab switch", () => {
  const originalChrome = (globalThis as Record<string, unknown>).chrome;
  let mockServer: http.Server | null = null;

  afterEach(async () => {
    stopHandsRun();
    if (originalChrome === undefined) {
      delete (globalThis as Record<string, unknown>).chrome;
    } else {
      (globalThis as Record<string, unknown>).chrome = originalChrome;
    }
    if (mockServer) {
      await new Promise<void>((resolve, reject) => {
        mockServer?.close((err) => (err ? reject(err) : resolve()));
      });
      mockServer = null;
    }
  });

  async function startResultServer(postedResults: unknown[]): Promise<string> {
    mockServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/hands/result") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          postedResults.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      mockServer!.listen(0, "127.0.0.1", () => resolve());
    });
    return `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
  }

  it("delivers decide popup to the last meaningful event tab, not a focused unrelated tab after tab_switch/mousemove", async () => {
    const postedResults: unknown[] = [];
    const baseUrl = await startResultServer(postedResults);

    const sendMessage = vi.fn(async (_tabId: number, _msg: unknown) => {
      void _tabId;
      void _msg;
      return { ok: true, decision: "dismissed" };
    });

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => [
          { id: 101, url: "http://localhost:4173/portal.html", active: false, windowId: 1 },
          { id: 202, url: "http://127.0.0.1:4173/erp.html", active: false, windowId: 1 },
          { id: 303, url: "https://mail.google.com/mail/u/0/#inbox", active: true, windowId: 2 },
        ]),
        sendMessage,
      },
    };

    const evtRes = vi.fn();
    handleRuntimeMessage(
      {
        kind: "EYES_EVENT",
        event: {
          v: 1,
          id: "evt-erp-save",
          ts: Date.now(),
          session: "sess_test",
          source: "browser",
          app: "127.0.0.1",
          url: "http://127.0.0.1:4173/erp.html",
          type: "click",
        },
      },
      { tab: { id: 202, url: "http://127.0.0.1:4173/erp.html" } },
      evtRes,
    );

    // Unrelated tab focus + mousemove must not steal the offer popup target
    recordEvent({
      v: 1,
      id: "evt-switch-gmail",
      ts: Date.now() + 100,
      session: BROWSER_SESSION_ID,
      source: "browser",
      app: "mail.google.com",
      url: "https://mail.google.com/mail/u/0/#inbox",
      type: "tab_switch",
      meta: { tabId: 303 },
    });
    handleRuntimeMessage(
      {
        kind: "EYES_EVENT",
        event: {
          v: 1,
          id: "evt-gmail-move",
          ts: Date.now() + 200,
          session: "sess_test",
          source: "browser",
          app: "mail.google.com",
          url: "https://mail.google.com/mail/u/0/#inbox",
          type: "mousemove",
        },
      },
      { tab: { id: 303, url: "https://mail.google.com/mail/u/0/#inbox" } },
      evtRes,
    );

    await handleHandsCommand(
      {
        id: "dec-gen95-1",
        kind: "decide",
        name: "Sync Portal to ERP",
        solution: "Copy order and save in ERP",
        url: "http://localhost:4173/portal.html",
        script: {
          name: "Sync Portal to ERP",
          steps: [
            { action: "switchTab", host: "localhost", url: "http://localhost:4173/portal.html" },
            { action: "readText", target: { kind: "css", value: ".order" }, bind: "order" },
            { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:4173/erp.html" },
            { action: "fill", target: { kind: "css", value: "#order" }, value: "{{order}}" },
          ],
        },
      },
      baseUrl,
    );

    await vi.waitFor(() => {
      expect(postedResults).toHaveLength(1);
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(202);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ kind: "EYES_SHOW_DECIDER" });
  });

  it("ignores clicks on unrelated hosts and falls back to the flow start URL tab for decide", async () => {
    const postedResults: unknown[] = [];
    const baseUrl = await startResultServer(postedResults);

    const sendMessage = vi.fn(async (_tabId: number, _msg: unknown) => {
      void _tabId;
      void _msg;
      return { ok: true, decision: "dismissed" };
    });

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => [
          { id: 101, url: "http://localhost:4173/portal.html", active: false, windowId: 1 },
          { id: 102, url: "http://localhost:4173/other.html", active: false, windowId: 1 },
          { id: 303, url: "https://mail.google.com/mail/u/0/#inbox", active: true, windowId: 2 },
        ]),
        sendMessage,
      },
    };

    // User even clicked inside mail.google.com while compiler ran
    handleRuntimeMessage(
      {
        kind: "EYES_EVENT",
        event: {
          v: 1,
          id: "evt-gmail-click",
          ts: Date.now(),
          session: "sess_test",
          source: "browser",
          app: "mail.google.com",
          url: "https://mail.google.com/mail/u/0/#inbox",
          type: "click",
        },
      },
      { tab: { id: 303, url: "https://mail.google.com/mail/u/0/#inbox" } },
      vi.fn(),
    );

    await handleHandsCommand(
      {
        id: "dec-gen95-2",
        kind: "decide",
        name: "Submit portal order",
        solution: "Click submit on portal",
        url: "http://localhost:4173/portal.html",
        script: {
          name: "Submit portal order",
          steps: [
            { action: "switchTab", host: "localhost", url: "http://localhost:4173/portal.html" },
            { action: "click", target: { kind: "testid", value: "submit-btn" } },
          ],
        },
      },
      baseUrl,
    );

    await vi.waitFor(() => {
      expect(postedResults).toHaveLength(1);
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(101);
  });

  it("Run first switches to the flow start tab (switchTab with url) before replaying, even when approved on another tab or missing leading switchTab", async () => {
    const postedResults: unknown[] = [];
    const baseUrl = await startResultServer(postedResults);

    const updatedTabs: number[] = [];
    const executedOnTabs: number[] = [];
    const sendMessage = vi.fn(async (_tabId: number, msg: { kind?: string }) => {
      if (msg.kind === "EYES_SHOW_DECIDER") {
        return { ok: true, decision: "approved" };
      }
      return { ok: true };
    });

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => [
          { id: 101, url: "http://localhost:4173/portal.html", active: false, windowId: 1 },
          { id: 202, url: "http://127.0.0.1:4173/erp.html", active: false, windowId: 1 },
          { id: 303, url: "https://mail.google.com/mail/u/0/#inbox", active: true, windowId: 2 },
        ]),
        update: vi.fn(async (tabId: number) => {
          updatedTabs.push(tabId);
          return { id: tabId };
        }),
        sendMessage,
      },
      windows: { update: vi.fn(async () => ({})) },
      scripting: {
        executeScript: vi.fn(async ({ target }: { target: { tabId: number } }) => {
          executedOnTabs.push(target.tabId);
          return [{ frameId: 0, result: { ok: true, value: "INV-1" } }];
        }),
      },
    };

    // 1. Decide arrives on cmd.tabId=202 (erp.html) and user clicks Run
    await handleHandsCommand(
      {
        id: "dec-gen95-3",
        kind: "decide",
        name: "Sync Portal to ERP",
        solution: "Sync",
        tabId: 202,
        url: "http://localhost:4173/portal.html",
        script: {
          name: "Sync Portal to ERP",
          steps: [
            { action: "switchTab", host: "localhost", url: "http://localhost:4173/portal.html" },
            { action: "readText", target: { kind: "css", value: ".order" }, bind: "order" },
            { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:4173/erp.html" },
            { action: "fill", target: { kind: "css", value: "#order" }, value: "{{order}}" },
          ],
        },
      },
      baseUrl,
    );
    await vi.waitFor(() => {
      expect(postedResults).toHaveLength(1);
    });
    expect(sendMessage.mock.calls[0]?.[0]).toBe(202);

    // 2. Run starts by switching to flow start tab 101 (portal.html), reading there, then switching to 202 (erp.html)
    await handleHandsCommand(
      {
        id: "run-gen95-3",
        url: "http://localhost:4173/portal.html",
        script: {
          name: "Sync Portal to ERP",
          steps: [
            { action: "switchTab", host: "localhost", url: "http://localhost:4173/portal.html" },
            { action: "readText", target: { kind: "css", value: ".order" }, bind: "order" },
            { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:4173/erp.html" },
            { action: "fill", target: { kind: "css", value: "#order" }, value: "{{order}}" },
          ],
        },
      },
      baseUrl,
    );
    expect(updatedTabs).toEqual([101, 202]);
    expect(executedOnTabs).toEqual([101, 202]);

    // 3. Run with cmd.url on a script lacking a leading switchTab also switches to flow start tab 101 first
    updatedTabs.length = 0;
    executedOnTabs.length = 0;
    await handleHandsCommand(
      {
        id: "run-gen95-4",
        url: "http://localhost:4173/portal.html",
        script: {
          name: "Click portal button",
          steps: [{ action: "click", target: { kind: "testid", value: "refresh" } }],
        },
      },
      baseUrl,
    );
    expect(updatedTabs).toEqual([101]);
    expect(executedOnTabs).toEqual([101]);
  });

  it("GEN-123 / GEN-126: precheck checks only the first step with a locator per matching open tab (skipping revealed/later steps on already-checked tabs and missing tabs)", async () => {
    const postedResults: unknown[] = [];
    const baseUrl = await startResultServer(postedResults);

    const sendMessage = vi.fn(async (tabId: number, msg: { kind?: string; locators?: Array<{ value: string }> }) => {
      if (msg.kind !== "EYES_PRECHECK_STEP") return { ok: false };
      const val = msg.locators?.[0]?.value;
      if (tabId === 101 && val === "portal-invoice-id") {
        return { ok: true, matchCount: 1, unique: true };
      }
      if (tabId === 202 && (val === "erp-invoice-id" || val === "save-btn")) {
        return { ok: true, matchCount: 1, unique: true };
      }
      if (tabId === 404 && val === "summary-heading") {
        return { ok: true, matchCount: 1, unique: true };
      }
      return { ok: true, matchCount: 0, unique: false };
    });

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => [
          { id: 101, url: "http://127.0.0.1:5173/portal.html", active: false, windowId: 1 },
          { id: 202, url: "http://127.0.0.1:5173/erp.html", active: false, windowId: 1 },
          { id: 303, url: "https://example.com/", active: true, windowId: 2 },
          { id: 404, url: "https://reports.local/summary", active: false, windowId: 2 },
        ]),
        sendMessage,
      },
    };

    await handleHandsCommand(
      {
        id: "pre-gen123-1",
        kind: "precheck",
        url: "http://127.0.0.1:5173/portal.html",
        script: {
          name: "Transfer Invoices",
          steps: [
            {
              action: "forEach",
              items: [{ invoiceId: "INV-1" }],
              steps: [
                { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:5173/portal.html" },
                { action: "readText", target: { kind: "testid", value: "portal-invoice-id" }, bind: "inv" },
                { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:5173/erp.html" },
                { action: "fill", target: { kind: "testid", value: "erp-invoice-id" }, value: "{{inv}}" },
                { action: "click", target: { kind: "css", value: ".select2-results__option" } },
                { action: "navigate", url: "https://missing.local/step" },
                { action: "click", target: { kind: "testid", value: "missing-btn" } },
                { action: "switchTab", host: "reports.local" },
                { action: "click", target: { kind: "testid", value: "summary-heading" } },
              ],
            },
            { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:5173/erp.html" },
            { action: "click", target: { kind: "testid", value: "save-btn" } },
          ],
        },
      },
      baseUrl,
    );

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(101);
    expect(sendMessage.mock.calls[1]?.[0]).toBe(202);
    expect(sendMessage.mock.calls[2]?.[0]).toBe(404);
    expect(postedResults[0]).toEqual({
      id: "pre-gen123-1",
      ok: true,
      results: [
        { index: 2, action: "readText", ok: true, matchCount: 1, unique: true },
        { index: 4, action: "fill", ok: true, matchCount: 1, unique: true },
        { index: 9, action: "click", ok: true, matchCount: 1, unique: true },
      ],
    });
  });

  it("GEN-123: precheck returns ok: true with empty results when no open tabs match and times out hung tabs quickly", async () => {
    const postedResults: unknown[] = [];
    const baseUrl = await startResultServer(postedResults);

    // 1. No matching tabs open -> skips all steps instead of failing
    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => [
          { id: 303, url: "https://example.com/", active: true },
        ]),
        sendMessage: vi.fn(),
      },
    };

    await handleHandsCommand(
      {
        id: "pre-gen123-none",
        kind: "precheck",
        url: "http://127.0.0.1:5173/portal.html",
        script: {
          steps: [
            { action: "readText", target: { kind: "testid", value: "portal-invoice-id" }, bind: "inv" },
            { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:5173/erp.html" },
            { action: "fill", target: { kind: "testid", value: "erp-invoice-id" }, value: "{{inv}}" },
          ],
        },
      },
      baseUrl,
    );

    expect(postedResults[0]).toEqual({ id: "pre-gen123-none", ok: true, results: [] });

    // 2. Hung tabs.sendMessage on portal tab times out per message and skips remaining steps on that tab, while still checking healthy ERP tab
    const sendMessageHung = vi.fn((tabId: number) => {
      if (tabId === 101) {
        return new Promise(() => {
          // intentionally never resolves
        });
      }
      return Promise.resolve({ ok: true, matchCount: 1, unique: true });
    });

    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: vi.fn(async () => [
          { id: 101, url: "http://127.0.0.1:5173/portal.html", active: false },
          { id: 202, url: "http://127.0.0.1:5173/erp.html", active: true },
        ]),
        sendMessage: sendMessageHung,
      },
    };

    const started = Date.now();
    await handleHandsCommand(
      {
        id: "pre-gen123-timeout",
        kind: "precheck",
        url: "http://127.0.0.1:5173/portal.html",
        script: {
          steps: [
            { action: "readText", target: { kind: "testid", value: "portal-invoice-id" }, bind: "inv" },
            { action: "readText", target: { kind: "testid", value: "portal-vendor" }, bind: "vendor" },
            { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:5173/erp.html" },
            { action: "fill", target: { kind: "testid", value: "erp-invoice-id" }, value: "{{inv}}" },
          ],
        },
      },
      baseUrl,
    );
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(3500);
    // Hung tab 101 only waited once; second step on tab 101 was skipped immediately; tab 202 still ran
    expect(sendMessageHung).toHaveBeenCalledTimes(2);
    expect(postedResults[1]).toEqual({
      id: "pre-gen123-timeout",
      ok: true,
      results: [{ index: 3, action: "fill", ok: true, matchCount: 1, unique: true }],
    });
  });
});
