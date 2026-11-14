import type { Event, Report } from "@gen/shared";
import { ReportSchema } from "@gen/shared/schema.ts";
import { writeSnippetArtifact } from "./artifacts.ts";
import { normalize } from "./detect/normalize.ts";
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
  const findings = detected.map(({ finding, text }) =>
    dataDir !== undefined
      ? writeSnippetArtifact(dataDir, finding, text)
      : finding,
  );
  return ReportSchema.parse({
    generatedAt: Date.now(),
    session,
    findings,
  });
}
