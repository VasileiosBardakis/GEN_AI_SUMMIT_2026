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
