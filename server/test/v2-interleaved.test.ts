import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { EventsSchema, LocatorSchema } from "@gen/shared/schema.ts";
import { buildMeaningfulWindow, eventsToSteps } from "../src/v2/steps.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_HTML_TAG_RE = /<[a-z!/][^>]*>/i;

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

describe("v2 interleaved workflow fixture invariants and meaningful window", () => {
  it("validates unseen-interleaved.jsonl invariants and builds a meaningful window", async () => {
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
    const window = buildMeaningfulWindow(steps, events);
    expect(window.meaningfulCount).toBeGreaterThanOrEqual(2);
    expect(window.steps.length).toBeLessThanOrEqual(40);
  });
});
