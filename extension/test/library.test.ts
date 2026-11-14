import { describe, expect, it } from "vitest";
import {
  computeLibrarySummary,
  createDefaultOptimizations,
  findingToOptimization,
  formatDuration,
  formatRelativeTime,
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

  it("computes library totals and increments runs accurately", () => {
    const defaults = createDefaultOptimizations(1_000_000);
    const before = computeLibrarySummary(defaults);
    expect(before.activeCount).toBe(3);
    expect(before.suggestedCount).toBe(1);
    expect(before.totalRuns).toBe(32);
    expect(before.totalTimeSavedSec).toBe(606);

    const updated = recordOptimizationRun(defaults, "opt_shipping_reply", 2_000_000);
    const after = computeLibrarySummary(updated);
    expect(after.totalRuns).toBe(33);
    expect(after.totalTimeSavedSec).toBe(628);
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
});
