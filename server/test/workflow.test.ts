import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event, Step } from "@gen/shared";
import { EventSchema } from "@gen/shared/schema.ts";
import { normalize } from "../src/detect/normalize.ts";
import { detectWorkflows } from "../src/detect/workflow.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

describe("detectWorkflows", () => {
  it("detects the 9-repetition invoice workflow from invoice-x9.jsonl with 4 shared params and 9 instances", async () => {
    const events = await loadFixtureEvents("invoice-x9.jsonl");
    const steps = normalize(events);
    const candidates = detectWorkflows(steps, { events });

    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;

    expect(candidate.repetitions).toBe(9);
    expect(candidate.stability).toBeGreaterThanOrEqual(0.9);
    expect(candidate.workflow.id).toMatch(/^wf_[0-9a-f]{8}$/);
    expect(candidate.workflow.sourceApp).toBe("portal.local");
    expect(candidate.workflow.destApp).toBe("erp.local");
    expect(candidate.workflow.steps).toHaveLength(9);
    expect(candidate.workflow.params).toHaveLength(4);
    expect(candidate.workflow.params.map((p) => p.name)).toEqual([
      "portal_invoice_id",
      "portal_vendor",
      "portal_amount",
      "portal_date",
    ]);

    for (let i = 0; i < 4; i++) {
      const paramName = candidate.workflow.params[i].name;
      expect(candidate.workflow.steps[i].action).toBe("copy");
      expect(candidate.workflow.steps[i].value).toEqual({ param: paramName });
      expect(candidate.workflow.steps[i + 4].action).toBe("paste");
      expect(candidate.workflow.steps[i + 4].value).toEqual({
        param: paramName,
      });
    }
    expect(candidate.workflow.steps[8].action).toBe("click");
    expect(candidate.workflow.steps[8].value).toBeUndefined();

    expect(candidate.workflow.instances).toHaveLength(9);
    expect(candidate.workflow.instances[0].bindings).toEqual({
      portal_invoice_id: "INV-2026-001",
      portal_vendor: "Acme Industrial",
      portal_amount: "1250.00",
      portal_date: "2026-02-01",
    });
    expect(candidate.workflow.instances[8].bindings).toEqual({
      portal_invoice_id: "INV-2026-009",
      portal_vendor: "Hooli Cloud",
      portal_amount: "540.00",
      portal_date: "2026-02-24",
    });
  });

  it("detects the 4-repetition 20-step routine from routine-20-noisy.jsonl and drops stray clicks", async () => {
    const events = await loadFixtureEvents("routine-20-noisy.jsonl");
    const steps = normalize(events);
    const candidates = detectWorkflows(steps);

    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;

    expect(candidate.repetitions).toBe(4);
    expect(candidate.workflow.steps).toHaveLength(20);
    expect(candidate.stability).toBeGreaterThan(0.8);
    expect(candidate.workflow.params).toEqual([]);
    expect(candidate.workflow.instances).toHaveLength(4);

    const hasStrayToolbar = candidate.workflow.steps.some((step) =>
      step.target?.some((loc) => loc.value === "stray-toolbar"),
    );
    expect(hasStrayToolbar).toBe(false);
  });

  it("returns [] for reply-x3.jsonl and one-off.jsonl", async () => {
    const replyEvents = await loadFixtureEvents("reply-x3.jsonl");
    const replySteps = normalize(replyEvents);
    expect(detectWorkflows(replySteps)).toEqual([]);
    expect(detectWorkflows(replySteps, { maxEditDistance: 0.4 })).toEqual([]);

    const oneOffEvents = await loadFixtureEvents("one-off.jsonl");
    const oneOffSteps = normalize(oneOffEvents);
    expect(detectWorkflows(oneOffSteps)).toEqual([]);
  });

  it("detects the 3-repetition dispute workflow from dispute-x3.jsonl with structural stability", async () => {
    const events = await loadFixtureEvents("dispute-x3.jsonl");
    const steps = normalize(events);
    const candidates = detectWorkflows(steps);

    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;

    expect(candidate.repetitions).toBe(3);
    expect(candidate.stability).toBe(Number((4 / 7).toFixed(4)));
    expect(candidate.workflow.params.map((p) => p.name)).toEqual([
      "reply_body",
    ]);
    expect(candidate.workflow.instances).toHaveLength(3);
  });

  it("splits sequences on >= 30s timestamp gaps", () => {
    const unitSteps = (
      baseTs: number,
      firstTarget: string,
      idValue: string,
    ): Step[] => [
      {
        action: "click",
        target: [{ kind: "testid", value: firstTarget }],
        ...({ ts: baseTs } as Record<string, unknown>),
      },
      {
        action: "copy",
        target: [{ kind: "testid", value: "portal-record-id" }],
        value: idValue,
        ...({ ts: baseTs + 1_000 } as Record<string, unknown>),
      },
      {
        action: "paste",
        target: [{ kind: "testid", value: "erp-record-id" }],
        value: idValue,
        ...({ ts: baseTs + 2_000 } as Record<string, unknown>),
      },
      {
        action: "click",
        target: [{ kind: "testid", value: "verify-record" }],
        ...({ ts: baseTs + 3_000 } as Record<string, unknown>),
      },
      {
        action: "click",
        target: [{ kind: "testid", value: "save-record" }],
        ...({ ts: baseTs + 4_000 } as Record<string, unknown>),
      },
    ];

    // 3 sequences with distinct first-step keys and 4 shared tail steps (edit distance 1/5 = 0.2),
    // separated by an exact 30_000ms gap (5_000 -> 35_000) and a 35_000ms gap (39_000 -> 74_000)
    const stepsWithGaps: Step[] = [
      ...unitSteps(1_000, "row-select-1", "REC-100"),
      ...unitSteps(35_000, "row-select-2", "REC-200"),
      ...unitSteps(74_000, "row-select-3", "REC-300"),
    ];

    const candidates = detectWorkflows(stepsWithGaps);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].repetitions).toBe(3);
    expect(candidates[0].workflow.instances).toEqual([
      {
        startTs: 1_000,
        endTs: 5_000,
        bindings: { portal_record_id: "REC-100" },
      },
      {
        startTs: 35_000,
        endTs: 39_000,
        bindings: { portal_record_id: "REC-200" },
      },
      {
        startTs: 74_000,
        endTs: 78_000,
        bindings: { portal_record_id: "REC-300" },
      },
    ]);

    // Explicit boundary check at exactly 30_000ms
    expect(detectWorkflows(stepsWithGaps, { gapMs: 30_000 })).toHaveLength(1);

    // When gapMs is above the 30_000ms gap or above all trace gaps, sequences are not split
    expect(detectWorkflows(stepsWithGaps, { gapMs: 30_001 })).toEqual([]);
    expect(detectWorkflows(stepsWithGaps, { gapMs: 40_000 })).toEqual([]);
  });

  it("keeps 3 repetitions of [click, fill, submit(Enter), fill, submit(Enter), fill, submit(Enter), click Save] intact per repetition", () => {
    const tagTarget = [{ kind: "testid" as const, value: "tag-input" }];
    const saveTarget = [{ kind: "testid" as const, value: "save-btn" }];

    const steps: Step[] = [
      ["t1a", "t1b", "t1c"],
      ["t2a", "t2b", "t2c"],
      ["t3a", "t3b", "t3c"],
    ].flatMap(([tag1, tag2, tag3]) => [
      { action: "click" as const, target: tagTarget },
      { action: "fill" as const, target: tagTarget, value: tag1 },
      { action: "submit" as const, target: tagTarget, value: "Enter" },
      { action: "fill" as const, target: tagTarget, value: tag2 },
      { action: "submit" as const, target: tagTarget, value: "Enter" },
      { action: "fill" as const, target: tagTarget, value: tag3 },
      { action: "submit" as const, target: tagTarget, value: "Enter" },
      { action: "click" as const, target: saveTarget },
    ]);

    const candidates = detectWorkflows(steps);
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate.repetitions).toBe(3);
    expect(candidate.workflow.steps).toHaveLength(8);
    expect(candidate.workflow.steps.map((s) => s.action)).toEqual([
      "click",
      "fill",
      "submit",
      "fill",
      "submit",
      "fill",
      "submit",
      "click",
    ]);
    expect(candidate.workflow.instances).toHaveLength(3);
    expect(candidate.workflow.instances.map((i) => Object.values(i.bindings))).toEqual([
      ["t1a", "t1b", "t1c"],
      ["t2a", "t2b", "t2c"],
      ["t3a", "t3b", "t3c"],
    ]);
  });
});
