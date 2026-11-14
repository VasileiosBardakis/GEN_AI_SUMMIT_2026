import { z } from "zod";
import { ALL_EVENT_TYPES, type Event } from "./contract.ts";

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

const _check: z.infer<typeof EventSchema> extends Event ? true : never = true;
void _check;
