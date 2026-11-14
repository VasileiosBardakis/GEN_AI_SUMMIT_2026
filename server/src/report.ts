import type { Event, Finding, Report } from "@gen/shared";
import { ReportSchema } from "@gen/shared/schema.ts";
import { normalize } from "./detect/normalize.ts";
import type { ActionScript } from "./hands/types.ts";
import type { GeminiClient, GeminiClientOptions } from "./llm/gemini.ts";
import { mergeSessions } from "./merge-sessions.ts";
import { runPipeline } from "./pipeline.ts";

export interface BuildReportOptions {
  dataDir?: string;
  llm?: boolean;
  gemini?: GeminiClient | GeminiClientOptions;
  implement?: (solution: string, opts?: { name?: string }) => Promise<ActionScript>;
  scriptStore?: Map<string, ActionScript>;
  gapMs?: number;
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
  const mergedStreams = mergeSessions(
    sessionEvents,
    options.gapMs !== undefined ? { gapMs: options.gapMs } : undefined,
  );
  const findingIndexById = new Map<string, number>();
  const findings: Finding[] = [];

  for (const stream of mergedStreams) {
    const steps = normalize(stream.events);
    const streamFindings = await runPipeline(steps, {
      llm: options.llm ?? true,
      events: stream.events,
      gemini: options.gemini,
      implement: options.implement,
      dataDir: options.dataDir,
      scriptStore: options.scriptStore,
    });
    for (const finding of streamFindings) {
      const existingIndex = findingIndexById.get(finding.id);
      if (existingIndex === undefined) {
        findingIndexById.set(finding.id, findings.length);
        findings.push(finding);
      } else if (
        finding.stats.repetitions > findings[existingIndex].stats.repetitions
      ) {
        findings[existingIndex] = finding;
      }
    }
  }

  return ReportSchema.parse({
    generatedAt: Date.now(),
    session: "all",
    findings,
  });
}
