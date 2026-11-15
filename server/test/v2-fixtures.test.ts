import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { EventsSchema, LocatorSchema } from "@gen/shared/schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UNSEEN_FIXTURES = [
  "unseen-rows-wrongtab.jsonl",
  "unseen-multifield-tab.jsonl",
  "unseen-extra-click.jsonl",
  "unseen-two-repeats.jsonl",
  "unseen-enter-controls.jsonl",
  "unseen-pii-risky.jsonl",
] as const;

const RAW_HTML_TAG_RE = /<[a-z!/][^>]*>/i;

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const rawEvents = lines.map((line) => JSON.parse(line) as unknown);
  return EventsSchema.parse(rawEvents);
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("Brain v2 unseen workflow JSONL fixtures", () => {
  it("parses all 6 unseen fixtures via EventsSchema.parse in under 500 ms with common invariants", async () => {
    const startMs = performance.now();
    const parsedByFile = new Map<string, Event[]>();

    for (const filename of UNSEEN_FIXTURES) {
      const events = await loadFixtureEvents(filename);
      parsedByFile.set(filename, events);
    }

    const elapsedMs = performance.now() - startMs;
    expect(elapsedMs).toBeLessThan(500);

    for (const filename of UNSEEN_FIXTURES) {
      const events = parsedByFile.get(filename) ?? [];
      expect(events.length).toBeGreaterThan(0);

      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        expect(ev.v).toBe(1);
        expect(ev.source).toBe("browser");

        if (i > 0) {
          expect(ev.ts).toBeGreaterThan(events[i - 1].ts);
        }

        if (ev.target) {
          expect(ev.target.locators.length).toBeGreaterThanOrEqual(2);
          for (const locator of ev.target.locators) {
            expect(LocatorSchema.parse(locator)).toEqual(locator);
          }
        }
      }

      const tabSwitches = events.filter((e) => e.type === "tab_switch");
      expect(tabSwitches.length).toBeGreaterThan(0);

      const pageSummaries = events
        .map((e) => e.meta?.pageSummary)
        .filter((s): s is string => typeof s === "string");
      expect(pageSummaries.length).toBeGreaterThan(0);

      for (const summary of pageSummaries) {
        expect(utf8ByteLength(summary)).toBeLessThanOrEqual(4096);
        expect(RAW_HTML_TAG_RE.test(summary)).toBe(false);
      }
    }
  });

  it("unseen-rows-wrongtab.jsonl: 3 reps with #row-1..#row-3, dest tab end, and rows 4-5 in pageSummary", async () => {
    const events = await loadFixtureEvents("unseen-rows-wrongtab.jsonl");

    const rowCopies = events.filter((e) => e.type === "copy");
    expect(rowCopies).toHaveLength(6);

    for (const rowIdx of [1, 2, 3]) {
      const copiesForRow = rowCopies.filter((e) =>
        e.target?.locators.some(
          (l) => l.kind === "css" && l.value.includes(`#row-${rowIdx}`),
        ),
      );
      expect(copiesForRow).toHaveLength(2);
    }

    const fileClicks = events.filter(
      (e) => e.type === "click" && e.target?.label === "File Declaration",
    );
    expect(fileClicks).toHaveLength(3);

    const lastEvent = events[events.length - 1];
    expect(lastEvent.app).toBe("customs.local");
    expect(lastEvent.meta?.tabId).toBe(302);

    const summaries = events
      .map((e) => e.meta?.pageSummary)
      .filter((s): s is string => typeof s === "string");
    expect(
      summaries.some(
        (s) =>
          s.includes("Row 4") &&
          s.includes("Row 5") &&
          s.includes("#row-4") &&
          s.includes("#row-5"),
      ),
    ).toBe(true);
  });

  it("unseen-multifield-tab.jsonl: 3x3 Tab-filled fields with hex IDs, colliding aria, Tab keys, and noise", async () => {
    const events = await loadFixtureEvents("unseen-multifield-tab.jsonl");

    const saveClicks = events.filter(
      (e) => e.type === "click" && e.target?.label === "Save Reading",
    );
    expect(saveClicks).toHaveLength(3);

    const tabKeys = events.filter(
      (e) =>
        (e.type === "keydown" || e.type === "key") && e.meta?.key === "Tab",
    );
    expect(tabKeys).toHaveLength(6);

    const changeEvents = events.filter((e) => e.type === "change");
    expect(changeEvents).toHaveLength(9);

    const hexIds = new Set<string>();
    const ariaValues = new Set<string>();
    for (const ev of changeEvents) {
      const hexLoc = ev.target?.locators.find(
        (l) => l.kind === "css" && /^#[a-z]+-[0-9a-f]{8}$/.test(l.value),
      );
      expect(hexLoc).toBeDefined();
      if (hexLoc) hexIds.add(hexLoc.value);

      const ariaLoc = ev.target?.locators.find((l) => l.kind === "aria");
      expect(ariaLoc).toBeDefined();
      if (ariaLoc) ariaValues.add(ariaLoc.value);
    }

    expect(hexIds.size).toBe(9);
    expect(ariaValues.size).toBe(1);

    // No intermediate clicks between fields 1->2->3 within a repetition
    let repStart = 0;
    for (const saveClick of saveClicks) {
      const repEnd = events.indexOf(saveClick);
      const repSlice = events.slice(repStart, repEnd);
      const fieldClicks = repSlice.filter(
        (e) => e.type === "click" && e.target?.label === "Entry Value",
      );
      expect(fieldClicks).toHaveLength(1);
      repStart = repEnd + 1;
    }

    expect(events.some((e) => e.type === "scroll")).toBe(true);
    expect(events.some((e) => e.type === "mousemove")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "click" &&
          e.target?.locators.some(
            (l) => l.kind === "testid" && l.value === "assay-guidelines-banner",
          ),
      ),
    ).toBe(true);
  });

  it("unseen-extra-click.jsonl: 3 reps with stray click in rep 2 only", async () => {
    const events = await loadFixtureEvents("unseen-extra-click.jsonl");

    const recordClicks = events.filter(
      (e) => e.type === "click" && e.target?.label === "Record Claim",
    );
    expect(recordClicks).toHaveLength(3);

    const strayClicks = events.filter(
      (e) =>
        e.type === "click" &&
        e.target?.locators.some(
          (l) => l.kind === "testid" && l.value === "policy-tooltip-toggle",
        ),
    );
    expect(strayClicks).toHaveLength(1);

    const strayIdx = events.indexOf(strayClicks[0]);
    const rep1EndIdx = events.indexOf(recordClicks[0]);
    const rep2EndIdx = events.indexOf(recordClicks[1]);
    expect(strayIdx).toBeGreaterThan(rep1EndIdx);
    expect(strayIdx).toBeLessThan(rep2EndIdx);
  });

  it("unseen-two-repeats.jsonl: 2 repeats only and table pageSummary with remaining rows", async () => {
    const events = await loadFixtureEvents("unseen-two-repeats.jsonl");

    const postClicks = events.filter(
      (e) => e.type === "click" && e.target?.label === "Post Transfer",
    );
    expect(postClicks).toHaveLength(2);

    const copies = events.filter((e) => e.type === "copy");
    const pastes = events.filter((e) => e.type === "paste");
    expect(copies).toHaveLength(4);
    expect(pastes).toHaveLength(4);

    const summaries = events
      .map((e) => e.meta?.pageSummary)
      .filter((s): s is string => typeof s === "string");
    expect(
      summaries.some(
        (s) =>
          s.includes("Table: Pending Transfers") &&
          s.includes("| Row | SKU | Bin |") &&
          s.includes("remaining"),
      ),
    ).toBe(true);
  });

  it("unseen-enter-controls.jsonl: 3 reps with select, checkbox, and Enter submission", async () => {
    const events = await loadFixtureEvents("unseen-enter-controls.jsonl");

    const selectChanges = events.filter(
      (e) => e.type === "change" && e.target?.tag === "select",
    );
    expect(selectChanges).toHaveLength(3);

    const checkboxEvents = events.filter(
      (e) =>
        e.type === "click" &&
        e.target?.tag === "input" &&
        e.target?.role === "checkbox",
    );
    expect(checkboxEvents).toHaveLength(3);

    const enterKeys = events.filter(
      (e) =>
        (e.type === "keydown" || e.type === "key") && e.meta?.key === "Enter",
    );
    expect(enterKeys).toHaveLength(3);

    const submits = events.filter((e) => e.type === "submit");
    expect(submits).toHaveLength(3);
  });

  it("unseen-pii-risky.jsonl: 3 reps with redacted email meta.privacy and Wire payment click", async () => {
    const events = await loadFixtureEvents("unseen-pii-risky.jsonl");

    const wireClicks = events.filter(
      (e) => e.type === "click" && e.target?.label === "Wire payment",
    );
    expect(wireClicks).toHaveLength(3);

    const emailPrivacyEvents = events.filter((e) => {
      const privacy = e.meta?.privacy as
        | {
            redacted?: boolean;
            reason?: string;
            piiTypes?: string[];
            valueHash?: string;
            valueLength?: number;
          }
        | undefined;
      return (
        privacy?.redacted === true &&
        privacy.reason === "pii_pattern" &&
        Array.isArray(privacy.piiTypes) &&
        privacy.piiTypes.includes("email") &&
        typeof privacy.valueHash === "string" &&
        typeof privacy.valueLength === "number"
      );
    });
    expect(emailPrivacyEvents).toHaveLength(6);

    for (const ev of emailPrivacyEvents) {
      expect(ev.value).toMatch(/^\[REDACTED:EMAIL#h_[0-9a-f]+\]$/);
    }
  });
});
