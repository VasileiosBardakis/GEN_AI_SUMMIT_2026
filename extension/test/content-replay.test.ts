import { afterEach, describe, expect, it } from "vitest";
import { renderReplay } from "../src/content.ts";
import type { Suggestion } from "../src/suggestion.ts";

const baseSuggestion: Suggestion = {
  id: "decider_test",
  kind: "click",
  count: 1,
  preview: "Fill invoice",
  headline: "Fill invoice",
  detail: "Copies the invoice id into the ERP field.",
  meta: "2 steps · Ready to run",
  flows: {
    user: [
      { kind: "click", label: "Copy reference" },
      { kind: "input", label: "Paste into ERP" },
    ],
    proposed: [
      { kind: "ai", label: "Fill invoice" },
      { kind: "done", label: "Done" },
    ],
  },
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("renderReplay", () => {
  it("renders the bundled replay demo for click suggestions inside the extension", () => {
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        id: "test-extension",
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      },
    };

    const html = renderReplay(baseSuggestion);

    expect(html).toContain(
      'src="chrome-extension://test-extension/dist/replay-demo.webm"'
    );
    expect(html).not.toContain("replay-bar");
  });

  it("prefers an explicit videoUrl over the bundled demo", () => {
    const html = renderReplay({
      ...baseSuggestion,
      videoUrl: "https://example.com/custom-replay.mp4",
    });

    expect(html).toContain('src="https://example.com/custom-replay.mp4"');
  });

  it("does not render replay for text snippets or flow tips", () => {
    expect(renderReplay({ ...baseSuggestion, kind: "text" })).toBe("");
    expect(renderReplay({ ...baseSuggestion, primaryLabel: "Got it" })).toBe("");
  });

  it("does not render replay outside an extension context", () => {
    expect(renderReplay(baseSuggestion)).toBe("");
  });
});
