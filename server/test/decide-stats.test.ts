import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event, Step, Workflow } from "@gen/shared";
import { EventSchema } from "@gen/shared/schema.ts";
import {
  DEFAULT_STATS_CONFIG,
  decideStats,
  type Candidate,
  type StatsDeciderConfig,
} from "../src/decide/stats.ts";
import { normalize } from "../src/detect/normalize.ts";
import { trigramJaccard } from "../src/detect/snippet.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

function meanPairwiseSimilarity(values: string[]): number {
  if (values.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      total += trigramJaccard(values[i], values[j]);
      pairs += 1;
    }
  }
  return pairs === 0 ? 1 : total / pairs;
}

function locatorValue(step: Step): string | undefined {
  return step.target?.[0]?.value;
}

describe("decideStats", () => {
  it("routes invoice-x9 fixture to rung2 with high confidence", async () => {
    const events = await loadFixtureEvents("invoice-x9.jsonl");
    const steps = normalize(events);

    const cleanSteps = steps.filter(
      (step) => locatorValue(step) !== "portal-banner",
    );
    expect(cleanSteps).toHaveLength(81);

    const templateRaw = cleanSteps.slice(0, 9);
    const paramByTarget: Record<string, string> = {
      "portal-invoice-id": "invoiceId",
      "portal-vendor": "vendor",
      "portal-amount": "amount",
      "portal-date": "date",
      "erp-invoice-id": "invoiceId",
      "erp-vendor": "vendor",
      "erp-amount": "amount",
      "erp-date": "date",
    };

    const templateSteps: Step[] = templateRaw.map((step) => {
      const targetVal = locatorValue(step);
      const param = targetVal ? paramByTarget[targetVal] : undefined;
      if (param) {
        return { ...step, value: { param } };
      }
      return step;
    });

    const copyEvents = events.filter((e) => e.type === "copy");
    const saveEvents = events.filter(
      (e) => e.type === "click" && e.target?.label === "Save",
    );
    const instances: Workflow["instances"] = [];
    for (let i = 0; i < 9; i++) {
      const cycleSteps = cleanSteps.slice(i * 9, (i + 1) * 9);
      const bindings: Record<string, string> = {};
      for (const s of cycleSteps) {
        if (s.action === "copy" && typeof s.value === "string") {
          const param = paramByTarget[locatorValue(s) ?? ""];
          if (param) bindings[param] = s.value;
        }
      }
      instances.push({
        startTs: copyEvents[i * 4].ts,
        endTs: saveEvents[i].ts,
        bindings,
      });
    }

    const workflow: Workflow = {
      id: "wf_invoice_x9",
      name: "Copy invoices from portal to ERP",
      sourceApp: "portal.local",
      destApp: "erp.local",
      steps: templateSteps,
      params: [
        { name: "invoiceId", example: instances[0].bindings.invoiceId },
        { name: "vendor", example: instances[0].bindings.vendor },
        { name: "amount", example: instances[0].bindings.amount },
        { name: "date", example: instances[0].bindings.date },
      ],
      instances,
    };

    const candidate: Candidate = {
      workflow,
      repetitions: 9,
      minutesPerWeek: 18,
      stability: cleanSteps.length / steps.length,
    };

    const decision = decideStats(candidate);

    expect(decision.verdict).toBe("rung2");
    expect(decision.confidence).toBeGreaterThanOrEqual(0.8);
    expect(decision.confidence).toBeLessThanOrEqual(1);
    expect(decision.features).toMatchObject({
      repetitions: 9,
      stepCount: 9,
      paramCount: 4,
      paramDistinctRatio_invoiceId: 1,
      paramDistinctRatio_vendor: 1,
      paramDistinctRatio_amount: 1,
      paramDistinctRatio_date: 1,
      paramDistinctRatioMean: 1,
      paramConstantShare: 0,
      paramVaryingShare: 1,
      paramUniqueShare: 1,
    });
    expect("minutesPerWeek" in decision.features).toBe(false);
  });

  it("routes routine-20-noisy fixture to rung2", async () => {
    const events = await loadFixtureEvents("routine-20-noisy.jsonl");
    const steps = normalize(events);

    const routineSteps = steps.filter((step) =>
      step.target?.some(
        (loc) => loc.kind === "testid" && loc.value.startsWith("routine-cell-"),
      ),
    );
    expect(routineSteps).toHaveLength(80);

    const templateSteps = routineSteps.slice(0, 20);
    const cellEvents = events.filter(
      (e) =>
        e.type === "click" &&
        e.target?.locators.some(
          (l) => l.kind === "testid" && l.value.startsWith("routine-cell-"),
        ),
    );

    const instances: Workflow["instances"] = [];
    for (let i = 0; i < 4; i++) {
      instances.push({
        startTs: cellEvents[i * 20].ts,
        endTs: cellEvents[(i + 1) * 20 - 1].ts,
        bindings: {},
      });
    }

    const candidate: Candidate = {
      workflow: {
        id: "wf_routine_20_noisy",
        name: "20-cell sheet routine",
        sourceApp: "sheets.local",
        destApp: "sheets.local",
        steps: templateSteps,
        params: [],
        instances,
      },
      repetitions: 4,
      minutesPerWeek: 12,
      stability: routineSteps.length / steps.length,
    };

    const decision = decideStats(candidate);

    expect(decision.verdict).toBe("rung2");
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
    expect(decision.features).toMatchObject({
      repetitions: 4,
      stepCount: 20,
      paramCount: 0,
      paramDistinctRatioMean: 0,
      paramConstantShare: 0,
      paramVaryingShare: 0,
      paramUniqueShare: 0,
    });
    expect("minutesPerWeek" in decision.features).toBe(false);
  });

  it("routes dispute-x3 fixture to do_not_automate due to low stability", async () => {
    const events = await loadFixtureEvents("dispute-x3.jsonl");
    const steps = normalize(events);

    expect(steps).toHaveLength(18);
    const fillValues = steps
      .filter((step) => step.action === "fill" && typeof step.value === "string")
      .map((step) => step.value as string);
    expect(fillValues).toHaveLength(3);

    const templateSteps: Step[] = steps.slice(0, 6).map((step) =>
      step.action === "fill" ? { ...step, value: { param: "replyBody" } } : step,
    );

    const navEvents = events.filter((e) => e.type === "nav");
    const submitEvents = events.filter((e) => e.type === "submit");
    const instances: Workflow["instances"] = fillValues.map((body, idx) => ({
      startTs: navEvents[idx].ts,
      endTs: submitEvents[idx].ts,
      bindings: { replyBody: body },
    }));

    const stability = meanPairwiseSimilarity(fillValues);
    expect(stability).toBeLessThan(DEFAULT_STATS_CONFIG.minStability);

    const candidate: Candidate = {
      workflow: {
        id: "wf_dispute_x3",
        name: "Dispute resolution replies",
        sourceApp: "127.0.0.1",
        destApp: "127.0.0.1",
        steps: templateSteps,
        params: [{ name: "replyBody", example: fillValues[0] }],
        instances,
      },
      repetitions: 3,
      minutesPerWeek: 15,
      stability,
    };

    const decision = decideStats(candidate);

    expect(decision.verdict).toBe("do_not_automate");
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
    expect(decision.features.paramDistinctRatio_replyBody).toBe(1);
    expect("minutesPerWeek" in decision.features).toBe(false);
  });

  it("routes reply-x3 fixture as a single-step snippet to rung1", async () => {
    const events = await loadFixtureEvents("reply-x3.jsonl");
    const steps = normalize(events);

    const fillSteps = steps.filter(
      (step) => step.action === "fill" && typeof step.value === "string",
    );
    expect(fillSteps).toHaveLength(3);

    const fillValues = fillSteps.map((step) => step.value as string);
    const inputEvents = events.filter((e) => e.type === "input");

    const stability = meanPairwiseSimilarity(fillValues);
    expect(stability).toBeGreaterThanOrEqual(DEFAULT_STATS_CONFIG.minStability);

    const candidate: Candidate = {
      workflow: {
        id: "wf_reply_x3",
        name: "Order shipping reply snippet",
        sourceApp: "127.0.0.1",
        destApp: "127.0.0.1",
        steps: [fillSteps[0]],
        params: [],
        instances: inputEvents.map((ev) => ({
          startTs: ev.ts,
          endTs: ev.ts,
          bindings: {},
        })),
      },
      repetitions: 3,
      minutesPerWeek: 4,
      stability,
    };

    const decision = decideStats(candidate);

    expect(decision.verdict).toBe("rung1");
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
    expect(decision.features.stepCount).toBe(1);
    expect(decision.features.repetitions).toBe(3);
    expect("minutesPerWeek" in decision.features).toBe(false);
  });

  it("routes one-off fixture to do_not_automate", async () => {
    const events = await loadFixtureEvents("one-off.jsonl");
    const steps = normalize(events);

    expect(steps).toHaveLength(6);
    const fillStep = steps.find((s) => s.action === "fill");
    const body = typeof fillStep?.value === "string" ? fillStep.value : "";

    const candidate: Candidate = {
      workflow: {
        id: "wf_one_off",
        name: "Single scheduling reply",
        sourceApp: "127.0.0.1",
        destApp: "127.0.0.1",
        steps,
        params: [{ name: "replyBody", example: body }],
        instances: [
          {
            startTs: events[0].ts,
            endTs: events[events.length - 1].ts,
            bindings: { replyBody: body },
          },
        ],
      },
      repetitions: 1,
      minutesPerWeek: 1,
      stability: 1,
    };

    const decision = decideStats(candidate);

    expect(decision.verdict).toBe("do_not_automate");
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
    expect(decision.confidence).toBeLessThan(0.5);
    expect(decision.features).toMatchObject({
      repetitions: 1,
      stability: 1,
      stepCount: 6,
      paramCount: 1,
      paramDistinctRatio_replyBody: 1,
      paramDistinctRatioMean: 1,
      paramConstantShare: 1,
      paramVaryingShare: 0,
      paramUniqueShare: 0,
    });
    expect("minutesPerWeek" in decision.features).toBe(false);
  });

  it("passes repetitions === 2 while repetitions === 1 fails, and omits minutesPerWeek", () => {
    const baseWorkflow: Workflow = {
      id: "wf_rep_boundary",
      name: "Boundary check",
      sourceApp: "portal.local",
      destApp: "erp.local",
      steps: [
        { action: "click", target: [{ kind: "testid", value: "open" }] },
        { action: "fill", target: [{ kind: "testid", value: "field" }], value: { param: "id" } },
        { action: "submit", target: [{ kind: "testid", value: "form" }] },
      ],
      params: [{ name: "id", example: "A-1" }],
      instances: [
        { startTs: 1, endTs: 2, bindings: { id: "A-1" } },
        { startTs: 3, endTs: 4, bindings: { id: "A-2" } },
      ],
    };

    const failDecision = decideStats({
      workflow: {
        ...baseWorkflow,
        instances: [baseWorkflow.instances[0]],
      },
      repetitions: 1,
      minutesPerWeek: 500,
      stability: 0.95,
    });
    expect(failDecision.verdict).toBe("do_not_automate");
    expect("minutesPerWeek" in failDecision.features).toBe(false);

    const passLowMin = decideStats({
      workflow: baseWorkflow,
      repetitions: 2,
      minutesPerWeek: 0,
      stability: 0.95,
    });
    const passHighMin = decideStats({
      workflow: baseWorkflow,
      repetitions: 2,
      minutesPerWeek: 999,
      stability: 0.95,
    });

    expect(passLowMin.verdict).toBe("rung2");
    expect(passLowMin).toEqual(passHighMin);
    expect(passLowMin.confidence).toBeGreaterThanOrEqual(0);
    expect(passLowMin.confidence).toBeLessThanOrEqual(1);
    expect("minutesPerWeek" in passLowMin.features).toBe(false);
  });

  it("routes short snippets and small step counts to rung0 and computes mixed param ratios", () => {
    const shortSnippet = decideStats({
      workflow: {
        id: "wf_short_snip",
        name: "Short snippet",
        sourceApp: "mail.local",
        destApp: "mail.local",
        steps: [{ action: "fill", value: "Thanks!" }],
        params: [],
        instances: [
          { startTs: 1, endTs: 2, bindings: {} },
          { startTs: 3, endTs: 4, bindings: {} },
        ],
      },
      repetitions: 3,
      minutesPerWeek: 1,
      stability: 1,
    });
    expect(shortSnippet.verdict).toBe("rung0");
    expect(shortSnippet.confidence).toBeGreaterThanOrEqual(0);
    expect(shortSnippet.confidence).toBeLessThanOrEqual(1);

    const mixedWorkflow: Workflow = {
      id: "wf_mixed",
      name: "Mixed param workflow",
      sourceApp: "a.local",
      destApp: "b.local",
      steps: [
        { action: "fill", value: { param: "env" } },
        { action: "fill", value: { param: "region" } },
        { action: "fill", value: { param: "orderId" } },
      ],
      params: [
        { name: "env", example: "prod" },
        { name: "region", example: "us" },
        { name: "orderId", example: "ORD-1" },
      ],
      instances: [
        { startTs: 1, endTs: 2, bindings: { env: "prod", region: "us", orderId: "ORD-1" } },
        { startTs: 3, endTs: 4, bindings: { env: "prod", region: "eu", orderId: "ORD-2" } },
        { startTs: 5, endTs: 6, bindings: { env: "prod", region: "us", orderId: "ORD-3" } },
        { startTs: 7, endTs: 8, bindings: { env: "prod", region: "eu", orderId: "ORD-4" } },
      ],
    };

    const mixedDecision = decideStats({
      workflow: mixedWorkflow,
      repetitions: 4,
      minutesPerWeek: 10,
      stability: 0.9,
    });
    expect(mixedDecision.verdict).toBe("rung2");
    expect(mixedDecision.features.paramDistinctRatio_env).toBeCloseTo(0.25);
    expect(mixedDecision.features.paramDistinctRatio_region).toBeCloseTo(0.5);
    expect(mixedDecision.features.paramDistinctRatio_orderId).toBeCloseTo(1);
    expect(mixedDecision.features.paramDistinctRatioMean).toBeCloseTo(1.75 / 3);
    expect(mixedDecision.features.paramConstantShare).toBeCloseTo(1 / 3);
    expect(mixedDecision.features.paramVaryingShare).toBeCloseTo(2 / 3);
    expect(mixedDecision.features.paramUniqueShare).toBeCloseTo(1 / 3);

    const emptyInstancesDecision = decideStats({
      workflow: { ...mixedWorkflow, instances: [] },
      repetitions: 4,
      minutesPerWeek: 10,
      stability: 0.9,
    });
    expect(emptyInstancesDecision.features.paramDistinctRatio_env).toBe(0);
    expect(emptyInstancesDecision.features.paramDistinctRatioMean).toBe(0);
    expect(emptyInstancesDecision.features.paramConstantShare).toBe(0);
    expect(emptyInstancesDecision.features.paramVaryingShare).toBe(0);
    expect(emptyInstancesDecision.features.paramUniqueShare).toBe(0);
  });

  it("gives lower confidence near cutoff boundaries and respects custom config overrides", () => {
    const workflow: Workflow = {
      id: "wf_config",
      name: "Config override workflow",
      sourceApp: "portal.local",
      destApp: "erp.local",
      steps: [
        { action: "click", target: [{ kind: "testid", value: "a" }] },
        { action: "click", target: [{ kind: "testid", value: "b" }] },
      ],
      params: [],
      instances: [],
    };

    const borderline = decideStats({
      workflow,
      repetitions: 2,
      minutesPerWeek: 5,
      stability: 0.71,
    });
    const decisive = decideStats({
      workflow,
      repetitions: 10,
      minutesPerWeek: 5,
      stability: 0.98,
    });
    expect(borderline.verdict).toBe("rung2");
    expect(decisive.verdict).toBe("rung2");
    expect(borderline.confidence).toBeLessThan(decisive.confidence);
    expect(borderline.confidence).toBeLessThan(0.3);

    const nearBelowStability = decideStats({
      workflow,
      repetitions: 5,
      minutesPerWeek: 5,
      stability: 0.69,
    });
    const farBelowStability = decideStats({
      workflow,
      repetitions: 5,
      minutesPerWeek: 5,
      stability: 0.1,
    });
    expect(nearBelowStability.verdict).toBe("do_not_automate");
    expect(farBelowStability.verdict).toBe("do_not_automate");
    expect(nearBelowStability.confidence).toBeLessThan(
      farBelowStability.confidence,
    );

    const strictConfig: StatsDeciderConfig = {
      ...DEFAULT_STATS_CONFIG,
      minRepetitions: 5,
      minStability: 0.95,
      minStepsSaved: 20,
      minCharsSaved: 500,
    };

    const repBlocked = decideStats(
      { workflow, repetitions: 4, minutesPerWeek: 5, stability: 0.99 },
      strictConfig,
    );
    expect(repBlocked.verdict).toBe("do_not_automate");

    const stabilityBlocked = decideStats(
      { workflow, repetitions: 6, minutesPerWeek: 5, stability: 0.9 },
      strictConfig,
    );
    expect(stabilityBlocked.verdict).toBe("do_not_automate");

    const stepsRung0 = decideStats(
      { workflow, repetitions: 6, minutesPerWeek: 5, stability: 0.99 },
      strictConfig,
    );
    expect(stepsRung0.verdict).toBe("rung0");

    const snippetRung0 = decideStats(
      {
        workflow: {
          ...workflow,
          steps: [{ action: "fill", value: "a".repeat(80) }],
        },
        repetitions: 6,
        minutesPerWeek: 5,
        stability: 0.99,
      },
      strictConfig,
    );
    expect(snippetRung0.verdict).toBe("rung0");
    expect(snippetRung0.verdict).not.toBe("rung3");
  });
});
