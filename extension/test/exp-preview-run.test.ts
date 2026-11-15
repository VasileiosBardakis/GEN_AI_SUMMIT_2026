import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSubmitElement, previewRun } from "../src/exp/preview-run.ts";
import type { ActionScript } from "../src/types.ts";

class MockElement {
  nodeType = 1;
  tagName: string;
  id = "";
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  labels: MockElement[] = [];
  private attrs = new Map<string, string>();
  private ownText = "";
  private _value = "";

  clickSpy = vi.fn();
  focusSpy = vi.fn();
  setAttributeSpy = vi.fn();
  removeAttributeSpy = vi.fn();
  dispatchEventSpy = vi.fn();
  appendChildSpy = vi.fn();
  removeChildSpy = vi.fn();
  valueSetSpy = vi.fn();
  textContentSetSpy = vi.fn();

  constructor(
    tagName: string,
    attrs: Record<string, string> = {},
    text = "",
    opts: { value?: string } = {},
  ) {
    this.tagName = tagName.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) {
      this.attrs.set(k, v);
      if (k === "id") this.id = v;
    }
    this.ownText = text;
    if (opts.value !== undefined) {
      this._value = opts.value;
    } else if (attrs.value !== undefined) {
      this._value = attrs.value;
    }
  }

  get value(): string {
    return this._value;
  }

  set value(next: string) {
    this.valueSetSpy(next);
    this._value = next;
  }

  get textContent(): string {
    if (this.children.length === 0) return this.ownText;
    return [this.ownText, ...this.children.map((c) => c.textContent)]
      .filter(Boolean)
      .join(" ");
  }

  set textContent(next: string) {
    this.textContentSetSpy(next);
    this.ownText = next;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.setAttributeSpy(name, value);
    this.attrs.set(name, value);
    if (name === "id") this.id = value;
  }

  removeAttribute(name: string): void {
    this.removeAttributeSpy(name);
    this.attrs.delete(name);
  }

  click(): void {
    this.clickSpy();
  }

  focus(): void {
    this.focusSpy();
  }

  dispatchEvent(event: unknown): boolean {
    this.dispatchEventSpy(event);
    return true;
  }

  appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  appendChildTracked(child: MockElement): MockElement {
    this.appendChildSpy(child);
    return this.appendChild(child);
  }

  removeChild(child: MockElement): MockElement {
    this.removeChildSpy(child);
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
    return child;
  }

  matches(selector: string): boolean {
    return selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .some((part) => this.matchesCompound(part));
  }

  private matchesCompound(selector: string): boolean {
    const tokens = selector.trim().split(/\s+/);
    if (tokens.length > 1) {
      const last = tokens[tokens.length - 1];
      if (!this.matchesSingle(last)) return false;
      let ancestor = this.parentElement;
      let tokenIdx = tokens.length - 2;
      while (ancestor && tokenIdx >= 0) {
        if (ancestor.matchesSingle(tokens[tokenIdx])) {
          tokenIdx -= 1;
        }
        ancestor = ancestor.parentElement;
      }
      return tokenIdx < 0;
    }
    return this.matchesSingle(selector);
  }

  private matchesSingle(sel: string): boolean {
    if (sel === "*") return true;
    let remaining = sel;

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

    const classMatches = [...remaining.matchAll(/\.([a-z0-9_-]+)/gi)];
    for (const cm of classMatches) {
      const classes = (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
      if (!classes.includes(cm[1])) return false;
      remaining = remaining.replace(cm[0], "");
    }

    const attrMatches = [...remaining.matchAll(/\[([a-z0-9_-]+)(?:=["']([^"']*)["'])?\]/gi)];
    for (const m of attrMatches) {
      const attrName = m[1];
      const expected = m[2];
      const actual = this.getAttribute(attrName);
      if (actual === null) return false;
      if (expected !== undefined && actual !== expected) return false;
      remaining = remaining.replace(m[0], "");
    }

    return remaining.trim() === "" && (Boolean(tagMatch) || Boolean(idMatch) || classMatches.length > 0 || attrMatches.length > 0);
  }

  closest(selector: string): MockElement | null {
    if (this.matches(selector)) return this;
    let curr: MockElement | null = this.parentElement;
    while (curr) {
      if (curr.matches(selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const out: MockElement[] = [];
    const visit = (node: MockElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

class MockDocument {
  nodeType = 9;
  body: MockElement;

  constructor() {
    this.body = new MockElement("body");
  }

  querySelectorAll(selector: string): MockElement[] {
    return this.body.querySelectorAll(selector);
  }

  getElementById(id: string): MockElement | null {
    return this.querySelectorAll(`#${id}`)[0] ?? null;
  }
}

function attachDomSpyMethods(root: MockElement): MockElement[] {
  const all: MockElement[] = [];
  const visit = (el: MockElement): void => {
    all.push(el);
    for (const child of el.children) visit(child);
  };
  visit(root);
  for (const el of all) {
    el.appendChild = el.appendChildTracked.bind(el);
  }
  return all;
}

describe("isSubmitElement", () => {
  it("detects submit buttons and inputs without relying on button text", () => {
    const form = new MockElement("form", { id: "f" });
    const explicitSubmitBtn = new MockElement("button", { type: "submit" }, "Continue");
    const implicitFormBtn = new MockElement("button", {}, "Next");
    const explicitButtonInForm = new MockElement("button", { type: "button" }, "Submit");
    const resetInForm = new MockElement("button", { type: "reset" }, "Reset");
    const outsideNoTypeBtn = new MockElement("button", {}, "Save");
    const submitInput = new MockElement("input", { type: "submit", value: "Go" });
    const buttonInput = new MockElement("input", { type: "button", value: "Submit" });
    const roleSubmitDiv = new MockElement("div", { role: "submit" }, "Done");

    form.appendChild(explicitSubmitBtn);
    form.appendChild(implicitFormBtn);
    form.appendChild(explicitButtonInForm);
    form.appendChild(resetInForm);
    form.appendChild(submitInput);
    form.appendChild(buttonInput);

    expect(isSubmitElement(explicitSubmitBtn as unknown as Element)).toBe(true);
    expect(isSubmitElement(implicitFormBtn as unknown as Element)).toBe(true);
    expect(isSubmitElement(explicitButtonInForm as unknown as Element)).toBe(false);
    expect(isSubmitElement(resetInForm as unknown as Element)).toBe(false);
    expect(isSubmitElement(outsideNoTypeBtn as unknown as Element)).toBe(false);
    expect(isSubmitElement(submitInput as unknown as Element)).toBe(true);
    expect(isSubmitElement(buttonInput as unknown as Element)).toBe(false);
    expect(isSubmitElement(roleSubmitDiv as unknown as Element)).toBe(true);
  });
});

describe("previewRun", () => {
  const originalDocument = (globalThis as Record<string, unknown>).document;
  let doc: MockDocument;

  beforeEach(() => {
    doc = new MockDocument();
    (globalThis as Record<string, unknown>).document = doc;
  });

  afterEach(() => {
    if (originalDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = originalDocument;
    }
  });

  it("marks resolved non-submit steps as found, submit click as skipped, and formats ready summary", () => {
    const form = new MockElement("form", { id: "profile-form" });
    const company = new MockElement("input", { name: "company_name" });
    const email = new MockElement("input", { name: "owner_email", "data-testid": "email-input" });
    const previewBtn = new MockElement("button", { type: "button" }, "Check");
    const submitBtn = new MockElement("button", { type: "submit" }, "Save profile");
    form.appendChild(company);
    form.appendChild(email);
    form.appendChild(previewBtn);
    form.appendChild(submitBtn);
    doc.body.appendChild(form);

    const script: ActionScript = {
      name: "Profile",
      steps: [
        { action: "fill", target: { kind: "css", value: 'input[name="company_name"]' }, value: "Acme" },
        { action: "fill", target: { kind: "testid", value: "email-input" }, value: "ops@acme.test" },
        { action: "click", target: { kind: "text", value: "Check" } },
        { action: "click", target: { kind: "css", value: 'button[type="submit"]' } },
      ],
    };

    const result = previewRun(script, { root: doc as unknown as ParentNode });

    expect(result.ready).toBe(true);
    expect(result.found).toBe(3);
    expect(result.total).toBe(4);
    expect(result.summary).toBe("ready: 3 of 4 steps found");
    expect(result.steps).toEqual([
      { index: 0, action: "fill", status: "found" },
      { index: 1, action: "fill", status: "found" },
      { index: 2, action: "click", status: "found" },
      {
        index: 3,
        action: "click",
        status: "skipped",
        reason: "Submit click skipped in dry-run preview",
      },
    ]);
  });

  it("marks missing target element as missing and names the failing step in summary", () => {
    const form = new MockElement("form", { id: "profile-form" });
    const company = new MockElement("input", { name: "company_name" });
    form.appendChild(company);
    doc.body.appendChild(form);

    const script: ActionScript = {
      steps: [
        { action: "fill", target: { kind: "css", value: 'input[name="company_name"]' }, value: "Acme" },
        { action: "fill", target: { kind: "css", value: 'input[name="missing_field"]' }, value: "Nope" },
      ],
    };

    const result = previewRun(script);

    expect(result.ready).toBe(false);
    expect(result.found).toBe(1);
    expect(result.total).toBe(2);
    expect(result.steps[0]).toEqual({ index: 0, action: "fill", status: "found" });
    expect(result.steps[1].status).toBe("missing");
    expect(result.steps[1].action).toBe("fill");
    expect(result.steps[1].reason).toContain("missing_field");
    expect(result.summary).not.toMatch(/^ready:/);
    expect(result.summary).toContain("step 1");
    expect(result.summary).toContain("fill");
    expect(result.summary).toContain("missing_field");
  });

  it("detects missing {{param}} bindings and passes when opts.bindings supplies them", () => {
    const company = new MockElement("input", { name: "company_name", "aria-label": "Company name" });
    doc.body.appendChild(company);

    const script: ActionScript = {
      steps: [
        {
          action: "fill",
          target: { kind: "aria", value: 'textbox[name="Company name"]' },
          value: "{{companyName}}",
        },
      ],
    };

    const missingResult = previewRun(script);
    expect(missingResult.ready).toBe(false);
    expect(missingResult.found).toBe(0);
    expect(missingResult.total).toBe(1);
    expect(missingResult.steps[0]).toMatchObject({
      index: 0,
      action: "fill",
      status: "missing",
    });
    expect(missingResult.steps[0].reason).toContain("companyName");
    expect(missingResult.summary).toContain("companyName");

    const okResult = previewRun(script, { bindings: { companyName: "Nikolaidis SA" } });
    expect(okResult.ready).toBe(true);
    expect(okResult.found).toBe(1);
    expect(okResult.total).toBe(1);
    expect(okResult.summary).toBe("ready: 1 of 1 steps found");
  });

  it("tracks readText binding feeding a later fill step", () => {
    const orderBadge = new MockElement("span", { class: "order-id" }, "INV-2026-0841");
    const erpInput = new MockElement("input", { name: "invoice_ref" });
    doc.body.appendChild(orderBadge);
    doc.body.appendChild(erpInput);

    const script: ActionScript = {
      steps: [
        { action: "readText", target: { kind: "css", value: ".order-id" }, bind: "orderId" },
        { action: "fill", target: { kind: "css", value: 'input[name="invoice_ref"]' }, value: "{{orderId}}" },
      ],
    };

    const result = previewRun(script);
    expect(result.ready).toBe(true);
    expect(result.found).toBe(2);
    expect(result.total).toBe(2);
    expect(result.summary).toBe("ready: 2 of 2 steps found");
    expect(result.steps).toEqual([
      { index: 0, action: "readText", status: "found" },
      { index: 1, action: "fill", status: "found" },
    ]);
  });

  it("does not bind when readText target is missing, leaving dependent fill missing", () => {
    const erpInput = new MockElement("input", { name: "invoice_ref" });
    doc.body.appendChild(erpInput);

    const script: ActionScript = {
      steps: [
        { action: "readText", target: { kind: "css", value: ".missing-badge" }, bind: "orderId" },
        { action: "fill", target: { kind: "css", value: 'input[name="invoice_ref"]' }, value: "{{orderId}}" },
      ],
    };

    const result = previewRun(script);
    expect(result.ready).toBe(false);
    expect(result.steps[0].status).toBe("missing");
    expect(result.steps[1].status).toBe("missing");
    expect(result.steps[1].reason).toContain("orderId");
  });

  it("performs zero DOM mutations, clicks, focus calls, or value writes during preview", () => {
    const form = new MockElement("form", { id: "profile-form" });
    const source = new MockElement("span", { class: "source" }, "Acme Corp");
    const company = new MockElement("input", { name: "company_name" }, "", { value: "initial" });
    const select = new MockElement("select", { name: "country" }, "", { value: "GR" });
    const helperBtn = new MockElement("button", { type: "button" }, "Helper");
    const submitBtn = new MockElement("button", {}, "Save");

    form.appendChild(source);
    form.appendChild(company);
    form.appendChild(select);
    form.appendChild(helperBtn);
    form.appendChild(submitBtn);
    doc.body.appendChild(form);

    const allElements = attachDomSpyMethods(doc.body);

    const script: ActionScript = {
      steps: [
        { action: "readText", target: { kind: "css", value: ".source" }, bind: "company" },
        { action: "fill", target: { kind: "css", value: 'input[name="company_name"]' }, value: "{{company}}" },
        { action: "select", target: { kind: "css", value: 'select[name="country"]' }, value: "DE" },
        { action: "click", target: { kind: "text", value: "Helper" } },
        { action: "click", target: { kind: "text", value: "Save" } },
      ],
    };

    const result = previewRun(script);
    expect(result.ready).toBe(true);
    expect(result.found).toBe(4);
    expect(result.total).toBe(5);
    expect(result.steps[4].status).toBe("skipped");

    expect(company.value).toBe("initial");
    expect(select.value).toBe("GR");
    expect(source.textContent).toBe("Acme Corp");

    for (const el of allElements) {
      expect(el.clickSpy).not.toHaveBeenCalled();
      expect(el.focusSpy).not.toHaveBeenCalled();
      expect(el.setAttributeSpy).not.toHaveBeenCalled();
      expect(el.removeAttributeSpy).not.toHaveBeenCalled();
      expect(el.dispatchEventSpy).not.toHaveBeenCalled();
      expect(el.appendChildSpy).not.toHaveBeenCalled();
      expect(el.removeChildSpy).not.toHaveBeenCalled();
      expect(el.valueSetSpy).not.toHaveBeenCalled();
      expect(el.textContentSetSpy).not.toHaveBeenCalled();
    }
  });

  it("normalizes Locator[] targets with toLocatorList and tries each locator in order", () => {
    const form = new MockElement("form", { id: "profile-form" });
    const company = new MockElement("input", { name: "company_name" });
    const row1 = new MockElement("li", { class: "row" }, "Item 1");
    const row2 = new MockElement("li", { class: "row" }, "Item 2");
    const submitBtn = new MockElement("button", { type: "submit" }, "Save");
    form.appendChild(company);
    form.appendChild(row1);
    form.appendChild(row2);
    form.appendChild(submitBtn);
    doc.body.appendChild(form);

    const script: ActionScript = {
      steps: [
        {
          action: "fill",
          target: [
            { kind: "testid", value: "missing-company" },
            { kind: "css", value: 'input[name="company_name"]' },
          ],
          value: "Acme",
        },
        {
          action: "extractList",
          target: [
            { kind: "css", value: ".no-such-row" },
            { kind: "css", value: ".row" },
          ],
          bind: "rows",
        },
        {
          action: "click",
          target: [
            { kind: "testid", value: "missing-submit" },
            { kind: "css", value: 'button[type="submit"]' },
          ],
        },
      ],
    };

    const okResult = previewRun(script);
    expect(okResult.ready).toBe(true);
    expect(okResult.found).toBe(2);
    expect(okResult.total).toBe(3);
    expect(okResult.summary).toBe("ready: 2 of 3 steps found");
    expect(okResult.steps[2]).toEqual({
      index: 2,
      action: "click",
      status: "skipped",
      reason: "Submit click skipped in dry-run preview",
    });

    const missingResult = previewRun({
      steps: [
        {
          action: "fill",
          target: [
            { kind: "testid", value: "no-id" },
            { kind: "css", value: 'input[name="no_field"]' },
          ],
          value: "x",
        },
      ],
    });
    expect(missingResult.ready).toBe(false);
    expect(missingResult.steps[0].status).toBe("missing");
    expect(missingResult.steps[0].reason).toContain("testid: no-id | css: input[name=\"no_field\"]");
  });
});
