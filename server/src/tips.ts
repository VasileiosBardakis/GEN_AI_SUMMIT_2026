import type { Event } from "@gen/shared";
import {
  createGeminiClient,
  type GeminiClient,
  type GeminiClientOptions,
  type ZodLikeSchema,
} from "./llm/gemini.ts";

export type FlowTip = {
  tip: string | null;
  keys: string[] | null;
  why: string;
};

export type FlowTipOptions = {
  client?: GeminiClient;
  gemini?: GeminiClientOptions;
  exclude?: string[];
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export const FlowTipSchema: ZodLikeSchema<FlowTip> = {
  safeParse(data: unknown) {
    const record =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    const keysValid =
      record !== null &&
      (record.keys === null ||
        (Array.isArray(record.keys) && record.keys.every((key) => isNonEmptyString(key))));
    if (
      !record ||
      !keysValid ||
      !(record.tip === null || isNonEmptyString(record.tip)) ||
      !isNonEmptyString(record.why)
    ) {
      return {
        success: false,
        error: { message: "Expected { tip: string|null, keys: string[]|null, why: string }" },
      };
    }
    return {
      success: true,
      data: {
        tip: record.tip === null ? null : record.tip.trim(),
        keys: record.keys === null ? null : (record.keys as string[]).map((key) => key.trim()),
        why: record.why.trim(),
      },
    };
  },
};

const FLOW_TIP_EVENT_TYPES = new Set<Event["type"]>([
  "click",
  "contextmenu",
  "copy",
  "cut",
  "paste",
  "input",
  "change",
  "keydown",
  "key",
  "submit",
  "tab_switch",
]);

function summarizeFlowEvents(events: Event[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const ev of events) {
    if (!FLOW_TIP_EVENT_TYPES.has(ev.type)) continue;
    const entry: Record<string, unknown> = { type: ev.type, app: ev.app };
    if (ev.target?.role) entry.role = ev.target.role;
    if (ev.target?.tag) entry.tag = ev.target.tag;
    if (ev.target?.label) entry.label = ev.target.label.slice(0, 60);
    if (ev.meta?.key) entry.key = ev.meta.key;
    if (ev.meta?.modifiers && ev.meta.modifiers.length > 0) {
      entry.modifiers = ev.meta.modifiers;
    }
    if (ev.meta?.menu) entry.menu = ev.meta.menu;
    if (ev.meta?.grid) {
      entry.grid = {
        isFormula: ev.meta.grid.isFormula,
        formulaFunc: ev.meta.grid.formulaFunc,
      };
    }
    if (ev.meta?.typing) {
      entry.typing = {
        keystrokeCount: ev.meta.typing.keystrokeCount,
        backspaceCount: ev.meta.typing.backspaceCount,
      };
    }
    if (ev.clipboard?.fromApp || ev.clipboard?.toApp) {
      entry.clipboard = {
        fromApp: ev.clipboard.fromApp,
        toApp: ev.clipboard.toApp,
      };
    }
    out.push(entry);
  }
  return out.slice(-40);
}

export function buildFlowTipPrompt(events: Event[], exclude?: string[]): string {
  return [
    "You are an advisory flow coach. The user is repeating the same manual browser interaction pattern.",
    "Suggest ONE outside way to speed up this exact pattern: a keyboard shortcut (browser or the app), a built-in menu command, or an OS-level flow booster (e.g. clipboard history, window snapping).",
    "Do NOT propose automations, macros, or code.",
    "",
    "Return ONLY valid JSON:",
    '{ "tip": string | null, "keys": string[] | null, "why": string }',
    '(If a menu command applies without a keyboard shortcut, set "keys" to null.)',
    'Each "keys" entry must be one complete shortcut (e.g. "Ctrl+C"), never a separate modifier/key token.',
    "Use tip: null and keys: null when the user already uses the faster shortcut or when no meaningful shortcut applies.",
    "Focus on the interaction shape and ignore personal values.",
    ...(exclude && exclude.length > 0
      ? [`Already shown (do NOT suggest these again): ${exclude.join(", ")}`]
      : []),
    "",
    "Interaction sequence (most recent last, personal values omitted):",
    JSON.stringify(summarizeFlowEvents(events), null, 2),
  ].join("\n");
}

export async function suggestFlowTip(
  events: Event[],
  opts?: FlowTipOptions,
): Promise<FlowTip | null> {
  const client =
    opts?.client ?? createGeminiClient({ thinkingBudget: 0, ...opts?.gemini });
  return client.generateJson(buildFlowTipPrompt(events, opts?.exclude), FlowTipSchema);
}
