import type { Finding } from "@gen/shared";
import type { EyesDetectionSpec, LibraryEntry } from "@gen/shared/schema.ts";
import type { ActionScript } from "./types.ts";
import type { FlowNode, Suggestion } from "./suggestion.ts";

export type OptimizationKind = "snippet" | "workflow";
export type OptimizationStatus = "active" | "suggested" | "paused";

export interface OptimizationItem {
  id: string;
  title: string;
  description: string;
  kind: OptimizationKind;
  status: OptimizationStatus;
  app?: string;
  preview?: string;
  shortcut?: string;
  timeSavedPerRunSec: number;
  runCount: number;
  totalTimeSavedSec: number;
  detectedCount?: number;
  createdAt: number;
  lastRunAt?: number;
  snippetText?: string;
  solution?: string;
  script?: ActionScript;
  eyes?: EyesDetectionSpec;
  flows?: {
    user: FlowNode[];
    proposed: FlowNode[];
  };
}

export interface LibrarySummary {
  totalTimeSavedSec: number;
  totalRuns: number;
  activeCount: number;
  suggestedCount: number;
}

export const LIBRARY_STORAGE_KEY = "eyes_optimization_library_v1";

export function createDefaultOptimizations(_now = Date.now()): OptimizationItem[] {
  void _now;
  return [];
}

export function formatDuration(totalSeconds: number): string {
  const secs = Math.max(0, Math.round(totalSeconds));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) {
    return remSecs === 0 ? `${mins}m` : `${mins}m ${remSecs}s`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hours}h` : `${hours}h ${remMins}m`;
}

export function formatRelativeTime(ts?: number, now = Date.now()): string {
  if (!ts) return "Not run yet";
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

export function computeLibrarySummary(items: OptimizationItem[]): LibrarySummary {
  let totalTimeSavedSec = 0;
  let totalRuns = 0;
  let activeCount = 0;
  let suggestedCount = 0;

  for (const item of items) {
    totalTimeSavedSec += item.totalTimeSavedSec;
    totalRuns += item.runCount;
    if (item.status === "active") activeCount += 1;
    if (item.status === "suggested") suggestedCount += 1;
  }

  return {
    totalTimeSavedSec,
    totalRuns,
    activeCount,
    suggestedCount,
  };
}

export function suggestionToOptimization(
  suggestion: Suggestion,
  opts: { app?: string; status?: OptimizationStatus; now?: number } = {}
): OptimizationItem {
  const now = opts.now ?? Date.now();
  const status = opts.status ?? "suggested";
  const isText = suggestion.kind === "text";
  const text = suggestion.snippetText ?? suggestion.preview;

  return {
    id: suggestion.id,
    title: suggestion.headline,
    description: suggestion.detail,
    kind: isText ? "snippet" : "workflow",
    status,
    app: opts.app || "Browser",
    preview: suggestion.preview,
    snippetText: isText ? text : undefined,
    timeSavedPerRunSec: 0,
    runCount: 0,
    totalTimeSavedSec: 0,
    detectedCount: suggestion.count,
    createdAt: now,
    flows: suggestion.flows,
  };
}

export function findingToOptimization(
  finding: Finding,
  now = Date.now()
): OptimizationItem | null {
  if (finding.verdict === "do_not_automate") return null;
  const reps = Math.max(1, finding.stats.repetitions);
  const perRunSec = Math.max(
    6,
    Math.round((finding.stats.minutesPerWeek * 60) / reps)
  );
  const isSnippet = finding.artifact?.kind === "snippet";
  const cleanTitle = finding.title.replace(/^Save a snippet for:\s*/i, "Snippet: ");

  return {
    id: finding.id,
    title: cleanTitle,
    description: finding.why,
    kind: isSnippet ? "snippet" : "workflow",
    status: "suggested",
    app: "Recent activity",
    timeSavedPerRunSec: perRunSec,
    runCount: 0,
    totalTimeSavedSec: 0,
    detectedCount: finding.stats.repetitions,
    createdAt: now,
  };
}

export function upsertOptimizationItem(
  items: OptimizationItem[],
  incoming: OptimizationItem,
  options: { forceActivate?: boolean } = {}
): OptimizationItem[] {
  const existingIndex = items.findIndex((item) => item.id === incoming.id);
  if (existingIndex === -1) {
    return [incoming, ...items];
  }

  const existing = items[existingIndex];
  const merged: OptimizationItem = {
    ...existing,
    ...incoming,
    status: options.forceActivate
      ? "active"
      : existing.status === "active" || existing.status === "paused"
        ? existing.status
        : incoming.status,
    runCount: existing.runCount,
    totalTimeSavedSec: existing.totalTimeSavedSec,
    lastRunAt: existing.lastRunAt,
    createdAt: existing.createdAt,
    detectedCount: Math.max(existing.detectedCount ?? 0, incoming.detectedCount ?? 0) || undefined,
    snippetText: incoming.snippetText ?? existing.snippetText,
    solution: incoming.solution ?? existing.solution,
    script: incoming.script ?? existing.script,
    eyes: incoming.eyes ?? existing.eyes,
    flows: incoming.flows ?? existing.flows,
  };

  const next = items.slice();
  next[existingIndex] = merged;
  return next;
}

export function recordOptimizationRun(
  items: OptimizationItem[],
  id: string,
  now = Date.now()
): OptimizationItem[] {
  return items.map((item) => {
    if (item.id !== id) return item;
    return {
      ...item,
      status: "active",
      runCount: item.runCount + 1,
      totalTimeSavedSec: item.totalTimeSavedSec + item.timeSavedPerRunSec,
      lastRunAt: now,
    };
  });
}

const DEFAULT_MOCK_IDS = new Set([
  "opt_shipping_reply",
  "opt_copy_invoice_erp",
  "opt_supplier_receipt",
  "opt_grid_gross_fill",
]);

export type LibraryEntryStats = {
  repetitions?: number;
  stepCount?: number;
  manualSeconds?: number;
  replaySeconds?: number;
  timeSavedSeconds?: number;
};

export type LibraryEntryWithStats = LibraryEntry & {
  stats?: LibraryEntryStats;
};

export function libraryEntryToOptimization(entry: LibraryEntryWithStats): OptimizationItem {
  const firstStep = entry.script.steps[0];
  const isSnippet =
    entry.kind === "snippet" &&
    entry.script.steps.length === 1 &&
    firstStep?.action === "insertText" &&
    typeof firstStep.value === "string";
  const snippetText = isSnippet && typeof firstStep.value === "string" ? firstStep.value : undefined;
  const timeSavedPerRunSec =
    typeof entry.stats?.timeSavedSeconds === "number"
      ? entry.stats.timeSavedSeconds
      : 0;
  const app = entry.eyes.scope.apps[0] || "Browser";
  const preview = snippetText
    ? snippetText.length > 64
      ? `${snippetText.slice(0, 64).trim()}...`
      : snippetText
    : entry.name;

  return {
    id: entry.id,
    title: entry.name,
    description: entry.description || entry.solution,
    kind: entry.kind,
    status: entry.status,
    app,
    preview,
    ...(snippetText ? { snippetText } : {}),
    solution: entry.solution,
    script: entry.script,
    eyes: entry.eyes,
    timeSavedPerRunSec,
    runCount: entry.runCount,
    totalTimeSavedSec: entry.runCount * timeSavedPerRunSec,
    ...(typeof entry.stats?.repetitions === "number"
      ? { detectedCount: entry.stats.repetitions }
      : {}),
    createdAt: entry.createdAt,
    lastRunAt: entry.runCount > 0 ? entry.updatedAt : undefined,
  };
}

export function mergeServerAndLocalOptimizations(
  serverEntries: LibraryEntryWithStats[],
  localItems: OptimizationItem[]
): OptimizationItem[] {
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const serverIds = new Set<string>();
  const merged: OptimizationItem[] = [];

  for (const entry of serverEntries) {
    serverIds.add(entry.id);
    const base = libraryEntryToOptimization(entry);
    const local = localById.get(entry.id);
    if (local) {
      const runCount = Math.max(entry.runCount, local.runCount);
      merged.push({
        ...base,
        runCount,
        totalTimeSavedSec: Math.max(
          runCount * base.timeSavedPerRunSec,
          local.totalTimeSavedSec
        ),
        lastRunAt: local.lastRunAt ?? base.lastRunAt,
        flows: local.flows ?? base.flows,
      });
    } else {
      merged.push(base);
    }
  }

  const serverSignatures = new Set(
    serverEntries.map((entry) => `${entry.name}\0${entry.solution}`)
  );

  for (const item of localItems) {
    if (serverIds.has(item.id)) continue;
    if (DEFAULT_MOCK_IDS.has(item.id)) continue;
    if (
      item.id.startsWith("decider_") &&
      item.solution &&
      serverSignatures.has(`${item.title}\0${item.solution}`)
    ) {
      continue;
    }
    merged.push(item);
  }

  return merged;
}
