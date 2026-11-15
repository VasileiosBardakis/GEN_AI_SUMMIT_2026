import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { mergeWithinSession } from "../src/merge-sessions.ts";
import { buildMeaningfulWindow, eventsToSteps } from "../src/v2/steps.ts";

let seq = 0;

function makeEvent(
  type: Event["type"],
  extra: Partial<Omit<Event, "type">> = {},
): Event {
  seq += 1;
  return {
    v: 1,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    ts: 1_740_000_000_000 + seq * 100,
    session: "sess_v2_test",
    source: "browser",
    app: "portal.local",
    type,
    ...extra,
  };
}

describe("v2 steps, mergeWithinSession, and buildMeaningfulWindow", () => {
  it("acceptance 2: mergeWithinSession keeps distinct session IDs separate", () => {
    const baseTs = 1_740_000_000_000;
    const makePair = (session: string, startTs: number): Event[] => [
      makeEvent("copy", {
        ts: startTs,
        session,
        app: "portal.local",
        clipboard: { text: "item" },
      }),
      makeEvent("tab_switch", {
        ts: startTs + 200,
        session,
        app: "erp.local",
      }),
      makeEvent("paste", {
        ts: startTs + 400,
        session,
        app: "erp.local",
        value: "item",
      }),
    ];

    const sessAEvents = [
      ...makePair("sess_a", baseTs),
      ...makePair("sess_a", baseTs + 1000),
    ];
    const sessBEvents = [...makePair("sess_b", baseTs + 500)];

    const merged = mergeWithinSession([sessAEvents, sessBEvents]);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.session)).toEqual(["sess_a", "sess_b"]);
    expect(merged[0].events.every((e) => e.session === "sess_a")).toBe(true);
    expect(merged[1].events.every((e) => e.session === "sess_b")).toBe(true);
  });

  it("acceptance 3: 3 Tab-filled fields with colliding aria-label='Value' and distinct css selectors produce 3 distinct fill steps", () => {
    const fields = [
      "form > div.row:nth-of-type(1) > input.val",
      "form > div.row:nth-of-type(2) > input.val",
      "form > div.row:nth-of-type(3) > input.val",
    ];

    const events: Event[] = [];
    for (let i = 0; i < fields.length; i++) {
      const target: NonNullable<Event["target"]> = {
        tag: "input",
        role: "textbox",
        label: "Value",
        locators: [
          { kind: "aria", value: 'textbox[name="Value"]' },
          { kind: "css", value: fields[i] },
        ],
      };
      const value = `v${i + 1}`;
      events.push(
        makeEvent("input", { target, value: value.slice(0, 1) }),
        makeEvent("input", { target, value }),
        makeEvent("change", { target, value }),
      );
    }

    const { steps } = eventsToSteps(events);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.action)).toEqual(["fill", "fill", "fill"]);
    expect(steps.map((s) => s.target?.[0])).toEqual(
      fields.map((css) => ({ kind: "css", value: css })),
    );
    expect(steps.map((s) => s.value)).toEqual(["v1", "v2", "v3"]);
  });

  it("acceptance 4: preserves step values and pageSummary without rewriting into __PII_*__ tokens", () => {
    const events: Event[] = [
      makeEvent("input", {
        target: {
          tag: "input",
          locators: [{ kind: "testid", value: "contact-email" }],
        },
        value: "ana@acme.com",
        meta: {
          pageSummary: "Editing profile for ana@acme.com",
        },
      }),
      makeEvent("click", {
        target: {
          tag: "button",
          locators: [{ kind: "testid", value: "save" }],
        },
      }),
    ];

    const { steps } = eventsToSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0].value).toBe("ana@acme.com");
    expect(steps[0].pageSummary).toBe("Editing profile for ana@acme.com");
  });

  it("drops noise, keeps Enter keydown/key, ranks gridcell css-first, strips shortcuts, and respects empty-target and submit/nav rules", () => {
    const events: Event[] = [
      makeEvent("mousemove", { ts: 1000 }),
      makeEvent("scroll", { ts: 1100 }),
      makeEvent("focus", { ts: 1200 }),
      makeEvent("dom_mutation", { ts: 1300 }),
      makeEvent("keydown", { ts: 1400, meta: { key: "Tab" } }),
      makeEvent("input", { ts: 1500, value: "empty-target-1" }),
      makeEvent("input", { ts: 1600, value: "empty-target-2" }),
      makeEvent("click", {
        ts: 1700,
        target: {
          tag: "td",
          role: "gridcell",
          locators: [
            { kind: "text", value: "Cell A1 F2" },
            { kind: "aria", value: "gridcell A1 Ctrl+C" },
            { kind: "testid", value: "cell-a1" },
            { kind: "css", value: 'td[data-cell="A1"]' },
          ],
        },
      }),
      makeEvent("keydown", { ts: 1800, meta: { key: "Enter" } }),
      makeEvent("key", { ts: 1900, meta: { key: "Enter" } }),
      makeEvent("input", {
        ts: 2000,
        target: { tag: "input", locators: [{ kind: "css", value: "#f" }] },
        value: "same",
      }),
      makeEvent("submit", { ts: 2100 }),
      makeEvent("change", {
        ts: 2200,
        target: { tag: "input", locators: [{ kind: "css", value: "#f" }] },
        value: "same",
      }),
      makeEvent("nav", { ts: 2300, url: "http://portal.local/next" }),
      makeEvent("change", {
        ts: 2400,
        target: { tag: "input", locators: [{ kind: "css", value: "#f" }] },
        value: "same",
      }),
    ];

    const { steps } = eventsToSteps(events);
    expect(steps.map((s) => s.action)).toEqual([
      "fill",
      "fill",
      "click",
      "key",
      "key",
      "fill",
      "submit",
      "fill",
      "nav",
      "fill",
    ]);
    expect(steps[2].target).toEqual([
      { kind: "css", value: 'td[data-cell="A1"]' },
      { kind: "testid", value: "cell-a1" },
      { kind: "aria", value: "gridcell A1" },
      { kind: "text", value: "Cell A1" },
    ]);
    expect(steps[3].key).toBe("Enter");
    expect(steps[4].key).toBe("Enter");
    expect(steps[8].url).toBe("http://portal.local/next");
  });

  it("buildMeaningfulWindow keeps host-changing nav/tab_switch, links paste to copy, emits >=60s gap markers, and caps window", () => {
    const events: Event[] = [
      makeEvent("nav", { ts: 1000, app: "portal.local", url: "http://portal.local/list" }),
      makeEvent("copy", {
        ts: 2000,
        app: "portal.local",
        url: "http://portal.local/list",
        target: { label: "Invoice ID", locators: [{ kind: "testid", value: "inv" }] },
        clipboard: { text: "INV-42" },
      }),
      makeEvent("nav", { ts: 2500, app: "portal.local", url: "http://portal.local/list?p=2" }),
      makeEvent("tab_switch", { ts: 3000, app: "erp.local", url: "http://erp.local/form" }),
      makeEvent("paste", {
        ts: 243_000,
        app: "erp.local",
        url: "http://erp.local/form",
        target: { label: "ERP Invoice", locators: [{ kind: "testid", value: "erp-inv" }] },
        value: "INV-42",
      }),
    ];

    const { steps } = eventsToSteps(events);
    const window = buildMeaningfulWindow(steps, events, 40);

    expect(window.meaningfulCount).toBe(3);
    expect(window.steps).toEqual([
      {
        index: 0,
        action: "copy",
        host: "portal.local",
        label: "Invoice ID",
        value: "INV-42",
      },
      {
        index: 1,
        action: "tab_switch",
        host: "erp.local",
      },
      {
        index: 2,
        action: "paste",
        host: "erp.local",
        label: "ERP Invoice",
        value: "INV-42",
        copiedFromStep: 0,
      },
    ]);
    expect(window.gaps).toEqual([
      { afterIndex: 1, marker: "4 min elsewhere (erp.local)" },
    ]);
  });
});
