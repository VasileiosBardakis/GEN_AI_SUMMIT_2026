import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event, Step } from "@gen/shared";
import { EventSchema, FindingSchema } from "@gen/shared/schema.ts";
import { normalize } from "../src/detect/normalize.ts";
import { detectSnippets, trigramJaccard } from "../src/detect/snippet.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

describe("trigramJaccard", () => {
  it("returns 1 for identical normalized strings and 0 for short non-equal strings", () => {
    expect(trigramJaccard("Hello   World", "  hello world ")).toBe(1);
    expect(trigramJaccard("ab", "ab")).toBe(1);
    expect(trigramJaccard("ab", "cd")).toBe(0);
    expect(trigramJaccard("ab", "abcdef")).toBe(0);
    expect(trigramJaccard("abcdef", "xy")).toBe(0);
  });

  it("scores similar sentences high and unrelated sentences low", () => {
    const a =
      "Hi, thanks for your order. It ships Friday and tracking will follow shortly.";
    const b =
      "Hi, thanks for your order. It ships Monday and tracking will follow shortly.";
    const c = "Completely unrelated text about database migrations and indexing.";

    const simAb = trigramJaccard(a, b);
    const simAc = trigramJaccard(a, c);

    expect(simAb).toBeGreaterThanOrEqual(0.8);
    expect(simAb).toBeLessThan(1);
    expect(simAc).toBeLessThan(0.2);
  });
});

describe("detectSnippets", () => {
  it("emits 1 rung1 finding from reply-x3.jsonl", async () => {
    const events = await loadFixtureEvents("reply-x3.jsonl");
    const steps = normalize(events);
    const findings = detectSnippets(steps);

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(FindingSchema.parse(finding)).toEqual(finding);
    expect(finding.verdict).toBe("rung1");
    expect(finding.stats.repetitions).toBe(3);
    expect(finding.stats.stability).toBeGreaterThanOrEqual(0.8);
    expect(finding.stats.stability).toBeLessThanOrEqual(1);
    expect(finding.id).toMatch(/^snip_[0-9a-f]{8}$/);
    expect(finding.artifact).toEqual({
      kind: "snippet",
      path: `snippets/${finding.id}.txt`,
      verified: false,
    });
    expect(finding.title).toBe(
      'Save a snippet for: "Hi, thanks for your order. It ships Frid..."',
    );
  });

  it("returns an empty array for one-off.jsonl", async () => {
    const events = await loadFixtureEvents("one-off.jsonl");
    const steps = normalize(events);
    const findings = detectSnippets(steps);

    expect(findings).toEqual([]);
  });

  it("clusters distinct repeated fill/paste messages while ignoring redacted, short, and non-string values", () => {
    const msgA1 =
      "Please find attached the quarterly revenue breakdown for your review.";
    const msgA2 =
      "Please find attached the quarterly revenue breakdown for your team.";
    const msgA3 =
      "Please find attached the quarterly revenue breakdown for your review!";

    const msgB1 =
      "Your support ticket has been escalated to the engineering on-call rotation.";
    const msgB2 =
      "Your support ticket has been escalated to the engineering on-call team.";
    const msgB3 =
      "Your support ticket has been escalated to the engineering on-call rotation!";

    const steps: Step[] = [
      { action: "fill", value: msgA1 },
      { action: "paste", value: msgB1 },
      { action: "fill", value: "[REDACTED:PASSWORD#h_12345678]" },
      { action: "fill", value: "   short note   " },
      { action: "fill", value: { param: "dynamicParam" } },
      { action: "click" },
      { action: "paste", value: msgA2 },
      { action: "fill", value: "[REDACTED:PASSWORD#h_12345678]" },
      { action: "paste", value: "tiny text" },
      { action: "fill", value: msgB2 },
      { action: "fill", value: "[REDACTED:PASSWORD#h_12345678]" },
      { action: "fill", value: msgA3 },
      { action: "paste", value: msgB3 },
      { action: "paste", value: "[REDACTED:PASSWORD#h_12345678]" },
      { action: "copy", value: msgA1 },
      { action: "nav", value: "https://example.com/very-long-navigation-url-path" },
    ];

    const findings = detectSnippets(steps);
    const findingsRepeat = detectSnippets(steps);

    expect(findings).toHaveLength(2);
    expect(findings).toEqual(findingsRepeat);
    expect(findings[0].id).not.toBe(findings[1].id);

    for (const finding of findings) {
      expect(FindingSchema.parse(finding)).toEqual(finding);
      expect(finding.id).toMatch(/^snip_[0-9a-f]{8}$/);
      expect(finding.verdict).toBe("rung1");
      expect(finding.stats.repetitions).toBe(3);
      expect(finding.stats.stability).toBeGreaterThanOrEqual(0.8);
      expect(finding.stats.stability).toBeLessThanOrEqual(1);
      expect(finding.artifact).toEqual({
        kind: "snippet",
        path: `snippets/${finding.id}.txt`,
        verified: false,
      });
    }
  });
});
