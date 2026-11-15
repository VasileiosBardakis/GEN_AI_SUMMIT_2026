import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { normalize } from "../src/detect/normalize.ts";

let seq = 0;

function makeEvent(
  type: Event["type"],
  extra: Partial<Omit<Event, "type">> = {},
): Event {
  seq += 1;
  return {
    v: 1,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    ts: 1740000000000 + seq * 500,
    session: "sess_tab_fields",
    source: "browser",
    app: "erp.local",
    type,
    ...extra,
  };
}

describe("normalize Tab-filled fields and cross-tab change deduplication", () => {
  it("keeps 3 distinct fill steps per repetition for Tab-filled fields with colliding aria-label='Value' and distinct css selectors", () => {
    const fields = [
      {
        css: "form > div.field-row:nth-of-type(1) > input.value-input",
        aria: 'textbox[name="Value"]',
      },
      {
        css: "form > div.field-row:nth-of-type(2) > input.value-input",
        aria: 'textbox[name="Value"]',
      },
      {
        css: "form > div.field-row:nth-of-type(3) > input.value-input",
        aria: 'textbox[name="Value"]',
      },
    ];

    const saveTarget: NonNullable<Event["target"]> = {
      tag: "button",
      role: "button",
      label: "Save",
      locators: [
        { kind: "testid", value: "save-btn" },
        { kind: "text", value: "Save" },
      ],
    };

    const events: Event[] = [];
    for (let rep = 1; rep <= 3; rep++) {
      for (let fIdx = 0; fIdx < fields.length; fIdx++) {
        const field = fields[fIdx];
        const target: NonNullable<Event["target"]> = {
          tag: "input",
          role: "textbox",
          label: "Value",
          locators: [
            { kind: "aria", value: field.aria },
            { kind: "css", value: field.css },
          ],
        };
        const value = `rep${rep}-val${fIdx + 1}`;
        // Simulate typing + Tab (no intermediate clicks)
        events.push(makeEvent("input", { target, value: value.slice(0, 4) }));
        events.push(makeEvent("input", { target, value }));
        events.push(makeEvent("change", { target, value }));
      }
      events.push(makeEvent("click", { target: saveTarget }));
    }

    const steps = normalize(events);

    expect(steps).toHaveLength(12);
    expect(steps.map((s) => s.action)).toEqual([
      "fill",
      "fill",
      "fill",
      "click",
      "fill",
      "fill",
      "fill",
      "click",
      "fill",
      "fill",
      "fill",
      "click",
    ]);

    const fills = steps.filter((s) => s.action === "fill");
    expect(fills).toHaveLength(9);
    for (let rep = 0; rep < 3; rep++) {
      const repFills = fills.slice(rep * 3, rep * 3 + 3);
      expect(repFills.map((s) => s.target?.[0])).toEqual(
        fields.map((f) => ({ kind: "css", value: f.css })),
      );
      expect(repFills.map((s) => s.value)).toEqual([
        `rep${rep + 1}-val1`,
        `rep${rep + 1}-val2`,
        `rep${rep + 1}-val3`,
      ]);
    }
  });

  it("never merges consecutive fill steps when target is empty", () => {
    const events: Event[] = [
      makeEvent("input", { value: "first" }),
      makeEvent("input", { target: { tag: "input", locators: [] }, value: "second" }),
      makeEvent("change", { target: { tag: "input", locators: [] }, value: "third" }),
      makeEvent("click", {
        target: {
          tag: "button",
          locators: [{ kind: "testid", value: "save-btn" }],
        },
      }),
    ];

    const steps = normalize(events);

    expect(steps).toEqual([
      { action: "fill", value: "first" },
      { action: "fill", value: "second" },
      { action: "fill", value: "third" },
      { action: "click", target: [{ kind: "testid", value: "save-btn" }] },
    ]);
  });

  it("emits only 1 fill step when input is followed by a cross-tab copy and then change on the same target/value", () => {
    const erpField: NonNullable<Event["target"]> = {
      tag: "input",
      role: "textbox",
      label: "Invoice ID",
      locators: [
        { kind: "aria", value: 'textbox[name="Invoice ID"]' },
        { kind: "css", value: "#erp-invoice-id" },
      ],
    };

    const portalField: NonNullable<Event["target"]> = {
      tag: "span",
      label: "Vendor",
      locators: [
        { kind: "css", value: "#portal-vendor-1" },
      ],
    };

    const events: Event[] = [
      makeEvent("input", {
        app: "erp.local",
        target: erpField,
        value: "INV-2026-001",
      }),
      makeEvent("copy", {
        app: "portal.local",
        target: portalField,
        value: "Acme Industrial",
        clipboard: {
          fromApp: "portal.local",
          text: "Acme Industrial",
        },
      }),
      makeEvent("change", {
        app: "erp.local",
        target: erpField,
        value: "INV-2026-001",
      }),
    ];

    const steps = normalize(events);

    expect(steps).toEqual([
      {
        action: "fill",
        target: [
          { kind: "css", value: "#erp-invoice-id" },
          { kind: "aria", value: 'textbox[name="Invoice ID"]' },
        ],
        value: "INV-2026-001",
      },
      {
        action: "copy",
        target: [{ kind: "css", value: "#portal-vendor-1" }],
        value: "Acme Industrial",
      },
    ]);
  });

  it("clears lastFillByTarget on submit and nav so subsequent repetitions record fills normally", () => {
    const erpField: NonNullable<Event["target"]> = {
      tag: "input",
      role: "textbox",
      locators: [{ kind: "css", value: "#erp-vendor" }],
    };

    const events: Event[] = [
      makeEvent("input", { target: erpField, value: "Acme Industrial" }),
      makeEvent("submit", {
        target: { tag: "form", locators: [{ kind: "css", value: "#erp-form" }] },
      }),
      makeEvent("change", { target: erpField, value: "Acme Industrial" }),
      makeEvent("nav", { url: "http://erp.local/new" }),
      makeEvent("change", { target: erpField, value: "Acme Industrial" }),
    ];

    const steps = normalize(events);
    expect(steps.map((s) => s.action)).toEqual([
      "fill",
      "submit",
      "fill",
      "nav",
      "fill",
    ]);
  });
});
