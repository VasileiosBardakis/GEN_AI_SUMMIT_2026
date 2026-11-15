import crypto from "node:crypto";
import type { Event, Finding, Locator, Report } from "@gen/shared";
import { primaryTargetKey } from "./common/target.ts";
import {
  ActionScriptSchema,
  FindingSchema,
  ReportSchema,
  type ScriptLocator,
  type ScriptStep,
} from "@gen/shared/schema.ts";
import { normalize } from "./detect/normalize.ts";
import type { ActionScript } from "./hands/types.ts";
import type { GeminiClient, GeminiClientOptions } from "./llm/gemini.ts";
import type { IrisJudgeOptions } from "./llm/iris.ts";
import { mergeSessions, mergeWithinSession } from "./merge-sessions.ts";
import { runPipeline } from "./pipeline.ts";
import {
  compileWorkflow,
  detectRepeatedCandidates,
  eventsToSteps,
  resolveRepeatCount,
  type CompiledLeafStep,
  type CompiledStep,
  type CompiledWorkflow,
  type IrisWorkflowJudge,
  type PatternCandidate,
  type V2Action,
  type V2Step,
} from "./v2/index.ts";

export interface BuildReportOptions {
  pipeline?: "v1" | "v2";
  dataDir?: string;
  llm?: boolean;
  gemini?: GeminiClient | GeminiClientOptions;
  iris?: IrisJudgeOptions | IrisWorkflowJudge;
  implement?: (solution: string, opts?: { name?: string }) => Promise<ActionScript>;
  scriptStore?: Map<string, ActionScript>;
  compiledStore?: Map<string, CompiledWorkflow>;
  minRepeats?: number;
  gapMs?: number;
}

export function resolvePipeline(pipeline?: "v1" | "v2"): "v1" | "v2" {
  // v2 is the default since 2026-11-15; set BRAIN_PIPELINE=v1 to use the old pipeline.
  return pipeline ?? (process.env.BRAIN_PIPELINE === "v1" ? "v1" : "v2");
}

function toScriptLocators(locators: readonly Locator[] | undefined): ScriptLocator[] | undefined {
  if (!locators || locators.length === 0) return undefined;
  const converted: ScriptLocator[] = [];
  for (const loc of locators) {
    if (
      loc.kind === "testid" ||
      loc.kind === "aria" ||
      loc.kind === "css" ||
      loc.kind === "text"
    ) {
      if (loc.value.trim().length > 0) {
        converted.push({ kind: loc.kind, value: loc.value });
      }
    }
  }
  return converted.length > 0 ? converted : undefined;
}

function normalizePressKey(rawKey?: string): "Enter" | "Tab" | "Escape" {
  const key = (rawKey ?? "Enter").trim();
  if (key === "Tab") return "Tab";
  if (key === "Escape" || key === "Esc") return "Escape";
  return "Enter";
}

function convertCompiledLeafStep(step: CompiledLeafStep): ScriptStep {
  const opt = step.optional !== undefined ? { optional: step.optional } : {};
  switch (step.action) {
    case "click": {
      const target = toScriptLocators(step.target);
      const within = toScriptLocators(step.within);
      if (!target) throw new Error("Compiled click step missing valid target");
      return { action: "click", target, ...(within ? { within } : {}), ...opt };
    }
    case "fill": {
      const target = toScriptLocators(step.target);
      const within = toScriptLocators(step.within);
      if (!target) throw new Error("Compiled fill step missing valid target");
      return { action: "fill", target, ...(within ? { within } : {}), value: step.value, ...opt };
    }
    case "insertText": {
      const target = toScriptLocators(step.target);
      const within = toScriptLocators(step.within);
      return {
        action: "insertText",
        ...(target ? { target } : {}),
        ...(within ? { within } : {}),
        value: step.value,
        ...opt,
      };
    }
    case "select": {
      const target = toScriptLocators(step.target);
      const within = toScriptLocators(step.within);
      if (!target) throw new Error("Compiled select step missing valid target");
      return { action: "select", target, ...(within ? { within } : {}), value: step.value, ...opt };
    }
    case "waitFor": {
      const target = toScriptLocators(step.target);
      const within = toScriptLocators(step.within);
      if (!target) throw new Error("Compiled waitFor step missing valid target");
      return {
        action: "waitFor",
        target,
        ...(within ? { within } : {}),
        ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
        ...opt,
      };
    }
    case "readText":
    case "readValue": {
      const target = toScriptLocators(step.target);
      const within = toScriptLocators(step.within);
      if (!target) throw new Error(`Compiled ${step.action} step missing valid target`);
      return {
        action: step.action,
        target,
        ...(within ? { within } : {}),
        bind: step.bind,
        ...opt,
      };
    }
    case "extractList": {
      const target = toScriptLocators(step.target);
      const within = toScriptLocators(step.within);
      if (!target) throw new Error("Compiled extractList step missing valid target");
      const fields: Record<string, ScriptLocator> | undefined = step.fields
        ? Object.fromEntries(
            Object.entries(step.fields)
              .map(([k, locs]) => [k, toScriptLocators(locs)?.[0]] as const)
              .filter((pair): pair is [string, ScriptLocator] => Boolean(pair[1])),
          )
        : undefined;
      return {
        action: "extractList",
        target,
        ...(within ? { within } : {}),
        bind: step.bind,
        ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
        ...opt,
      };
    }
    case "navigate":
      return { action: "navigate", url: step.url, ...opt };
    case "wait":
      return { action: "wait", ms: step.ms, ...opt };
    case "switchTab":
      return {
        action: "switchTab",
        host: step.host,
        ...(step.url ? { url: step.url } : {}),
        ...opt,
      };
    case "key": {
      const target = toScriptLocators(step.target);
      const within = toScriptLocators(step.within);
      return {
        action: "pressKey",
        key: normalizePressKey(step.key),
        ...(target ? { target } : {}),
        ...(within ? { within } : {}),
        ...opt,
      };
    }
    case "submit": {
      const target = toScriptLocators(step.target);
      const within = toScriptLocators(step.within);
      return {
        action: "pressKey",
        key: "Enter",
        ...(target ? { target } : {}),
        ...(within ? { within } : {}),
        ...opt,
      };
    }
  }
}

function convertCompiledSteps(steps: readonly CompiledStep[]): ScriptStep[] {
  return steps.map((step) => {
    if (step.action === "forEach") {
      return {
        action: "forEach",
        items: step.items,
        steps: convertCompiledSteps(step.steps),
        ...(step.optional !== undefined ? { optional: step.optional } : {}),
      };
    }
    return convertCompiledLeafStep(step);
  });
}

export function compiledWorkflowToActionScript(workflow: CompiledWorkflow): ActionScript {
  return ActionScriptSchema.parse({
    name: workflow.name,
    steps: convertCompiledSteps(workflow.steps),
    pauseBeforeSubmit: workflow.pauseBeforeSubmit,
    runMode: workflow.runMode,
    ...(workflow.params.length > 0 ? { params: workflow.params } : {}),
  });
}

export function compiledWorkflowToFinding(workflow: CompiledWorkflow): Finding {
  const prefix = workflow.kind === "snippet" ? "snip_" : "wf_";
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ name: workflow.name, steps: workflow.steps }))
    .digest("hex")
    .slice(0, 12);
  const id = `${prefix}${hash}`;
  const verdict = workflow.kind === "snippet" ? "rung1" : "rung2";
  return FindingSchema.parse({
    id,
    ...(workflow.kind === "workflow" ? { workflowId: id } : {}),
    verdict,
    title: workflow.name,
    why: workflow.reason,
    whyNotNext: workflow.pauseBeforeSubmit
      ? "Requires user confirmation before final submit."
      : workflow.kind === "snippet"
        ? "Reusable text snippet."
        : "Compiled browser workflow.",
    stats: {
      repetitions: workflow.stats.repetitions,
      minutesPerWeek: workflow.stats.minutesPerWeek,
      stability: 1,
    },
    artifact: {
      kind: workflow.kind === "snippet" ? "snippet" : "playwright",
      path: `/script/${id}`,
      verified: false,
    },
  });
}

function isExactRepetitionOf(
  longer: readonly V2Action[],
  shorter: readonly V2Action[],
): boolean {
  if (longer.length <= shorter.length || shorter.length === 0) return false;
  if (longer.length % shorter.length !== 0) return false;
  for (let i = 0; i < longer.length; i++) {
    if (longer[i] !== shorter[i % shorter.length]) return false;
  }
  return true;
}

function hasAnyPrimaryTarget(cand: PatternCandidate): boolean {
  return cand.instances.some((inst) =>
    inst.steps.some((step) => primaryTargetKey(step) !== undefined),
  );
}

function hasDistinctRepeatingSubtargets(
  longer: PatternCandidate,
  subLen: number,
): boolean {
  if (longer.instances.length < 2 || subLen <= 0) return false;
  if (longer.actions.length % subLen !== 0) return false;
  const k = longer.actions.length / subLen;
  if (k < 2) return false;
  if (!longer.instances.every((inst) => inst.steps.length === longer.actions.length)) {
    return false;
  }

  for (let j = 0; j < subLen; j++) {
    const hasDistinctSubTargets = longer.instances.some((inst) => {
      const seen = new Set<string>();
      for (let m = 0; m < k; m++) {
        const key = primaryTargetKey(inst.steps[m * subLen + j]);
        if (key !== undefined) seen.add(key);
      }
      return seen.size >= 2;
    });
    if (!hasDistinctSubTargets) continue;

    for (let m = 0; m < k; m++) {
      const counts = new Map<string, number>();
      for (const inst of longer.instances) {
        const key = primaryTargetKey(inst.steps[m * subLen + j]);
        if (key === undefined) continue;
        const next = (counts.get(key) ?? 0) + 1;
        if (next >= 2) {
          return true;
        }
        counts.set(key, next);
      }
    }
  }

  return false;
}

function isTrivialRepetitionGrouping(
  longer: PatternCandidate,
  shorter: PatternCandidate,
): boolean {
  if (!isExactRepetitionOf(longer.actions, shorter.actions)) return false;
  if (hasDistinctRepeatingSubtargets(longer, shorter.actions.length)) {
    return false;
  }
  if (!hasAnyPrimaryTarget(longer) && !hasAnyPrimaryTarget(shorter)) {
    return false;
  }
  return true;
}

function candidateCovers(
  other: PatternCandidate,
  cand: PatternCandidate,
): boolean {
  if (other === cand || other.actions.length <= cand.actions.length) return false;

  const otherSteps = new Set<V2Step>();
  for (const oi of other.instances) {
    for (const s of oi.steps) {
      otherSteps.add(s);
    }
  }

  if (otherSteps.size > 0 && cand.instances.every((ci) => ci.steps.length > 0)) {
    let totalSteps = 0;
    let coveredSteps = 0;
    const minPerInstance = Math.max(1, cand.actions.length - 1);
    for (const ci of cand.instances) {
      let instCovered = 0;
      for (const s of ci.steps) {
        if (otherSteps.has(s)) instCovered += 1;
      }
      if (instCovered < minPerInstance) return false;
      totalSteps += ci.steps.length;
      coveredSteps += instCovered;
    }
    return coveredSteps * 5 >= totalSteps * 4;
  }

  return cand.instances.every((ci) =>
    other.instances.some((oi) => ci.startTs >= oi.startTs && ci.endTs <= oi.endTs),
  );
}

export function pickPrimaryCandidate(
  candidates: readonly PatternCandidate[],
  minRepeats = resolveRepeatCount(),
): PatternCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const nonSubsumed = candidates.filter((cand) => {
    const subsumed = candidates.some((other) => {
      if (!candidateCovers(other, cand)) return false;
      if (isTrivialRepetitionGrouping(other, cand)) return false;
      if (
        candidates.some(
          (sup) =>
            sup !== other &&
            sup.actions.length > other.actions.length &&
            candidateCovers(sup, other) &&
            isTrivialRepetitionGrouping(sup, cand),
        )
      ) {
        return false;
      }
      return true;
    });
    return !subsumed;
  });
  const pool = nonSubsumed.length > 0 ? nonSubsumed : candidates;
  const filteredPool = pool.filter(
    (cand) =>
      !pool.some(
        (shorter) =>
          shorter !== cand &&
          isTrivialRepetitionGrouping(cand, shorter),
      ),
  );
  const finalPool = filteredPool.length > 0 ? filteredPool : pool;
  const isTrivialClickPair = (c: PatternCandidate) =>
    c.actions.length <= 2 && c.actions.every((a) => a === "click");
  return [...finalPool].sort(
    (a, b) =>
      (isTrivialClickPair(a) ? 1 : 0) - (isTrivialClickPair(b) ? 1 : 0) ||
      (b.count >= minRepeats ? 1 : 0) - (a.count >= minRepeats ? 1 : 0) ||
      b.count * b.actions.length - a.count * a.actions.length ||
      b.actions.length - a.actions.length ||
      b.count - a.count ||
      a.signature.localeCompare(b.signature),
  )[0];
}

async function runV2ReportForEvents(
  events: Event[],
  options: BuildReportOptions,
): Promise<Finding[]> {
  if (events.length === 0) return [];
  const { steps, piiMap } = eventsToSteps(events);
  const minRepeats = options.minRepeats ?? resolveRepeatCount();
  const candidates = detectRepeatedCandidates(steps, { minRepeats });
  const top = pickPrimaryCandidate(candidates, minRepeats);
  if (!top) return [];

  if (options.llm === false) {
    const idHash = crypto
      .createHash("sha256")
      .update(top.signature)
      .digest("hex")
      .slice(0, 12);
    const id = `wf_${idHash}`;
    return [
      FindingSchema.parse({
        id,
        workflowId: id,
        verdict: "rung0",
        title: `Repeated workflow (${top.actions.join(" -> ")})`,
        why: `Observed ${top.count} repetitions across ${top.apps.join(", ") || "browser"}.`,
        whyNotNext: "LLM compilation disabled.",
        stats: {
          repetitions: top.count,
          minutesPerWeek: 0,
          stability: 1,
        },
      }),
    ];
  }

  let compiled: CompiledWorkflow | null = null;
  try {
    compiled = await compileWorkflow(
      { events, steps, piiMap, repeatCount: top.count },
      { gemini: options.gemini, iris: options.iris },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[v2/report] compileWorkflow failed: ${message}`);
    return [];
  }
  if (!compiled) return [];

  const finding = compiledWorkflowToFinding(compiled);
  const script = compiledWorkflowToActionScript(compiled);
  options.scriptStore?.set(finding.id, script);
  options.compiledStore?.set(finding.id, compiled);
  return [finding];
}

export async function buildReport(
  session: string,
  events: Event[] = [],
  opts?: string | BuildReportOptions,
): Promise<Report> {
  const options: BuildReportOptions =
    typeof opts === "string" ? { dataDir: opts } : (opts ?? {});
  const pipeline = resolvePipeline(options.pipeline);
  if (pipeline === "v2") {
    const findings = await runV2ReportForEvents(events, options);
    return ReportSchema.parse({
      generatedAt: Date.now(),
      session,
      findings,
    });
  }
  const steps = normalize(events);
  const findings = await runPipeline(steps, {
    llm: options.llm ?? true,
    events,
    gemini: options.gemini,
    implement: options.implement,
    dataDir: options.dataDir,
    scriptStore: options.scriptStore,
  });
  return ReportSchema.parse({
    generatedAt: Date.now(),
    session,
    findings,
  });
}

export async function buildCombinedReport(
  sessionEvents: Event[][],
  opts?: string | BuildReportOptions,
): Promise<Report> {
  const options: BuildReportOptions =
    typeof opts === "string" ? { dataDir: opts } : (opts ?? {});
  const pipeline = resolvePipeline(options.pipeline);
  const findingIndexById = new Map<string, number>();
  const findings: Finding[] = [];

  if (pipeline === "v2") {
    const streams = mergeWithinSession(sessionEvents);
    for (const stream of streams) {
      const streamFindings = await runV2ReportForEvents(stream.events, options);
      for (const finding of streamFindings) {
        const existingIndex = findingIndexById.get(finding.id);
        if (existingIndex === undefined) {
          findingIndexById.set(finding.id, findings.length);
          findings.push(finding);
        } else if (
          finding.stats.repetitions > findings[existingIndex].stats.repetitions
        ) {
          findings[existingIndex] = finding;
        }
      }
    }
    return ReportSchema.parse({
      generatedAt: Date.now(),
      session: "all",
      findings,
    });
  }

  const mergedStreams = mergeSessions(
    sessionEvents,
    options.gapMs !== undefined ? { gapMs: options.gapMs } : undefined,
  );

  for (const stream of mergedStreams) {
    const steps = normalize(stream.events);
    const streamFindings = await runPipeline(steps, {
      llm: options.llm ?? true,
      events: stream.events,
      gemini: options.gemini,
      implement: options.implement,
      dataDir: options.dataDir,
      scriptStore: options.scriptStore,
    });
    for (const finding of streamFindings) {
      const existingIndex = findingIndexById.get(finding.id);
      if (existingIndex === undefined) {
        findingIndexById.set(finding.id, findings.length);
        findings.push(finding);
      } else if (
        finding.stats.repetitions > findings[existingIndex].stats.repetitions
      ) {
        findings[existingIndex] = finding;
      }
    }
  }

  return ReportSchema.parse({
    generatedAt: Date.now(),
    session: "all",
    findings,
  });
}
