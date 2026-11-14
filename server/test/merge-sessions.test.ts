import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import {
  DEFAULT_MERGE_SESSIONS_CONFIG,
  mergeSessions,
} from "../src/merge-sessions.ts";

function makeEvent(
  id: string,
  ts: number,
  session: string,
  overrides: Partial<Event> = {},
): Event {
  return {
    v: 1,
    id,
    ts,
    session,
    source: "browser",
    app: "portal.local",
    type: "click",
    ...overrides,
  };
}

describe("mergeSessions", () => {
  it("exports DEFAULT_MERGE_SESSIONS_CONFIG with gapMs = 10 * 60_000", () => {
    expect(DEFAULT_MERGE_SESSIONS_CONFIG).toEqual({
      gapMs: 10 * 60_000,
    });
  });

  it("returns [] when there are no events", () => {
    expect(mergeSessions([])).toEqual([]);
    expect(mergeSessions([[], []])).toEqual([]);
    expect(mergeSessions(new Map())).toEqual([]);
    expect(mergeSessions({})).toEqual([]);
  });

  it("stably sorts events across sessions by ts and assigns merged_<first ts>", () => {
    const sessA = [
      makeEvent("a1", 1000, "sess_a"),
      makeEvent("a2", 3000, "sess_a"),
    ];
    const sessB = [
      makeEvent("b1", 2000, "sess_b"),
      makeEvent("b2", 3000, "sess_b"),
    ];
    const sessBrowser = [
      makeEvent("br1", 1500, "sess_browser", { type: "tab_switch" }),
    ];

    const merged = mergeSessions([sessA, sessB, sessBrowser]);
    expect(merged).toHaveLength(1);
    expect(merged[0].session).toBe("merged_1000");
    expect(merged[0].events.map((e) => e.id)).toEqual([
      "a1",
      "br1",
      "b1",
      "a2",
      "b2",
    ]);
    expect(merged[0].events.every((e) => e.session === "merged_1000")).toBe(true);

    // Original events are not mutated.
    expect(sessA[0].session).toBe("sess_a");
    expect(sessB[0].session).toBe("sess_b");
    expect(sessBrowser[0].session).toBe("sess_browser");
  });

  it("accepts Map and Record inputs in addition to Event[][]", () => {
    const sessA = [makeEvent("a1", 5000, "sess_a")];
    const sessB = [makeEvent("b1", 5500, "sess_b")];

    const fromMap = mergeSessions(
      new Map([
        ["sess_a", sessA],
        ["sess_b", sessB],
      ]),
    );
    const fromRecord = mergeSessions({ sess_a: sessA, sess_b: sessB });

    expect(fromMap).toHaveLength(1);
    expect(fromMap[0].session).toBe("merged_5000");
    expect(fromMap[0].events.map((e) => e.id)).toEqual(["a1", "b1"]);
    expect(fromRecord).toEqual(fromMap);
  });

  it("joins events at or within gapMs and cuts into groups when gap exceeds gapMs", () => {
    const base = 1_740_000_000_000;
    const gapMs = DEFAULT_MERGE_SESSIONS_CONFIG.gapMs;

    const e1 = makeEvent("e1", base, "sess_a");
    const e2 = makeEvent("e2", base + gapMs, "sess_b");
    const e3 = makeEvent("e3", base + gapMs + gapMs + 1, "sess_a");

    const merged = mergeSessions([[e1, e3], [e2]]);
    expect(merged).toHaveLength(2);

    expect(merged[0].session).toBe(`merged_${base}`);
    expect(merged[0].events.map((e) => e.id)).toEqual(["e1", "e2"]);

    expect(merged[1].session).toBe(`merged_${base + gapMs + gapMs + 1}`);
    expect(merged[1].events.map((e) => e.id)).toEqual(["e3"]);
  });

  it("respects custom gapMs option", () => {
    const e1 = makeEvent("e1", 1000, "sess_a");
    const e2 = makeEvent("e2", 1600, "sess_b");
    const e3 = makeEvent("e3", 2000, "sess_a");

    const merged = mergeSessions([[e1, e3], [e2]], { gapMs: 500 });
    expect(merged).toHaveLength(2);
    expect(merged[0].session).toBe("merged_1000");
    expect(merged[0].events.map((e) => e.id)).toEqual(["e1"]);
    expect(merged[1].session).toBe("merged_1600");
    expect(merged[1].events.map((e) => e.id)).toEqual(["e2", "e3"]);
  });
});
