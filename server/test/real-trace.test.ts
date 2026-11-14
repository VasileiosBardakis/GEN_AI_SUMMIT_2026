import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventSchema, FindingSchema } from "@gen/shared/schema.ts";
import { normalize } from "../src/detect/normalize.ts";
import { detectSnippets } from "../src/detect/snippet.ts";
import { readEvents } from "../src/trace.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tracesDir = path.resolve(__dirname, "../../traces");

const SIMILAR_REPLIES = [
  "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
  "Hi, thanks for your order. It ships Monday and tracking will follow shortly.",
  "Hi, thanks for your order! It ships Friday and tracking will follow shortly.",
];

const UNRELATED_REPLY =
  "Can you please send the updated tax invoice for the November consulting retainer?";

const ALL_REPLIES = [...SIMILAR_REPLIES, UNRELATED_REPLY];

describe("real Playwright extension reply trace (real_reply_x3)", () => {
  it("loads captured events, validates schema, normalizes, and detects 1 rung1 snippet finding", async () => {
    const events = await readEvents(tracesDir, "real_reply_x3");

    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      expect(EventSchema.parse(event)).toEqual(event);
      expect(event.session).toBe("real_reply_x3");
    }

    const blurCommitValues = events
      .filter((e) => e.type === "input" && e.meta?.subType === "blur_commit")
      .map((e) => e.value);
    expect(blurCommitValues).toEqual(ALL_REPLIES);

    const steps = normalize(events);
    const fillValues = steps
      .filter((s) => s.action === "fill")
      .map((s) => s.value);
    expect(fillValues).toEqual(ALL_REPLIES);

    const findings = detectSnippets(steps);
    expect(findings).toHaveLength(1);

    const [finding] = findings;
    expect(FindingSchema.parse(finding)).toEqual(finding);
    expect(finding.verdict).toBe("rung1");
    expect(finding.stats.repetitions).toBe(3);
    expect(finding.stats.stability).toBeGreaterThanOrEqual(0.8);
    expect(finding.stats.stability).toBeLessThanOrEqual(1);
    expect(finding.title).toContain("Hi, thanks for your order.");
    expect(finding.title).not.toContain(UNRELATED_REPLY);
    expect(finding.title).not.toContain("tax invoice");
    expect(finding.why).not.toContain(UNRELATED_REPLY);
    expect(JSON.stringify(finding)).not.toContain("tax invoice");
  });
});
