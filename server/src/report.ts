import type { Event, Finding, Report } from "@gen/shared";
import { ReportSchema } from "@gen/shared/schema.ts";
import { normalize } from "./detect/normalize.ts";
import type { ActionScript } from "./hands/types.ts";
import type { GeminiClient, GeminiClientOptions } from "./llm/gemini.ts";
import { runPipeline } from "./pipeline.ts";

export interface BuildReportOptions {
  dataDir?: string;
  llm?: boolean;
  gemini?: GeminiClient | GeminiClientOptions;
  implement?: (solution: string, opts?: { name?: string }) => Promise<ActionScript>;
  scriptStore?: Map<string, ActionScript>;
}

export async function buildReport(
  session: string,
  events: Event[] = [],
  opts?: string | BuildReportOptions,
): Promise<Report> {
  const options: BuildReportOptions =
    typeof opts === "string" ? { dataDir: opts } : (opts ?? {});
  const steps = normalize(events);
  const findings = await runPipeline(steps, {
    llm: options.llm ?? true,
    events,
    gemini: options.gemini,
    implement: options.implement,
    dataDir: options.dataDir,
    scriptStore: options.scriptStore,
  });
  return ReportSchema.parse({
    generatedAt: Date.now(),
    session,
    findings,
  });
}

export async function buildCombinedReport(
  sessionEvents: Event[][],
  opts?: string | BuildReportOptions,
): Promise<Report> {
  const options: BuildReportOptions =
    typeof opts === "string" ? { dataDir: opts } : (opts ?? {});
  const seenIds = new Set<string>();
  const findings: Finding[] = [];

  for (const events of sessionEvents) {
    const steps = normalize(events);
    const sessionFindings = await runPipeline(steps, {
      llm: options.llm ?? true,
      events,
      gemini: options.gemini,
      implement: options.implement,
      dataDir: options.dataDir,
      scriptStore: options.scriptStore,
    });
    for (const finding of sessionFindings) {
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
