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
    expect(candidate.workflow.id).toMatch(/^wf_[0-9a-f]{8}$/);
    expect(candidate.workflow.sourceApp).toBe("portal.local");
    expect(candidate.workflow.destApp).toBe("erp.local");
    expect(candidate.workflow.steps).toHaveLength(9);
    expect(candidate.workflow.params).toHaveLength(4);
    expect(candidate.workflow.params.map((p) => p.name)).toEqual([
      "invoice_id",
      "vendor",
      "amount",
      "date",
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
      invoice_id: "INV-2026-001",
      vendor: "Acme Industrial",
      amount: "1250.00",
      date: "2026-02-01",
    });
    expect(candidate.workflow.instances[8].bindings).toEqual({
      invoice_id: "INV-2026-009",
      vendor: "Hooli Cloud",
      amount: "540.00",
      date: "2026-02-24",
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

  it("detects the 3-repetition dispute workflow from dispute-x3.jsonl with stability < 0.5", async () => {
    const events = await loadFixtureEvents("dispute-x3.jsonl");
    const steps = normalize(events);
    const candidates = detectWorkflows(steps);

    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;

    expect(candidate.repetitions).toBe(3);
    expect(candidate.stability).toBeLessThan(0.5);
    expect(candidate.workflow.instances).toHaveLength(3);
  });

  it("splits sequences on >= 30s timestamp gaps", () => {
    const unitSteps = (baseTs: number, idValue: string): Step[] => [
      {
        action: "click",
        target: [{ kind: "testid", value: "row-select" }],
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
        target: [{ kind: "testid", value: "save-record" }],
        ...({ ts: baseTs + 3_000 } as Record<string, unknown>),
      },
    ];

    // 3 sequences separated by >= 30s timestamp gaps (35s between end of rep and start of next)
    const stepsWithGaps: Step[] = [
      ...unitSteps(1_000, "REC-100"),
      ...unitSteps(39_000, "REC-200"),
      ...unitSteps(77_000, "REC-300"),
    ];

    const candidates = detectWorkflows(stepsWithGaps);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].repetitions).toBe(3);
    expect(candidates[0].workflow.instances).toEqual([
      { startTs: 1_000, endTs: 4_000, bindings: { record_id: "REC-100" } },
      { startTs: 39_000, endTs: 42_000, bindings: { record_id: "REC-200" } },
      { startTs: 77_000, endTs: 80_000, bindings: { record_id: "REC-300" } },
    ]);

    // When a >= 30s gap interrupts each repetition into < minSteps fragments, no candidate is emitted
    const brokenSteps: Step[] = [
      {
        action: "click",
        target: [{ kind: "testid", value: "a" }],
        ...({ ts: 1_000 } as Record<string, unknown>),
      },
      {
        action: "click",
        target: [{ kind: "testid", value: "b" }],
        ...({ ts: 2_000 } as Record<string, unknown>),
      },
      {
        action: "click",
        target: [{ kind: "testid", value: "c" }],
        ...({ ts: 35_000 } as Record<string, unknown>),
      },
    ];
    expect(detectWorkflows(brokenSteps)).toEqual([]);
  });
});
