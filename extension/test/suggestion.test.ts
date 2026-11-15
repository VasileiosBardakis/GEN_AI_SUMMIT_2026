import { describe, expect, it } from "vitest";
import { buildDeciderSuggestion } from "../src/suggestion.ts";

describe("buildDeciderSuggestion", () => {
  it("formats AI decider suggestions for single-insert snippets and multi-step workflows", () => {
    const snippet = buildDeciderSuggestion({
      name: "Reply snippet",
      solution: "Insert greeting.",
      script: {
        name: "Reply snippet",
        steps: [{ action: "insertText", value: "Hello customer!" }],
      },
    });
    expect(snippet.kind).toBe("text");
    expect(snippet.snippetText).toBe("Hello customer!");
    expect(snippet.headline).toBe("Reply snippet");

    const wf = buildDeciderSuggestion({
      name: "Copy invoice",
      solution: "Copies invoice to ERP.",
      runMode: "run",
      script: {
        name: "Copy invoice",
        steps: [
          { action: "click", target: { kind: "css", value: "#open" } },
          { action: "fill", target: { kind: "css", value: "#inv" }, value: "{{id}}" },
        ],
      },
    });
    expect(wf.kind).toBe("click");
    expect(wf.runMode).toBe("run");
    expect(wf.meta).toContain("2 steps");
  });

  it("supports pauseBeforeSubmit, runMode save_only, and {{param}} metadata", () => {
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

  it("renders show-only flow tips as a keycap with Got it and no flow tracks", () => {
    const tip = buildDeciderSuggestion({
      name: "Ctrl+C → Ctrl+V",
      solution: "Use the keyboard shortcuts instead of the right-click menu.",
      primaryLabel: "Got it",
      script: {
        name: "Ctrl+C → Ctrl+V",
        steps: [{ action: "wait", ms: 0 }],
      },
    });
    expect(tip.primaryLabel).toBe("Got it");
    expect(tip.kind).toBe("click");
    expect(tip.preview).toBe("Ctrl+C → Ctrl+V");
    expect(tip.headline).toBe("Ctrl+C → Ctrl+V");
    expect(tip.meta).toBe("Flow tip");
    expect(tip.flows).toEqual({ user: [], proposed: [] });
  });

  it("treats targeted or switchTab-prefixed single insertText scripts as text snippets so the card offers Insert", () => {
    const targetedSnippet = buildDeciderSuggestion({
      name: "Reply to customer",
      solution: "Insert repeated customer reply.",
      runMode: "run",
      script: {
        name: "Reply to customer",
        steps: [
          {
            action: "insertText",
            target: { kind: "css", value: 'textarea[name="customer_reply"]' },
            value: "Hi, thanks for your order.",
          },
        ],
      },
    });
    expect(targetedSnippet.kind).toBe("text");
    expect(targetedSnippet.snippetText).toBe("Hi, thanks for your order.");
    expect(targetedSnippet.primaryLabel).toBeUndefined();

    const withSwitchTab = buildDeciderSuggestion({
      name: "Reply to customer",
      solution: "Insert repeated customer reply.",
      runMode: "run",
      script: {
        name: "Reply to customer",
        steps: [
          { action: "switchTab", host: "localhost", url: "http://localhost:5173/" },
          {
            action: "insertText",
            target: { kind: "css", value: 'textarea[name="customer_reply"]' },
            value: "Hi, thanks for your order.",
          },
        ],
      },
    });
    expect(withSwitchTab.kind).toBe("text");
    expect(withSwitchTab.snippetText).toBe("Hi, thanks for your order.");
  });
});
