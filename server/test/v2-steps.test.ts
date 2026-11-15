import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { mergeWithinSession } from "../src/merge-sessions.ts";
import { eventsToSteps } from "../src/v2/steps.ts";
import { countRepeatedPatterns, splitEpisodes } from "../src/v2/tries.ts";

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

describe("v2 steps, mergeWithinSession, and tries pattern counter", () => {
  it("acceptance 1: triggers count = 3 for both 0s continuous and >10min spaced copy -> tab_switch -> paste in one session", () => {
    const baseTs = 1_740_000_000_000;
    const continuousEvents: Event[] = [];
    for (let i = 0; i < 3; i++) {
      continuousEvents.push(
        makeEvent("copy", {
          ts: baseTs,
          session: "sess_cont",
          app: "portal.local",
          clipboard: { text: `row-${i}` },
        }),
        makeEvent("tab_switch", {
          ts: baseTs,
          session: "sess_cont",
          app: "erp.local",
        }),
        makeEvent("paste", {
          ts: baseTs,
          session: "sess_cont",
          app: "erp.local",
          value: `row-${i}`,
        }),
      );
    }

    const contMerged = mergeWithinSession([continuousEvents]);
    expect(contMerged).toHaveLength(1);
    const { steps: contSteps } = eventsToSteps(contMerged[0].events);
    expect(splitEpisodes(contSteps)).toHaveLength(1);
    const contPatterns = countRepeatedPatterns(contSteps);
    expect(
      contPatterns.find((p) => p.signature === "copy->tab_switch->paste"),
    ).toEqual({
      signature: "copy->tab_switch->paste",
      actions: ["copy", "tab_switch", "paste"],
      count: 3,
    });

    const spacedEvents: Event[] = [];
    const elevenMinMs = 11 * 60_000;
    for (let i = 0; i < 3; i++) {
      const start = baseTs + i * elevenMinMs;
      spacedEvents.push(
        makeEvent("copy", {
          ts: start,
          session: "sess_spaced",
          app: "portal.local",
          clipboard: { text: `val-${i}` },
        }),
        makeEvent("tab_switch", {
          ts: start + 500,
          session: "sess_spaced",
          app: "erp.local",
        }),
        makeEvent("paste", {
          ts: start + 1000,
          session: "sess_spaced",
          app: "erp.local",
          value: `val-${i}`,
        }),
      );
    }

    const spacedMerged = mergeWithinSession([spacedEvents]);
    expect(spacedMerged).toHaveLength(1);
    expect(spacedMerged[0].session).toBe("sess_spaced");
    const { steps: spacedSteps } = eventsToSteps(spacedMerged[0].events);
    expect(splitEpisodes(spacedSteps)).toHaveLength(3);
    const spacedPatterns = countRepeatedPatterns(spacedSteps);
    expect(
      spacedPatterns.find((p) => p.signature === "copy->tab_switch->paste"),
    ).toEqual({
      signature: "copy->tab_switch->paste",
      actions: ["copy", "tab_switch", "paste"],
      count: 3,
    });
  });

  it("acceptance 2: 3 identical sequences split across 2 distinct session IDs produce 0 triggers and mergeWithinSession keeps them separate", () => {
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

    const allEvents = merged.flatMap((m) => m.events);
    const { steps } = eventsToSteps(allEvents);
    expect(countRepeatedPatterns(steps)).toEqual([]);
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

  it("acceptance 4: ana@acme.com in value and meta.pageSummary maps to __PII_EMAIL_1__ in both steps and piiMap without leaking raw PII", () => {
    const events: Event[] = [
      makeEvent("input", {
        target: {
          tag: "input",
          locators: [{ kind: "testid", value: "contact-email" }],
        },
        value: "ana@acme.com",
        meta: {
          pageSummary: "Editing profile for ana@acme.com (phone +1 415-555-0199)",
        },
      }),
      makeEvent("change", {
        target: {
          tag: "input",
          locators: [{ kind: "testid", value: "contact-email" }],
        },
        value: "ana@acme.com",
      }),
      makeEvent("click", {
        target: {
          tag: "button",
          locators: [{ kind: "testid", value: "save" }],
        },
        meta: {
          pageSummary: "Confirming ana@acme.com; keep [REDACTED:SSN]",
        },
      }),
    ];

    const { steps, piiMap } = eventsToSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0].value).toBe("__PII_EMAIL_1__");
    expect(steps[0].pageSummary).toBe(
      "Editing profile for __PII_EMAIL_1__ (phone __PII_PHONE_1__)",
    );
    expect(steps[1].pageSummary).toBe(
      "Confirming __PII_EMAIL_1__; keep [REDACTED:SSN]",
    );

    expect(piiMap.get("__PII_EMAIL_1__")).toBe("ana@acme.com");
    expect(piiMap.get("__PII_PHONE_1__")).toBe("+1 415-555-0199");

    const serializedSteps = JSON.stringify(steps);
    expect(serializedSteps).not.toContain("ana@acme.com");
    expect(serializedSteps).not.toContain("415-555-0199");
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

  it("splitEpisodes splits only on >= idleGapMs or session change and keeps nav/tab_switch inside episodes", () => {
    const { steps } = eventsToSteps([
      makeEvent("click", { ts: 1000, session: "s1" }),
      makeEvent("tab_switch", { ts: 5000, session: "s1" }),
      makeEvent("nav", { ts: 10_000, session: "s1", url: "http://a.local" }),
      makeEvent("click", { ts: 39_999, session: "s1" }),
      makeEvent("click", { ts: 69_999, session: "s1" }), // gap == 30_000 -> split
      makeEvent("click", { ts: 70_500, session: "s2" }), // session change -> split
    ]);

    const episodes = splitEpisodes(steps, 30_000);
    expect(episodes).toHaveLength(3);
    expect(episodes[0]).toMatchObject({
      session: "s1",
      startTs: 1000,
      endTs: 39_999,
    });
    expect(episodes[0].steps).toHaveLength(4);
    expect(episodes[1]).toMatchObject({
      session: "s1",
      startTs: 69_999,
      endTs: 69_999,
    });
    expect(episodes[2]).toMatchObject({
      session: "s2",
      startTs: 70_500,
      endTs: 70_500,
    });
  });
});
