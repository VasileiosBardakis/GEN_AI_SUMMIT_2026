import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import type { ActionScript } from "../src/hands/types.ts";
import { createProposer } from "../src/propose.ts";

function makeEvent(id: string, ts: number, type: Event["type"]): Event {
  return {
    v: 1,
    id,
    ts,
    session: "s1",
    source: "browser",
    app: "app.local",
    type,
  };
}

function repeatedCutEvents(): Event[] {
  const events: Event[] = [];
  let ts = 1_000;
  for (let i = 0; i < 3; i++) {
    events.push(makeEvent(`cm${i}`, (ts += 1_000), "contextmenu"));
    events.push(makeEvent(`cut${i}`, (ts += 1_000), "cut"));
  }
  return events;
}

describe("propose flow tips", () => {
  it("shows a show-only Got it card without compiling or running anything", async () => {
    const decisions: Array<{
      name: string;
      solution: string;
      script: ActionScript;
      primaryLabel?: string;
    }> = [];
    const proposer = createProposer({
      readSessionEvents: async () => repeatedCutEvents(),
      compileV2: async () => {
        throw new Error("workflow compile should not run");
      },
      suggestFlowTip: async () => ({
        tip: "Use Ctrl+C then Ctrl+V instead of the right-click menu.",
        keys: ["Ctrl+C", "Ctrl+V"],
        why: "Right-click copy/paste repeated.",
      }),
      requestDecision: async (name, solution, script, primaryLabel) => {
        decisions.push({ name, solution, script, primaryLabel });
        return { ok: true, decision: "approved" };
      },
      runScript: async () => {
        throw new Error("tip must never run a script");
      },
      debounceMs: 0,
    });

    proposer.onEvents("s1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    proposer.close();

    expect(decisions).toEqual([
      {
        name: "Ctrl+C → Ctrl+V",
        solution: "Use Ctrl+C then Ctrl+V instead of the right-click menu.",
        script: {
          name: "Ctrl+C → Ctrl+V",
          steps: [{ action: "wait", ms: 0 }],
        },
        primaryLabel: "Got it",
      },
    ]);
  });

  it("does not repeat the same tip for a session", async () => {
    let suggestions = 0;
    let decisions = 0;
    const proposer = createProposer({
      readSessionEvents: async () => repeatedCutEvents(),
      compileV2: async () => null,
      suggestFlowTip: async () => {
        suggestions += 1;
        return { tip: "Use Tab to move between fields.", keys: ["Tab"], why: "Clicks repeated." };
      },
      requestDecision: async () => {
        decisions += 1;
        return { ok: true, decision: "dismissed" };
      },
      runScript: async () => ({ ok: true }),
      debounceMs: 0,
    });

    proposer.onEvents("s1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    proposer.onEvents("s1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    proposer.close();

    expect(suggestions).toBe(1);
    expect(decisions).toBe(1);
  });

  it("does not call the model before a pattern actually repeats", async () => {
    let suggestions = 0;
    const proposer = createProposer({
      readSessionEvents: async () => [
        makeEvent("n1", 1, "nav"),
        makeEvent("c1", 2, "contextmenu"),
        makeEvent("x1", 3, "cut"),
      ],
      compileV2: async () => null,
      suggestFlowTip: async () => {
        suggestions += 1;
        return { tip: "Use Ctrl+X.", keys: ["Ctrl+X"], why: "Cut repeated." };
      },
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
      debounceMs: 0,
    });

    proposer.onEvents("s1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    proposer.close();

    expect(suggestions).toBe(0);
  });
});
