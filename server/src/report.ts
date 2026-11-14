import type { Event, Report } from "@gen/shared";
import { ReportSchema } from "@gen/shared/schema.ts";
import { normalize } from "./detect/normalize.ts";
import { detectSnippets } from "./detect/snippet.ts";

export function buildReport(session: string, events: Event[] = []): Report {
  const steps = normalize(events);
  const findings = detectSnippets(steps);
  return ReportSchema.parse({
    generatedAt: Date.now(),
    session,
    findings,
  });
}
