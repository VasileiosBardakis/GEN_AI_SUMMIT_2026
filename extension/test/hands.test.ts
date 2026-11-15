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

    // Only step 0 (.order-id on portal.html) and step 3 (explicit portal.html url) should be checked,
    // NOT step 2 (#erp-order after switchTab to erp.html).
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      kind: "EYES_PRECHECK_STEP",
      locators: [{ kind: "css", value: ".order-id" }],
    });
    expect(sendMessage.mock.calls[1]?.[1]).toMatchObject({
      kind: "EYES_PRECHECK_STEP",
      locators: [{ kind: "testid", value: "portal-refresh" }],
    });

    expect(receivedResults).toHaveLength(1);
    expect(receivedResults[0]).toMatchObject({
      id: "precheck-1",
      ok: true,
      results: [
        { index: 0, action: "readText", ok: true, matchCount: 1, unique: true },
        { index: 3, action: "click", ok: true, matchCount: 1, unique: true },
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

  it("switchTab with host='localhost' and url='http://localhost:4173/erp.html' activates http://127.0.0.1:4173/erp.html over http://localhost:4173/portal.html and replays fill on row 4", async () => {
    expect(normalizeLoopbackHost("127.0.0.1")).toBe("localhost");
    expect(normalizeLoopbackHost("127.0.0.1:4173")).toBe("localhost:4173");
    expect(normalizeLoopbackHost("localhost:4173")).toBe("localhost:4173");
    expect(tabMatchesHost("http://127.0.0.1:4173/erp.html", "localhost")).toBe(true);
    expect(tabMatchesHost("http://127.0.0.1:4173/erp.html", "localhost:4173")).toBe(true);
    expect(tabMatchesHost("http://127.0.0.1:4173/erp.html", "localhost:5173")).toBe(false);
    expect(
      scoreTabUrlMatch("http://127.0.0.1:4173/erp.html", "http://localhost:4173/erp.html"),
    ).toBe(3);
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
              host: "localhost",
              url: "http://localhost:4173/erp.html",
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
      tab: "localhost",
      url: "http://127.0.0.1:4173/erp.html",
    });
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
});
