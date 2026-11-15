import type { Event, Step, Workflow } from "@gen/shared";
import {
  createGeminiClient,
  type GeminiClient,
  type GeminiClientOptions,
  type ZodLikeSchema,
} from "../llm/gemini.ts";

export type TipSuggestion = {
  tip: string | null;
  keys: string[] | null;
  why: string;
};

export type SuggestTipOptions = {
  client?: GeminiClient;
  gemini?: GeminiClientOptions;
  events?: Event[];
};

type SchemaIssue = {
  path: ReadonlyArray<PropertyKey>;
  message: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export const TipSuggestionSchema: ZodLikeSchema<TipSuggestion> = {
  safeParse(data: unknown) {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return {
        success: false,
        error: {
          message: "Expected object",
          issues: [{ path: [], message: "Expected an object" }],
        },
      };
    }

    const record = data as Record<string, unknown>;
    const issues: SchemaIssue[] = [];

    let tip: string | null = null;
    if (record.tip === null) {
      tip = null;
    } else if (isNonEmptyString(record.tip)) {
      tip = record.tip.trim();
    } else {
      issues.push({
        path: ["tip"],
        message: "Expected non-empty string or null",
      });
    }

    let keys: string[] | null = null;
    if (record.keys === null) {
      keys = null;
    } else if (
      Array.isArray(record.keys) &&
      record.keys.every((item) => isNonEmptyString(item))
    ) {
      keys = record.keys.map((item) => item.trim());
    } else {
      issues.push({
        path: ["keys"],
        message: "Expected array of non-empty strings or null",
      });
    }

    let why = "";
    if (isNonEmptyString(record.why)) {
      why = record.why.trim();
    } else {
      issues.push({
        path: ["why"],
        message: "Expected non-empty string",
      });
    }

    if (issues.length > 0) {
      return {
        success: false,
        error: {
          message: issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`).join("; "),
          issues,
        },
      };
    }

    return {
      success: true,
      data: { tip, keys, why },
    };
  },
};

function summarizeStepValue(value: Step["value"]): string | { param: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null && "param" in value) {
    return { param: value.param };
  }
  const str = String(value);
  return str.length > 120 ? `${str.slice(0, 117)}...` : str;
}

function summarizeEvents(events: Event[] | undefined): Array<Record<string, unknown>> {
  if (!events || events.length === 0) return [];

  const relevant: Array<Record<string, unknown>> = [];
  for (const ev of events) {
    const grid = ev.meta?.grid;
    const menu = ev.meta?.menu;
    const key = ev.meta?.key;
    const modifiers = ev.meta?.modifiers;

    if (!grid && !menu && !key && ev.type !== "contextmenu") {
      continue;
    }

    const entry: Record<string, unknown> = {
      type: ev.type,
      app: ev.app,
    };
    if (ev.window) entry.window = ev.window;
    if (ev.target?.label) entry.targetLabel = ev.target.label;
    if (ev.target?.role) entry.targetRole = ev.target.role;
    if (grid) entry.grid = grid;
    if (menu) entry.menu = menu;
    if (key) entry.key = key;
    if (modifiers && modifiers.length > 0) entry.modifiers = modifiers;

    relevant.push(entry);
    if (relevant.length >= 30) break;
  }

  return relevant;
}

export function buildTipPrompt(workflow: Workflow, events?: Event[]): string {
  const workflowSummary = {
    id: workflow.id,
    name: workflow.name,
    sourceApp: workflow.sourceApp,
    destApp: workflow.destApp,
    instanceCount: workflow.instances.length,
    params: workflow.params.map((p) => p.name),
    steps: workflow.steps.map((step, index) => ({
      index: index + 1,
      action: step.action,
      targets: step.target?.map((loc) => `${loc.kind}:${loc.value}`) ?? [],
      ...(step.value !== undefined ? { value: summarizeStepValue(step.value) } : {}),
    })),
  };

  const eventMetadata = summarizeEvents(events);

  return [
    "You are an advisory workflow assistant. Inspect the repeated user workflow below and decide whether a single built-in keyboard shortcut or UI menu command in the application can replace or significantly simplify these manual steps.",
    "This is purely show-only advice for the user. Do NOT propose automation scripts, macros, or code.",
    "",
    "Return ONLY valid JSON in one of these two shapes:",
    '- When a built-in shortcut or menu tip applies: { "tip": "<short actionable tip>", "keys": ["<shortcut>", ...], "why": "<concise reason referencing the repeated workflow>" }',
    '  (If a built-in menu command applies without a keyboard shortcut, set "keys" to null.)',
    '- When no built-in shortcut or menu command applies: { "tip": null, "keys": null, "why": "<concise reason why no shortcut or menu tip applies>" }',
    "",
    "Rules:",
    '- "why" must always be a non-empty string.',
    "- Only suggest shortcuts or menu actions that genuinely apply to the observed app and steps; when uncertain or when the task is bespoke cross-app data transfer, return tip: null and keys: null.",
    "",
    "Workflow summary:",
    JSON.stringify(workflowSummary, null, 2),
    "",
    "Event menu/grid metadata:",
    JSON.stringify(eventMetadata, null, 2),
  ].join("\n");
}

export async function suggestTip(
  workflow: Workflow,
  opts?: SuggestTipOptions,
): Promise<TipSuggestion> {
  const client = opts?.client ?? createGeminiClient(opts?.gemini);
  const prompt = buildTipPrompt(workflow, opts?.events);
  return client.generateJson(prompt, TipSuggestionSchema);
}
