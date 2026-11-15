import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { createServer } from "../src/app.ts";
import type { ActionScript } from "../src/hands/types.ts";
import type { GeminiClient, ZodLikeSchema } from "../src/llm/gemini.ts";
import { createProposer } from "../src/propose.ts";
import type { CompiledWorkflow } from "../src/v2/index.ts";

function makeEvent(id: string, ts: number, type: Event["type"]): Event {
  return {
    v: 1,
    id,
    ts,
    session: "s1",
    source: "browser",
    app: "app.local",
    url: "http://app.local/doc",
    type,
  };
}

function copyPasteEvents(cycles = 1): Event[] {
  const events: Event[] = [];
  let ts = 1_000;
  for (let i = 0; i < cycles; i++) {
    events.push(makeEvent(`cm${i}`, (ts += 1_000), "contextmenu"));
    events.push(makeEvent(`copy${i}`, (ts += 1_000), "copy"));
    events.push(makeEvent(`click${i}`, (ts += 1_000), "click"));
    events.push(makeEvent(`paste${i}`, (ts += 1_000), "paste"));
  }
  return events;
}

function makeCompiledOffer(): CompiledWorkflow {
  return {
    kind: "workflow",
    name: "Copy and paste field",
    reason: "Automates copy/paste",
    risk: "low",
    offerAt2: false,
    runMode: "run_remaining",
    pauseBeforeSubmit: false,
    startUrl: "http://app.local/doc",
    apps: ["app.local"],
    params: [],
    steps: [
      { action: "switchTab", host: "app.local", url: "http://app.local/doc" },
      { action: "click", target: [{ kind: "css", value: "#target" }] },
    ],
    stats: {
      repetitions: 2,
      minutesPerWeek: 0.2,
      manualSeconds: 6,
      replaySeconds: 1,
    },
  };
}

describe("propose flow tips", () => {
  it("shows a show-only Got it card after Iris says yes and compile produces null (no repeat-count gate)", async () => {
    const decisions: Array<{
      name: string;
      solution: string;
      script: ActionScript;
      primaryLabel?: string;
    }> = [];
    const logs: string[] = [];
    const proposer = createProposer({
      readSessionEvents: async () => copyPasteEvents(1),
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      compileV2: async () => null,
      suggestFlowTip: async () => ({
        tip: "Use Ctrl+C then Ctrl+V instead of the right-click menu.",
        keys: ["Ctrl+C", "Ctrl+V"],
        why: "Right-click copy/paste.",
      }),
      requestDecision: async (name, solution, script, primaryLabel) => {
        decisions.push({ name, solution, script, primaryLabel });
        return { ok: true, decision: "approved" };
      },
      runScript: async () => {
        throw new Error("tip must never run a script");
      },
      log: (line) => logs.push(line),
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
    expect(logs.some((l) => l.includes("[tip] session=s1 shown reason="))).toBe(true);
  });

  it("does not call suggestFlowTip unless Iris verdict is yes", async () => {
    let suggestions = 0;

    for (const verdict of [
      { worthAutomating: false, pauseBeforeSubmit: false },
      null,
    ]) {
      const proposer = createProposer({
        readSessionEvents: async () => copyPasteEvents(3),
        judgeIris: async () => verdict,
        compileV2: async () => null,
        suggestFlowTip: async () => {
          suggestions += 1;
          return { tip: "Use Ctrl+C.", keys: ["Ctrl+C"], why: "Shortcut." };
        },
        requestDecision: async () => ({ ok: true, decision: "dismissed" }),
        runScript: async () => ({ ok: true }),
      });

      proposer.onEvents("s1");
      await new Promise((resolve) => setTimeout(resolve, 25));
      proposer.close();
    }

    // < 2 meaningful steps also skips Iris and tip
    const pSkip = createProposer({
      readSessionEvents: async () => [makeEvent("c1", 1_000, "click")],
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      compileV2: async () => null,
      suggestFlowTip: async () => {
        suggestions += 1;
        return { tip: "Use Ctrl+C.", keys: ["Ctrl+C"], why: "Shortcut." };
      },
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
    });
    pSkip.onEvents("s1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    pSkip.close();

    expect(suggestions).toBe(0);
  });

  it("lets the workflow offer win over a tip on one Iris yes, and falls back to tip when precheck rejects", async () => {
    const offerDecisions: Array<{ name: string; primaryLabel?: string }> = [];
    let tipCallsOnOffer = 0;
    const pOffer = createProposer({
      readSessionEvents: async () => copyPasteEvents(2),
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      compileV2: async () => makeCompiledOffer(),
      precheck: async () => ({ ok: true, results: [{ ok: true, matchCount: 1 }] }),
      suggestFlowTip: async () => {
        tipCallsOnOffer += 1;
        return { tip: "Use Ctrl+C.", keys: ["Ctrl+C"], why: "Shortcut." };
      },
      requestDecision: async (name, _sol, _script, primaryLabel) => {
        offerDecisions.push({ name, primaryLabel });
        return { ok: true, decision: "dismissed" };
      },
      runScript: async () => ({ ok: true }),
    });

    pOffer.onEvents("s1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    pOffer.close();

    expect(tipCallsOnOffer).toBe(0);
    expect(offerDecisions).toEqual([{ name: "Copy and paste field", primaryLabel: undefined }]);

    const fallbackDecisions: Array<{ name: string; primaryLabel?: string }> = [];
    let tipCallsOnRejected = 0;
    const pRejected = createProposer({
      readSessionEvents: async () => copyPasteEvents(2),
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      compileV2: async () => makeCompiledOffer(),
      precheck: async () => ({ ok: true, results: [{ ok: true, matchCount: 0 }] }),
      suggestFlowTip: async () => {
        tipCallsOnRejected += 1;
        return { tip: "Use Ctrl+C.", keys: ["Ctrl+C"], why: "Shortcut." };
      },
      requestDecision: async (name, _sol, _script, primaryLabel) => {
        fallbackDecisions.push({ name, primaryLabel });
        return { ok: true, decision: "approved" };
      },
      runScript: async () => ({ ok: true }),
    });

    pRejected.onEvents("s1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    pRejected.close();

    expect(tipCallsOnRejected).toBe(1);
    expect(fallbackDecisions).toEqual([{ name: "Ctrl+C", primaryLabel: "Got it" }]);
  });

  it("shares proposedKeys dedupe and logs skipped reason on repeat", async () => {
    let nowMs = 100_000;
    let suggestions = 0;
    let decisions = 0;
    const logs: string[] = [];
    const proposer = createProposer({
      now: () => nowMs,
      readSessionEvents: async () => copyPasteEvents(2),
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
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
      log: (line) => logs.push(line),
    });

    proposer.onEvents("s1");
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Within cooldown -> skipped reason=cooldown
    proposer.onEvents("s1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(suggestions).toBe(1);
    expect(logs.some((l) => l.includes("[tip] session=s1 skipped reason=cooldown"))).toBe(true);

    // Past cooldown -> suggestFlowTip runs, proposedKeys dedupes -> skipped reason=duplicate
    nowMs += 61_000;
    proposer.onEvents("s1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    proposer.close();

    expect(suggestions).toBe(2);
    expect(decisions).toBe(1);
    expect(logs.some((l) => l.includes("[tip] session=s1 skipped reason=duplicate"))).toBe(true);
  });

  it("queues a Got it tip decide through the HTTP bridge when Iris says yes and compile returns null", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "gen-flow-tip-"));
    const tipClient: GeminiClient = {
      async generateText() {
        throw new Error("unexpected generateText call");
      },
      async generateJson<T>(_prompt: string, schema: ZodLikeSchema<T>): Promise<T> {
        const parsed = schema.safeParse({
          tip: "Select the text and press Ctrl+C, then Ctrl+V instead of the right-click menu.",
          keys: ["Ctrl+C", "Ctrl+V"],
          why: "Right-click copy/paste repeated.",
        });
        if (!parsed.success) throw new Error("schema validation failed");
        return parsed.data as T;
      },
    };
    const workflowClient: GeminiClient = {
      async generateText() {
        throw new Error("unexpected generateText call");
      },
      async generateJson<T>(_prompt: string, schema: ZodLikeSchema<T>): Promise<T> {
        const parsed = schema.safeParse({
          suggest: false,
          offerAt2: false,
          kind: "workflow",
          name: "unused",
          reason: "unused",
          risk: "low",
          runMode: "save_only",
          params: [],
          steps: [],
        });
        if (!parsed.success) throw new Error("schema validation failed");
        return parsed.data as T;
      },
    };

    const server = createServer({
      tracesDir: path.join(rootDir, "traces"),
      dataDir: path.join(rootDir, "data"),
      autoPropose: true,
      proposeDebounceMs: 0,
      flowTips: true,
      iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      gemini: workflowClient,
      tipGemini: tipClient,
    });

    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const postRes = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(copyPasteEvents(3)),
      });
      expect(postRes.status).toBe(200);

      const nextRes = await fetch(`${baseUrl}/hands/next?waitMs=3000`);
      expect(nextRes.status).toBe(200);
      const cmd = (await nextRes.json()) as {
        id: string;
        kind?: string;
        name?: string;
        primaryLabel?: string;
      };
      expect(cmd.kind).toBe("decide");
      expect(cmd.primaryLabel).toBe("Got it");
      expect(cmd.name).toBe("Ctrl+C → Ctrl+V");

      const resultRes = await fetch(`${baseUrl}/hands/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cmd.id, ok: true, decision: "approved" }),
      });
      expect(resultRes.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
