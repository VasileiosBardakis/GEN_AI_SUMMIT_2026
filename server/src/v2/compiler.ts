import type { Event, Locator } from "@gen/shared";
import { z } from "../../../shared/node_modules/zod/index.js";
import { hostnameFromUrl, resolveEventHost } from "../common/host.ts";
import { dedupeLocators } from "../common/target.ts";
import {
  createGeminiClient,
  DEFAULT_GEMINI_MODEL,
  type GeminiClient,
  type GeminiClientOptions,
} from "../llm/gemini.ts";
import {
  judgeWorkflowIris,
  type IrisJudgeOptions,
  type WorkflowIrisJudgment,
} from "../llm/iris.ts";
import { eventsToSteps, type PiiMap, type V2Step } from "./steps.ts";
import {
  isPlaceholderHost,
  isSameStepTarget,
  normalizeHost,
  validateCompiledWorkflow,
  type CompiledLeafStep,
  type CompiledParam,
  type CompiledStep,
  type CompiledWorkflow,
  type CompiledWorkflowStats,
} from "./validate.ts";

export { isPlaceholderHost };

export type {
  CompiledLeafStep,
  CompiledParam,
  CompiledStep,
  CompiledWorkflow,
  CompiledWorkflowStats,
};

export type CompileInput = {
  events?: Event[];
  steps?: V2Step[];
  piiMap?: PiiMap;
  repeatCount?: number;
};

export type IrisWorkflowJudge = (
  digest: Record<string, unknown>,
  opts?: IrisJudgeOptions,
) => Promise<WorkflowIrisJudgment | null>;

export type CompileOptions = {
  gemini?: GeminiClient | GeminiClientOptions;
  iris?: IrisJudgeOptions | IrisWorkflowJudge;
  irisOptions?: IrisJudgeOptions;
  irisJudgment?: WorkflowIrisJudgment | null;
  maxSteps?: number;
  timeoutMs?: number;
  model?: string;
};

export const DEFAULT_V2_COMPILE_MODEL = DEFAULT_GEMINI_MODEL;
export const DEFAULT_COMPILE_TIMEOUT_MS = 20_000;

export function resolveCompileTimeoutMs(): number {
  const n = Number(process.env.V2_COMPILE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMPILE_TIMEOUT_MS;
}

export function resolveCompileModel(): string {
  return (
    process.env.V2_COMPILE_MODEL?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    DEFAULT_V2_COMPILE_MODEL
  );
}
const MAX_PROMPT_STEPS = 120;
const MAX_SUMMARY_CHARS = 4096;

const MODEL_LEAF_ACTIONS = [
  "click",
  "fill",
  "insertText",
  "select",
  "waitFor",
  "readText",
  "readValue",
  "extractList",
  "navigate",
  "wait",
  "switchTab",
  "key",
  "submit",
] as const;

const ModelParamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  example: z.string().optional(),
});

const ModelLeafStepSchema = z.object({
  action: z.enum(MODEL_LEAF_ACTIONS),
  stepIndex: z.number().int().nonnegative().optional(),
  targetId: z.string().optional(),
  withinId: z.string().optional(),
  targetTextParam: z.string().optional(),
  withinTextParam: z.string().optional(),
  value: z.string().optional(),
  bind: z.string().optional(),
  url: z.string().optional(),
  host: z.string().optional(),
  key: z.string().optional(),
  ms: z.number().nonnegative().optional(),
  timeoutMs: z.number().positive().optional(),
  optional: z.boolean().optional(),
});

type ModelLeafStep = z.infer<typeof ModelLeafStepSchema>;

const ModelStepSchema = z.object({
  action: z.enum([...MODEL_LEAF_ACTIONS, "forEach"]),
  stepIndex: z.number().int().nonnegative().optional(),
  targetId: z.string().optional(),
  withinId: z.string().optional(),
  targetTextParam: z.string().optional(),
  withinTextParam: z.string().optional(),
  value: z.string().optional(),
  bind: z.string().optional(),
  url: z.string().optional(),
  host: z.string().optional(),
  key: z.string().optional(),
  ms: z.number().nonnegative().optional(),
  timeoutMs: z.number().positive().optional(),
  optional: z.boolean().optional(),
  items: z.string().optional(),
  itemIds: z.array(z.string()).optional(),
  steps: z.array(ModelLeafStepSchema).optional(),
});

type ModelStep = z.infer<typeof ModelStepSchema>;

export const ModelCompileOutputSchema = z.object({
  suggest: z.boolean(),
  offerAt2: z.boolean().default(false),
  kind: z.enum(["snippet", "workflow"]),
  name: z.string(),
  reason: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  runMode: z.enum(["run_remaining", "save_only"]),
  params: z.array(ModelParamSchema).default([]),
  steps: z.array(ModelStepSchema).default([]),
});

export type ModelCompileOutput = z.infer<typeof ModelCompileOutputSchema>;

const MODEL_LEAF_STEP_PROPERTIES = {
  action: { type: "string", enum: [...MODEL_LEAF_ACTIONS] },
  stepIndex: {
    type: "integer",
    description: "0-based stepIndex from Steps to reuse captured target/url/host.",
  },
  bind: {
    type: "string",
    description: "For readText/readValue/extractList: variable name to store result.",
  },
  value: { type: "string", description: "For fill/select/insertText: literal or {{var}}." },
  host: { type: "string", description: "Hostname only for switchTab." },
  url: { type: "string" },
  key: { type: "string" },
  targetId: {
    type: "string",
    description:
      "Exact ps_* targetId from PageSummary Targets ONLY (never invent IDs; omit and use stepIndex if not listed).",
  },
  withinId: {
    type: "string",
    description:
      "For leaf UI steps inside forEach.steps (NOT on forEach itself): container withinId from PageSummary Containers.",
  },
  targetTextParam: {
    type: "string",
    description: "Inside forEach.steps only: param name for exact-text target.",
  },
  withinTextParam: {
    type: "string",
    description:
      "For leaf UI steps inside forEach.steps (NOT on forEach itself): row field param name (e.g. col1) to scope within container row.",
  },
  ms: { type: "number" },
  timeoutMs: { type: "number" },
  optional: { type: "boolean" },
} as const;

/** Non-recursive JSON Schema for Gemini structured compilation output. */
export const COMPILER_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    suggest: { type: "boolean" },
    offerAt2: { type: "boolean" },
    kind: {
      type: "string",
      enum: ["snippet", "workflow"],
      description:
        "Use 'snippet' when the steps are paste/fill of the same literal text into one field with no copy/source read (even with clear clicks in between); otherwise 'workflow'.",
    },
    name: { type: "string" },
    reason: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    runMode: { type: "string", enum: ["run_remaining", "save_only"] },
    params: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          example: { type: "string" },
        },
        required: ["name"],
      },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ...MODEL_LEAF_STEP_PROPERTIES,
          action: { type: "string", enum: [...MODEL_LEAF_ACTIONS, "forEach"] },
          items: {
            type: "string",
            description: "For forEach only: listId from PageSummary Lists (e.g. list_1).",
          },
          itemIds: {
            type: "array",
            items: { type: "string" },
            description: "For forEach only: unprocessed itemId values from PageSummary Lists.",
          },
          steps: {
            type: "array",
            description: "For forEach only (REQUIRED): nested loop body steps executed per item.",
            items: {
              type: "object",
              properties: MODEL_LEAF_STEP_PROPERTIES,
              required: ["action"],
            },
          },
        },
        required: ["action"],
      },
    },
  },
  required: [
    "suggest",
    "offerAt2",
    "kind",
    "name",
    "reason",
    "risk",
    "runMode",
    "params",
    "steps",
  ],
} as const;

type EnrichedStep = V2Step & {
  label?: string;
  role?: string;
  tag?: string;
  container?: { testid?: string; css?: string; itemKey?: string };
  rawPageSummary?: unknown;
};

type PageSummaryTarget = {
  id: string;
  host: string;
  description: string;
  locators: Locator[];
  withinOnly?: boolean;
};

type PageSummaryListItem = {
  id: string;
  host: string;
  fields: Record<string, string>;
  targetId?: string;
};

type PageSummaryList = {
  id: string;
  host: string;
  url?: string;
  containerId?: string;
  description: string;
  items: PageSummaryListItem[];
};

type SourceColumnMeta = {
  rowTag: string;
  columns: Array<{
    texts: string[];
    locators: Locator[];
    invariantLocators: Locator[];
  }>;
};

type SourceCellEntry = {
  host: string;
  containerId?: string;
  rowIndex: number;
  colIndex: number;
  colKey: string;
  text: string;
  locators: Locator[];
  invariantLocators: Locator[];
};

type CopySourceMatch = {
  sourceTargetId: string;
  withinId?: string;
  colKey: string;
  cellLocators: Locator[];
  invariantLocators: Locator[];
};

type PromptContext = {
  allSteps: EnrichedStep[];
  indexedSteps: EnrichedStep[];
  targets: Map<string, PageSummaryTarget>;
  lists: Map<string, PageSummaryList>;
  items: Map<string, PageSummaryListItem>;
  sourceMetaByContainerId: Map<string, SourceColumnMeta>;
  copySourceMatches: Map<number, CopySourceMatch>;
  copyNoSourceSteps: Set<number>;
  summaryViews: Array<{ host: string; viewKey: string; content: string }>;
};

function buildCompilerSchemaForPrompt(prompt: string): Record<string, unknown> {
  const lines = prompt.split("\n");
  const hasContainers = lines.includes(
    "PageSummary Containers (for withinId ONLY, NEVER targetId):",
  );
  const hasTargets = lines.includes("PageSummary Targets:") || hasContainers;
  const hasLists = lines.includes("PageSummary Lists:");
  if (hasTargets && hasLists) {
    return COMPILER_RESPONSE_SCHEMA as unknown as Record<string, unknown>;
  }

  const leafProps: Record<string, unknown> = {
    action: MODEL_LEAF_STEP_PROPERTIES.action,
    stepIndex: MODEL_LEAF_STEP_PROPERTIES.stepIndex,
    bind: MODEL_LEAF_STEP_PROPERTIES.bind,
    value: MODEL_LEAF_STEP_PROPERTIES.value,
    host: MODEL_LEAF_STEP_PROPERTIES.host,
    url: MODEL_LEAF_STEP_PROPERTIES.url,
    key: MODEL_LEAF_STEP_PROPERTIES.key,
    ms: MODEL_LEAF_STEP_PROPERTIES.ms,
    timeoutMs: MODEL_LEAF_STEP_PROPERTIES.timeoutMs,
    optional: MODEL_LEAF_STEP_PROPERTIES.optional,
    ...(hasTargets
      ? {
          targetId: MODEL_LEAF_STEP_PROPERTIES.targetId,
          withinId: MODEL_LEAF_STEP_PROPERTIES.withinId,
          targetTextParam: MODEL_LEAF_STEP_PROPERTIES.targetTextParam,
          withinTextParam: MODEL_LEAF_STEP_PROPERTIES.withinTextParam,
        }
      : {}),
  };

  const topStepProps: Record<string, unknown> = {
    ...leafProps,
    ...(hasLists
      ? {
          action: { type: "string", enum: [...MODEL_LEAF_ACTIONS, "forEach"] },
          items: {
            type: "string",
            description: "For forEach only: listId from PageSummary Lists (e.g. list_1).",
          },
          itemIds: {
            type: "array",
            items: { type: "string" },
            description: "For forEach only: unprocessed itemId values from PageSummary Lists.",
          },
          steps: {
            type: "array",
            description:
              "For forEach only (REQUIRED): nested loop body steps executed per item.",
            items: {
              type: "object",
              properties: leafProps,
              required: ["action"],
            },
          },
        }
      : {}),
  };

  return {
    type: "object",
    properties: {
      suggest: { type: "boolean" },
      offerAt2: { type: "boolean" },
      kind: {
        type: "string",
        enum: ["snippet", "workflow"],
        description:
          "Use 'snippet' when the steps are paste/fill of the same literal text into one field with no copy/source read (even with clear clicks in between); otherwise 'workflow'.",
      },
      name: { type: "string" },
      reason: { type: "string" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      runMode: { type: "string", enum: ["run_remaining", "save_only"] },
      params: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            example: { type: "string" },
          },
          required: ["name"],
        },
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: topStepProps,
          required: ["action"],
        },
      },
    },
    required: [...COMPILER_RESPONSE_SCHEMA.required],
  };
}

function isGeminiClient(
  value: GeminiClient | GeminiClientOptions | undefined,
): value is GeminiClient {
  return (
    typeof value === "object" &&
    value !== null &&
    "generateJson" in value &&
    typeof value.generateJson === "function"
  );
}

function normalizeUrlHost(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hostname = normalizeHost(parsed.hostname);
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function resolveStepRealHost(step: { app?: string; url?: string }): string | undefined {
  return resolveEventHost(step, { preferUrl: true });
}

function mergeCapturedNavigateUrl(
  rawUrl: string,
  fallbackUrl: string | undefined,
): string {
  if (!fallbackUrl) return rawUrl;
  let parsedRaw: URL;
  let parsedFallback: URL;
  try {
    parsedRaw = new URL(rawUrl);
    parsedFallback = new URL(fallbackUrl);
  } catch {
    return rawUrl;
  }
  if (
    normalizeHost(parsedRaw.hostname) !==
    normalizeHost(parsedFallback.hostname)
  ) {
    return rawUrl;
  }
  if (!parsedRaw.port && parsedFallback.port) {
    parsedRaw.port = parsedFallback.port;
  }
  const isOriginOnly =
    parsedRaw.pathname === "/" &&
    parsedRaw.search === "" &&
    parsedRaw.hash === "";
  const fallbackHasPathOrQuery =
    parsedFallback.pathname !== "/" || parsedFallback.search !== "";
  if (
    isOriginOnly &&
    fallbackHasPathOrQuery &&
    (!parsedRaw.port || parsedRaw.port === parsedFallback.port)
  ) {
    return fallbackUrl;
  }
  return parsedRaw.toString();
}

function stripParamBraces(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

function enrichSteps(steps: V2Step[], events?: Event[]): EnrichedStep[] {
  if (!events || events.length === 0) {
    return steps.map((step) => ({
      ...step,
      rawPageSummary: step.pageSummary,
    }));
  }

  const eventQueues = new Map<string, Event[]>();
  for (const ev of events) {
    const mappedAction =
      ev.type === "input" || ev.type === "change"
        ? "fill"
        : ev.type === "keydown" || ev.type === "key"
          ? "key"
          : ev.type;
    const key = `${ev.session}::${mappedAction}`;
    const queue = eventQueues.get(key) ?? [];
    queue.push(ev);
    eventQueues.set(key, queue);
  }

  const cursorByKey = new Map<string, number>();

  return steps.map((step) => {
    const key = `${step.session}::${step.action}`;
    const queue = eventQueues.get(key);
    let matched: Event | undefined;
    if (queue) {
      let idx = cursorByKey.get(key) ?? 0;
      while (idx < queue.length && queue[idx].ts < step.ts) {
        idx += 1;
      }
      if (idx < queue.length) {
        matched = queue[idx];
        cursorByKey.set(key, idx + 1);
      }
    }

    const containerMeta = matched?.meta?.container as
      | { testid?: unknown; itemKey?: unknown }
      | undefined;
    const rawPs = matched?.meta?.pageSummary as
      | { source?: { containerLocators?: Array<{ kind?: unknown; value?: unknown }> } }
      | undefined;
    const sourceLoc0 =
      !containerMeta && Array.isArray(rawPs?.source?.containerLocators)
        ? rawPs!.source!.containerLocators![0]
        : undefined;
    const derivedContainer =
      containerMeta && typeof containerMeta === "object"
        ? {
            ...(typeof containerMeta.testid === "string"
              ? { testid: containerMeta.testid }
              : {}),
            ...(typeof containerMeta.itemKey === "string"
              ? { itemKey: containerMeta.itemKey }
              : {}),
          }
        : sourceLoc0 &&
            typeof sourceLoc0.value === "string" &&
            sourceLoc0.value.trim()
          ? {
              ...(sourceLoc0.kind === "testid"
                ? { testid: sourceLoc0.value.trim() }
                : { css: sourceLoc0.value.trim() }),
            }
          : undefined;

    return {
      ...step,
      label: matched?.target?.label,
      role: matched?.target?.role,
      tag: matched?.target?.tag,
      ...(derivedContainer ? { container: derivedContainer } : {}),
      rawPageSummary: matched?.meta?.pageSummary ?? step.pageSummary,
    };
  });
}

function inferLabelFromTarget(target?: Locator[]): string | undefined {
  if (!target) return undefined;
  const aria = target.find((l) => l.kind === "aria");
  if (aria) return aria.value;
  const text = target.find((l) => l.kind === "text");
  if (text) return text.value;
  return undefined;
}

const VALID_SUMMARY_LOCATOR_KINDS = new Set<Locator["kind"]>([
  "testid",
  "aria",
  "css",
  "text",
  "uia",
]);

function parseSummaryLocators(raw: unknown): Locator[] {
  if (!Array.isArray(raw)) return [];
  const out: Locator[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { kind?: unknown; value?: unknown };
    if (
      typeof rec.kind === "string" &&
      VALID_SUMMARY_LOCATOR_KINDS.has(rec.kind as Locator["kind"]) &&
      typeof rec.value === "string" &&
      rec.value.trim().length > 0
    ) {
      out.push({ kind: rec.kind as Locator["kind"], value: rec.value.trim() });
    }
  }
  return out;
}

function extractPageSummaryData(
  steps: EnrichedStep[],
): {
  targets: Map<string, PageSummaryTarget>;
  lists: Map<string, PageSummaryList>;
  items: Map<string, PageSummaryListItem>;
  sourceMetaByContainerId: Map<string, SourceColumnMeta>;
  sourceCells: SourceCellEntry[];
  nextTargetSeq: number;
  summaryViews: Array<{ host: string; viewKey: string; content: string }>;
} {
  const latestByView = new Map<
    string,
    { host: string; viewKey: string; url?: string; summary: unknown }
  >();
  const seenControlsByTargetKey = new Map<
    string,
    Map<string, { label: string; locators: Locator[] }>
  >();

  for (const step of steps) {
    if (step.rawPageSummary === undefined) continue;
    const host = resolveStepRealHost(step) ?? normalizeHost(step.app);
    const stepUrl = step.url ? normalizeUrlHost(step.url) : undefined;
    const scrubbed = step.rawPageSummary;

    if (typeof scrubbed === "string") {
      const firstLine = scrubbed.split(/\r?\n/)[0]?.trim() ?? "";
      const viewKey = firstLine || host;
      latestByView.set(`${host}::${viewKey}`, {
        host,
        viewKey,
        ...(stepUrl ? { url: stepUrl } : {}),
        summary: scrubbed,
      });
      continue;
    }

    if (scrubbed && typeof scrubbed === "object") {
      const rec = scrubbed as Record<string, unknown>;
      const hasSource = Boolean(
        rec.source && typeof rec.source === "object" && !Array.isArray(rec.source),
      );
      const hasTarget = Boolean(
        rec.target && typeof rec.target === "object" && !Array.isArray(rec.target),
      );

      if (hasSource) {
        const src = rec.source as Record<string, unknown>;
        const containerLocs = parseSummaryLocators(src.containerLocators);
        const rowTag =
          typeof src.rowTag === "string" && src.rowTag.trim()
            ? src.rowTag.trim().toLowerCase()
            : "tr";
        const sourceKey = containerLocs[0]
          ? `source:${containerLocs[0].kind}:${containerLocs[0].value}`
          : `source:${rowTag}`;
        latestByView.set(`${host}::${sourceKey}`, {
          host,
          viewKey: sourceKey,
          ...(stepUrl ? { url: stepUrl } : {}),
          summary: { source: rec.source },
        });
      }

      if (hasTarget) {
        const tgt = rec.target as Record<string, unknown>;
        const containerLocs = parseSummaryLocators(tgt.containerLocators);
        const containerTag =
          typeof tgt.containerTag === "string" && tgt.containerTag.trim()
            ? tgt.containerTag.trim().toLowerCase()
            : "form";
        const targetKey = containerLocs[0]
          ? `target:${containerLocs[0].kind}:${containerLocs[0].value}`
          : `target:${containerTag}`;
        const mapKey = `${host}::${targetKey}`;
        let seenMap = seenControlsByTargetKey.get(mapKey);
        if (!seenMap) {
          seenMap = new Map();
          seenControlsByTargetKey.set(mapKey, seenMap);
        }
        const emptyControls = Array.isArray(tgt.emptyControls)
          ? tgt.emptyControls
          : [];
        for (const rawCtrl of emptyControls) {
          if (!rawCtrl || typeof rawCtrl !== "object") continue;
          const ctrl = rawCtrl as Record<string, unknown>;
          const ctrlLocs = parseSummaryLocators(ctrl.locators);
          if (ctrlLocs.length === 0) continue;
          const label =
            typeof ctrl.label === "string" && ctrl.label.trim()
              ? ctrl.label.trim()
              : typeof ctrl.name === "string" && ctrl.name.trim()
                ? ctrl.name.trim()
                : typeof ctrl.tag === "string" && ctrl.tag.trim()
                  ? ctrl.tag.trim()
                  : "control";
          const locKey = ctrlLocs.map((l) => `${l.kind}:${l.value}`).join("|");
          if (!seenMap.has(locKey)) {
            seenMap.set(locKey, { label, locators: ctrlLocs });
          }
        }
        latestByView.set(mapKey, {
          host,
          viewKey: targetKey,
          ...(stepUrl ? { url: stepUrl } : {}),
          summary: { target: rec.target },
        });
      }

      if (hasSource || hasTarget) {
        if (typeof rec.view !== "string" && !Array.isArray(rec.containers)) {
          continue;
        }
      }

      let viewKey = host;
      if (typeof rec.view === "string" && rec.view.trim()) {
        viewKey = rec.view.trim();
      } else {
        const containers = Array.isArray(rec.containers) ? rec.containers : [];
        const firstId =
          containers[0] &&
          typeof containers[0] === "object" &&
          typeof (containers[0] as Record<string, unknown>).testid === "string"
            ? String((containers[0] as Record<string, unknown>).testid)
            : "";
        viewKey = firstId || host;
      }

      latestByView.set(`${host}::${viewKey}`, {
        host,
        viewKey,
        ...(stepUrl ? { url: stepUrl } : {}),
        summary: scrubbed,
      });
    }
  }

  const targets = new Map<string, PageSummaryTarget>();
  const lists = new Map<string, PageSummaryList>();
  const items = new Map<string, PageSummaryListItem>();
  const sourceMetaByContainerId = new Map<string, SourceColumnMeta>();
  const sourceCells: SourceCellEntry[] = [];
  const summaryViews: Array<{ host: string; viewKey: string; content: string }> = [];

  let targetSeq = 0;
  let listSeq = 0;

  function addTarget(
    host: string,
    description: string,
    locators: Locator[],
    withinOnly = false,
  ): string {
    targetSeq += 1;
    const id = `ps_${targetSeq}`;
    targets.set(id, {
      id,
      host,
      description,
      locators,
      ...(withinOnly ? { withinOnly: true } : {}),
    });
    return id;
  }

  function addList(
    host: string,
    description: string,
    rawItems: Array<{ fields: Record<string, string>; targetId?: string }>,
    containerId?: string,
    url?: string,
  ): string {
    listSeq += 1;
    const id = `list_${listSeq}`;
    const listItems: PageSummaryListItem[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      const itemId = `item_${listSeq}_${i + 1}`;
      const item: PageSummaryListItem = {
        id: itemId,
        host,
        fields: rawItems[i].fields,
        ...(rawItems[i].targetId ? { targetId: rawItems[i].targetId } : {}),
      };
      items.set(itemId, item);
      listItems.push(item);
    }
    lists.set(id, {
      id,
      host,
      ...(url ? { url } : {}),
      containerId,
      description,
      items: listItems,
    });
    return id;
  }

  for (const entry of latestByView.values()) {
    const { host, viewKey, url: entryUrl, summary } = entry;

    if (typeof summary === "string") {
      const lines = summary.split(/\r?\n/);
      const bulletListItems: Array<{
        fields: Record<string, string>;
        targetId?: string;
      }> = [];

      let i = 0;
      while (i < lines.length) {
        const line = lines[i].trim();

        // Parse markdown tables: | Col1 | Col2 | ... |
        if (line.startsWith("|") && line.endsWith("|")) {
          const splitCells = (row: string) =>
            row
              .slice(1, -1)
              .split("|")
              .map((c) => c.trim());
          const headers = splitCells(line);
          const nextLine = (lines[i + 1] ?? "").trim();
          const hasSeparator =
            nextLine.startsWith("|") && /^[\s|:-]+$/.test(nextLine);
          let j = hasSeparator ? i + 2 : i + 1;
          const tableRows: Array<{ fields: Record<string, string> }> = [];
          while (j < lines.length) {
            const rowLine = lines[j].trim();
            if (!rowLine.startsWith("|") || !rowLine.endsWith("|")) break;
            const cells = splitCells(rowLine);
            if (cells.length === headers.length) {
              const fields: Record<string, string> = {};
              for (let c = 0; c < headers.length; c++) {
                if (headers[c]) {
                  fields[headers[c]] = cells[c];
                }
              }
              tableRows.push({ fields });
            }
            j += 1;
          }
          if (tableRows.length > 0) {
            addList(host, `${viewKey} table`, tableRows);
          }
          i = j;
          continue;
        }

        // Parse bullet lines, optionally with an explicit selector like (#row-4)
        if (line.startsWith("- ")) {
          const bulletBody = line.slice(2).trim();
          const idMatch = /^([^:(]+?)\s*\((#[A-Za-z0-9_-]+)\)\s*:\s*(.+)$/.exec(
            bulletBody,
          );
          if (idMatch) {
            const label = idMatch[1].trim();
            const selector = idMatch[2].trim();
            const rest = idMatch[3].trim();
            const targetId = addTarget(host, `${label} (${selector}): ${rest}`, [
              { kind: "css", value: selector },
            ]);
            const fields: Record<string, string> = {
              selector,
              label,
              text: rest,
            };
            const parts = rest.split("|").map((p) => p.trim()).filter(Boolean);
            for (let p = 0; p < parts.length; p++) {
              fields[`col${p + 1}`] = parts[p];
            }
            bulletListItems.push({ fields, targetId });
          } else {
            const parts = bulletBody.split("|").map((p) => p.trim()).filter(Boolean);
            const fields: Record<string, string> = { text: bulletBody };
            for (let p = 0; p < parts.length; p++) {
              fields[`col${p + 1}`] = parts[p];
            }
            bulletListItems.push({ fields });
          }
        }

        i += 1;
      }

      if (bulletListItems.length > 0) {
        addList(host, `${viewKey} items`, bulletListItems);
      }

      summaryViews.push({
        host,
        viewKey,
        content: summary.slice(0, MAX_SUMMARY_CHARS),
      });
      continue;
    }

    if (summary && typeof summary === "object") {
      const rec = summary as Record<string, unknown>;
      const containers = Array.isArray(rec.containers) ? rec.containers : [];

      for (const rawContainer of containers) {
        if (!rawContainer || typeof rawContainer !== "object") continue;
        const container = rawContainer as Record<string, unknown>;

        const locators: Locator[] = [];
        if (typeof container.testid === "string" && container.testid.trim()) {
          locators.push({ kind: "testid", value: container.testid.trim() });
        }
        if (typeof container.id === "string" && container.id.trim()) {
          locators.push({ kind: "css", value: `#${container.id.trim()}` });
        }
        if (locators.length === 0 && typeof container.role === "string" && container.role.trim()) {
          locators.push({ kind: "aria", value: `[role="${container.role.trim()}"]` });
        }

        let containerId: string | undefined;
        if (locators.length > 0) {
          const desc =
            typeof container.testid === "string"
              ? `container ${container.testid}`
              : `container ${viewKey}`;
          containerId = addTarget(host, desc, locators, true);
        }

        if (Array.isArray(container.fields)) {
          for (const rawField of container.fields) {
            if (!rawField || typeof rawField !== "object") continue;
            const field = rawField as Record<string, unknown>;
            const fieldLocators: Locator[] = [];
            if (typeof field.testid === "string" && field.testid.trim()) {
              fieldLocators.push({ kind: "testid", value: field.testid.trim() });
            }
            if (typeof field.label === "string" && field.label.trim()) {
              fieldLocators.push({ kind: "aria", value: field.label.trim() });
            }
            if (fieldLocators.length > 0) {
              const desc =
                typeof field.label === "string"
                  ? `field ${field.label}`
                  : "field";
              addTarget(host, desc, fieldLocators);
            }
          }
        }

        const listCandidate = Array.isArray(container.items)
          ? container.items
          : Array.isArray(container.rows)
            ? container.rows
            : null;

        if (listCandidate && listCandidate.length > 0) {
          const parsedRows: Array<{ fields: Record<string, string> }> = [];
          for (const row of listCandidate) {
            if (row && typeof row === "object") {
              const fields: Record<string, string> = {};
              for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
                if (v !== undefined && v !== null) {
                  fields[k] = String(v);
                }
              }
              if (Object.keys(fields).length > 0) {
                parsedRows.push({ fields });
              }
            } else if (typeof row === "string" && row.trim()) {
              parsedRows.push({ fields: { text: row.trim() } });
            }
          }
          if (parsedRows.length > 0) {
            addList(
              host,
              containerId ? `${viewKey} (${containerId})` : viewKey,
              parsedRows,
              containerId,
            );
          }
        }
      }

      if (rec.source && typeof rec.source === "object" && !Array.isArray(rec.source)) {
        const src = rec.source as Record<string, unknown>;
        const containerLocs = parseSummaryLocators(src.containerLocators);
        const rowTag =
          typeof src.rowTag === "string" && src.rowTag.trim()
            ? src.rowTag.trim().toLowerCase()
            : "tr";
        const containerId = addTarget(
          host,
          containerLocs.length > 0
            ? `container ${containerLocs[0].value}`
            : `container ${rowTag}`,
          containerLocs,
          true,
        );

        const rawRows = Array.isArray(src.rows) ? src.rows : [];
        const parsedRows: Array<{ fields: Record<string, string> }> = [];
        const rawCellMatrix: Array<
          Array<{ colIndex: number; text: string; locators: Locator[] }>
        > = [];
        const columnAccum: Array<{
          texts: string[];
          locators: Locator[];
          locatorRowCounts: Map<string, { loc: Locator; rows: number }>;
        }> = [];

        for (const rawRow of rawRows) {
          if (!rawRow || typeof rawRow !== "object") continue;
          const rowRec = rawRow as Record<string, unknown>;
          const rawCells = Array.isArray(rowRec.cells) ? rowRec.cells : [];
          const fields: Record<string, string> = {};
          const rowCellEntries: Array<{
            colIndex: number;
            text: string;
            locators: Locator[];
          }> = [];
          for (let c = 0; c < rawCells.length; c++) {
            const cell = rawCells[c];
            if (!cell || typeof cell !== "object") continue;
            const cellRec = cell as Record<string, unknown>;
            const text =
              typeof cellRec.text === "string" ? cellRec.text.trim() : "";
            fields[`col${c + 1}`] = text;

            while (columnAccum.length <= c) {
              columnAccum.push({
                texts: [],
                locators: [],
                locatorRowCounts: new Map(),
              });
            }
            const colEntry = columnAccum[c];
            if (text) colEntry.texts.push(text);
            const cellLocs = parseSummaryLocators(cellRec.locators);
            rowCellEntries.push({ colIndex: c, text, locators: cellLocs });
            const seenInCell = new Set<string>();
            for (const loc of cellLocs) {
              colEntry.locators.push(loc);
              const k = `${loc.kind}::${loc.value}`;
              if (!seenInCell.has(k)) {
                seenInCell.add(k);
                const prev = colEntry.locatorRowCounts.get(k);
                if (prev) {
                  prev.rows += 1;
                } else {
                  colEntry.locatorRowCounts.set(k, { loc, rows: 1 });
                }
              }
            }
          }
          if (Object.keys(fields).length > 0) {
            parsedRows.push({ fields });
            rawCellMatrix.push(rowCellEntries);
          }
        }

        if (parsedRows.length > 0) {
          addList(
            host,
            containerId ? `${viewKey} (${containerId})` : viewKey,
            parsedRows,
            containerId,
            entryUrl,
          );
        }

        if (containerId && columnAccum.length > 0) {
          const allLocatorCols = new Map<string, Set<number>>();
          for (let c = 0; c < columnAccum.length; c++) {
            for (const k of columnAccum[c].locatorRowCounts.keys()) {
              let set = allLocatorCols.get(k);
              if (!set) {
                set = new Set<number>();
                allLocatorCols.set(k, set);
              }
              set.add(c);
            }
          }

          const columns: SourceColumnMeta["columns"] = columnAccum.map(
            (colEntry, c) => {
              const invariantLocators: Locator[] = [];
              for (const [k, info] of colEntry.locatorRowCounts.entries()) {
                const colSpread = allLocatorCols.get(k)?.size ?? 0;
                if (info.rows >= 2 && colSpread === 1) {
                  invariantLocators.push(info.loc);
                }
              }
              if (invariantLocators.length === 0 && rowTag === "tr") {
                invariantLocators.push({
                  kind: "css",
                  value: `td:nth-of-type(${c + 1})`,
                });
              }
              return {
                texts: colEntry.texts,
                locators: colEntry.locators,
                invariantLocators,
              };
            },
          );
          sourceMetaByContainerId.set(containerId, { rowTag, columns });
          for (let r = 0; r < rawCellMatrix.length; r++) {
            for (const cellEntry of rawCellMatrix[r]) {
              if (cellEntry.text || cellEntry.locators.length > 0) {
                sourceCells.push({
                  host,
                  containerId,
                  rowIndex: r,
                  colIndex: cellEntry.colIndex,
                  colKey: `col${cellEntry.colIndex + 1}`,
                  text: cellEntry.text,
                  locators: cellEntry.locators,
                  invariantLocators:
                    columns[cellEntry.colIndex]?.invariantLocators ?? [],
                });
              }
            }
          }
        }
      }

      if (rec.target && typeof rec.target === "object" && !Array.isArray(rec.target)) {
        const tgt = rec.target as Record<string, unknown>;
        const containerTag =
          typeof tgt.containerTag === "string" && tgt.containerTag.trim()
            ? tgt.containerTag.trim()
            : "form";
        const emptyControls = Array.isArray(tgt.emptyControls)
          ? tgt.emptyControls
          : [];
        const emittedLocKeys = new Set<string>();
        for (const rawCtrl of emptyControls) {
          if (!rawCtrl || typeof rawCtrl !== "object") continue;
          const ctrl = rawCtrl as Record<string, unknown>;
          const ctrlLocs = parseSummaryLocators(ctrl.locators);
          if (ctrlLocs.length > 0) {
            const label =
              typeof ctrl.label === "string" && ctrl.label.trim()
                ? ctrl.label.trim()
                : typeof ctrl.name === "string" && ctrl.name.trim()
                  ? ctrl.name.trim()
                  : typeof ctrl.tag === "string" && ctrl.tag.trim()
                    ? ctrl.tag.trim()
                    : "control";
            emittedLocKeys.add(ctrlLocs.map((l) => `${l.kind}:${l.value}`).join("|"));
            addTarget(host, `field ${label}`, ctrlLocs);
          }
        }
        const submitLocs = parseSummaryLocators(tgt.submitLocators);
        if (submitLocs.length > 0) {
          addTarget(host, `submit ${containerTag}`, submitLocs);
        }
        const priorSeen = seenControlsByTargetKey.get(`${host}::${viewKey}`);
        if (priorSeen) {
          for (const [locKey, info] of priorSeen.entries()) {
            if (!emittedLocKeys.has(locKey)) {
              addTarget(host, `field ${info.label}`, info.locators);
            }
          }
        }
      }

      summaryViews.push({
        host,
        viewKey,
        content: JSON.stringify(summary).slice(0, MAX_SUMMARY_CHARS),
      });
    }
  }

  return {
    targets,
    lists,
    items,
    sourceMetaByContainerId,
    sourceCells,
    nextTargetSeq: targetSeq,
    summaryViews,
  };
}

function isCopyButtonStep(step: EnrichedStep): boolean {
  if (step.action !== "copy") return false;
  const tag = step.tag?.toLowerCase();
  const role = step.role?.toLowerCase();
  if (tag === "button" || role === "button") return true;
  if (!step.target || step.target.length === 0) return true;
  return step.target.some(
    (loc) => loc.kind === "aria" && /^button\[/i.test(loc.value),
  );
}

function resolveCopySourceContext(
  indexedSteps: readonly EnrichedStep[],
  targets: Map<string, PageSummaryTarget>,
  sourceCells: readonly SourceCellEntry[],
  startTargetSeq: number,
): {
  copySourceMatches: Map<number, CopySourceMatch>;
  copyNoSourceSteps: Set<number>;
} {
  const copySourceMatches = new Map<number, CopySourceMatch>();
  const copyNoSourceSteps = new Set<number>();
  let targetSeq = startTargetSeq;

  const targetIdByLocKey = new Map<string, string>();
  for (const t of targets.values()) {
    if (t.withinOnly || t.locators.length === 0) continue;
    const key = `${t.host}::${t.locators.map((l) => `${l.kind}:${l.value}`).join("|")}`;
    targetIdByLocKey.set(key, t.id);
  }

  let recentRowIndex: number | undefined;

  for (let idx = 0; idx < indexedSteps.length; idx++) {
    const step = indexedSteps[idx];
    if (!isCopyButtonStep(step)) {
      if (step.action === "tab_switch" || step.action === "nav") {
        recentRowIndex = undefined;
      }
      continue;
    }

    const host = resolveStepRealHost(step) ?? normalizeHost(step.app);
    const needle = (step.value ?? "").trim();

    let bestCell: SourceCellEntry | undefined;
    if (needle && sourceCells.length > 0) {
      const hostCandidates = sourceCells.filter(
        (c) =>
          c.locators.length > 0 &&
          (isPlaceholderHost(host) || c.host === host),
      );
      let bestScore = -1;
      for (const cell of hostCandidates) {
        let score = 0;
        if (cell.text === needle) score = 3;
        else if (cell.text.startsWith(`${needle} `)) score = 2;
        else if (cell.text.includes(needle)) score = 1;
        if (score === 0) continue;

        const rowBonus =
          recentRowIndex !== undefined && cell.rowIndex === recentRowIndex
            ? 10
            : 0;
        const totalScore = score + rowBonus;
        if (totalScore > bestScore) {
          bestScore = totalScore;
          bestCell = cell;
        }
      }
    }

    if (bestCell) {
      recentRowIndex = bestCell.rowIndex;
      const locKey = `${bestCell.host}::${bestCell.locators.map((l) => `${l.kind}:${l.value}`).join("|")}`;
      let sourceTargetId = targetIdByLocKey.get(locKey);
      if (!sourceTargetId) {
        targetSeq += 1;
        sourceTargetId = `ps_${targetSeq}`;
        targets.set(sourceTargetId, {
          id: sourceTargetId,
          host: bestCell.host,
          description: `source cell row ${bestCell.rowIndex + 1} ${bestCell.colKey} (${bestCell.text})`,
          locators: bestCell.locators,
        });
        targetIdByLocKey.set(locKey, sourceTargetId);
      }
      copySourceMatches.set(idx, {
        sourceTargetId,
        ...(bestCell.containerId ? { withinId: bestCell.containerId } : {}),
        colKey: bestCell.colKey,
        cellLocators: bestCell.locators,
        invariantLocators: bestCell.invariantLocators,
      });
    } else {
      copyNoSourceSteps.add(idx);
    }
  }

  return { copySourceMatches, copyNoSourceSteps };
}

function buildCompilePrompt(
  ctx: PromptContext,
  stabilityCounts: ReadonlyMap<string, number>,
): string {
  const lastUrlForApp = new Map<string, string>();
  const stepLines = ctx.indexedSteps.map((step, idx) => {
    const app = resolveStepRealHost(step) ?? normalizeHost(step.app);
    const entry: Record<string, unknown> = {
      stepIndex: idx,
      action: step.action,
      app,
    };
    const label = step.label ?? inferLabelFromTarget(step.target);
    if (label) entry.label = label;
    if (step.role) entry.role = step.role;
    if (step.tag) entry.tag = step.tag;
    const copyMatch = ctx.copySourceMatches.get(idx);
    const copyNoSource = ctx.copyNoSourceSteps.has(idx);
    if (step.target && step.target.length > 0 && !copyNoSource) {
      entry.hasTarget = true;
      let maxSeen = 0;
      for (const loc of step.target) {
        const c = stabilityCounts.get(`${step.action}::${loc.kind}::${loc.value}`) ?? 0;
        if (c > maxSeen) maxSeen = c;
      }
      if (maxSeen > 0) entry.seenCount = maxSeen;
    }
    if (copyMatch) {
      entry.copyButton = true;
      entry.sourceTargetId = copyMatch.sourceTargetId;
      if (copyMatch.withinId) entry.sourceWithinId = copyMatch.withinId;
      entry.sourceColumn = copyMatch.colKey;
    } else if (copyNoSource) {
      entry.copyButton = true;
      entry.noReadableSource = true;
    }
    if (step.value !== undefined) entry.value = step.value;
    if (step.key !== undefined) entry.key = step.key;
    if (step.url !== undefined) {
      const normUrl = normalizeUrlHost(step.url);
      if (
        step.action === "nav" ||
        step.action === "tab_switch" ||
        lastUrlForApp.get(app) !== normUrl
      ) {
        lastUrlForApp.set(app, normUrl);
        entry.url = normUrl;
      }
    }
    if (step.container) {
      entry.container = step.container;
    }
    return JSON.stringify(entry);
  });

  const containerLines = Array.from(ctx.targets.values())
    .filter((t) => t.withinOnly)
    .map((t) =>
      JSON.stringify({
        withinId: t.id,
        host: t.host,
        description: t.description,
      }),
    );

  const targetLines = Array.from(ctx.targets.values())
    .filter((t) => !t.withinOnly)
    .map((t) =>
      JSON.stringify({
        targetId: t.id,
        host: t.host,
        description: t.description,
      }),
    );

  const listLines = Array.from(ctx.lists.values()).map((l) =>
    JSON.stringify({
      listId: l.id,
      host: l.host,
      ...(l.containerId ? { withinId: l.containerId } : {}),
      description: l.description,
      items: l.items.map((it) => ({ itemId: it.id, ...it.fields })),
    }),
  );

  const viewLines = ctx.summaryViews
    .filter((v) => !v.content.startsWith("{"))
    .map((v) => `[${v.host} / ${v.viewKey}]\n${v.content}`);

  const rule1 =
    targetLines.length > 0
      ? "1. Never write CSS/DOM selectors and NEVER invent a `targetId`. Every UI step (`click`, `fill`, `select`, `readText`, `readValue`, `extractList`, `waitFor`, `key`, `submit`) must reference a `stepIndex` from Steps or an exact `ps_*` `targetId` from PageSummary Targets (if the element is not in PageSummary Targets, omit `targetId` and use `stepIndex`)."
      : "1. Never write CSS/DOM selectors and NEVER invent a `targetId`. Every UI step (`click`, `fill`, `select`, `readText`, `readValue`, `extractList`, `waitFor`, `key`, `submit`) must reference a `stepIndex` from Steps (omit `targetId` and `withinId` since no PageSummary Targets exist).";

  return [
    "Compile the user's browser steps into ONE concise JSON (a reusable `snippet` or parameterized `workflow`) if worth automating.",
    "",
    "RULES:",
    rule1,
    "2. Output one clean generalized repetition covering ONE complete cycle, starting at the cycle's natural start (the page/first input of the form) and ending at the submit — NEVER start or end mid-cycle (preferring the latest complete cycle). Drop one-off stray clicks, side excursions, and one-time setup/cookie/consent clicks (`seenCount: 1` when not a varying per-repetition item), and do not add extra `navigate` steps unless the user navigated between distinct pages as part of the task. Only keep a transient banner/modal click if it recurs, and mark it with \"optional\": true.",
    "3. Keep all distinct form inputs and submit keys (e.g. `Enter`).",
    "4. Parameterize user-supplied variables in `params[]` and `\"{{paramName}}\"` (EXCEPT for `kind: \"snippet\"`, which keeps the repeated text literal with `params: []`). When `copy` steps have a readable source (`sourceTargetId` for copy-button steps, or a non-button source `stepIndex`/PageSummary source target), emit `readText`/`readValue` with `stepIndex` (or `sourceTargetId`), setting `bind: \"varName\"` (NOT `value`) to store each copied value and filling the destination field with `\"{{varName}}\"`. NEVER emit `readText`/`readValue` on a Copy button or on the destination input field being filled (no self-read). If a `copy` step has `noReadableSource: true`, parameterize it in `params[]` and `\"{{paramName}}\"` with NO `readText`/`readValue`.",
    "5. `switchTab` uses `stepIndex` or `host` (hostname only). Any `navigate` must preserve the full URL (scheme, host, port, path).",
    "6. SNIPPET: When the steps are `paste` or `fill` of the same literal text into one field with no `copy`/source read (even with clear clicks or empty clears in between), set `suggest: true`, `kind: \"snippet\"`, `params: []`, `runMode: \"save_only\"`, and emit ONLY ONE `insertText` step with `stepIndex` and that exact repeated text (no `fill`, `click`, or clear steps).",
    "7. WORKFLOW: When PageSummary Lists contains a source list with rows on the source page, ALWAYS emit `forEach` with `runMode: \"run_remaining\"` and `itemIds` (for remaining unprocessed items, or `items: \"<listId>\"` for all rows) and put ALL per-row steps inside `forEach.steps: [...]` (never leave `forEach.steps` empty or put body steps after `forEach`). Inside `forEach.steps`, scope row-level `readText`/`click` steps using `withinId` and `withinTextParam` (NOT on `forEach` itself) plus `stepIndex` (or `targetId`), and fill destination fields using `stepIndex` or exact `ps_*` `targetId`. Otherwise set `runMode: \"save_only\"` with flat steps. Set `risk: \"high\"` for irreversible external actions; set `suggest: true` for repeated workflows (2+ cycles), snippet pastes, or multi-field transfers with a PageSummary list — set `suggest: false` if one-off or incomplete.",
    "",
    "Steps:",
    ...stepLines,
    "",
    ...(containerLines.length > 0
      ? [
          "PageSummary Containers (for withinId ONLY, NEVER targetId):",
          ...containerLines,
          "",
        ]
      : []),
    ...(targetLines.length > 0 ? ["PageSummary Targets:", ...targetLines, ""] : []),
    ...(listLines.length > 0 ? ["PageSummary Lists:", ...listLines, ""] : []),
    ...(viewLines.length > 0 ? ["Page Summaries:", ...viewLines, ""] : []),
  ].join("\n");
}

function buildLocatorStabilityCounts(
  indexedSteps: readonly EnrichedStep[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of indexedSteps) {
    if (!step.target) continue;
    const seenInStep = new Set<string>();
    for (const loc of step.target) {
      const k = `${step.action}::${loc.kind}::${loc.value}`;
      if (!seenInStep.has(k)) {
        seenInStep.add(k);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function selectCapturedLocators(
  action: EnrichedStep["action"],
  rawLocators: readonly Locator[],
  stabilityCounts: ReadonlyMap<string, number>,
  preferInvariantOnly: boolean,
): Locator[] {
  const cloned = rawLocators.map((loc, idx) => ({ loc: { ...loc }, idx }));
  const countOf = (loc: Locator) =>
    stabilityCounts.get(`${action}::${loc.kind}::${loc.value}`) ?? 0;

  if (preferInvariantOnly) {
    const invariant = cloned.filter((entry) => countOf(entry.loc) >= 2);
    if (invariant.length > 0) {
      return invariant.map((entry) => entry.loc);
    }
  }

  return cloned
    .sort((a, b) => {
      const aCount = countOf(a.loc);
      const bCount = countOf(b.loc);
      const aStable = aCount >= 2 ? 1 : 0;
      const bStable = bCount >= 2 ? 1 : 0;
      if (aStable !== bStable) return bStable - aStable;
      if (a.loc.kind === b.loc.kind) {
        const diff = bCount - aCount;
        if (diff !== 0) return diff;
      }
      return a.idx - b.idx;
    })
    .map((entry) => entry.loc);
}

type LoopLeafContext = {
  itemKeys?: ReadonlySet<string>;
  fallbackItemKey?: string;
};

function findUniqueColumnByText(
  columns: SourceColumnMeta["columns"],
  rawText: string,
): SourceColumnMeta["columns"][number] | undefined {
  const needle = rawText.trim();
  if (!needle) return undefined;
  const exact = columns.filter((col) => col.texts.includes(needle));
  if (exact.length === 1) return exact[0];
  const prefixMatches = columns.filter((col) =>
    col.texts.some((t) => t === needle || t.startsWith(`${needle} `)),
  );
  if (prefixMatches.length === 1) return prefixMatches[0];
  return undefined;
}

function findUrlForHost(
  steps: readonly EnrichedStep[],
  host: string,
  exactHostWithPort?: string,
): string | undefined {
  if (exactHostWithPort && exactHostWithPort.includes(":")) {
    const exactNormalized = normalizeHost(exactHostWithPort);
    const portMatch =
      steps.find((s) => {
        if (s.action !== "tab_switch" || !s.url) return false;
        try {
          return normalizeHost(new URL(s.url).host) === exactNormalized;
        } catch {
          return false;
        }
      }) ??
      steps.find((s) => {
        if (!s.url) return false;
        try {
          return normalizeHost(new URL(s.url).host) === exactNormalized;
        } catch {
          return false;
        }
      });
    if (portMatch?.url) {
      return normalizeUrlHost(portMatch.url);
    }
  }
  const match =
    steps.find(
      (s) => s.action === "tab_switch" && resolveStepRealHost(s) === host && Boolean(s.url),
    ) ??
    steps.find((s) => resolveStepRealHost(s) === host && Boolean(s.url));
  return match?.url ? normalizeUrlHost(match.url) : undefined;
}

function resolveLeafStep(
  raw: ModelLeafStep,
  ctx: PromptContext,
  stabilityCounts: ReadonlyMap<string, number>,
  inLoop: boolean,
  loopContext?: LoopLeafContext,
): { step: CompiledLeafStep; host?: string; url?: string } | null {
  const captured =
    raw.stepIndex !== undefined &&
    raw.stepIndex >= 0 &&
    raw.stepIndex < ctx.indexedSteps.length
      ? ctx.indexedSteps[raw.stepIndex]
      : undefined;

  const psTarget = raw.targetId ? ctx.targets.get(raw.targetId) : undefined;
  const capturedRealHost = captured
    ? resolveStepRealHost({ app: captured.app, url: captured.url })
    : undefined;

  let effectiveWithinId = raw.withinId;
  let withinTarget = effectiveWithinId ? ctx.targets.get(effectiveWithinId) : undefined;
  if (!withinTarget && effectiveWithinId) {
    const mappedContainerId = ctx.lists.get(effectiveWithinId)?.containerId;
    if (mappedContainerId) {
      effectiveWithinId = mappedContainerId;
      withinTarget = ctx.targets.get(mappedContainerId);
    }
  }

  const loopItemKeys = loopContext?.itemKeys;
  const fallbackItemKey = loopContext?.fallbackItemKey;
  const normalizeLoopParam = (rawParam: string | undefined): string | undefined => {
    if (!rawParam || !rawParam.trim()) return undefined;
    const stripped = stripParamBraces(rawParam);
    if (!stripped) return undefined;
    if (loopItemKeys && fallbackItemKey && !loopItemKeys.has(stripped)) {
      return fallbackItemKey;
    }
    return stripped;
  };

  const withinLocators: Locator[] = [];
  if (withinTarget) {
    withinLocators.push(...withinTarget.locators.map((l) => ({ ...l })));
    const param = normalizeLoopParam(raw.withinTextParam) ?? fallbackItemKey;
    if (param) {
      withinLocators.push({ kind: "text", value: `{{${param}}}` });
    }
  }

  const copyMatchForStep =
    (raw.action === "readText" || raw.action === "readValue") &&
    raw.stepIndex !== undefined &&
    !raw.targetId
      ? ctx.copySourceMatches.get(raw.stepIndex)
      : undefined;
  const copyNoSourceForStep =
    (raw.action === "readText" || raw.action === "readValue") &&
    raw.stepIndex !== undefined &&
    !raw.targetId &&
    ctx.copyNoSourceSteps.has(raw.stepIndex);

  if (copyNoSourceForStep) {
    return null;
  }

  const targetLocators: Locator[] = [];
  const allowTextTarget =
    raw.targetTextParam &&
    raw.targetTextParam.trim() &&
    (withinTarget !== undefined || (inLoop && !captured?.target && !psTarget));
  if (allowTextTarget && raw.targetTextParam) {
    const param = normalizeLoopParam(raw.targetTextParam);
    if (param) {
      targetLocators.push({ kind: "text", value: `{{${param}}}` });
    }
  } else if (copyMatchForStep) {
    if (
      inLoop &&
      (withinTarget || copyMatchForStep.withinId) &&
      copyMatchForStep.invariantLocators.length > 0
    ) {
      targetLocators.push(
        ...copyMatchForStep.invariantLocators.map((l) => ({ ...l })),
      );
    } else {
      targetLocators.push(
        ...copyMatchForStep.cellLocators.map((l) => ({ ...l })),
      );
    }
  } else if (captured?.target && captured.target.length > 0) {
    const preferInvariant = inLoop || withinLocators.length > 0;
    targetLocators.push(
      ...selectCapturedLocators(
        captured.action,
        captured.target,
        stabilityCounts,
        preferInvariant,
      ),
    );
  } else if (psTarget && !psTarget.withinOnly && psTarget.locators.length > 0) {
    targetLocators.push(...psTarget.locators.map((l) => ({ ...l })));
  }

  let dedupedTarget = dedupeLocators(targetLocators);
  const dedupedWithin = dedupeLocators(withinLocators);

  if (
    (raw.action === "readText" || raw.action === "readValue") &&
    !allowTextTarget &&
    !copyMatchForStep &&
    effectiveWithinId &&
    withinTarget
  ) {
    const srcMeta = ctx.sourceMetaByContainerId.get(effectiveWithinId);
    if (srcMeta) {
      if (captured) {
        const capturedVal = captured.value ? captured.value.trim() : "";
        const matchedCol =
          (capturedVal ? findUniqueColumnByText(srcMeta.columns, capturedVal) : undefined) ??
          (captured.target
            ? srcMeta.columns.find((col) =>
                col.locators.some((cl) =>
                  captured.target!.some(
                    (tl) => tl.kind === cl.kind && tl.value === cl.value,
                  ),
                ),
              )
            : undefined);
        if (matchedCol && matchedCol.invariantLocators.length > 0) {
          dedupedTarget = dedupeLocators(matchedCol.invariantLocators);
        }
      } else if (dedupedTarget.length === 0 && raw.withinTextParam) {
        const colMatch = /^col(\d+)$/i.exec(stripParamBraces(raw.withinTextParam));
        if (colMatch) {
          const colIdx = Number(colMatch[1]) - 1;
          const colMeta = srcMeta.columns[colIdx];
          if (colMeta && colMeta.invariantLocators.length > 0) {
            dedupedTarget = dedupeLocators(colMeta.invariantLocators);
          }
        }
      }
    }
  }

  const psTargetHost =
    psTarget && !isPlaceholderHost(psTarget.host) ? psTarget.host : undefined;
  const withinTargetHost =
    withinTarget && !isPlaceholderHost(withinTarget.host)
      ? withinTarget.host
      : undefined;
  const stepHost = capturedRealHost ?? psTargetHost ?? withinTargetHost;
  const stepUrl = captured?.url ? normalizeUrlHost(captured.url) : undefined;

  const optionalPart = raw.optional !== undefined ? { optional: raw.optional } : {};
  const withinPart = dedupedWithin.length > 0 ? { within: dedupedWithin } : {};
  const valueProp = raw.value;

  switch (raw.action) {
    case "click": {
      if (dedupedTarget.length === 0) return null;
      return {
        step: { action: "click", target: dedupedTarget, ...withinPart, ...optionalPart },
        host: stepHost,
        url: stepUrl,
      };
    }
    case "fill": {
      if (dedupedTarget.length === 0) return null;
      const val = valueProp ?? captured?.value ?? "";
      return {
        step: {
          action: "fill",
          target: dedupedTarget,
          ...withinPart,
          value: val,
          ...optionalPart,
        },
        host: stepHost,
        url: stepUrl,
      };
    }
    case "insertText": {
      const val = valueProp ?? captured?.value ?? "";
      return {
        step: {
          action: "insertText",
          ...(dedupedTarget.length > 0 ? { target: dedupedTarget } : {}),
          ...withinPart,
          value: val,
          ...optionalPart,
        },
        host: stepHost,
        url: stepUrl,
      };
    }
    case "select": {
      if (dedupedTarget.length === 0) return null;
      const val = valueProp ?? captured?.value ?? "";
      return {
        step: {
          action: "select",
          target: dedupedTarget,
          ...withinPart,
          value: val,
          ...optionalPart,
        },
        host: stepHost,
        url: stepUrl,
      };
    }
    case "waitFor": {
      if (dedupedTarget.length === 0) return null;
      return {
        step: {
          action: "waitFor",
          target: dedupedTarget,
          ...withinPart,
          ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
          ...optionalPart,
        },
        host: stepHost,
        url: stepUrl,
      };
    }
    case "readText":
    case "readValue": {
      const rawBind = raw.bind?.trim();
      const rawVal = raw.value?.trim();
      const bindName = rawBind
        ? stripParamBraces(rawBind)
        : rawVal &&
            (/^\{\{[^}]+\}\}$/.test(rawVal) ||
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawVal))
          ? stripParamBraces(rawVal)
          : inLoop &&
              effectiveWithinId &&
              ctx.sourceMetaByContainerId.has(effectiveWithinId) &&
              raw.withinTextParam?.trim()
            ? stripParamBraces(raw.withinTextParam)
            : "";
      if (dedupedTarget.length === 0 || !bindName) return null;
      return {
        step: {
          action: raw.action,
          target: dedupedTarget,
          ...withinPart,
          bind: bindName,
          ...optionalPart,
        },
        host: stepHost,
        url: stepUrl,
      };
    }
    case "extractList": {
      if (!raw.bind?.trim()) return null;
      if (dedupedTarget.length === 0 && effectiveWithinId) {
        const srcMeta = ctx.sourceMetaByContainerId.get(effectiveWithinId);
        if (srcMeta) {
          const rowLocators: Locator[] = [
            {
              kind: "css",
              value: srcMeta.rowTag === "tr" ? "tr:has(td)" : srcMeta.rowTag,
            },
          ];
          const fields: Record<string, Locator[]> = {};
          for (let i = 0; i < srcMeta.columns.length; i += 1) {
            const col = srcMeta.columns[i];
            if (col.invariantLocators.length > 0) {
              fields[`col${i + 1}`] = [{ ...col.invariantLocators[0] }];
            }
          }
          return {
            step: {
              action: "extractList",
              target: rowLocators,
              ...withinPart,
              bind: raw.bind.trim(),
              ...(Object.keys(fields).length > 0 ? { fields } : {}),
              ...optionalPart,
            },
            host: stepHost,
            url: stepUrl,
          };
        }
      }
      if (dedupedTarget.length === 0) return null;
      return {
        step: {
          action: "extractList",
          target: dedupedTarget,
          ...withinPart,
          bind: raw.bind.trim(),
          ...optionalPart,
        },
        host: stepHost,
        url: stepUrl,
      };
    }
    case "navigate": {
      const seenHostnames = new Set<string>();
      for (const s of ctx.indexedSteps) {
        if (s.app) {
          const norm = normalizeHost(s.app);
          if (!isPlaceholderHost(norm)) seenHostnames.add(norm);
        }
        if (s.url) {
          const urlHost = hostnameFromUrl(s.url);
          if (urlHost) seenHostnames.add(urlHost);
        }
      }

      const rawUrl = raw.url?.trim() ? raw.url.trim() : undefined;
      const rawUrlHost = rawUrl ? hostnameFromUrl(rawUrl) : undefined;
      const rawUrlSeen = rawUrlHost !== undefined && seenHostnames.has(rawUrlHost);

      if (captured?.url) {
        const mergedUrl =
          rawUrl && rawUrlSeen
            ? mergeCapturedNavigateUrl(rawUrl, captured.url)
            : captured.url;
        const normalized = normalizeUrlHost(mergedUrl);
        return {
          step: { action: "navigate", url: normalized, ...optionalPart },
          host: hostnameFromUrl(normalized) ?? stepHost,
          url: normalized,
        };
      }

      if (rawUrl && !rawUrlSeen) {
        return null;
      }

      const targetHost =
        rawUrlHost ??
        (raw.host?.trim() && !isPlaceholderHost(normalizeHost(raw.host))
          ? normalizeHost(raw.host)
          : undefined) ??
        (captured?.app && !isPlaceholderHost(normalizeHost(captured.app))
          ? normalizeHost(captured.app)
          : undefined);
      const matchingHostUrl = targetHost
        ? findUrlForHost(ctx.indexedSteps, targetHost)
        : undefined;
      const candidateUrl = rawUrl
        ? mergeCapturedNavigateUrl(rawUrl, matchingHostUrl)
        : matchingHostUrl;
      if (!candidateUrl) return null;

      const normalized = normalizeUrlHost(candidateUrl);
      return {
        step: { action: "navigate", url: normalized, ...optionalPart },
        host: hostnameFromUrl(normalized) ?? stepHost,
        url: normalized,
      };
    }
    case "wait": {
      return {
        step: { action: "wait", ms: raw.ms ?? 500, ...optionalPart },
        host: stepHost,
        url: stepUrl,
      };
    }
    case "switchTab": {
      const rawHostTrimmed = raw.host?.trim() ?? "";
      const rawHostWithPort =
        rawHostTrimmed && !rawHostTrimmed.includes("://")
          ? rawHostTrimmed.split("/")[0] ?? ""
          : undefined;
      const hostFromRaw = rawHostTrimmed
        ? rawHostTrimmed.includes("://")
          ? hostnameFromUrl(rawHostTrimmed)
          : (() => {
              const norm = normalizeHost((rawHostWithPort ?? "").replace(/:\d+$/, ""));
              return isPlaceholderHost(norm) ? undefined : norm;
            })()
        : undefined;
      const rawUrlNorm = raw.url?.trim() ? normalizeUrlHost(raw.url.trim()) : undefined;
      const capturedUrlNorm = captured?.url?.trim()
        ? normalizeUrlHost(captured.url.trim())
        : undefined;

      const finalHost =
        hostFromRaw ??
        hostnameFromUrl(rawUrlNorm) ??
        (captured
          ? resolveStepRealHost({ app: captured.app, url: capturedUrlNorm })
          : undefined);
      if (!finalHost || isPlaceholderHost(finalHost)) {
        return null;
      }

      const fallbackUrl =
        (capturedUrlNorm && hostnameFromUrl(capturedUrlNorm) === finalHost
          ? capturedUrlNorm
          : undefined) ??
        findUrlForHost(ctx.indexedSteps, finalHost, rawHostWithPort);

      const resolvedUrl =
        capturedUrlNorm && hostnameFromUrl(capturedUrlNorm) === finalHost
          ? capturedUrlNorm
          : rawUrlNorm && hostnameFromUrl(rawUrlNorm) === finalHost
            ? normalizeUrlHost(mergeCapturedNavigateUrl(rawUrlNorm, fallbackUrl))
            : fallbackUrl;

      return {
        step: {
          action: "switchTab",
          host: finalHost,
          ...(resolvedUrl ? { url: resolvedUrl } : {}),
          ...optionalPart,
        },
        host: finalHost,
        url: resolvedUrl ?? stepUrl,
      };
    }
    case "key": {
      const key = raw.key?.trim() || captured?.key || "Enter";
      return {
        step: {
          action: "key",
          ...(dedupedTarget.length > 0 ? { target: dedupedTarget } : {}),
          ...withinPart,
          key,
          ...optionalPart,
        },
        host: stepHost,
        url: stepUrl,
      };
    }
    case "submit": {
      return {
        step: {
          action: "submit",
          ...(dedupedTarget.length > 0 ? { target: dedupedTarget } : {}),
          ...withinPart,
          ...optionalPart,
        },
        host: stepHost,
        url: stepUrl,
      };
    }
  }
}

function describeLeafRejection(
  raw: ModelLeafStep,
  ctx: PromptContext,
  inLoop = false,
): string {
  if (
    (raw.action === "readText" || raw.action === "readValue") &&
    raw.stepIndex !== undefined &&
    !raw.targetId &&
    ctx.copyNoSourceSteps.has(raw.stepIndex)
  ) {
    return "copy step has no readable source";
  }
  const hasBind = Boolean(
    raw.bind?.trim() ||
      (raw.value?.trim() &&
        (/^\{\{[^}]+\}\}$/.test(raw.value.trim()) ||
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.value.trim()))) ||
      (inLoop &&
        raw.withinId &&
        ctx.sourceMetaByContainerId.has(raw.withinId) &&
        raw.withinTextParam?.trim()),
  );
  if ((raw.action === "readText" || raw.action === "readValue" || raw.action === "extractList") && !hasBind) {
    return "missing bind";
  }
  if (raw.action === "navigate") {
    return `unseen or invalid navigate url=${raw.url ?? "-"}`;
  }
  if (raw.action === "switchTab") {
    return `invalid or placeholder host=${raw.host ?? "-"}`;
  }
  return `no target resolved (stepIndex=${raw.stepIndex ?? "-"}, targetId=${raw.targetId ?? "-"})`;
}

function logRejectedStep(
  raw: ModelStep | ModelLeafStep,
  reason: string,
): void {
  console.log(
    `[v2/compiler] rejected step action=${raw.action} stepIndex=${raw.stepIndex ?? "-"} targetId=${raw.targetId ?? "-"} withinId=${raw.withinId ?? "-"}: ${reason}`,
  );
}

const COMPILE_RESOLVE_RETRIES = 2;

function resolveSteps(
  rawSteps: readonly ModelStep[],
  ctx: PromptContext,
  stabilityCounts: ReadonlyMap<string, number>,
): {
  steps: CompiledStep[];
  stepHosts: Array<string | undefined>;
  hosts: string[];
  firstHost?: string;
  firstUrl?: string;
} | null {
  const out: CompiledStep[] = [];
  const stepHosts: Array<string | undefined> = [];
  const hosts: string[] = [];
  let firstHost: string | undefined;
  let firstUrl: string | undefined;

  const recordLocation = (host?: string, url?: string) => {
    if (host) {
      if (!hosts.includes(host)) hosts.push(host);
      if (!firstHost) firstHost = host;
    }
    if (url && !firstUrl) {
      firstUrl = url;
    }
  };

  for (let idx = 0; idx < rawSteps.length; idx++) {
    const raw = rawSteps[idx];
    if (raw.action === "forEach") {
      let resolvedItems: string | Record<string, string>[] | undefined;
      let sourceList: PageSummaryList | undefined;

      const explicitItemIds = raw.itemIds && raw.itemIds.length > 0 ? raw.itemIds : [];

      if (explicitItemIds.length > 0) {
        const rows: Record<string, string>[] = [];
        for (const itemId of explicitItemIds) {
          const item = ctx.items.get(itemId);
          if (item) {
            recordLocation(!isPlaceholderHost(item.host) ? item.host : undefined);
            rows.push({ ...item.fields });
          }
        }
        if (rows.length > 0) {
          resolvedItems = rows;
        }
        for (const list of ctx.lists.values()) {
          if (list.items.some((it) => explicitItemIds.includes(it.id))) {
            sourceList = list;
            break;
          }
        }
      } else if (raw.items && raw.items.trim()) {
        const key = stripParamBraces(raw.items);
        const list =
          ctx.lists.get(key) ??
          Array.from(ctx.lists.values()).find(
            (l) =>
              l.containerId !== undefined &&
              ctx.sourceMetaByContainerId.has(l.containerId),
          );
        if (list && list.items.length > 0) {
          recordLocation(
            !isPlaceholderHost(list.host) ? list.host : undefined,
            list.url,
          );
          resolvedItems = list.items.map((item) => ({ ...item.fields }));
          sourceList = list;
        } else if (key) {
          resolvedItems = key;
        }
      }
      if (sourceList?.url) {
        recordLocation(
          !isPlaceholderHost(sourceList.host) ? sourceList.host : undefined,
          sourceList.url,
        );
      }

      const sourceContainerId = sourceList?.containerId;
      const sourceMeta = sourceContainerId
        ? ctx.sourceMetaByContainerId.get(sourceContainerId)
        : undefined;
      const containerTarget = sourceContainerId
        ? ctx.targets.get(sourceContainerId)
        : undefined;

      let childRawSteps = raw.steps;
      let consumedTrailing = 0;
      if (
        (!childRawSteps || childRawSteps.length === 0) &&
        idx + 1 < rawSteps.length
      ) {
        const trailing: ModelLeafStep[] = [];
        for (let k = idx + 1; k < rawSteps.length; k++) {
          if (rawSteps[k].action === "forEach") break;
          trailing.push(rawSteps[k] as ModelLeafStep);
        }
        if (trailing.length > 0) {
          childRawSteps = trailing;
          consumedTrailing = trailing.length;
        }
      }

      if (!resolvedItems && !sourceMeta) {
        logRejectedStep(
          raw,
          `forEach items/itemIds not resolved (items=${raw.items ?? "-"}, itemIds=${JSON.stringify(raw.itemIds ?? [])})`,
        );
        return null;
      }
      if (!childRawSteps || childRawSteps.length === 0) {
        logRejectedStep(raw, "forEach missing nested steps");
        return null;
      }

      const sampleRows =
        Array.isArray(resolvedItems) && resolvedItems.length > 0
          ? resolvedItems
          : sourceList && sourceList.items.length > 0
            ? sourceList.items.map((item) => item.fields)
            : undefined;

      let loopItemKeys: ReadonlySet<string> | undefined;
      let fallbackItemKey: string | undefined;
      if (sampleRows && sampleRows.length > 0) {
        const keys = Object.keys(sampleRows[0]);
        const distinctKeys = keys.filter((k) => {
          const vals = sampleRows.map((r) => r[k]);
          return vals.every(Boolean) && new Set(vals).size === vals.length;
        });
        loopItemKeys = new Set(
          sampleRows.length > 1 && distinctKeys.length > 0 ? distinctKeys : keys,
        );
        fallbackItemKey = distinctKeys[0] ?? keys[0];
      }

      const nestedSteps: CompiledStep[] = [];
      for (const rawChild of childRawSteps) {
        const child: ModelLeafStep =
          (rawChild.action === "readText" || rawChild.action === "readValue") &&
          !rawChild.withinId &&
          (raw.withinId || sourceContainerId)
            ? {
                ...rawChild,
                withinId: raw.withinId ?? sourceContainerId,
                ...(rawChild.withinTextParam
                  ? {}
                  : raw.withinTextParam
                    ? { withinTextParam: raw.withinTextParam }
                    : {}),
              }
            : rawChild;
        const resolved = resolveLeafStep(
          child,
          ctx,
          stabilityCounts,
          true,
          { itemKeys: loopItemKeys, fallbackItemKey },
        );
        if (!resolved) {
          if (child.action === "switchTab") continue;
          logRejectedStep(child, describeLeafRejection(child, ctx, true));
          return null;
        }
        recordLocation(resolved.host, resolved.url);
        nestedSteps.push(resolved.step);
      }

      if (nestedSteps.length === 0) {
        logRejectedStep(raw, "forEach produced zero resolved child steps");
        return null;
      }

      if (sourceMeta) {
        const rowLocators: Locator[] = [
          {
            kind: "css",
            value: sourceMeta.rowTag === "tr" ? "tr:has(td)" : sourceMeta.rowTag,
          },
        ];
        const containerLocators = containerTarget
          ? dedupeLocators(containerTarget.locators.map((l) => ({ ...l })))
          : [];
        const fields: Record<string, Locator[]> = {};
        for (let i = 0; i < sourceMeta.columns.length; i += 1) {
          const col = sourceMeta.columns[i];
          if (col.invariantLocators.length > 0) {
            fields[`col${i + 1}`] = [{ ...col.invariantLocators[0] }];
          }
        }
        const existingExtract = out.find((s) => s.action === "extractList");
        if (existingExtract && existingExtract.action === "extractList") {
          resolvedItems = existingExtract.bind;
        } else {
          out.push({
            action: "extractList",
            target: rowLocators,
            ...(containerLocators.length > 0 ? { within: containerLocators } : {}),
            bind: "rows",
            ...(Object.keys(fields).length > 0 ? { fields } : {}),
          });
          stepHosts.push(
            sourceList && !isPlaceholderHost(sourceList.host)
              ? sourceList.host
              : undefined,
          );
          resolvedItems = "rows";
        }
      }

      out.push({
        action: "forEach",
        items: resolvedItems!,
        steps: nestedSteps,
        ...(raw.optional !== undefined ? { optional: raw.optional } : {}),
      });
      stepHosts.push(undefined);
      idx += consumedTrailing;
      continue;
    }

    const resolved = resolveLeafStep(
      raw as ModelLeafStep,
      ctx,
      stabilityCounts,
      false,
    );
    if (!resolved) {
      if (raw.action === "switchTab") continue;
      // A click scoped only to a container has no element to act on; skip it
      // and keep the rest of the workflow.
      if (
        raw.action === "click" &&
        raw.withinId &&
        raw.stepIndex === undefined &&
        !raw.targetId
      ) {
        console.log(
          `[v2/compiler] skipped click with only withinId=${raw.withinId} (no stepIndex/targetId)`,
        );
        continue;
      }
      logRejectedStep(raw, describeLeafRejection(raw as ModelLeafStep, ctx));
      return null;
    }
    recordLocation(resolved.host, resolved.url);
    out.push(resolved.step);
    stepHosts.push(resolved.host);
  }

  return { steps: out, stepHosts, hosts, firstHost, firstUrl };
}

function computeStats(
  allSteps: readonly V2Step[],
  repetitions: number,
): CompiledWorkflowStats {
  let observedMs = 0;
  for (let i = 1; i < allSteps.length; i++) {
    const prev = allSteps[i - 1];
    const curr = allSteps[i];
    if (curr.session === prev.session) {
      const dt = curr.ts - prev.ts;
      if (dt > 0 && dt < 60_000) {
        observedMs += dt;
      }
    }
  }

  const manualSeconds = Number((observedMs / 1000).toFixed(2));
  const replaySeconds = 0;
  const minutesPerWeek = Number((manualSeconds / 60).toFixed(2));

  return {
    repetitions,
    minutesPerWeek,
    manualSeconds,
    replaySeconds,
  };
}

function createCompileGeminiClient(
  opts?: CompileOptions,
  prompt?: string,
): GeminiClient {
  if (isGeminiClient(opts?.gemini)) {
    return opts.gemini;
  }
  const baseOpts: GeminiClientOptions = opts?.gemini ?? {};
  return createGeminiClient({
    ...baseOpts,
    model: opts?.model ?? baseOpts.model ?? resolveCompileModel(),
    thinkingBudget: baseOpts.thinkingBudget ?? 0,
    responseSchema:
      baseOpts.responseSchema ??
      (prompt ? buildCompilerSchemaForPrompt(prompt) : COMPILER_RESPONSE_SCHEMA),
    timeoutMs: baseOpts.timeoutMs ?? opts?.timeoutMs ?? resolveCompileTimeoutMs(),
  });
}

function collectFillTargets(
  steps: readonly CompiledStep[],
): Array<{ target: Locator[]; within?: Locator[] }> {
  const fills: Array<{ target: Locator[]; within?: Locator[] }> = [];
  for (const s of steps) {
    if (s.action === "forEach") {
      fills.push(...collectFillTargets(s.steps));
    } else if (
      (s.action === "fill" || s.action === "insertText" || s.action === "select") &&
      s.target &&
      s.target.length > 0
    ) {
      fills.push({ target: s.target, within: s.within });
    }
  }
  return fills;
}

function findExampleForSelfReadBind(
  bindName: string,
  readTarget: readonly Locator[],
  indexedSteps: readonly EnrichedStep[],
): string | undefined {
  for (let i = indexedSteps.length - 1; i >= 0; i--) {
    const s = indexedSteps[i];
    if (
      (s.action === "fill" || s.action === "paste") &&
      s.value &&
      s.target &&
      isSameStepTarget(readTarget, undefined, s.target, undefined)
    ) {
      return s.value;
    }
  }
  const needle = bindName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (needle) {
    for (let i = indexedSteps.length - 1; i >= 0; i--) {
      const s = indexedSteps[i];
      if (!s.value) continue;
      const lbl = (s.label ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (lbl && (lbl.includes(needle) || needle.includes(lbl))) {
        return s.value;
      }
    }
  }
  return undefined;
}

function stripSelfReadsToParams(
  steps: CompiledStep[],
  params: CompiledParam[],
  indexedSteps: readonly EnrichedStep[],
): CompiledStep[] {
  const existingParams = new Set(params.map((p) => p.name));
  const out: CompiledStep[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.action === "forEach") {
      const cleanedChildren = stripSelfReadsToParams(
        step.steps,
        params,
        indexedSteps,
      );
      if (cleanedChildren.length > 0) {
        out.push({ ...step, steps: cleanedChildren });
      }
      continue;
    }

    if (step.action === "readText" || step.action === "readValue") {
      const laterFills = collectFillTargets(steps.slice(i + 1));
      const isSelfRead = laterFills.some((f) =>
        isSameStepTarget(step.target, step.within, f.target, f.within),
      );
      if (isSelfRead) {
        if (!existingParams.has(step.bind)) {
          existingParams.add(step.bind);
          const example = findExampleForSelfReadBind(
            step.bind,
            step.target,
            indexedSteps,
          );
          params.push({
            name: step.bind,
            ...(example !== undefined ? { example } : {}),
          });
        }
        continue;
      }
    }

    out.push(step);
  }

  return out;
}

export async function compileWorkflow(
  input: CompileInput,
  opts?: CompileOptions,
): Promise<CompiledWorkflow | null> {
  const rawSteps: V2Step[] = input.steps
    ? input.steps
    : input.events
      ? eventsToSteps(input.events).steps
      : [];

  if (rawSteps.length === 0) {
    return null;
  }

  const enrichedAll = enrichSteps(rawSteps, input.events);
  const indexedSteps =
    enrichedAll.length > MAX_PROMPT_STEPS
      ? enrichedAll.slice(-MAX_PROMPT_STEPS)
      : enrichedAll;

  const repeatCount = Math.max(1, Math.trunc(input.repeatCount ?? 1));

  const summaryData = extractPageSummaryData(enrichedAll);
  const { copySourceMatches, copyNoSourceSteps } = resolveCopySourceContext(
    indexedSteps,
    summaryData.targets,
    summaryData.sourceCells,
    summaryData.nextTargetSeq,
  );

  const ctx: PromptContext = {
    allSteps: enrichedAll,
    indexedSteps,
    targets: summaryData.targets,
    lists: summaryData.lists,
    items: summaryData.items,
    sourceMetaByContainerId: summaryData.sourceMetaByContainerId,
    copySourceMatches,
    copyNoSourceSteps,
    summaryViews: summaryData.summaryViews,
  };

  const stabilityCounts = buildLocatorStabilityCounts(indexedSteps);
  const prompt = buildCompilePrompt(ctx, stabilityCounts);
  const gemini = createCompileGeminiClient(opts, prompt);

  const distinctApps = Array.from(
    new Set(
      indexedSteps
        .map((s) => resolveStepRealHost(s))
        .filter((h): h is string => Boolean(h)),
    ),
  );
  const irisDigest: Record<string, unknown> = {
    sourceApp: distinctApps[0] ?? "",
    destApp: distinctApps[distinctApps.length - 1] ?? "",
    apps: distinctApps,
    repetitions: repeatCount,
    steps: indexedSteps.slice(0, 20).map((s) => {
      const rawLabel = s.label ?? inferLabelFromTarget(s.target);
      return {
        action: s.action,
        app: resolveStepRealHost(s) ?? normalizeHost(s.app),
        ...(rawLabel ? { label: rawLabel } : {}),
      };
    }),
  };

  const hasPrecomputedIris = opts !== undefined && opts.irisJudgment !== undefined;
  const irisPromise: Promise<WorkflowIrisJudgment | null> = hasPrecomputedIris
    ? Promise.resolve(opts.irisJudgment!)
    : typeof opts?.iris === "function"
      ? opts.iris(irisDigest, opts.irisOptions).catch(() => null)
      : judgeWorkflowIris(irisDigest, opts?.iris ?? opts?.irisOptions).catch(
          () => null,
        );

  let [modelOut, irisResult] = await Promise.all([
    gemini.generateJson(prompt, ModelCompileOutputSchema),
    irisPromise,
  ]);

  // Iris decides; Gemini only compiles. Gemini's own suggest=false is ignored when Iris said yes.
  if (!modelOut.suggest && irisResult?.worthAutomating !== true) {
    console.log(`[v2/compiler] dropped: gemini suggest=false and no Iris yes`);
    return null;
  }
  if (irisResult?.worthAutomating === false) {
    console.log(`[v2/compiler] dropped: Iris said no`);
    return null;
  }
  if (modelOut.steps.length === 0) {
    console.log(`[v2/compiler] dropped: gemini returned no steps (suggest=${modelOut.suggest})`);
    return null;
  }

  // The model occasionally omits a step reference; one bad step voids the whole
  // compile, so regenerate before giving up.
  let resolved = resolveSteps(modelOut.steps, ctx, stabilityCounts);
  for (
    let retry = 0;
    retry < COMPILE_RESOLVE_RETRIES && (!resolved || resolved.steps.length === 0);
    retry += 1
  ) {
    console.log(`[v2/compiler] unresolved step, regenerating (${retry + 1}/${COMPILE_RESOLVE_RETRIES})`);
    modelOut = await gemini.generateJson(prompt, ModelCompileOutputSchema);
    if (modelOut.steps.length === 0) break;
    resolved = resolveSteps(modelOut.steps, ctx, stabilityCounts);
  }
  if (!resolved || resolved.steps.length === 0) {
    console.log(`[v2/compiler] dropped: no step resolved to a real target (${modelOut.steps.length} model steps)`);
    return null;
  }

  if (repeatCount >= 2) {
    const maxSeenForLocators = (
      action: CompiledLeafStep["action"],
      locs: readonly Locator[],
    ): number => {
      let maxSeen = 0;
      for (const loc of locs) {
        const c = stabilityCounts.get(`${action}::${loc.kind}::${loc.value}`) ?? 0;
        if (c > maxSeen) maxSeen = c;
      }
      return maxSeen;
    };

    const hasRepeatedSteps = resolved.steps.some(
      (s) =>
        s.action !== "forEach" &&
        "target" in s &&
        Array.isArray(s.target) &&
        maxSeenForLocators(s.action, s.target) >= 2,
    );

    if (hasRepeatedSteps) {
      let seenRepeatedAfter = false;
      for (let idx = resolved.steps.length - 1; idx >= 0; idx -= 1) {
        const s = resolved.steps[idx];
        if (s.action === "forEach") {
          seenRepeatedAfter = true;
          continue;
        }
        if ("target" in s && Array.isArray(s.target)) {
          const maxSeen = maxSeenForLocators(s.action, s.target);
          if (maxSeen >= 2) {
            seenRepeatedAfter = true;
          } else if (
            s.action === "click" &&
            maxSeen === 1 &&
            seenRepeatedAfter &&
            s.optional === undefined
          ) {
            const prevStep = resolved.steps[idx - 1];
            const currHost = resolved.stepHosts[idx];
            const prevHost = resolved.stepHosts[idx - 1];
            const isFirstOnPageOrHost =
              idx === 0 ||
              prevStep?.action === "navigate" ||
              prevStep?.action === "switchTab" ||
              (Boolean(currHost) && Boolean(prevHost) && currHost !== prevHost);
            if (isFirstOnPageOrHost) {
              resolved.steps[idx] = { ...s, optional: true };
            }
          } else if (
            s.action === "click" &&
            maxSeen === 1 &&
            s.optional === undefined
          ) {
            const currHost = resolved.stepHosts[idx];
            const prevHost = resolved.stepHosts[idx - 1];
            if (Boolean(currHost) && Boolean(prevHost) && currHost !== prevHost) {
              resolved.steps[idx] = { ...s, optional: true };
            }
          }
        }
      }
    }
  }

  const firstRealStep = indexedSteps.find((s) => resolveStepRealHost(s) !== undefined);
  const startHost =
    (resolved.firstHost && !isPlaceholderHost(resolved.firstHost)
      ? resolved.firstHost
      : undefined) ??
    (firstRealStep ? resolveStepRealHost(firstRealStep) : undefined);

  const matchingHostStep = startHost
    ? indexedSteps.find((s) => resolveStepRealHost(s) === startHost && s.url)
    : undefined;
  const candidateStartUrl =
    resolved.firstUrl && (!startHost || hostnameFromUrl(resolved.firstUrl) === startHost)
      ? resolved.firstUrl
      : matchingHostStep?.url
        ? normalizeUrlHost(matchingHostStep.url)
        : undefined;
  const rawStartUrl =
    candidateStartUrl && hostnameFromUrl(candidateStartUrl) !== undefined
      ? candidateStartUrl
      : undefined;

  const steps = [...resolved.steps];
  if (startHost && modelOut.kind !== "snippet") {
    const startSwitchStep: CompiledStep = {
      action: "switchTab",
      host: startHost,
      ...(rawStartUrl ? { url: rawStartUrl } : {}),
    };
    if (steps[0]?.action !== "switchTab") {
      steps.unshift(startSwitchStep);
    } else if (steps[0].host !== startHost) {
      steps.unshift(startSwitchStep);
    } else if (!steps[0].url && rawStartUrl) {
      steps[0] = { ...steps[0], url: rawStartUrl };
    }
  }

  const appsSet = new Set<string>(
    [startHost, ...resolved.hosts].filter(
      (h): h is string => typeof h === "string" && !isPlaceholderHost(h),
    ),
  );
  const apps = Array.from(appsSet);

  const params: CompiledParam[] = modelOut.params.map((p) => ({
    name: stripParamBraces(p.name),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.example !== undefined ? { example: p.example } : {}),
  }));

  const cleanedSteps = stripSelfReadsToParams(steps, params, indexedSteps);
  if (cleanedSteps.length === 0) {
    console.log(`[v2/compiler] dropped: all steps were self-reads`);
    return null;
  }

  const pauseBeforeSubmit =
    irisResult?.pauseBeforeSubmit === true || modelOut.risk === "high";

  const stats = computeStats(rawSteps, repeatCount);

  const candidate: CompiledWorkflow = {
    kind: modelOut.kind,
    name: modelOut.name.trim(),
    reason: modelOut.reason.trim(),
    risk: modelOut.risk,
    offerAt2: modelOut.offerAt2,
    runMode: modelOut.runMode,
    pauseBeforeSubmit,
    ...(rawStartUrl ? { startUrl: rawStartUrl } : {}),
    apps,
    params,
    steps: cleanedSteps,
    stats,
  };

  const seenHosts = new Set<string>();
  const sourceEntries: ReadonlyArray<{ app?: string; url?: string }> =
    input.events && input.events.length > 0 ? input.events : rawSteps;
  for (const e of sourceEntries) {
    if (e.url) {
      try {
        const parsed = new URL(e.url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          const urlHost = normalizeHost(parsed.host);
          if (!isPlaceholderHost(urlHost)) {
            seenHosts.add(urlHost);
          }
          continue;
        }
      } catch {
        // fall back to app if URL is invalid
      }
    }
    if (e.app) {
      const appHost = normalizeHost(e.app);
      if (!isPlaceholderHost(appHost)) {
        seenHosts.add(appHost);
      }
    }
  }

  const validated = validateCompiledWorkflow(candidate, {
    maxSteps: opts?.maxSteps,
    seenHosts,
  });
  if (!validated.ok) {
    console.log(`[v2/compiler] validation failed: ${validated.error}`);
    return null;
  }

  return validated.value;
}
