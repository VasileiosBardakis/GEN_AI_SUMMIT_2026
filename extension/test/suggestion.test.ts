import { describe, expect, it } from "vitest";
import { createSuggestionEngine, trigramJaccard } from "../src/suggestion.ts";

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
});
