import { z } from "zod";
import type { Event } from "./contract.ts";

export const LocatorSchema = z.object({
  kind: z.enum(["testid", "aria", "css", "text", "uia"]),
  value: z.string(),
});

export const EventSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  ts: z.number(),
  session: z.string().min(1),
  source: z.enum(["browser", "desktop", "agent-log"]),
  app: z.string().min(1),
  window: z.string().optional(),
  url: z.string().optional(),
  type: z.enum(["click", "input", "paste", "copy", "nav", "submit", "key", "tool_call"]),
  target: z
    .object({
      locators: z.array(LocatorSchema),
      tag: z.string().optional(),
      label: z.string().optional(),
    })
    .optional(),
  value: z.string().optional(),
  clipboard: z
    .object({
      fromApp: z.string().optional(),
      toApp: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const EventsSchema = z.array(EventSchema);

const _check: z.infer<typeof EventSchema> extends Event ? true : never = true;
void _check;
