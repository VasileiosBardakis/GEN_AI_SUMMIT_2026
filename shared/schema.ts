import { z } from "zod";
import {
  ALL_EVENT_TYPES,
  type Event,
  type Finding,
  type Report,
  type Verdict,
} from "./contract.ts";

export const LocatorSchema = z.object({
  kind: z.enum(["testid", "aria", "css", "text", "uia"]),
  value: z.string(),
});

export const EventTypeSchema = z.enum(ALL_EVENT_TYPES);

export const EventSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  ts: z.number(),
  session: z.string().min(1),
  source: z.enum(["browser", "desktop", "agent-log"]),
  app: z.string().min(1),
  window: z.string().optional(),
  url: z.string().optional(),
  type: EventTypeSchema,
  target: z
    .object({
      locators: z.array(LocatorSchema),
      tag: z.string().optional(),
      label: z.string().optional(),
      role: z.string().optional(),
    })
    .optional(),
  value: z.string().optional(),
  clipboard: z
    .object({
      fromApp: z.string().optional(),
      toApp: z.string().optional(),
      fromUrl: z.string().optional(),
      fromCell: z.string().optional(),
      text: z.string().optional(),
      textHash: z.string().optional(),
      timeSinceCopyMs: z.number().optional(),
    })
    .optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const EventsSchema = z.array(EventSchema);

export const VerdictSchema = z.enum(["rung0", "rung1", "rung2", "rung3", "do_not_automate"]);

export const FindingSchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().optional(),
  verdict: VerdictSchema,
  title: z.string().min(1),
  why: z.string(),
  whyNotNext: z.string(),
  stats: z.object({
    repetitions: z.number().int().nonnegative(),
    minutesPerWeek: z.number().nonnegative(),
    stability: z.number().min(0).max(1),
  }),
  artifact: z
    .object({
      kind: z.enum(["snippet", "playwright", "ahk", "text"]),
      path: z.string(),
      verified: z.boolean(),
    })
    .optional(),
  dryRun: z
    .object({
      passed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .optional(),
  cost: z
    .object({
      scriptUsd: z.number().nonnegative(),
      scriptSeconds: z.number().nonnegative(),
      agentUsd: z.number().nonnegative(),
      agentSeconds: z.number().nonnegative(),
    })
    .optional(),
});

export const ReportSchema = z.object({
  generatedAt: z.number(),
  session: z.string(),
  findings: z.array(FindingSchema),
});

export const ScriptLocatorKindSchema = z.enum(["testid", "aria", "css", "text", "xpath"]);

export const ScriptLocatorSchema = z.object({
  kind: ScriptLocatorKindSchema,
  value: z.string().refine((s) => s.trim().length > 0, "expected non-empty string"),
});

export type ScriptLocatorKind = z.infer<typeof ScriptLocatorKindSchema>;
export type ScriptLocator = z.infer<typeof ScriptLocatorSchema>;

const ExtractFieldsSchema = z.union([
  z
    .array(
      z.object({
        name: z.string().refine((s) => s.trim().length > 0, "expected non-empty string"),
        locator: ScriptLocatorSchema,
      }),
    )
    .transform((entries) => {
      const out: Record<string, ScriptLocator> = {};
      for (const entry of entries) out[entry.name] = entry.locator;
      return out;
    }),
  z.record(z.string(), ScriptLocatorSchema),
]);

const ForEachItemsSchema = z.union([
  z.string().refine((s) => s.trim().length > 0, "expected non-empty binding name"),
  z.array(
    z.record(z.string(), z.unknown()).transform((row) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) out[k] = String(v);
      return out;
    }),
  ),
]);

const nonEmptyBind = z.string().refine((s) => s.trim().length > 0, "expected non-empty string");

export const ScriptDomStepSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("click"),
    target: ScriptLocatorSchema,
    optional: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("fill"),
    target: ScriptLocatorSchema,
    value: z.string(),
    optional: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("insertText"),
    target: ScriptLocatorSchema.optional(),
    value: z.string(),
    optional: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("select"),
    target: ScriptLocatorSchema,
    value: z.string(),
    optional: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("waitFor"),
    target: ScriptLocatorSchema,
    timeoutMs: z.number().positive().optional(),
    optional: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("readText"),
    target: ScriptLocatorSchema,
    bind: nonEmptyBind,
    optional: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("readValue"),
    target: ScriptLocatorSchema,
    bind: nonEmptyBind,
    optional: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("extractList"),
    target: ScriptLocatorSchema,
    bind: nonEmptyBind,
    fields: ExtractFieldsSchema.optional(),
    optional: z.boolean().optional(),
  }),
]);

export type ScriptDomStep = z.infer<typeof ScriptDomStepSchema>;

export type ScriptStep =
  | ScriptDomStep
  | { action: "navigate"; url: string; optional?: boolean }
  | { action: "wait"; ms: number; optional?: boolean }
  | {
      action: "forEach";
      items: Record<string, string>[] | string;
      steps: ScriptStep[];
      optional?: boolean;
    };

export const ScriptStepSchema: z.ZodType<ScriptStep, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion("action", [
    ...ScriptDomStepSchema.options,
    z.object({
      action: z.literal("navigate"),
      url: z.string().regex(/^https?:\/\//i, "expected http(s) URL"),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("wait"),
      ms: z.number().nonnegative(),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("forEach"),
      items: ForEachItemsSchema,
      steps: z.array(ScriptStepSchema).min(1),
      optional: z.boolean().optional(),
    }),
  ]),
);

export const ActionScriptSchema = z
  .object({
    name: z.string().optional(),
    steps: z.array(ScriptStepSchema).min(1),
  })
  .transform(({ name, steps }) => ({
    ...(name ? { name } : {}),
    steps,
  }));

export type ActionScript = z.infer<typeof ActionScriptSchema>;

export const EyesTriggerEventSchema = z.enum([
  "focus",
  "typing_prefix",
  "click",
  "copy",
  "nav",
]);

export type EyesTriggerEvent = z.infer<typeof EyesTriggerEventSchema>;

export const EyesDetectionSpecSchema = z.object({
  triggerEvent: EyesTriggerEventSchema,
  intent: z.string().refine((s) => s.trim().length > 0, "expected non-empty intent"),
  scope: z.object({
    apps: z.array(z.string()).default([]),
    urlPatterns: z.array(z.string()).default([]),
    pageHints: z.array(z.string()).default([]),
  }),
  targetHints: z.object({
    roles: z.array(z.string()).default([]),
    labelContains: z.array(z.string()).default([]),
    locators: z.array(ScriptLocatorSchema).default([]),
  }),
  textHints: z.object({
    prefixHints: z.array(z.string()).default([]),
    minCharsBeforeMatch: z.number().int().nonnegative().default(0),
  }),
  guards: z.object({
    fieldEmptyOnly: z.boolean().default(true),
    requireClipboard: z.boolean().default(false),
    cooldownMs: z.number().int().nonnegative().default(60_000),
    minSignals: z.number().int().min(1).max(4).default(2),
  }),
});

export type EyesDetectionSpec = z.infer<typeof EyesDetectionSpecSchema>;

export const LibraryEntryKindSchema = z.enum(["snippet", "workflow"]);
export const LibraryEntryStatusSchema = z.enum(["suggested", "active", "paused"]);

export type LibraryEntryKind = z.infer<typeof LibraryEntryKindSchema>;
export type LibraryEntryStatus = z.infer<typeof LibraryEntryStatusSchema>;

export const LibraryEntrySchema = z.object({
  id: z.string().refine((s) => /^[A-Za-z0-9_-]+$/.test(s), "expected safe id"),
  name: z.string().refine((s) => s.trim().length > 0, "expected non-empty name"),
  description: z.string().refine((s) => s.trim().length > 0, "expected non-empty description"),
  kind: LibraryEntryKindSchema,
  status: LibraryEntryStatusSchema.default("suggested"),
  solution: z.string().refine((s) => s.trim().length > 0, "expected non-empty solution"),
  script: ActionScriptSchema,
  eyes: EyesDetectionSpecSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  runCount: z.number().int().nonnegative().default(0),
});

export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;

export const ImplementedLibraryDraftSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  kind: LibraryEntryKindSchema.optional(),
  script: ActionScriptSchema,
  eyes: z
    .object({
      triggerEvent: EyesTriggerEventSchema.default("focus"),
      intent: z.string().optional(),
      scope: z
        .object({
          apps: z.array(z.string()).default([]),
          urlPatterns: z.array(z.string()).default([]),
          pageHints: z.array(z.string()).default([]),
        })
        .default({}),
      targetHints: z
        .object({
          roles: z.array(z.string()).default([]),
          labelContains: z.array(z.string()).default([]),
          locators: z
            .array(
              z.object({
                kind: ScriptLocatorKindSchema,
                value: z.string(),
              }),
            )
            .default([]),
        })
        .default({}),
      textHints: z
        .object({
          prefixHints: z.array(z.string()).default([]),
          minCharsBeforeMatch: z.number().int().nonnegative().default(0),
        })
        .default({}),
      guards: z
        .object({
          fieldEmptyOnly: z.boolean().default(true),
          requireClipboard: z.boolean().default(false),
          cooldownMs: z.number().int().nonnegative().default(60_000),
          minSignals: z.number().int().min(1).max(4).default(2),
        })
        .default({}),
    })
    .optional(),
});

export type ImplementedLibraryDraft = z.infer<typeof ImplementedLibraryDraftSchema>;

const _check: z.infer<typeof EventSchema> extends Event ? true : never = true;
void _check;

const _checkVerdict1: z.infer<typeof VerdictSchema> extends Verdict ? true : never = true;
const _checkVerdict2: Verdict extends z.infer<typeof VerdictSchema> ? true : never = true;
void _checkVerdict1;
void _checkVerdict2;

const _checkFinding1: z.infer<typeof FindingSchema> extends Finding ? true : never = true;
const _checkFinding2: Finding extends z.infer<typeof FindingSchema> ? true : never = true;
void _checkFinding1;
void _checkFinding2;

const _checkReport1: z.infer<typeof ReportSchema> extends Report ? true : never = true;
const _checkReport2: Report extends z.infer<typeof ReportSchema> ? true : never = true;
void _checkReport1;
void _checkReport2;
