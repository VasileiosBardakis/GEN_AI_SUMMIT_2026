import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureSourceSummary,
  captureTargetSummary,
  PAGE_SUMMARY_MAX_BYTES,
} from "../src/page-summary.ts";

class FakeElement {
  nodeType = 1;
  tagName: string;
  id = "";
  classList: string[] = [];
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  isContentEditable = false;
  value = "";
  checked = false;
  disabled = false;
  innerHTML = "";
  private ownText = "";
  private attrs = new Map<string, string>();

  constructor(
    tagName: string,
    attrs: Record<string, string> = {},
    text = "",
    opts: { value?: string; checked?: boolean; innerHTML?: string } = {}
  ) {
    this.tagName = tagName.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) {
      this.setAttribute(k, v);
    }
    this.ownText = text;
    if (opts.value !== undefined) this.value = opts.value;
    if (opts.checked !== undefined) this.checked = opts.checked;
    if (opts.innerHTML !== undefined) this.innerHTML = opts.innerHTML;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === "id") this.id = value;
    if (name === "class") {
      this.classList = value.split(/\s+/).filter(Boolean);
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
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

  get innerText(): string {
    return this.textContent;
  }

  matches(selector: string): boolean {
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (this.matchesSingle(part)) return true;
    }
    return false;
  }

  private matchesSingle(sel: string): boolean {
    const tagMatch = /^([a-z0-9]+)/i.exec(sel);
    if (tagMatch && this.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) {
      return false;
    }
    const attrMatches = sel.matchAll(/\[([a-z0-9_-]+)(?:=["']([^"']*)["'])?\]/gi);
    for (const m of attrMatches) {
      const attrName = m[1];
      const expected = m[2];
      const actual = this.getAttribute(attrName);
      if (actual === null) return false;
      if (expected !== undefined && actual !== expected) return false;
    }
    return Boolean(tagMatch || sel.includes("["));
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
}

describe("page-summary", () => {
  const originalHTMLElement = (globalThis as Record<string, unknown>).HTMLElement;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).HTMLElement = FakeElement;
  });

  afterEach(() => {
    if (originalHTMLElement === undefined) {
      delete (globalThis as Record<string, unknown>).HTMLElement;
    } else {
      (globalThis as Record<string, unknown>).HTMLElement = originalHTMLElement;
    }
  });

  it("captures all 5 rows' Locator[], scrubs secrets/IBANs, preserves emails, strips HTML, and stays <= 4096 bytes", () => {
    const table = new FakeElement("table", { "data-testid": "invoices-table" });
    const tbody = new FakeElement("tbody");
    table.appendChild(tbody);

    const rowData = [
      {
        id: "INV-001",
        contact: "alice@example.com",
        note: "IBAN GR1601101250000000012300695",
      },
      {
        id: "INV-002",
        contact: "bob@example.org",
        note: "API sk-live-9876543210abcdef123456",
      },
      {
        id: "INV-003",
        contact: "carol@acme.test",
        note: "Bearer abcdefghijklmnopqrstuvwxyz1234",
      },
      {
        id: "INV-004",
        contact: "dave@acme.test",
        note: "Standard invoice payment",
      },
      {
        id: "INV-005",
        contact: "eve@acme.test",
        note: "Net 30 terms",
      },
    ];

    let cell1: FakeElement | null = null;

    rowData.forEach((entry, idx) => {
      const rowNum = idx + 1;
      const tr = new FakeElement(
        "tr",
        { "data-testid": `row-${rowNum}` },
        "",
        { innerHTML: `<tr><td>${entry.id}</td></tr>` }
      );
      const tdId = new FakeElement(
        "td",
        { "data-testid": `cell-id-${rowNum}` },
        entry.id,
        { innerHTML: `<td><span>${entry.id}</span></td>` }
      );
      const tdContact = new FakeElement(
        "td",
        { "data-testid": `cell-contact-${rowNum}` },
        entry.contact
      );
      const tdNote = new FakeElement(
        "td",
        { "data-testid": `cell-note-${rowNum}` },
        `${entry.note} <b>bold</b>`
      );
      tr.appendChild(tdId);
      tr.appendChild(tdContact);
      tr.appendChild(tdNote);
      tbody.appendChild(tr);

      if (rowNum === 1) {
        cell1 = tdId;
      }
    });

    const summary = captureSourceSummary(cell1 as unknown as HTMLElement);
    expect(summary).toBeDefined();
    expect(summary?.rows).toHaveLength(5);

    for (let i = 0; i < 5; i += 1) {
      const row = summary!.rows[i];
      expect(row.locators.length).toBeGreaterThan(0);
      expect(row.locators.some((l) => l.kind === "testid" && l.value === `row-${i + 1}`)).toBe(true);
      expect(row.cells).toHaveLength(3);
      for (const cell of row.cells) {
        expect(cell.locators.length).toBeGreaterThan(0);
      }
    }

    const json = JSON.stringify(summary);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(PAGE_SUMMARY_MAX_BYTES);

    // Zero raw HTML
    expect(json).not.toMatch(/<(?:tr|td|th|table|tbody|span|b|div)\b/i);

    // Secrets and IBANs redacted
    expect(json).not.toContain("GR1601101250000000012300695");
    expect(json).not.toContain("sk-live-9876543210abcdef123456");
    expect(json).not.toContain("abcdefghijklmnopqrstuvwxyz1234");
    expect(json).toContain("[REDACTED:IBAN#");
    expect(json).toContain("[REDACTED:TOKEN#");

    // Emails preserved for local server __PII_*__ mapping
    expect(json).toContain("alice@example.com");
    expect(json).toContain("bob@example.org");
    expect(json).toContain("eve@acme.test");
  });

  it("enforces <= 4096 byte JSON cap even with oversized 5-row cell text", () => {
    const table = new FakeElement("table");
    const tbody = new FakeElement("tbody");
    table.appendChild(tbody);

    let firstCell: FakeElement | null = null;
    for (let i = 1; i <= 5; i += 1) {
      const tr = new FakeElement("tr", { "data-testid": `big-row-${i}` });
      for (let c = 1; c <= 4; c += 1) {
        const td = new FakeElement(
          "td",
          { "data-testid": `big-cell-${i}-${c}` },
          `Row ${i} Col ${c} ` + "x".repeat(600)
        );
        tr.appendChild(td);
        if (i === 1 && c === 1) firstCell = td;
      }
      tbody.appendChild(tr);
    }

    const summary = captureSourceSummary(firstCell as unknown as HTMLElement);
    expect(summary).toBeDefined();
    expect(summary?.rows).toHaveLength(5);
    for (const row of summary!.rows) {
      expect(row.locators.length).toBeGreaterThan(0);
    }
    const bytes = Buffer.byteLength(JSON.stringify(summary), "utf8");
    expect(bytes).toBeLessThanOrEqual(PAGE_SUMMARY_MAX_BYTES);
  });

  it("captures empty controls and submit Locator[] from enclosing form in captureTargetSummary", () => {
    const form = new FakeElement("form", { id: "erp-form" }, "", {
      innerHTML: '<form id="erp-form"><input name="vendor"/></form>',
    });
    const filledInput = new FakeElement(
      "input",
      { name: "invoice_id", "data-testid": "erp-invoice-id", type: "text" },
      "",
      { value: "INV-2026-001" }
    );
    const emptyVendor = new FakeElement(
      "input",
      { name: "vendor", "data-testid": "erp-vendor", type: "text", placeholder: "Vendor" },
      "",
      { value: "" }
    );
    const emptyCategory = new FakeElement(
      "select",
      { name: "category", "data-testid": "erp-category", "aria-label": "Category" },
      "",
      { value: "" }
    );
    const emptyNotes = new FakeElement(
      "textarea",
      { name: "notes", "data-testid": "erp-notes", placeholder: "Notes" },
      "",
      { value: "" }
    );
    const uncheckedBox = new FakeElement(
      "input",
      { name: "urgent", "data-testid": "erp-urgent", type: "checkbox" },
      "",
      { checked: false }
    );
    const hiddenInput = new FakeElement(
      "input",
      { name: "csrf", type: "hidden" },
      "",
      { value: "" }
    );
    const resetBtn = new FakeElement("button", { type: "reset", "data-testid": "reset-btn" }, "Reset");
    const submitBtn = new FakeElement("button", { type: "submit", "data-testid": "save-btn" }, "Save");

    form.appendChild(filledInput);
    form.appendChild(emptyVendor);
    form.appendChild(emptyCategory);
    form.appendChild(emptyNotes);
    form.appendChild(uncheckedBox);
    form.appendChild(hiddenInput);
    form.appendChild(resetBtn);
    form.appendChild(submitBtn);

    const summary = captureTargetSummary(emptyVendor as unknown as HTMLElement);
    expect(summary).toBeDefined();
    expect(summary?.containerTag).toBe("form");

    const controlNames = summary!.emptyControls.map((c) => c.name);
    expect(controlNames).toEqual(["vendor", "category", "notes", "urgent"]);
    expect(controlNames).not.toContain("invoice_id");
    expect(controlNames).not.toContain("csrf");

    for (const ctrl of summary!.emptyControls) {
      expect(ctrl.locators.length).toBeGreaterThan(0);
    }

    expect(summary!.submitLocators.some((l) => l.kind === "testid" && l.value === "save-btn")).toBe(
      true
    );
    expect(summary!.submitLocators.some((l) => l.value === "reset-btn")).toBe(false);

    const json = JSON.stringify(summary);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(PAGE_SUMMARY_MAX_BYTES);
    expect(json).not.toMatch(/<(?:form|input|select|textarea|button)\b/i);
  });

  it("returns undefined for null or elements outside rows/forms", () => {
    expect(captureSourceSummary(null)).toBeUndefined();
    expect(captureTargetSummary(null)).toBeUndefined();

    const orphan = new FakeElement("div", {}, "plain text");
    expect(captureSourceSummary(orphan as unknown as HTMLElement)).toBeUndefined();
    expect(captureTargetSummary(orphan as unknown as HTMLElement)).toBeUndefined();
  });
});
