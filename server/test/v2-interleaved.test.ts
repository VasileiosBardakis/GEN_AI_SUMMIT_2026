import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { EventsSchema, LocatorSchema } from "@gen/shared/schema.ts";
import { eventsToSteps } from "../src/v2/steps.ts";
import {
  countRepeatedPatterns,
  detectRepeatedCandidates,
  splitEpisodes,
} from "../src/v2/tries.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_HTML_TAG_RE = /<[a-z!/][^>]*>/i;

const NOISE_TESTIDS = new Set([
  "notice-dismiss-btn",
  "helpdesk-sidebar-toggle",
  "help-popover-btn",
  "refresh-orders-btn",
  "footer-info-btn",
]);

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

async function loadInterleavedFixture(): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", "unseen-interleaved.jsonl");
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const parsed = lines.map((line) => JSON.parse(line) as unknown);
  return EventsSchema.parse(parsed);
}

describe("v2 interleaved workflow detection (GEN-75)", () => {
  it("validates unseen-interleaved.jsonl invariants and detects Task A and Task B independently with disjoint instances and bindings", async () => {
    const events = await loadInterleavedFixture();
    expect(events.length).toBeGreaterThan(0);

    const sessions = new Set(events.map((e) => e.session));
    expect(sessions.size).toBe(1);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      expect(ev.v).toBe(1);
      expect(ev.source).toBe("browser");
      if (i > 0) {
        expect(ev.ts).toBeGreaterThan(events[i - 1].ts);
      }
      if (ev.target) {
        expect(ev.target.locators.length).toBeGreaterThanOrEqual(2);
        for (const loc of ev.target.locators) {
          expect(LocatorSchema.parse(loc)).toEqual(loc);
        }
      }
      const summary = ev.meta?.pageSummary;
      if (typeof summary === "string") {
        expect(utf8ByteLength(summary)).toBeLessThanOrEqual(4096);
        expect(RAW_HTML_TAG_RE.test(summary)).toBe(false);
      }
    }

    const { steps } = eventsToSteps(events);
    const patterns = countRepeatedPatterns(steps);
    const candidates = detectRepeatedCandidates(steps);

    const patA = patterns.find((p) => p.signature === "copy->tab_switch->paste");
    const patB = patterns.find((p) => p.signature === "click->fill->submit");
    expect(patA).toEqual({
      signature: "copy->tab_switch->paste",
      actions: ["copy", "tab_switch", "paste"],
      count: 3,
    });
    expect(patB).toEqual({
      signature: "click->fill->submit",
      actions: ["click", "fill", "submit"],
      count: 3,
    });

    const candA = candidates.find(
      (c) => c.signature === "copy->tab_switch->paste",
    );
    const candB = candidates.find((c) => c.signature === "click->fill->submit");
    expect(candA).toBeDefined();
    expect(candB).toBeDefined();
    if (!candA || !candB) return;

    expect(candA).not.toBe(candB);
    expect(candA.count).toBe(3);
    expect(candB.count).toBe(3);
    expect(candA.apps).toEqual(["portal.local", "erp.local"]);
    expect(candB.apps).toEqual(["helpdesk.local"]);

    expect(candA.instances).toHaveLength(3);
    expect(candB.instances).toHaveLength(3);

    // Check strict interleaving order A1 < B1 < A2 < B2 < A3 < B3 and zero overlap
    for (let i = 0; i < 3; i++) {
      const aInst = candA.instances[i];
      const bInst = candB.instances[i];

      expect(aInst.steps).toHaveLength(3);
      expect(bInst.steps).toHaveLength(3);
      expect(aInst.startTs).toBe(aInst.steps[0].ts);
      expect(aInst.endTs).toBe(aInst.steps[aInst.steps.length - 1].ts);
      expect(bInst.startTs).toBe(bInst.steps[0].ts);
      expect(bInst.endTs).toBe(bInst.steps[bInst.steps.length - 1].ts);

      expect(aInst.endTs).toBeLessThan(bInst.startTs);
      if (i + 1 < 3) {
        expect(bInst.endTs).toBeLessThan(candA.instances[i + 1].startTs);
      }
    }

    // Disjoint step timestamps across all instances of A and B, and zero noise steps inside instances
    const aTimestamps = new Set(
      candA.instances.flatMap((inst) => inst.steps.map((s) => s.ts)),
    );
    const bTimestamps = new Set(
      candB.instances.flatMap((inst) => inst.steps.map((s) => s.ts)),
    );
    expect(aTimestamps.size).toBe(9);
    expect(bTimestamps.size).toBe(9);
    for (const ts of aTimestamps) {
      expect(bTimestamps.has(ts)).toBe(false);
    }

    for (const inst of [...candA.instances, ...candB.instances]) {
      for (const step of inst.steps) {
        for (const loc of step.target ?? []) {
          expect(NOISE_TESTIDS.has(loc.value)).toBe(false);
        }
      }
    }

    // Bindings contain only each workflow's own values with zero cross-task mix-up
    const taskAExpected = ["ORD-8101", "ORD-8102", "ORD-8103"];
    const taskBExpected = [
      "Reset MFA token",
      "Issued replacement card",
      "Updated billing address",
    ];

    expect(candA.instances.map((inst) => inst.bindings)).toEqual(
      taskAExpected.map((val) => ({ step_0: val, step_2: val })),
    );
    expect(candB.instances.map((inst) => inst.bindings)).toEqual(
      taskBExpected.map((val) => ({ step_1: val })),
    );

    const serializedA = JSON.stringify(candA.instances.map((i) => i.bindings));
    const serializedB = JSON.stringify(candB.instances.map((i) => i.bindings));
    for (const bVal of taskBExpected) {
      expect(serializedA).not.toContain(bVal);
    }
    for (const aVal of taskAExpected) {
      expect(serializedB).not.toContain(aVal);
    }

    // Ensure no combined A+B cross-task candidate reached minRepeats
    const crossTask = candidates.filter(
      (c) => c.apps.includes("portal.local") && c.apps.includes("helpdesk.local"),
    );
    expect(crossTask).toEqual([]);
  });

  it("preserves interleaved counts and disjoint bindings across >=30s episode gaps within the same session", () => {
    const baseTs = 1_742_000_200_000;
    const gap = 45_000;
    const events: Event[] = [];
    let seq = 0;
    const pushEv = (ev: Omit<Event, "v" | "id" | "session" | "source">) => {
      seq += 1;
      events.push({
        v: 1,
        id: `e2000001-0000-4000-8000-${String(seq).padStart(12, "0")}`,
        session: "sess_spaced_interleaved",
        source: "browser",
        ...ev,
      });
    };

    for (let i = 0; i < 3; i++) {
      const t = baseTs + i * gap * 2;
      pushEv({
        ts: t,
        app: "alpha.local",
        type: "copy",
        value: `A-${i + 1}`,
        clipboard: { text: `A-${i + 1}` },
      });
      pushEv({ ts: t + 200, app: "beta.local", type: "tab_switch" });
      pushEv({
        ts: t + 400,
        app: "beta.local",
        type: "paste",
        value: `A-${i + 1}`,
      });

      const tb = t + gap;
      pushEv({
        ts: tb,
        app: "gamma.local",
        type: "click",
        target: { locators: [{ kind: "testid", value: "open-form" }, { kind: "css", value: "#open-form" }] },
      });
      pushEv({
        ts: tb + 200,
        app: "gamma.local",
        type: "change",
        target: { locators: [{ kind: "testid", value: "gamma-input" }, { kind: "css", value: "#gamma-input" }] },
        value: `B-${i + 1}`,
      });
      pushEv({
        ts: tb + 400,
        app: "gamma.local",
        type: "submit",
      });
    }

    const { steps } = eventsToSteps(events);
    expect(splitEpisodes(steps)).toHaveLength(6);

    const candidates = detectRepeatedCandidates(steps);
    const candA = candidates.find(
      (c) => c.signature === "copy->tab_switch->paste",
    );
    const candB = candidates.find((c) => c.signature === "click->fill->submit");

    expect(candA?.count).toBe(3);
    expect(candB?.count).toBe(3);
    expect(candA?.apps).toEqual(["alpha.local", "beta.local"]);
    expect(candB?.apps).toEqual(["gamma.local"]);
    expect(candA?.instances.map((x) => x.bindings)).toEqual([
      { step_0: "A-1", step_2: "A-1" },
      { step_0: "A-2", step_2: "A-2" },
      { step_0: "A-3", step_2: "A-3" },
    ]);
    expect(candB?.instances.map((x) => x.bindings)).toEqual([
      { step_1: "B-1" },
      { step_1: "B-2" },
      { step_1: "B-3" },
    ]);
  });

  it("isolates candidate counts and instances per session and handles empty inputs", () => {
    expect(detectRepeatedCandidates([])).toEqual([]);

    const baseTs = 1_742_000_300_000;
    const events: Event[] = [];
    let seq = 0;
    const pushEv = (
      session: string,
      ev: Omit<Event, "v" | "id" | "session" | "source">,
    ) => {
      seq += 1;
      events.push({
        v: 1,
        id: `e3000001-0000-4000-8000-${String(seq).padStart(12, "0")}`,
        session,
        source: "browser",
        ...ev,
      });
    };

    const pushPair = (session: string, startTs: number, tag: string) => {
      pushEv(session, {
        ts: startTs,
        app: "app1.local",
        type: "copy",
        value: tag,
        clipboard: { text: tag },
      });
      pushEv(session, {
        ts: startTs + 100,
        app: "app2.local",
        type: "tab_switch",
      });
      pushEv(session, {
        ts: startTs + 200,
        app: "app2.local",
        type: "paste",
        value: tag,
      });
    };

    pushPair("sess_1", baseTs, "one");
    pushPair("sess_1", baseTs + 1000, "two");
    pushPair("sess_2", baseTs + 2000, "three");

    const { steps } = eventsToSteps(events);
    expect(detectRepeatedCandidates(steps)).toEqual([]);
  });
});
