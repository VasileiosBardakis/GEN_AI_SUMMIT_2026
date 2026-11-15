import type { Event, Locator } from "@gen/shared";
import { z } from "../../../shared/node_modules/zod/index.js";
import {
  createGeminiClient,
  type GeminiClient,
  type GeminiClientOptions,
} from "../llm/gemini.ts";
import {
  judgeWorkflowIris,
  type IrisJudgeOptions,
  type WorkflowIrisJudgment,
} from "../llm/iris.ts";
import { eventsToSteps, type PiiMap, type V2Step } from "./steps.ts";
import { countRepeatedPatterns, splitEpisodes } from "./tries.ts";
import {
  normalizeHost,
  validateCompiledWorkflow,
  type CompiledLeafStep,
  type CompiledParam,
  type CompiledStep,
  type CompiledWorkflow,
  type CompiledWorkflowStats,
} from "./validate.ts";

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
  maxSteps?: number;
  timeoutMs?: number;
  model?: string;
};

const DEFAULT_COMPILE_TIMEOUT_MS = 5000;
const MAX_PROMPT_STEPS = 60;
const MAX_SUMMARY_CHARS = 4096;

const REDACTED_MARKER_RE = /\[REDACTED:([A-Z0-9_]+)(?:#([^\]]+))?\]/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;
const FOUR_BY_FOUR_CARD_RE = /^\d{4}(?:[ -]\d{4}){3}$/;
const PHONE_RE =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{4}\b/g;
const PII_TOKEN_RE = /__PII_[A-Za-z0-9_]+__/;
const ANY_REDACTED_RE = /\[REDACTED:/i;
const PLACEHOLDER_EMAIL_RE = /<email>/i;

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
  offerAt2: z.boolean(),
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
    description: "Exact targetId from PageSummary Targets (omit if not listed).",
  },
  withinId: {
    type: "string",
    description: "Exact container targetId from PageSummary Targets (omit if not listed).",
  },
  targetTextParam: {
    type: "string",
    description: "Inside forEach only: param name for exact-text target.",
  },
  withinTextParam: {
    type: "string",
    description: "Inside forEach only: param name to scope within container row.",
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
    kind: { type: "string", enum: ["snippet", "workflow"] },
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
          items: { type: "string" },
          itemIds: { type: "array", items: { type: "string" } },
          steps: {
            type: "array",
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
  container?: { testid?: string; itemKey?: string };
  rawPageSummary?: unknown;
};

type PageSummaryTarget = {
  id: string;
  host: string;
  description: string;
  locators: Locator[];
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
  containerId?: string;
  description: string;
  items: PageSummaryListItem[];
};

type PromptContext = {
  indexedSteps: EnrichedStep[];
  targets: Map<string, PageSummaryTarget>;
  lists: Map<string, PageSummaryList>;
  items: Map<string, PageSummaryListItem>;
  summaryViews: Array<{ host: string; viewKey: string; content: string }>;
  repeatCount: number;
};

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

function luhnCheck(digitsOnly: string): boolean {
  if (digitsOnly.length < 13 || digitsOnly.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    const digitRaw = digitsOnly.charCodeAt(i) - 48;
    if (digitRaw < 0 || digitRaw > 9) return false;
    let digit = digitRaw;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function createPromptScrubber(piiMap: PiiMap): {
  scrubText: (raw: string) => string;
  restoreMap: Map<string, string>;
} {
  const restoreMap = new Map<string, string>();
  const rawToToken = new Map<string, string>();
  const redactedToToken = new Map<string, string>();
  const typeCounters = new Map<string, number>();

  for (const [key, realVal] of piiMap.entries()) {
    restoreMap.set(key, realVal);
    const piiMatch = /^__PII_([A-Z0-9_]+)_(\d+)__$/.exec(key);
    if (piiMatch) {
      const kind = piiMatch[1];
      const idx = Number(piiMatch[2]);
      typeCounters.set(kind, Math.max(typeCounters.get(kind) ?? 0, idx));
      if (!rawToToken.has(realVal)) {
        rawToToken.set(realVal, key);
      }
    }
  }

  function nextToken(kind: string): string {
    const upper = kind.toUpperCase();
    const next = (typeCounters.get(upper) ?? 0) + 1;
    typeCounters.set(upper, next);
    return `__PII_${upper}_${next}__`;
  }

  function scrubText(raw: string): string {
    let out = raw.replace(REDACTED_MARKER_RE, (full, kind: string) => {
      const existing = redactedToToken.get(full);
      if (existing) return existing;
      const token = nextToken(kind || "REDACTED");
      redactedToToken.set(full, token);
      const localReal = piiMap.get(full);
      if (localReal !== undefined) {
        restoreMap.set(token, localReal);
      }
      return token;
    });

    out = out.replace(EMAIL_RE, (email) => {
      const existing = rawToToken.get(email);
      if (existing) return existing;
      const token = nextToken("EMAIL");
      rawToToken.set(email, token);
      restoreMap.set(token, email);
      return token;
    });

    out = out.replace(CARD_RE, (card) => {
      const digits = card.replace(/\D/g, "");
      if (!luhnCheck(digits) && !FOUR_BY_FOUR_CARD_RE.test(card)) {
        return card;
      }
      const existing = rawToToken.get(card);
      if (existing) return existing;
      const token = nextToken("CARD");
      rawToToken.set(card, token);
      restoreMap.set(token, card);
      return token;
    });

    out = out.replace(PHONE_RE, (phone) => {
      const existing = rawToToken.get(phone);
      if (existing) return existing;
      const token = nextToken("PHONE");
      rawToToken.set(phone, token);
      restoreMap.set(token, phone);
      return token;
    });

    return out;
  }

  return { scrubText, restoreMap };
}

function scrubUnknown(value: unknown, scrubText: (s: string) => string): unknown {
  if (typeof value === "string") {
    return scrubText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubUnknown(item, scrubText));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubUnknown(v, scrubText);
    }
    return out;
  }
  return value;
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

    return {
      ...step,
      label: matched?.target?.label,
      role: matched?.target?.role,
      tag: matched?.target?.tag,
      ...(containerMeta && typeof containerMeta === "object"
        ? {
            container: {
              ...(typeof containerMeta.testid === "string"
                ? { testid: containerMeta.testid }
                : {}),
              ...(typeof containerMeta.itemKey === "string"
                ? { itemKey: containerMeta.itemKey }
                : {}),
            },
          }
        : {}),
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

function extractPageSummaryData(
  steps: EnrichedStep[],
  scrubText: (s: string) => string,
): {
  targets: Map<string, PageSummaryTarget>;
  lists: Map<string, PageSummaryList>;
  items: Map<string, PageSummaryListItem>;
  summaryViews: Array<{ host: string; viewKey: string; content: string }>;
} {
  const latestByView = new Map<
    string,
    { host: string; viewKey: string; summary: unknown }
  >();

  for (const step of steps) {
    if (step.rawPageSummary === undefined) continue;
    const host = normalizeHost(step.app);
    const scrubbed = scrubUnknown(step.rawPageSummary, scrubText);

    let viewKey = host;
    if (typeof scrubbed === "string") {
      const firstLine = scrubbed.split(/\r?\n/)[0]?.trim() ?? "";
      viewKey = firstLine || host;
    } else if (scrubbed && typeof scrubbed === "object") {
      const rec = scrubbed as Record<string, unknown>;
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
    }

    latestByView.set(`${host}::${viewKey}`, {
      host,
      viewKey,
      summary: scrubbed,
    });
  }

  const targets = new Map<string, PageSummaryTarget>();
  const lists = new Map<string, PageSummaryList>();
  const items = new Map<string, PageSummaryListItem>();
  const summaryViews: Array<{ host: string; viewKey: string; content: string }> = [];

  let targetSeq = 0;
  let listSeq = 0;

  function addTarget(
    host: string,
    description: string,
    locators: Locator[],
  ): string {
    targetSeq += 1;
    const id = `ps_${targetSeq}`;
    targets.set(id, { id, host, description, locators });
    return id;
  }

  function addList(
    host: string,
    description: string,
    rawItems: Array<{ fields: Record<string, string>; targetId?: string }>,
    containerId?: string,
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
    lists.set(id, { id, host, containerId, description, items: listItems });
    return id;
  }

  for (const entry of latestByView.values()) {
    const { host, viewKey, summary } = entry;

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
          containerId = addTarget(host, desc, locators);
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

      summaryViews.push({
        host,
        viewKey,
        content: JSON.stringify(summary).slice(0, MAX_SUMMARY_CHARS),
      });
    }
  }

  return { targets, lists, items, summaryViews };
}

const COMPACT_LEAF_ACTIONS = [
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

function buildCompilerResponseSchema(ctx: PromptContext): Record<string, unknown> {
  const hasTargets = ctx.targets.size > 0;
  const hasLists = ctx.lists.size > 0;

  const leafProps: Record<string, unknown> = {
    action: { type: "string", enum: [...COMPACT_LEAF_ACTIONS] },
    stepIndex: { type: "integer" },
    bind: { type: "string", description: "Plain identifier e.g. itemId" },
    value: { type: "string" },
    host: { type: "string" },
    url: { type: "string" },
    key: { type: "string" },
    ...(hasTargets
      ? {
          targetId: { type: "string" },
          withinId: { type: "string" },
          targetTextParam: { type: "string" },
          withinTextParam: { type: "string" },
        }
      : {}),
  };

  const topStepProps: Record<string, unknown> = {
    ...leafProps,
    ...(hasLists
      ? {
          action: { type: "string", enum: [...COMPACT_LEAF_ACTIONS, "forEach"] },
          items: { type: "string" },
          itemIds: {
            type: "array",
            items: { type: "string" },
          },
          steps: {
            type: "array",
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
      kind: { type: "string", enum: ["snippet", "workflow"] },
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
  };
}

function buildCompilePrompt(
  ctx: PromptContext,
  scrubText: (s: string) => string,
): string {
  const seenUrlForApp = new Set<string>();
  const stepLines = ctx.indexedSteps.map((step, idx) => {
    const app = normalizeHost(step.app);
    const entry: Record<string, unknown> = {
      stepIndex: idx,
      action: step.action,
      app,
    };
    const label = step.label ?? inferLabelFromTarget(step.target);
    if (label) entry.label = scrubText(label);
    if (step.role) entry.role = step.role;
    if (step.tag) entry.tag = step.tag;
    if (step.target && step.target.length > 0) entry.hasTarget = true;
    if (step.value !== undefined) entry.value = scrubText(step.value);
    if (step.key !== undefined) entry.key = step.key;
    if (
      step.url !== undefined &&
      (step.action === "nav" ||
        step.action === "tab_switch" ||
        !seenUrlForApp.has(app))
    ) {
      seenUrlForApp.add(app);
      entry.url = normalizeUrlHost(scrubText(step.url));
    }
    if (step.container) {
      entry.container = scrubUnknown(step.container, scrubText);
    }
    return JSON.stringify(entry);
  });

  const targetLines = Array.from(ctx.targets.values()).map((t) =>
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
      ...(l.containerId ? { containerTargetId: l.containerId } : {}),
      description: l.description,
      items: l.items.map((it) => ({ itemId: it.id, ...it.fields })),
    }),
  );

  const viewLines = ctx.summaryViews
    .filter((v) => !v.content.startsWith("{"))
    .map((v) => `[${v.host} / ${v.viewKey}]\n${v.content}`);

  return [
    "Compile the repeated browser steps into ONE concise parameterized workflow JSON.",
    "",
    "RULES:",
    "1. Never write selectors. Every click/fill/select/readText/key/submit MUST have `stepIndex` of a step with `hasTarget: true` (matching the action, e.g. `fill` stepIndex for `fill`, `key` stepIndex for `key`), OR an exact `targetId` from PageSummary Targets. Never emit empty \"\".",
    "2. Pick ONE clean repetition and drop one-off stray clicks.",
    "3. Keep all distinct form fields (multi-field Tab forms keep every `fill` via its own `stepIndex`). Always preserve Enter-key submissions (`action: \"key\", key: \"Enter\"` with the `key` step's `stepIndex`) rather than dropping them.",
    "4. Copied values use `readText` with `bind` (REQUIRED on every `readText`, e.g. `\"bind\":\"<varName>\"`, NEVER omit `bind`) and `fill` with `\"{{<varName>}}\"`.",
    "5. User-supplied variables go in `params[]` and `\"{{paramName}}\"`. Never invent placeholder/masked literals; preserve `__PII_*__` tokens if typed literally.",
    "6. `switchTab` uses `stepIndex` or `host` (hostname only), never `url`. `navigate` MUST reuse `stepIndex` or keep the full URL including port and path (never strip to bare host/origin).",
    "7. Use `forEach` ONLY when PageSummary Lists is printed below AND has remaining unprocessed items (`runMode: \"run_remaining\"`, `itemIds` = ONLY remaining `itemId`s). Inside `forEach.steps`, only set `withinId` to a container `targetId` from PageSummary Targets (if any) and `withinTextParam` to an item field name from PageSummary Lists. Otherwise set `runMode: \"save_only\"` and emit flat steps.",
    "8. `offerAt2: true` when clearly generalizable at 2 repeats; `risk: \"high\"` for irreversible external actions (payments/wires/deletes/external sends); `suggest: false` only if one-off.",
    "",
    `Observed repeat count: ${ctx.repeatCount}`,
    "",
    "Steps:",
    ...stepLines,
    "",
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
      if (a.loc.kind === b.loc.kind) {
        const diff = countOf(b.loc) - countOf(a.loc);
        if (diff !== 0) return diff;
      }
      return a.idx - b.idx;
    })
    .map((entry) => entry.loc);
}

function dedupeLocators(locators: readonly Locator[]): Locator[] {
  const seen = new Set<string>();
  const out: Locator[] = [];
  for (const loc of locators) {
    const key = `${loc.kind}::${loc.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ ...loc });
    }
  }
  return out;
}

function restoreText(raw: string, restoreMap: ReadonlyMap<string, string>): string {
  let out = raw;
  for (const [token, realVal] of restoreMap.entries()) {
    if (out.includes(token)) {
      out = out.split(token).join(realVal);
    }
  }
  return out;
}

function hasAnyPiiMarker(value: string): boolean {
  return (
    PLACEHOLDER_EMAIL_RE.test(value) ||
    ANY_REDACTED_RE.test(value) ||
    PII_TOKEN_RE.test(value)
  );
}

function resolveLeafStep(
  raw: ModelLeafStep,
  ctx: PromptContext,
  stabilityCounts: ReadonlyMap<string, number>,
  restoreMap: ReadonlyMap<string, string>,
  inLoop: boolean,
): { step: CompiledLeafStep; host?: string; url?: string } | null {
  const captured =
    raw.stepIndex !== undefined &&
    raw.stepIndex >= 0 &&
    raw.stepIndex < ctx.indexedSteps.length
      ? ctx.indexedSteps[raw.stepIndex]
      : undefined;

  const psTarget = raw.targetId ? ctx.targets.get(raw.targetId) : undefined;
  const withinTarget = raw.withinId ? ctx.targets.get(raw.withinId) : undefined;

  const withinLocators: Locator[] = [];
  if (withinTarget) {
    withinLocators.push(...withinTarget.locators.map((l) => ({ ...l })));
    if (raw.withinTextParam && raw.withinTextParam.trim()) {
      const param = stripParamBraces(raw.withinTextParam);
      if (param) {
        withinLocators.push({ kind: "text", value: `{{${param}}}` });
      }
    }
  }

  const targetLocators: Locator[] = [];
  const allowTextTarget =
    raw.targetTextParam &&
    raw.targetTextParam.trim() &&
    (withinTarget !== undefined || (inLoop && !captured?.target && !psTarget));
  if (allowTextTarget && raw.targetTextParam) {
    const param = stripParamBraces(raw.targetTextParam);
    if (param) {
      targetLocators.push({ kind: "text", value: `{{${param}}}` });
    }
  } else {
    if (captured?.target && captured.target.length > 0) {
      const preferInvariant = inLoop || withinLocators.length > 0;
      targetLocators.push(
        ...selectCapturedLocators(
          captured.action,
          captured.target,
          stabilityCounts,
          preferInvariant,
        ),
      );
    }
    if (psTarget && psTarget.locators.length > 0) {
      targetLocators.push(...psTarget.locators.map((l) => ({ ...l })));
    }
  }

  const dedupedTarget = dedupeLocators(targetLocators);
  const dedupedWithin = dedupeLocators(withinLocators);

  const stepHost = captured
    ? normalizeHost(captured.app)
    : psTarget
      ? psTarget.host
      : withinTarget
        ? withinTarget.host
        : undefined;
  const stepUrl = captured?.url ? normalizeUrlHost(restoreText(captured.url, restoreMap)) : undefined;

  const optionalPart = raw.optional !== undefined ? { optional: raw.optional } : {};
  const withinPart = dedupedWithin.length > 0 ? { within: dedupedWithin } : {};
  const restoredValue =
    raw.value !== undefined ? restoreText(raw.value, restoreMap) : undefined;

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
      const val =
        restoredValue ??
        (captured?.value !== undefined ? restoreText(captured.value, restoreMap) : "");
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
      const val =
        restoredValue ??
        (captured?.value !== undefined ? restoreText(captured.value, restoreMap) : "");
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
      const val =
        restoredValue ??
        (captured?.value !== undefined ? restoreText(captured.value, restoreMap) : "");
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
      const rawValCandidate = raw.value?.trim() ?? "";
      const safeValBind =
        rawValCandidate &&
        !hasAnyPiiMarker(rawValCandidate) &&
        rawValCandidate !== captured?.value
          ? stripParamBraces(rawValCandidate)
          : "";
      const bindName =
        raw.bind?.trim() ||
        safeValBind ||
        (!withinTarget && raw.withinTextParam?.trim()
          ? stripParamBraces(raw.withinTextParam)
          : "") ||
        (!withinTarget && raw.targetTextParam?.trim()
          ? stripParamBraces(raw.targetTextParam)
          : "");
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
      if (dedupedTarget.length === 0 || !raw.bind?.trim()) return null;
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
      let targetHost: string | undefined;
      if (raw.url) {
        try {
          targetHost = normalizeHost(new URL(raw.url).hostname);
        } catch {
          // ignore invalid URL when inferring host
        }
      }
      if (!targetHost && raw.host?.trim()) {
        targetHost = normalizeHost(raw.host);
      }
      if (!targetHost && captured?.app) {
        targetHost = normalizeHost(captured.app);
      }
      const matchingHostUrl = targetHost
        ? ctx.indexedSteps.find((s) => {
            if (!s.url) return false;
            if (normalizeHost(s.app) === targetHost) return true;
            try {
              return normalizeHost(new URL(s.url).hostname) === targetHost;
            } catch {
              return false;
            }
          })?.url
        : undefined;
      const fallbackUrl = captured?.url ?? matchingHostUrl;
      const candidateUrl = raw.url ?? fallbackUrl;
      if (!candidateUrl) {
        if (raw.host?.trim()) {
          const host = normalizeHost(raw.host);
          return {
            step: { action: "switchTab", host, ...optionalPart },
            host,
            url: stepUrl,
          };
        }
        return null;
      }
      const mergedUrl = raw.url
        ? mergeCapturedNavigateUrl(raw.url, fallbackUrl)
        : candidateUrl;
      const normalized = normalizeUrlHost(restoreText(mergedUrl, restoreMap));
      let navHost = stepHost;
      try {
        navHost = normalizeHost(new URL(normalized).hostname);
      } catch {
        // Keep stepHost if URL parsing fails; validator will catch invalid URL
      }
      return {
        step: { action: "navigate", url: normalized, ...optionalPart },
        host: navHost,
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
      let rawHost = raw.host?.trim() || "";
      if (!rawHost && raw.url?.trim()) {
        try {
          rawHost = new URL(raw.url.trim()).hostname;
        } catch {
          rawHost = raw.url.trim();
        }
      }
      if (!rawHost) {
        rawHost = captured?.app ?? "";
      }
      if (!rawHost.trim()) return null;
      const host = normalizeHost(rawHost);
      return {
        step: { action: "switchTab", host, ...optionalPart },
        host,
        url: stepUrl,
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

function resolveSteps(
  rawSteps: readonly ModelStep[],
  ctx: PromptContext,
  stabilityCounts: ReadonlyMap<string, number>,
  restoreMap: ReadonlyMap<string, string>,
): {
  steps: CompiledStep[];
  hosts: string[];
  firstHost?: string;
  firstUrl?: string;
} | null {
  const out: CompiledStep[] = [];
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

  for (const raw of rawSteps) {
    if (raw.action === "forEach") {
      let resolvedItems: string | Record<string, string>[] | undefined;

      if (raw.itemIds && raw.itemIds.length > 0) {
        const rows: Record<string, string>[] = [];
        for (const itemId of raw.itemIds) {
          const item = ctx.items.get(itemId);
          if (item) {
            recordLocation(item.host);
            const restoredRow: Record<string, string> = {};
            for (const [k, v] of Object.entries(item.fields)) {
              restoredRow[k] = restoreText(v, restoreMap);
            }
            rows.push(restoredRow);
          }
        }
        if (rows.length > 0) {
          resolvedItems = rows;
        }
      } else if (raw.items && raw.items.trim()) {
        const key = stripParamBraces(raw.items);
        const list = ctx.lists.get(key);
        if (list && list.items.length > 0) {
          recordLocation(list.host);
          resolvedItems = list.items.map((item) => {
            const restoredRow: Record<string, string> = {};
            for (const [k, v] of Object.entries(item.fields)) {
              restoredRow[k] = restoreText(v, restoreMap);
            }
            return restoredRow;
          });
        } else if (key) {
          resolvedItems = key;
        }
      }

      if (!resolvedItems || !raw.steps || raw.steps.length === 0) {
        return null;
      }

      const nestedSteps: CompiledStep[] = [];
      for (const child of raw.steps) {
        const resolved = resolveLeafStep(
          child,
          ctx,
          stabilityCounts,
          restoreMap,
          true,
        );
        if (!resolved) return null;
        recordLocation(resolved.host, resolved.url);
        nestedSteps.push(resolved.step);
      }

      out.push({
        action: "forEach",
        items: resolvedItems,
        steps: nestedSteps,
        ...(raw.optional !== undefined ? { optional: raw.optional } : {}),
      });
      continue;
    }

    const resolved = resolveLeafStep(
      raw as ModelLeafStep,
      ctx,
      stabilityCounts,
      restoreMap,
      false,
    );
    if (!resolved) return null;
    recordLocation(resolved.host, resolved.url);
    out.push(resolved.step);
  }

  return { steps: out, hosts, firstHost, firstUrl };
}

function countCompiledExecutions(
  steps: readonly CompiledStep[],
  repetitions: number,
): { leafCount: number; replayExecutions: number } {
  let leafCount = 0;
  let replayExecutions = 0;
  for (const step of steps) {
    if (step.action === "forEach") {
      const inner = countCompiledExecutions(step.steps, 1);
      leafCount += inner.leafCount;
      const iterCount = Array.isArray(step.items)
        ? step.items.length
        : Math.max(1, repetitions);
      replayExecutions += inner.replayExecutions * iterCount;
    } else {
      leafCount += 1;
      replayExecutions += 1;
    }
  }
  return { leafCount, replayExecutions };
}

function computeStats(
  allSteps: readonly V2Step[],
  compiledSteps: readonly CompiledStep[],
  repetitions: number,
): CompiledWorkflowStats {
  const { leafCount, replayExecutions } = countCompiledExecutions(
    compiledSteps,
    repetitions,
  );
  const episodes = splitEpisodes([...allSteps]);
  let observedSeconds = 0;
  for (const ep of episodes) {
    observedSeconds += Math.max(0, (ep.endTs - ep.startTs) / 1000);
  }

  const floorManual = Math.max(1, repetitions * Math.max(1, leafCount) * 1.5);
  const manualSeconds = Number(Math.max(floorManual, observedSeconds).toFixed(2));
  const rawReplay = Math.max(0.5, replayExecutions * 0.35);
  const replaySeconds = Number(
    Math.min(manualSeconds * 0.5, rawReplay).toFixed(2),
  );
  const minutesPerWeek = Number(
    ((Math.max(0, manualSeconds - replaySeconds) * 5) / 60).toFixed(2),
  );

  return {
    repetitions,
    minutesPerWeek,
    manualSeconds,
    replaySeconds,
  };
}

function createCompileGeminiClient(
  ctx: PromptContext,
  opts?: CompileOptions,
): GeminiClient {
  if (isGeminiClient(opts?.gemini)) {
    return opts.gemini;
  }
  const baseOpts: GeminiClientOptions = opts?.gemini ?? {};
  return createGeminiClient({
    ...baseOpts,
    ...(opts?.model !== undefined ? { model: opts.model } : {}),
    thinkingBudget: baseOpts.thinkingBudget ?? 0,
    responseSchema:
      baseOpts.responseSchema ?? buildCompilerResponseSchema(ctx),
    timeoutMs: baseOpts.timeoutMs ?? opts?.timeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS,
  });
}

export async function compileWorkflow(
  input: CompileInput,
  opts?: CompileOptions,
): Promise<CompiledWorkflow | null> {
  const piiMap: PiiMap = new Map(input.piiMap ?? []);
  const rawSteps: V2Step[] = input.steps
    ? input.steps
    : input.events
      ? eventsToSteps(input.events, piiMap).steps
      : [];

  if (rawSteps.length === 0) {
    return null;
  }

  const enrichedAll = enrichSteps(rawSteps, input.events);
  const indexedSteps =
    enrichedAll.length > MAX_PROMPT_STEPS
      ? enrichedAll.slice(-MAX_PROMPT_STEPS)
      : enrichedAll;

  const patterns = countRepeatedPatterns(rawSteps, { minRepeats: 2 });
  const inferredRepeats = patterns[0]?.count ?? 1;
  const repeatCount = Math.max(
    1,
    Math.trunc(input.repeatCount ?? inferredRepeats),
  );

  const { scrubText, restoreMap } = createPromptScrubber(piiMap);
  const summaryData = extractPageSummaryData(enrichedAll, scrubText);

  const ctx: PromptContext = {
    indexedSteps,
    ...summaryData,
    repeatCount,
  };

  const prompt = buildCompilePrompt(ctx, scrubText);
  const gemini = createCompileGeminiClient(ctx, opts);

  const distinctApps = Array.from(
    new Set(indexedSteps.map((s) => normalizeHost(s.app)).filter(Boolean)),
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
        app: normalizeHost(s.app),
        ...(rawLabel ? { label: scrubText(rawLabel) } : {}),
      };
    }),
  };

  const irisPromise: Promise<WorkflowIrisJudgment | null> =
    typeof opts?.iris === "function"
      ? opts.iris(irisDigest, opts.irisOptions).catch(() => null)
      : judgeWorkflowIris(irisDigest, opts?.iris ?? opts?.irisOptions).catch(
          () => null,
        );

  const [modelOut, irisResult] = await Promise.all([
    gemini.generateJson(prompt, ModelCompileOutputSchema),
    irisPromise,
  ]);

  if (!modelOut.suggest) {
    return null;
  }
  if (irisResult?.worthAutomating === false) {
    return null;
  }
  if (modelOut.steps.length === 0) {
    return null;
  }

  const stabilityCounts = buildLocatorStabilityCounts(indexedSteps);
  const resolved = resolveSteps(
    modelOut.steps,
    ctx,
    stabilityCounts,
    restoreMap,
  );
  if (!resolved || resolved.steps.length === 0) {
    return null;
  }

  const fallbackFirst = indexedSteps.find((s) => s.url) ?? indexedSteps[0];
  const startHost = normalizeHost(
    resolved.firstHost ?? fallbackFirst.app,
  );
  const matchingHostStep = indexedSteps.find(
    (s) => normalizeHost(s.app) === startHost && s.url,
  );
  const rawStartUrl =
    matchingHostStep?.url
      ? normalizeUrlHost(restoreText(matchingHostStep.url, restoreMap))
      : resolved.firstUrl
        ? resolved.firstUrl
        : fallbackFirst.url
          ? normalizeUrlHost(restoreText(fallbackFirst.url, restoreMap))
          : undefined;

  const steps = [...resolved.steps];
  if (steps[0]?.action !== "switchTab") {
    steps.unshift({ action: "switchTab", host: startHost });
  } else if (steps[0].host !== startHost) {
    steps.unshift({ action: "switchTab", host: startHost });
  }

  const appsSet = new Set<string>([startHost, ...resolved.hosts]);
  const apps = Array.from(appsSet).filter(Boolean);

  const params: CompiledParam[] = modelOut.params.map((p) => {
    const restoredDesc =
      p.description !== undefined
        ? restoreText(p.description, restoreMap)
        : undefined;
    const restoredExample =
      p.example !== undefined
        ? restoreText(p.example, restoreMap)
        : undefined;
    return {
      name: stripParamBraces(p.name),
      ...(restoredDesc && !hasAnyPiiMarker(restoredDesc)
        ? { description: restoredDesc }
        : {}),
      ...(restoredExample && !hasAnyPiiMarker(restoredExample)
        ? { example: restoredExample }
        : {}),
    };
  });

  const pauseBeforeSubmit =
    irisResult?.pauseBeforeSubmit === true || modelOut.risk === "high";

  const stats = computeStats(rawSteps, steps, repeatCount);

  const candidate: CompiledWorkflow = {
    kind: modelOut.kind,
    name: restoreText(modelOut.name, restoreMap).trim(),
    reason: restoreText(modelOut.reason, restoreMap).trim(),
    risk: modelOut.risk,
    offerAt2: modelOut.offerAt2,
    runMode: modelOut.runMode,
    pauseBeforeSubmit,
    ...(rawStartUrl ? { startUrl: rawStartUrl } : {}),
    apps,
    params,
    steps,
    stats,
  };

  const validated = validateCompiledWorkflow(candidate, {
    maxSteps: opts?.maxSteps,
  });
  if (!validated.ok) {
    console.log(`[v2/compiler] validation failed: ${validated.error}`);
    return null;
  }

  return validated.value;
}
