import type { Event } from "@gen/shared";
import { EventsSchema } from "@gen/shared/schema.ts";

export function parseEvents(
  x: unknown,
): { ok: true; events: Event[] } | { ok: false; error: string } {
  const result = EventsSchema.safeParse(x);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, events: result.data };
}
