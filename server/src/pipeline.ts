import type { Event, Finding, Step, Verdict, Workflow } from "@gen/shared";
import { writeSnippetArtifact } from "./artifacts.ts";
import {
  buildDigest,
  decideSecond,
  type DecideSecondOptions,
  type SecondDecision,
  type WorkflowDigest,
} from "./decide/second.ts";
import {
  DEFAULT_STATS_CONFIG,
  decideStats,
  type Candidate,
} from "./decide/stats.ts";
import { detectSharedEdgesWithText } from "./detect/shared-edges.ts";
import { detectShortValues } from "./detect/short-values.ts";
import { detectSnippetsWithText, type SnippetFinding } from "./detect/snippet.ts";
import { detectWorkflows, exactStepKey } from "./detect/workflow.ts";
import { implementSolution } from "./hands/implementor.ts";
import { ActionScriptSchema, type ActionScript } from "./hands/types.ts";
import { matchLibrary } from "./library.ts";
import type { GeminiClient, GeminiClientOptions } from "./llm/gemini.ts";

export type PipelineConfig = {
  minBigramShare: number;
  confidenceThreshold: number;
  llmTimeoutMs: number;
  implementTimeoutMs: number;
  safetyWords: readonly string[];
};

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  minBigramShare: 0.5,
  confidenceThreshold: 0.6,
  llmTimeoutMs: 12_000,
  implementTimeoutMs: 60_000,
  safetyWords: [
    "send",
    "pay",
    "payment",
    "delete",
    "remove",
    "transfer",
    "purchase",
    "confirm order",
  ],
};

export type PipelineOptions = {
  llm: boolean;
  events?: Event[];
  gemini?: GeminiClient | GeminiClientOptions;
  decideSecond?: (
    digest: WorkflowDigest,
    opts?: DecideSecondOptions,
  ) => Promise<SecondDecision | null>;
  implement?: (solution: string, opts?: { name?: string }) => Promise<ActionScript>;
  dataDir?: string;
  scriptStore?: Map<string, ActionScript>;
  config?: Partial<PipelineConfig>;
};

export type SafetyCheckResult =
  | { safe: true }
  | {
      safe: false;
      stepIndex: number;
      step: Step;
      matchedWord: string;
      matchedText: string;
    };

export const generatedScripts = new Map<string, ActionScript>();

const INCLUDED_EVENT_TYPES = new Set<Event["type"]>([
  "click",
  "input",
  "change",
  "paste",
  "copy",
  "nav",
  "submit",
]);

const SHORTCUT_RE =
  /\s+(?:F(?:[1-9]|1[0-2])|(?:(?:Ctrl|Alt|Shift|Cmd|Meta)\+)+[A-Za-z0-9]+)$/i;

const DEFAULT_RANKS: Record<NonNullable<Step["target"]>[number]["kind"], number> = {
  testid: 0,
  aria: 1,
  text: 2,
  css: 3,
  uia: 4,
};

const GRID_RANKS: Record<NonNullable<Step["target"]>[number]["kind"], number> = {
  css: 0,
  testid: 1,
  aria: 2,
  text: 3,
  uia: 4,
};

function eventTargetKey(target?: Event["target"]): string {
  if (!target || target.locators.length === 0) return "";
  const isGrid =
    target.role === "gridcell" || target.tag?.toLowerCase() === "td";
  const ranks = isGrid ? GRID_RANKS : DEFAULT_RANKS;
  const sorted = target.locators
    .map((loc) => {
      if (loc.kind === "text" || loc.kind === "aria") {
        return { ...loc, value: loc.value.replace(SHORTCUT_RE, "") };
      }
      return { ...loc };
    })
    .sort((a, b) => ranks[a.kind] - ranks[b.kind]);
  return `${sorted[0].kind}:${sorted[0].value}`;
}

type EventStepMapping = {
  aligned: boolean;
  stepMeta: Array<{ startTs?: number; endTs?: number; app?: string; label?: string }>;
  stepIndexByEvent: Map<number, number>;
  labelsByStepKey: Map<string, string[]>;
};

function mapEventsToSteps(steps: Step[], events?: Event[]): EventStepMapping {
  const labelsByStepKey = new Map<string, string[]>();
  const stepIndexByEvent = new Map<number, number>();

  if (!events || events.length === 0) {
    return {
      aligned: false,
      stepMeta: steps.map((s) => {
        const ts = (s as { ts?: number }).ts;
        return typeof ts === "number" ? { startTs: ts, endTs: ts } : {};
      }),
      stepIndexByEvent,
      labelsByStepKey,
    };
  }

  for (const ev of events) {
    if ((ev.type === "click" || ev.type === "submit") && ev.target?.label) {
      const key = `${ev.type}:${eventTargetKey(ev.target)}`;
      const existing = labelsByStepKey.get(key) ?? [];
      existing.push(ev.target.label);
      labelsByStepKey.set(key, existing);
    }
  }

  const collapsed: Array<{
    action: Step["action"];
    startTs: number;
    endTs: number;
    app: string;
    label?: string;
    lastValue?: string;
  }> = [];
  let lastKey = "";

  for (let evIdx = 0; evIdx < events.length; evIdx++) {
    const ev = events[evIdx];
    if (!INCLUDED_EVENT_TYPES.has(ev.type)) continue;

    if (ev.type === "input") {
      const key = eventTargetKey(ev.target);
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.action === "fill" && lastKey === key) {
        prev.endTs = ev.ts;
        prev.lastValue = ev.value ?? "";
        stepIndexByEvent.set(evIdx, collapsed.length - 1);
      } else {
        collapsed.push({
          action: "fill",
          startTs: ev.ts,
          endTs: ev.ts,
          app: ev.app,
          label: ev.target?.label,
          lastValue: ev.value ?? "",
        });
        stepIndexByEvent.set(evIdx, collapsed.length - 1);
      }
      lastKey = key;
    } else if (ev.type === "change") {
      const key = eventTargetKey(ev.target);
      const prev = collapsed[collapsed.length - 1];
      if (
        prev &&
        prev.action === "fill" &&
        lastKey === key &&
        prev.lastValue === (ev.value ?? "")
      ) {
        prev.endTs = ev.ts;
        stepIndexByEvent.set(evIdx, collapsed.length - 1);
      } else {
        collapsed.push({
          action: "fill",
          startTs: ev.ts,
          endTs: ev.ts,
          app: ev.app,
          label: ev.target?.label,
          lastValue: ev.value ?? "",
        });
        stepIndexByEvent.set(evIdx, collapsed.length - 1);
      }
      lastKey = key;
    } else if (ev.type === "nav") {
      collapsed.push({
        action: "nav",
        startTs: ev.ts,
        endTs: ev.ts,
        app: ev.app,
      });
      stepIndexByEvent.set(evIdx, collapsed.length - 1);
      lastKey = "";
    } else if (
      ev.type === "click" ||
      ev.type === "submit" ||
      ev.type === "paste" ||
      ev.type === "copy"
    ) {
      collapsed.push({
        action: ev.type,
        startTs: ev.ts,
        endTs: ev.ts,
        app: ev.app,
        label: ev.target?.label,
      });
      stepIndexByEvent.set(evIdx, collapsed.length - 1);
      lastKey = eventTargetKey(ev.target);
    }
  }

  const aligned = collapsed.length === steps.length;
  const stepMeta = steps.map((s, idx) => {
    const inlineTs = (s as { ts?: number }).ts;
    const fromCollapsed = aligned ? collapsed[idx] : undefined;
    return {
      startTs: typeof inlineTs === "number" ? inlineTs : fromCollapsed?.startTs,
      endTs: typeof inlineTs === "number" ? inlineTs : fromCollapsed?.endTs,
      app: fromCollapsed?.app,
      label: fromCollapsed?.label,
    };
  });

  return {
    aligned,
    stepMeta,
    stepIndexByEvent,
    labelsByStepKey,
  };
}

type IndexedStep = {
  step: Step;
  origIdx: number;
  key: string;
  startTs?: number;
  endTs?: number;
};

const SEQUENCE_GAP_MS = 30_000;

function splitIntoSequences(
  items: IndexedStep[],
): IndexedStep[][] {
  const initialSeqs: IndexedStep[][] = [];
  let current: IndexedStep[] = [];

  const flush = () => {
    if (current.length > 0) {
      initialSeqs.push(current);
      current = [];
    }
  };

  for (const item of items) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const prevTs = prev.endTs ?? prev.startTs;
      const currTs = item.startTs ?? item.endTs;
      if (
        typeof prevTs === "number" &&
        typeof currTs === "number" &&
        currTs - prevTs >= SEQUENCE_GAP_MS
      ) {
        flush();
      }
    }

    if (item.step.action === "nav") {
      flush();
      continue;
    }

    if (item.step.action === "submit") {
      current.push(item);
      flush();
      continue;
    }

    current.push(item);
  }
  flush();

  const afterLoopSplit: IndexedStep[][] = [];
  for (const seq of initialSeqs) {
    if (seq.length === 0) continue;
    const hasSubmit = seq.some((s) => s.step.action === "submit");
    if (!hasSubmit) {
      const firstKey = seq[0].key;
      const splitIndices: number[] = [0];
      for (let i = 1; i < seq.length; i++) {
        if (
          seq[i].key === firstKey &&
          i - splitIndices[splitIndices.length - 1] >= 2
        ) {
          splitIndices.push(i);
        }
      }

      if (splitIndices.length >= 2) {
        for (let k = 0; k < splitIndices.length; k++) {
          const start = splitIndices[k];
          const end =
            k + 1 < splitIndices.length ? splitIndices[k + 1] : seq.length;
          afterLoopSplit.push(seq.slice(start, end));
        }
        continue;
      }
    }
    afterLoopSplit.push(seq);
  }

  return afterLoopSplit;
}

const ROW_SUFFIX_RE = /(?:-\d+|_\d+)(?=(?:["']\])?$)/;

function stripRowSuffix(value: string): string {
  return value.replace(ROW_SUFFIX_RE, "");
}

function normalizedStepKey(step: Step): string {
  const kind = step.target?.[0]?.kind ?? "";
  const val = step.target?.[0]?.value ?? "";
  return `${step.action}:${kind}:${stripRowSuffix(val)}`;
}

function computeRowNormalizedStepKeys(steps: Step[]): {
  keys: string[];
  isRowIndexed: boolean[];
} {
  const rawKeys = steps.map(exactStepKey);
  const normKeys = steps.map(normalizedStepKey);
  const rawKeyCounts = new Map<string, number>();
  const distinctRawByNormKey = new Map<string, Set<string>>();

  for (let i = 0; i < steps.length; i++) {
    const rawKey = rawKeys[i];
    const normKey = normKeys[i];
    rawKeyCounts.set(rawKey, (rawKeyCounts.get(rawKey) ?? 0) + 1);
    let set = distinctRawByNormKey.get(normKey);
    if (!set) {
      set = new Set<string>();
      distinctRawByNormKey.set(normKey, set);
    }
    set.add(rawKey);
  }

  const keys: string[] = [];
  const isRowIndexed: boolean[] = [];
  for (let i = 0; i < steps.length; i++) {
    const rawKey = rawKeys[i];
    const normKey = normKeys[i];
    const rowIndexed =
      normKey !== rawKey &&
      (rawKeyCounts.get(rawKey) ?? 0) < 2 &&
      (distinctRawByNormKey.get(normKey)?.size ?? 0) >= 2;
    isRowIndexed.push(rowIndexed);
    keys.push(rowIndexed ? normKey : rawKey);
  }

  return { keys, isRowIndexed };
}

function normalizeRowIndexedStepsForDetect(steps: Step[]): {
  stepsForDetect: Step[];
  originalTargetsByNormKey: Map<string, Step["target"]>;
} {
  const { keys, isRowIndexed } = computeRowNormalizedStepKeys(steps);
  const originalTargetsByNormKey = new Map<string, Step["target"]>();
  const stepsForDetect = steps.map((step, i) => {
    if (!isRowIndexed[i] || !step.target) return step;
    if (!originalTargetsByNormKey.has(keys[i])) {
      originalTargetsByNormKey.set(keys[i], step.target);
    }
    return {
      ...step,
      target: step.target.map((loc) => ({
        ...loc,
        value: stripRowSuffix(loc.value),
      })),
    };
  });
  return { stepsForDetect, originalTargetsByNormKey };
}

function restoreRowIndexedTargets(
  candidate: Candidate,
  originalTargetsByNormKey: Map<string, Step["target"]>,
): Candidate {
  if (originalTargetsByNormKey.size === 0) return candidate;
  const restoredSteps = candidate.workflow.steps.map((step) => {
    const origTarget = originalTargetsByNormKey.get(exactStepKey(step));
    return origTarget ? { ...step, target: origTarget } : step;
  });
  return {
    ...candidate,
    workflow: {
      ...candidate.workflow,
      steps: restoredSteps,
    },
  };
}

export function filterNoisySteps(
  steps: Step[],
  opts?: {
    events?: Event[];
    minBigramShare?: number;
  },
): { filteredSteps: Step[]; filteredEvents?: Event[] } {
  const minBigramShare =
    opts?.minBigramShare ?? DEFAULT_PIPELINE_CONFIG.minBigramShare;
  if (steps.length === 0) {
    return { filteredSteps: steps, filteredEvents: opts?.events };
  }

  const mapping = mapEventsToSteps(steps, opts?.events);
  const { keys } = computeRowNormalizedStepKeys(steps);
  const indexed: IndexedStep[] = steps.map((step, origIdx) => ({
    step,
    origIdx,
    key: keys[origIdx],
    startTs: mapping.stepMeta[origIdx]?.startTs,
    endTs: mapping.stepMeta[origIdx]?.endTs,
  }));

  const sequences = splitIntoSequences(indexed);
  if (sequences.length < 2) {
    return { filteredSteps: steps, filteredEvents: opts?.events };
  }

  const bigramSeqCount = new Map<string, number>();
  for (const seq of sequences) {
    const seenInSeq = new Set<string>();
    for (let i = 0; i < seq.length - 1; i++) {
      const bigram = `${seq[i].key}=>${seq[i + 1].key}`;
      if (!seenInSeq.has(bigram)) {
        seenInSeq.add(bigram);
        bigramSeqCount.set(bigram, (bigramSeqCount.get(bigram) ?? 0) + 1);
      }
    }
  }

  const seqCount = sequences.length;
  const keptIndices = new Set<number>();

  for (const seq of sequences) {
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].step.action === "copy" || seq[i].step.action === "paste") {
        keptIndices.add(seq[i].origIdx);
        continue;
      }
      const hasValidPrev =
        i > 0 &&
        (bigramSeqCount.get(`${seq[i - 1].key}=>${seq[i].key}`) ?? 0) / seqCount >=
          minBigramShare;
      const hasValidNext =
        i < seq.length - 1 &&
        (bigramSeqCount.get(`${seq[i].key}=>${seq[i + 1].key}`) ?? 0) / seqCount >=
          minBigramShare;
      if (hasValidPrev || hasValidNext) {
        keptIndices.add(seq[i].origIdx);
      }
    }
  }

  const filteredSteps = steps.filter((_, idx) => keptIndices.has(idx));
  let filteredEvents: Event[] | undefined;
  if (opts?.events && mapping.aligned) {
    filteredEvents = opts.events.filter((_, evIdx) => {
      const stepIdx = mapping.stepIndexByEvent.get(evIdx);
      return stepIdx !== undefined && keptIndices.has(stepIdx);
    });
  }

  return { filteredSteps, filteredEvents };
}

function normalizeForSafetyMatch(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findMatchedSafetyWord(
  rawText: string,
  safetyWords: readonly string[],
): string | null {
  const normalized = normalizeForSafetyMatch(rawText);
  if (!normalized) return null;

  const padded = ` ${normalized} `;
  for (const word of safetyWords) {
    const normWord = normalizeForSafetyMatch(word);
    if (!normWord) continue;
    if (padded.includes(` ${normWord} `)) {
      return word;
    }
  }
  return null;
}

export function checkCandidateSafety(
  candidate: Candidate,
  safetyWords: readonly string[] = DEFAULT_PIPELINE_CONFIG.safetyWords,
  labelsByStepKey?: Map<string, string[]>,
): SafetyCheckResult {
  const steps = candidate.workflow.steps;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.action !== "click" && step.action !== "submit") {
      continue;
    }

    const candidatesToCheck: string[] = [];
    for (const loc of step.target ?? []) {
      candidatesToCheck.push(loc.value);
    }

    const inlineLabel = (step as Step & { label?: string }).label;
    if (typeof inlineLabel === "string" && inlineLabel.trim().length > 0) {
      candidatesToCheck.push(inlineLabel);
    }

    if (labelsByStepKey) {
      const mappedLabels = labelsByStepKey.get(exactStepKey(step));
      if (mappedLabels) {
        candidatesToCheck.push(...mappedLabels);
      }
    }

    for (const text of candidatesToCheck) {
      const matchedWord = findMatchedSafetyWord(text, safetyWords);
      if (matchedWord) {
        return {
          safe: false,
          stepIndex: i,
          step,
          matchedWord,
          matchedText: text,
        };
      }
    }
  }

  return { safe: true };
}

export function describeCandidate(candidate: Candidate): string {
  const { workflow } = candidate;
  const steps = workflow.steps;
  const srcHost = workflow.sourceApp;
  const destHost = workflow.destApp;

  if (
    steps.length === 1 &&
    (steps[0].action === "fill" || steps[0].action === "paste") &&
    typeof steps[0].value === "string"
  ) {
    const collapsed = steps[0].value.replace(/\s+/g, " ").trim();
    if (collapsed.length > 0) {
      const preview =
        collapsed.length > 40 ? `${collapsed.slice(0, 40)}...` : collapsed;
      return `Insert reply: "${preview}"`;
    }
  }

  const readSteps = steps.filter((s) => s.action === "copy");
  const fillSteps = steps.filter(
    (s) => s.action === "fill" || s.action === "paste",
  );
  if (
    srcHost &&
    destHost &&
    srcHost !== destHost &&
    readSteps.length > 0 &&
    fillSteps.length > 0
  ) {
    const fieldCount = Math.min(readSteps.length, fillSteps.length);
    return `Copy ${fieldCount} ${fieldCount === 1 ? "field" : "fields"} from ${srcHost} to ${destHost}`;
  }

  if (steps.length > 0 && steps.every((s) => s.action === "click")) {
    const host = destHost || srcHost || "browser";
    const count = steps.length;
    return `Click ${count} ${count === 1 ? "item" : "items"} on ${host}`;
  }

  return workflow.name;
}

const SOLUTION_LOCATOR_PRIORITY: Record<string, number> = {
  testid: 0,
  css: 1,
  xpath: 2,
  text: 3,
  aria: 4,
  uia: 5,
};

function pickBestLocator(
  target?: Step["target"],
): NonNullable<Step["target"]>[number] | undefined {
  if (!target || target.length === 0) return undefined;
  if (target[0].kind === "testid" || target[0].kind === "css") {
    return target[0];
  }
  let best = target[0];
  let bestRank = SOLUTION_LOCATOR_PRIORITY[best.kind] ?? 99;
  for (let i = 1; i < target.length; i++) {
    const loc = target[i];
    const rank = SOLUTION_LOCATOR_PRIORITY[loc.kind] ?? 99;
    if (rank < bestRank) {
      best = loc;
      bestRank = rank;
    }
  }
  return best;
}

export function buildSolutionText(
  verdict: Verdict,
  workflow: Workflow,
  snippetText?: string,
): string | null {
  if (verdict === "rung1") {
    if (typeof snippetText === "string" && snippetText.trim().length > 0) {
      return `Insert the following text into the focused field:\n\n${snippetText}`;
    }
    return null;
  }

  if (verdict === "rung2") {
    const paramExampleByName = new Map<string, string>();
    for (const p of workflow.params ?? []) {
      if (typeof p.example === "string" && p.example.trim().length > 0) {
        paramExampleByName.set(p.name, p.example);
      }
    }

    const copiedParams = new Set<string>();
    const isCrossHost = Boolean(
      workflow.sourceApp &&
        workflow.destApp &&
        workflow.sourceApp !== workflow.destApp,
    );
    const hasCopySteps = workflow.steps.some((s) => s.action === "copy");
    let sawCopy = false;
    let insertedSwitchTab = false;
    const rawLines: string[] = [];

    if (workflow.sourceApp && (hasCopySteps || isCrossHost)) {
      rawLines.push(`switchTab host="${workflow.sourceApp}"`);
    }

    for (const step of workflow.steps) {
      if (
        isCrossHost &&
        !insertedSwitchTab &&
        sawCopy &&
        (copiedParams.size > 0 || hasCopySteps) &&
        (step.action === "fill" ||
          step.action === "paste" ||
          step.action === "click")
      ) {
        rawLines.push(`switchTab host="${workflow.destApp}"`);
        insertedSwitchTab = true;
      }

      const loc = pickBestLocator(step.target);
      const targetDesc = loc ? `${loc.kind}="${loc.value}"` : "focused element";

      if (step.action === "copy") {
        sawCopy = true;
        if (step.value !== undefined && typeof step.value === "object") {
          const { param } = step.value;
          copiedParams.add(param);
          rawLines.push(`readText from ${targetDesc} into "{{${param}}}"`);
          continue;
        }
      }

      if (
        (step.action === "fill" || step.action === "paste") &&
        step.value !== undefined &&
        typeof step.value === "object"
      ) {
        const { param } = step.value;
        if (copiedParams.has(param)) {
          rawLines.push(`fill ${targetDesc} with "{{${param}}}"`);
        } else {
          const example = paramExampleByName.get(param);
          if (example) {
            rawLines.push(`${step.action} ${targetDesc} with "${example}"`);
          } else {
            rawLines.push(`${step.action} ${targetDesc} with {${param}}`);
          }
        }
        continue;
      }

      const valDesc =
        step.value === undefined
          ? ""
          : typeof step.value === "string"
            ? ` with "${step.value}"`
            : copiedParams.has(step.value.param)
              ? ` with "{{${step.value.param}}}"`
              : paramExampleByName.has(step.value.param)
                ? ` with "${paramExampleByName.get(step.value.param)}"`
                : ` with {${step.value.param}}`;
      rawLines.push(`${step.action} ${targetDesc}${valDesc}`);
    }

    const lines = rawLines.map((line, idx) => `${idx + 1}. ${line}`);
    const header = isCrossHost
      ? `Read values on ${workflow.sourceApp}, switch to ${workflow.destApp}, and fill on ${workflow.destApp}:`
      : `Execute the workflow "${workflow.name}" on ${workflow.destApp}:`;
    return `${header}\n${lines.join("\n")}`;
  }

  return null;
}

type PipelineItem = {
  kind: "workflow" | "snippet" | "short";
  candidate: Candidate;
  baseFinding?: Finding;
  snippetText?: string;
  statsConfig?: typeof DEFAULT_STATS_CONFIG;
};

function resolvePrimaryApp(events?: Event[]): string {
  const nonNav = events?.find((e) => e.type !== "nav");
  return nonNav?.app ?? events?.[0]?.app ?? "browser";
}

function snippetToCandidate(
  item: SnippetFinding,
  app: string,
): Candidate {
  const { finding, text } = item;
  return {
    workflow: {
      id: finding.id,
      name: finding.title,
      sourceApp: app,
      destApp: app,
      steps: [{ action: "fill", value: text }],
      params: [],
      instances: [],
    },
    repetitions: finding.stats.repetitions,
    minutesPerWeek: finding.stats.minutesPerWeek,
    stability: finding.stats.stability,
  };
}

function shortValueToCandidate(finding: Finding, app: string): Candidate {
  const charMatch = /(\d+)-character/.exec(finding.why);
  const charLen = charMatch ? Number(charMatch[1]) : 10;
  const placeholder = "x".repeat(Math.max(1, charLen));
  return {
    workflow: {
      id: finding.id,
      name: finding.title,
      sourceApp: app,
      destApp: app,
      steps: [{ action: "fill", value: placeholder }],
      params: [],
      instances: [],
    },
    repetitions: finding.stats.repetitions,
    minutesPerWeek: finding.stats.minutesPerWeek,
    stability: finding.stats.stability,
  };
}

function buildWorkflowWhy(
  verdict: Verdict,
  candidate: Candidate,
  secondDecision: { risky: boolean; name: string } | null,
): { why: string; whyNotNext: string } {
  const reps = candidate.repetitions;
  const stepCount = candidate.workflow.steps.length;
  const stabilityPct = Math.round(candidate.stability * 100);

  if (secondDecision?.risky) {
    return {
      why: `Planner flagged "${secondDecision.name}" as risky to automate (${reps} repetitions, ${stabilityPct}% stability).`,
      whyNotNext: "Risky workflows must not be automated without explicit review.",
    };
  }

  switch (verdict) {
    case "rung2":
      return {
        why: `Observed ${reps} repetitions of a ${stepCount}-step workflow with ${stabilityPct}% stability.`,
        whyNotNext:
          "Steps and locators are deterministic across runs, so a compiled ActionScript is faster and cheaper than an agent.",
      };
    case "rung3":
      return {
        why: `Observed ${reps} repetitions of a ${stepCount}-step workflow requiring higher-level decision making.`,
        whyNotNext:
          "An agentic runner can handle branching that a static script cannot.",
      };
    case "rung1":
      return {
        why: `Observed ${reps} repetitions of a single text entry pattern.`,
        whyNotNext: "A reusable snippet is safer and faster than a full UI script.",
      };
    case "rung0":
      return {
        why: `Observed ${reps} repetitions across ${stepCount} steps, below automation threshold.`,
        whyNotNext: "Not enough repetition or time saved yet to justify automating.",
      };
    case "do_not_automate":
      return {
        why: `Repetitions (${reps}) or stability (${candidate.stability}) is too low for safe automation.`,
        whyNotNext: "Workflow is not stable enough for deterministic automation.",
      };
  }
}

export async function runPipeline(
  steps: Step[],
  opts: PipelineOptions = { llm: true },
): Promise<Finding[]> {
  const config: PipelineConfig = {
    ...DEFAULT_PIPELINE_CONFIG,
    ...opts.config,
  };
  const scriptStore = opts.scriptStore ?? generatedScripts;
  const decideSecondFn = opts.decideSecond ?? decideSecond;
  const implementFn =
    opts.implement ??
    ((solution: string, o?: { name?: string }) => {
      if (opts.gemini && "generateJson" in opts.gemini) {
        const geminiClient = opts.gemini;
        return implementSolution(solution, {
          ...o,
          generate: ({ systemInstruction, prompt, responseSchema }) => {
            const fullPrompt = [
              systemInstruction,
              "",
              "Output JSON strictly matching this JSON Schema:",
              JSON.stringify(responseSchema),
              "",
              prompt,
            ].join("\n");
            return geminiClient.generateJson(fullPrompt, ActionScriptSchema);
          },
        });
      }
      return implementSolution(solution, {
        ...o,
        gemini: {
          ...(typeof opts.gemini === "object" && opts.gemini !== null
            ? opts.gemini
            : {}),
          thinkingBudget: 0,
        },
      });
    });

  const mapping = mapEventsToSteps(steps, opts.events);
  const primaryApp = resolvePrimaryApp(opts.events);

  const { filteredSteps, filteredEvents } = filterNoisySteps(steps, {
    events: opts.events,
    minBigramShare: config.minBigramShare,
  });

  const { stepsForDetect, originalTargetsByNormKey } =
    normalizeRowIndexedStepsForDetect(filteredSteps);

  const workflowCandidates = detectWorkflows(stepsForDetect, {
    events: filteredEvents,
  }).map((candidate) =>
    restoreRowIndexedTargets(candidate, originalTargetsByNormKey),
  );
  const snippetFindings = detectSnippetsWithText(steps);
  const sharedEdgeFindings = detectSharedEdgesWithText(steps);
  const shortValueFindings = detectShortValues(steps, opts.events);

  const items: PipelineItem[] = [];
  const seenIds = new Set<string>();

  for (const wfCandidate of workflowCandidates) {
    if (seenIds.has(wfCandidate.workflow.id)) continue;
    seenIds.add(wfCandidate.workflow.id);
    items.push({ kind: "workflow", candidate: wfCandidate });
  }

  for (const snip of [...snippetFindings, ...sharedEdgeFindings]) {
    if (seenIds.has(snip.finding.id)) continue;
    seenIds.add(snip.finding.id);
    items.push({
      kind: "snippet",
      candidate: snippetToCandidate(snip, primaryApp),
      baseFinding: snip.finding,
      snippetText: snip.text,
    });
  }

  for (const shortFinding of shortValueFindings) {
    if (seenIds.has(shortFinding.id)) continue;
    seenIds.add(shortFinding.id);
    items.push({
      kind: "short",
      candidate: shortValueToCandidate(shortFinding, primaryApp),
      baseFinding: shortFinding,
      statsConfig: { ...DEFAULT_STATS_CONFIG, minCharsSaved: 10 },
    });
  }

  const results: Finding[] = [];

  for (const item of items) {
    const { candidate } = item;
    const statsDecision = decideStats(candidate, item.statsConfig);

    // Safety check on every candidate, before any planner, on every path
    const safety = checkCandidateSafety(
      candidate,
      config.safetyWords,
      mapping.labelsByStepKey,
    );

    let verdict: Verdict;
    let title =
      item.kind === "short"
        ? (item.baseFinding?.title ?? candidate.workflow.name)
        : describeCandidate(candidate);
    let why = item.baseFinding?.why ?? "";
    let whyNotNext = item.baseFinding?.whyNotNext ?? "";

    if (!safety.safe) {
      verdict = "do_not_automate";
      why = `Safety check blocked automation: step ${safety.stepIndex + 1} (${safety.step.action} "${safety.matchedText}") matches risky action "${safety.matchedWord}".`;
      whyNotNext = `Steps that click or submit irreversible actions (${safety.matchedWord}) must not be automated.`;
    } else {
      verdict = statsDecision.verdict;
      let secondDecision: SecondDecision | null = null;
      let effectiveRisky = false;

      if (statsDecision.confidence < config.confidenceThreshold && opts.llm) {
        const decideStartedAt = Date.now();
        try {
          secondDecision = await decideSecondFn(
            buildDigest(candidate, statsDecision.features),
            {
              gemini: opts.gemini,
              timeoutMs: config.llmTimeoutMs,
            },
          );
        } catch {
          secondDecision = null;
        }
        console.log(
          `[pipeline] decideSecond id=${candidate.workflow.id} ms=${Date.now() - decideStartedAt} verdict=${secondDecision?.level ?? "null"}`,
        );

        if (secondDecision) {
          const isSnippetOnly =
            (item.kind === "snippet" || item.kind === "short") &&
            !candidate.workflow.steps.some(
              (s) => s.action === "click" || s.action === "submit",
            );
          effectiveRisky = isSnippetOnly ? false : secondDecision.risky;
          verdict = effectiveRisky ? "do_not_automate" : secondDecision.level;
          if (item.kind !== "short" && secondDecision.name) {
            title = secondDecision.name;
          }
        }
      }

      if (item.kind === "workflow" || verdict !== item.baseFinding?.verdict) {
        const effectiveDecision =
          secondDecision !== null
            ? {
                risky: effectiveRisky,
                name: secondDecision.name ?? title,
              }
            : null;
        const reasons = buildWorkflowWhy(verdict, candidate, effectiveDecision);
        why = reasons.why;
        whyNotNext = reasons.whyNotNext;
      }
    }

    let finding: Finding = {
      id: candidate.workflow.id,
      ...(item.kind === "workflow" ? { workflowId: candidate.workflow.id } : {}),
      verdict,
      title,
      why,
      whyNotNext,
      stats: {
        repetitions: Math.max(0, Math.round(candidate.repetitions)),
        minutesPerWeek: Math.max(0, candidate.minutesPerWeek),
        stability: Math.min(1, Math.max(0, candidate.stability)),
      },
      ...(item.baseFinding?.artifact && verdict === "rung1"
        ? { artifact: item.baseFinding.artifact }
        : {}),
    };

    if (verdict === "rung1" || verdict === "rung2") {
      let matchedLibrary = false;

      if (item.kind === "workflow" && opts.dataDir !== undefined) {
        try {
          const match = await matchLibrary(candidate.workflow, {
            dataDir: opts.dataDir,
          });
          if (match.kind === "match" && match.entry?.script) {
            scriptStore.set(finding.id, match.entry.script);
            const matchedNote = `Matched saved automation ${match.entry.name}`;
            finding = {
              ...finding,
              why: finding.why ? `${finding.why} ${matchedNote}.` : `${matchedNote}.`,
              artifact: {
                kind: "text",
                path: `/script/${finding.id}`,
                verified: false,
              },
            };
            matchedLibrary = true;
          }
        } catch {
          // Fall back to implementor if library cannot be read
        }
      }

      if (!matchedLibrary) {
        const solution = buildSolutionText(
          verdict,
          candidate.workflow,
          item.snippetText,
        );
        if (solution && opts.llm) {
          const implementStartedAt = Date.now();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(
                  new Error(
                    `implement timed out after ${config.implementTimeoutMs}ms`,
                  ),
                );
              }, config.implementTimeoutMs);
            });
            const script = await Promise.race([
              implementFn(solution, { name: finding.title }),
              timeoutPromise,
            ]).finally(() => {
              if (timer !== undefined) {
                clearTimeout(timer);
              }
            });
            scriptStore.set(finding.id, script);
            finding = {
              ...finding,
              artifact: {
                kind: "text",
                path: `/script/${finding.id}`,
                verified: false,
              },
            };
            console.log(
              `[pipeline] implement id=${finding.id} ms=${Date.now() - implementStartedAt} ok steps=${script.steps.length}`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(
              `[pipeline] implement id=${finding.id} ms=${Date.now() - implementStartedAt} error=${msg}`,
            );
            // Keep non-script artifact / no script if implementor fails
          }
        }
      }
    }

    if (
      opts.dataDir !== undefined &&
      item.kind === "snippet" &&
      item.snippetText !== undefined &&
      verdict === "rung1"
    ) {
      const existingTextArtifact =
        finding.artifact?.kind === "text" ? finding.artifact : undefined;
      finding = writeSnippetArtifact(opts.dataDir, finding, item.snippetText);
      if (existingTextArtifact) {
        finding = { ...finding, artifact: existingTextArtifact };
      }
    }

    results.push(finding);
  }

  return results;
}
