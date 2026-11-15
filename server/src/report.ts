import crypto from "node:crypto";
import type { Event, Finding, Locator, Report } from "@gen/shared";
import {
  ActionScriptSchema,
  FindingSchema,
  ReportSchema,
  type ScriptLocator,
  type ScriptStep,
} from "@gen/shared/schema.ts";
import type { ActionScript } from "./hands/types.ts";
import type { GeminiClient, GeminiClientOptions } from "./llm/gemini.ts";
import type { IrisJudgeOptions } from "./llm/iris.ts";
import { mergeWithinSession } from "./merge-sessions.ts";
import {
  buildMeaningfulWindow,
  compileWorkflow,
  eventsToSteps,
  type CompiledLeafStep,
  type CompiledStep,
  type CompiledWorkflow,
  type IrisWorkflowJudge,
} from "./v2/index.ts";

export interface BuildReportOptions {
  dataDir?: string;
  llm?: boolean;
  gemini?: GeminiClient | GeminiClientOptions;
  iris?: IrisJudgeOptions | IrisWorkflowJudge;
  scriptStore?: Map<string, ActionScript>;
  compiledStore?: Map<string, CompiledWorkflow>;
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

async function runV2ReportForEvents(
  events: Event[],
  options: BuildReportOptions,
): Promise<Finding[]> {
  if (events.length === 0) return [];
  const { steps, piiMap } = eventsToSteps(events);
  const window = buildMeaningfulWindow(steps, events);
  if (window.meaningfulCount < 2) return [];

  if (options.llm === false) {
    const actions = window.steps.map((s) => s.action);
    const apps = Array.from(
      new Set(window.steps.map((s) => s.host).filter((h) => h.length > 0)),
    );
    const idHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(window.steps))
      .digest("hex")
      .slice(0, 12);
    const id = `wf_${idHash}`;
    return [
      FindingSchema.parse({
        id,
        workflowId: id,
        verdict: "rung0",
        title: `Observed workflow (${actions.slice(0, 6).join(" -> ")})`,
        why: `Observed ${window.meaningfulCount} meaningful steps across ${apps.join(", ") || "browser"}.`,
        whyNotNext: "LLM compilation disabled.",
        stats: {
          repetitions: 1,
          minutesPerWeek: 0,
          stability: 1,
        },
      }),
    ];
  }

  let compiled: CompiledWorkflow | null = null;
  try {
    compiled = await compileWorkflow(
      { events, steps, piiMap },
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
  const findings = await runV2ReportForEvents(events, options);
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
  const findingIndexById = new Map<string, number>();
  const findings: Finding[] = [];

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
