import { describe, expect, it } from "vitest";
import {
  computeLibrarySummary,
  createDefaultOptimizations,
  findingToOptimization,
  formatDuration,
  formatRelativeTime,
  libraryEntryToOptimization,
  mergeServerAndLocalOptimizations,
  recordOptimizationRun,
  suggestionToOptimization,
  upsertOptimizationItem,
} from "../src/library.ts";
import { createSuggestionEngine } from "../src/suggestion.ts";

describe("optimization library helpers", () => {
  it("formats durations and relative timestamps in user-friendly units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(22)).toBe("22s");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(308)).toBe("5m 8s");
    expect(formatDuration(3900)).toBe("1h 5m");

    const now = 1_700_000_000_000;
    expect(formatRelativeTime(undefined, now)).toBe("Not run yet");
    expect(formatRelativeTime(now - 20_000, now)).toBe("Just now");
    expect(formatRelativeTime(now - 12 * 60_000, now)).toBe("12m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("returns empty defaults and computes library totals accurately", () => {
    const defaults = createDefaultOptimizations(1_000_000);
    expect(defaults).toEqual([]);
    const summary = computeLibrarySummary([]);
    expect(summary.totalRuns).toBe(0);
    expect(summary.totalTimeSavedSec).toBe(0);
    expect(summary.activeCount).toBe(0);
    expect(summary.suggestedCount).toBe(0);

    const item = libraryEntryToOptimization({
      id: "lib_run_test",
      name: "Copy invoice reference",
      kind: "workflow",
      status: "active",
      description: "Copies invoice code.",
      solution: "Read and fill.",
      script: {
        name: "Copy invoice reference",
        steps: [
          { action: "readText", target: { kind: "css", value: "#invoice-source" }, bind: "ref" },
          { action: "fill", target: { kind: "css", value: "#erp-invoice" }, value: "{{ref}}" },
        ],
      },
      eyes: {
        intent: "Copy invoice code",
        scope: { apps: ["127.0.0.1"], urlPatterns: [], pageHints: [] },
        targetHints: { roles: [], labelContains: [], locators: [] },
        textHints: { prefixHints: [], minCharsBeforeMatch: 0 },
        guards: { requireClipboard: false, fieldEmptyOnly: true, minSignals: 2, cooldownMs: 5000 },
      },
      stats: {
        repetitions: 3,
        stepCount: 2,
        manualSeconds: 26,
        replaySeconds: 4,
        timeSavedSeconds: 22,
      },
      runCount: 0,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const updated = recordOptimizationRun([item], "lib_run_test", 2_000_000);
    const after = computeLibrarySummary(updated);
    expect(after.totalRuns).toBe(1);
    expect(after.totalTimeSavedSec).toBe(22);
    expect(updated[0].lastRunAt).toBe(2_000_000);
  });

  it("converts suggestions and findings without debug codes", () => {
    const engine = createSuggestionEngine();
    const msg = "Hi, thanks for your order. It ships Friday and tracking will follow shortly.";
    engine.recordText(msg);
    engine.recordText(msg);
    const suggestion = engine.recordText(msg)!;

    const item = suggestionToOptimization(suggestion, { app: "mail.example.com" });
    expect(item.kind).toBe("snippet");
    expect(item.snippetText).toBe(msg);
    expect(item.timeSavedPerRunSec).toBeGreaterThanOrEqual(8);

    const existing = upsertOptimizationItem([], item);
    expect(existing).toHaveLength(1);

    const convertedFinding = findingToOptimization({
      id: "snip_1234",
      verdict: "rung1",
      title: 'Save a snippet for: "Shipping update"',
      why: "You typed this 70-character text 3 times in this session.",
      whyNotNext: "Text varies slightly.",
      stats: { repetitions: 3, minutesPerWeek: 1.5, stability: 0.95 },
      artifact: { kind: "snippet", path: "snippets/snip_1234.txt", verified: false },
    });
    expect(convertedFinding).not.toBeNull();
    expect(convertedFinding?.title).not.toContain("RUNG");
    expect(convertedFinding?.timeSavedPerRunSec).toBe(30);

    expect(
      findingToOptimization({
        id: "dna_1",
        verdict: "do_not_automate",
        title: "One-off login",
        why: "Too rare.",
        whyNotNext: "N/A",
        stats: { repetitions: 1, minutesPerWeek: 0.1, stability: 0.2 },
      })
    ).toBeNull();
  });

  it("merges server LibraryEntry items over mock defaults while preserving local run stats", () => {
    const defaults = createDefaultOptimizations(1_000_000);
    const serverEntry = {
      id: "lib_abc123",
      name: 'Insert "Acme Logistics"',
      kind: "snippet" as const,
      status: "active" as const,
      description: "Inserts Acme Logistics into company field.",
      solution: "Insert 'Acme Logistics' into the focused field.",
      script: {
        name: 'Insert "Acme Logistics"',
        steps: [{ action: "insertText" as const, value: "Acme Logistics" }],
      },
      eyes: {
        intent: "Fill company name",
        scope: { apps: ["127.0.0.1"], urlPatterns: [], pageHints: [] },
        targetHints: { roles: ["textbox"], labelContains: ["company"], locators: [] },
        textHints: { prefixHints: ["acme"], minCharsBeforeMatch: 2 },
        guards: { requireClipboard: false, fieldEmptyOnly: true, minSignals: 2, cooldownMs: 5000 },
      },
      runCount: 2,
      createdAt: 1_000,
      updatedAt: 2_000,
    };

    const opt = libraryEntryToOptimization(serverEntry);
    expect(opt.id).toBe("lib_abc123");
    expect(opt.snippetText).toBe("Acme Logistics");
    expect(opt.app).toBe("127.0.0.1");

    const localWithRun = recordOptimizationRun([opt, ...defaults], "lib_abc123", 5_000);
    const merged = mergeServerAndLocalOptimizations([serverEntry], localWithRun);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("lib_abc123");
    expect(merged[0].runCount).toBe(3);
  });

  it("maps measured entry.stats onto OptimizationItem instead of step-count estimates", () => {
    const entry = {
      id: "lib_workflow_stats",
      name: "Fill ERP invoice",
      kind: "workflow" as const,
      status: "active" as const,
      description: "Copies invoice code to ERP field.",
      solution: "Read #invoice-source and fill #erp-invoice.",
      script: {
        name: "Fill ERP invoice",
        steps: [
          { action: "readText" as const, target: { kind: "css" as const, value: "#invoice-source" }, bind: "ref" },
          { action: "fill" as const, target: { kind: "css" as const, value: "#erp-invoice" }, value: "{{ref}}" },
          { action: "click" as const, target: { kind: "css" as const, value: "#save-btn" } },
        ],
      },
      eyes: {
        intent: "Fill ERP invoice",
        scope: { apps: ["127.0.0.1"], urlPatterns: [], pageHints: [] },
        targetHints: { roles: ["textbox"], labelContains: ["invoice"], locators: [] },
        textHints: { prefixHints: [], minCharsBeforeMatch: 0 },
        guards: { requireClipboard: false, fieldEmptyOnly: true, minSignals: 2, cooldownMs: 5000 },
      },
      stats: {
        repetitions: 4,
        stepCount: 3,
        manualSeconds: 50,
        replaySeconds: 8,
        timeSavedSeconds: 42,
      },
      runCount: 2,
      createdAt: 1_000,
      updatedAt: 2_000,
    };

    const opt = libraryEntryToOptimization(entry);
    expect(opt.timeSavedPerRunSec).toBe(42);
    expect(opt.detectedCount).toBe(4);
    expect(opt.totalTimeSavedSec).toBe(84);
  });
});
