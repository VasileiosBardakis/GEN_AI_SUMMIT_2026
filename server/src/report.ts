import type { Event, Finding, Report } from "@gen/shared";
import { ReportSchema } from "@gen/shared/schema.ts";
import { writeSnippetArtifact } from "./artifacts.ts";
import { normalize } from "./detect/normalize.ts";
import { detectShortValues } from "./detect/short-values.ts";
import { detectSnippetsWithText } from "./detect/snippet.ts";

export interface BuildReportOptions {
  dataDir?: string;
}

export function buildReport(
  session: string,
  events: Event[] = [],
  opts?: string | BuildReportOptions,
): Report {
  const dataDir = typeof opts === "string" ? opts : opts?.dataDir;
  const steps = normalize(events);
  const detected = detectSnippetsWithText(steps);
  const findings = [
    ...detected.map(({ finding, text }) =>
      dataDir !== undefined
        ? writeSnippetArtifact(dataDir, finding, text)
        : finding,
    ),
    ...detectShortValues(steps, events),
  ];
  return ReportSchema.parse({
    generatedAt: Date.now(),
    session,
    findings,
  });
}

export function buildCombinedReport(
  sessionEvents: Event[][],
  opts?: string | BuildReportOptions,
): Report {
  const dataDir = typeof opts === "string" ? opts : opts?.dataDir;
  const seenIds = new Set<string>();
  const findings: Finding[] = [];

  for (const events of sessionEvents) {
    const steps = normalize(events);
    for (const { finding, text } of detectSnippetsWithText(steps)) {
      if (!seenIds.has(finding.id)) {
        seenIds.add(finding.id);
        findings.push(
          dataDir !== undefined
            ? writeSnippetArtifact(dataDir, finding, text)
            : finding,
        );
      }
    }
    for (const finding of detectShortValues(steps, events)) {
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

