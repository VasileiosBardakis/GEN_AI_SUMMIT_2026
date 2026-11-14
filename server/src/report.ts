import type { Event, Finding, Report } from "@gen/shared";
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

export function buildCombinedReport(sessionEvents: Event[][]): Report {
  const seenIds = new Set<string>();
  const findings: Finding[] = [];

  for (const events of sessionEvents) {
    const steps = normalize(events);
    for (const finding of detectSnippets(steps)) {
      if (!seenIds.has(finding.id)) {
        seenIds.add(finding.id);
        findings.push(finding);
      }
    }
  }

  return ReportSchema.parse({
    generatedAt: Date.now(),
    session: "all",
    findings,
  });
}

