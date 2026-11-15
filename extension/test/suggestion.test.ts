import { describe, expect, it } from "vitest";
import { buildDeciderSuggestion, createSuggestionEngine, trigramJaccard } from "../src/suggestion.ts";

const REPLY_A =
  "Hi, thanks for your order. It ships Friday and tracking will follow shortly.";
const REPLY_B =
  "Hi, thanks for your order. It ships Monday and tracking will follow shortly.";
const REPLY_C =
  "Hi, thanks for your order! It ships Friday and tracking will follow shortly.";

describe("trigramJaccard", () => {
  it("scores near-identical text high and unrelated text low", () => {
    expect(trigramJaccard(REPLY_A, REPLY_B)).toBeGreaterThanOrEqual(0.8);
    expect(trigramJaccard(REPLY_A, "Database migration checklist.")).toBeLessThan(0.2);
  });
});

describe("createSuggestionEngine", () => {
  it("emits one text suggestion when similar text is committed three times", () => {
    const engine = createSuggestionEngine();

    expect(engine.recordText(REPLY_A)).toBeNull();
    expect(engine.recordText(REPLY_B)).toBeNull();
    const suggestion = engine.recordText(REPLY_C);

    expect(suggestion).not.toBeNull();
    expect(suggestion?.kind).toBe("text");
    expect(suggestion?.count).toBe(3);
    expect(suggestion?.preview).toContain("Hi, thanks for your order.");
    expect(suggestion?.headline).toContain("snippet");
    expect(suggestion?.meta).toContain("3 repeats");
    expect(suggestion?.videoUrl).toBeUndefined();
    expect(suggestion?.flows.user.map((node) => node.kind)).toEqual([
      "click",
      "input",
      "click",
      "loop",
    ]);
    expect(suggestion?.flows.proposed.some((node) => node.kind === "ai")).toBe(true);
  });

  it("does not repeat the same suggestion after it has been shown", () => {
    const engine = createSuggestionEngine();

    engine.recordText(REPLY_A);
    engine.recordText(REPLY_B);
    expect(engine.recordText(REPLY_C)).not.toBeNull();
    expect(engine.recordText(REPLY_A)).toBeNull();
    expect(engine.recordText(REPLY_B)).toBeNull();
  });

  it("ignores short, redacted, and unrelated text", () => {
    const engine = createSuggestionEngine();

    expect(engine.recordText("short note")).toBeNull();
    expect(engine.recordText("[REDACTED:PASSWORD#h_12345678]")).toBeNull();

    expect(engine.recordText(REPLY_A)).toBeNull();
    expect(engine.recordText("Unrelated note about database migrations.")).toBeNull();
    expect(engine.recordText("Another unrelated note about quarterly invoices.")).toBeNull();
  });

  it("never attaches videoUrl to text suggestions even when clickReplayUrl is configured", () => {
    const engine = createSuggestionEngine({
      clickReplayUrl: "chrome-extension://test/dist/replay-demo.mp4",
    });

    engine.recordText(REPLY_A);
    engine.recordText(REPLY_B);
    const suggestion = engine.recordText(REPLY_C);

    expect(suggestion).not.toBeNull();
    expect(suggestion?.kind).toBe("text");
    expect(suggestion?.videoUrl).toBeUndefined();
    expect(suggestion?.flows.user.length).toBeGreaterThan(0);
    expect(suggestion?.flows.proposed.length).toBeGreaterThan(0);
  });

  it("emits one click suggestion after three clicks inside the window", () => {
    const engine = createSuggestionEngine({
      clickWindowMs: 1_000,
      clickReplayUrl: "chrome-extension://test/dist/replay-demo.mp4",
    });
    const key = "button:testid:copy-invoice";

    expect(engine.recordClick(key, "Copy reference", 0)).toBeNull();
    expect(engine.recordClick(key, "Copy reference", 500)).toBeNull();
    const suggestion = engine.recordClick(key, "Copy reference", 900);

    expect(suggestion).not.toBeNull();
    expect(suggestion?.kind).toBe("click");
    expect(suggestion?.count).toBe(3);
    expect(suggestion?.headline).toBe('Automate "Copy reference"?');
    expect(suggestion?.videoUrl).toBe("chrome-extension://test/dist/replay-demo.mp4");
    expect(suggestion?.flows.user.map((node) => node.kind)).toEqual([
      "click",
      "tab",
      "paste",
      "loop",
    ]);
    expect(suggestion?.flows.proposed.map((node) => node.kind)).toEqual([
      "click",
      "ai",
      "done",
    ]);
    expect(engine.recordClick(key, "Copy reference", 1_200)).toBeNull();
  });

  it("prunes clicks outside the window and keeps different targets separate", () => {
    const engine = createSuggestionEngine({ clickWindowMs: 1_000 });

    engine.recordClick("button:testid:copy", "Copy", 0);
    engine.recordClick("button:testid:copy", "Copy", 500);
    expect(engine.recordClick("button:testid:copy", "Copy", 2_000)).toBeNull();
    expect(engine.recordClick("button:testid:submit", "Submit", 2_100)).toBeNull();
    expect(engine.recordClick("button:testid:copy", "Copy", 2_200)).toBeNull();
    expect(engine.recordClick("button:testid:copy", "Copy", 2_400)).not.toBeNull();
  });

  it("builds a decider suggestion from a planner solution and action script", () => {
    const suggestion = buildDeciderSuggestion({
      name: "Search current page",
      solution: "Type 'quarterly report' into the search box.",
      script: {
        name: "Search current page",
        steps: [
          {
            action: "fill",
            target: { kind: "css", value: "input[type='search']" },
            value: "quarterly report",
          },
        ],
      },
    });

    expect(suggestion.kind).toBe("click");
    expect(suggestion.headline).toBe("Search current page");
    expect(suggestion.detail).toContain("quarterly report");
    expect(suggestion.meta).toBe("1 step · Ready to run");
    expect(suggestion.flows.user.map((n) => n.kind)).toEqual(["input", "loop"]);
    expect(suggestion.flows.proposed.map((n) => n.kind)).toEqual(["ai", "done"]);
  });

  it("persists and restores text clusters across engine instances (page reloads)", () => {
    let savedClusters: import("../src/suggestion.ts").TextCluster[] = [];
    const engine1 = createSuggestionEngine({
      minTextLength: 6,
      onTextClustersChange: (clusters) => {
        savedClusters = clusters;
      },
    });
    expect(engine1.recordText("Acme Logistics", "127.0.0.1::company_name")).toBeNull();
    expect(engine1.recordText("Acme Logistics", "127.0.0.1::company_name")).toBeNull();
    expect(savedClusters).toHaveLength(1);

    const engine2 = createSuggestionEngine({
      minTextLength: 6,
      initialTextClusters: savedClusters,
    });
    const detected = engine2.recordText("Acme Logistics", "127.0.0.1::company_name");
    expect(detected).not.toBeNull();
    expect(detected?.count).toBe(3);
  });

  it("supports pauseBeforeSubmit, runMode save_only, and {{param}} metadata in buildDeciderSuggestion", () => {
    const paused = buildDeciderSuggestion({
      name: "Send vendor payment",
      solution: "Fill payment form and pause before clicking Pay.",
      pauseBeforeSubmit: true,
      script: {
        name: "Send vendor payment",
        steps: [
          { action: "fill", target: { kind: "css", value: "#amount" }, value: "500.00" },
          { action: "click", target: { kind: "css", value: "#pay-btn" } },
        ],
      },
    });
    expect(paused.pauseBeforeSubmit).toBe(true);
    expect(paused.pauseNotice?.toLowerCase()).toContain("you click the final button");
    expect(paused.primaryLabel).toBeUndefined();

    const saveOnly = buildDeciderSuggestion({
      name: "Submit expense report",
      solution: "Save this reusable expense workflow with runtime {{param}} inputs.",
      runMode: "save_only",
      params: [
        { name: "vendor", example: "Acme" },
        { name: "amount", example: "125.00" },
      ],
      script: {
        name: "Submit expense report",
        steps: [
          { action: "fill", target: { kind: "css", value: "#vendor" }, value: "{{vendor}}" },
          { action: "fill", target: { kind: "css", value: "#amount" }, value: "{{amount}}" },
        ],
      },
    });
    expect(saveOnly.runMode).toBe("save_only");
    expect(saveOnly.primaryLabel).toBe("Save skill");
    expect(saveOnly.params).toEqual([
      { name: "vendor", example: "Acme" },
      { name: "amount", example: "125.00" },
    ]);
  });
});
