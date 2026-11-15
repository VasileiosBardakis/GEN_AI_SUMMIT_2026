import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Event } from "@gen/shared";
import { EventSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import type { GeminiClient } from "../src/llm/gemini.ts";
import { createProposer } from "../src/propose.ts";
import { compileWorkflow, type CompiledWorkflow } from "../src/v2/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

function makeTestEvent(
  id: string,
  type: Event["type"],
  ts: number,
  extra: Partial<Omit<Event, "v" | "id" | "type" | "ts" | "session" | "source">> = {},
): Event {
  return {
    v: 1,
    id,
    ts,
    session: "sess_propose_iris",
    source: "browser",
    app: "portal.local",
    url: "http://portal.local/form",
    type,
    ...extra,
  };
}

function makeCompiledStub(): CompiledWorkflow {
  return {
    kind: "workflow",
    name: "Copy invoice to ERP",
    reason: "Copies field from portal to ERP",
    risk: "low",
    offerAt2: false,
    runMode: "save_only",
    pauseBeforeSubmit: false,
    startUrl: "http://portal.local/form",
    apps: ["portal.local"],
    params: [],
    steps: [
      { action: "switchTab", host: "portal.local", url: "http://portal.local/form" },
      { action: "click", target: [{ kind: "testid", value: "save-btn" }] },
    ],
    stats: {
      repetitions: 1,
      minutesPerWeek: 0.1,
      manualSeconds: 6,
      replaySeconds: 0,
    },
  };
}

describe("auto-propose config", () => {
  it("disables automatic proposals when BRAIN_AUTO_PROPOSE=0", async () => {
    const prev = process.env.BRAIN_AUTO_PROPOSE;
    process.env.BRAIN_AUTO_PROPOSE = "0";
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "gen-propose-env-"));
    const server = createServer({
      tracesDir: path.join(rootDir, "traces"),
      dataDir: path.join(rootDir, "data"),
      proposeDebounceMs: 0,
    });
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const replyEvents = await loadFixtureEvents("reply-x3.jsonl");
      const res = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(replyEvents),
      });
      expect(res.status).toBe(200);
      const nextRes = await fetch(`${baseUrl}/hands/next?waitMs=60`);
      expect(nextRes.status).toBe(204);
    } finally {
      if (prev === undefined) {
        delete process.env.BRAIN_AUTO_PROPOSE;
      } else {
        process.env.BRAIN_AUTO_PROPOSE = prev;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("proposer Iris-gated pipeline (GEN-114)", () => {
  const twoStepEvents: Event[] = [
    makeTestEvent("p-1", "copy", 1_000, {
      target: { label: "Invoice ID", locators: [{ kind: "testid", value: "inv-id" }] },
      clipboard: { text: "INV-1" },
    }),
    makeTestEvent("p-2", "click", 2_000, {
      target: { label: "Save", locators: [{ kind: "testid", value: "save-btn" }] },
    }),
  ];

  it("skips Iris on < 2 meaningful steps, compiles when worthAutomating=true, skips when false, lets Gemini suggest decide on null, and preserves steps before > 60s gap", async () => {
    // 1. < 2 meaningful steps skips Iris
    const judgeSkipped = vi.fn(async () => ({ worthAutomating: true, pauseBeforeSubmit: false }));
    const compileSkipped = vi.fn(async () => makeCompiledStub());
    const p1 = createProposer({
      readSessionEvents: async () => [
        makeTestEvent("noise-1", "nav", 500),
        twoStepEvents[0],
      ],
      judgeIris: judgeSkipped,
      compileV2: compileSkipped,
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
    });
    p1.onEvents("sess_propose_iris");
    await vi.waitFor(() => {
      expect(judgeSkipped).not.toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(judgeSkipped).not.toHaveBeenCalled();
    expect(compileSkipped).not.toHaveBeenCalled();
    p1.close();

    // 2. Iris mock worthAutomating: true calls compileV2
    const judgeTrue = vi.fn(async () => ({ worthAutomating: true, pauseBeforeSubmit: false }));
    const compileTrue = vi.fn(async () => makeCompiledStub());
    const onCompiledTrue = vi.fn();
    const p2 = createProposer({
      readSessionEvents: async () => twoStepEvents,
      judgeIris: judgeTrue,
      compileV2: compileTrue,
      onCompiled: onCompiledTrue,
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
    });
    p2.onEvents("sess_propose_iris");
    await vi.waitFor(() => {
      expect(onCompiledTrue).toHaveBeenCalledTimes(1);
    });
    expect(judgeTrue).toHaveBeenCalledTimes(1);
    expect(compileTrue).toHaveBeenCalledTimes(1);
    p2.close();

    // 3. Iris mock worthAutomating: false skips compileV2
    const judgeFalse = vi.fn(async () => ({ worthAutomating: false, pauseBeforeSubmit: false }));
    const compileFalse = vi.fn(async () => makeCompiledStub());
    const p3 = createProposer({
      readSessionEvents: async () => twoStepEvents,
      judgeIris: judgeFalse,
      compileV2: compileFalse,
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
    });
    p3.onEvents("sess_propose_iris");
    await vi.waitFor(() => {
      expect(judgeFalse).toHaveBeenCalledTimes(1);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(compileFalse).not.toHaveBeenCalled();
    p3.close();

    // 4. Iris null lets compileV2 (Gemini suggest) decide
    const makeGeminiSuggest = (suggest: boolean): GeminiClient => ({
      async generateText() {
        throw new Error("unexpected");
      },
      async generateJson<T>(
        _prompt: string,
        schema: Parameters<GeminiClient["generateJson"]>[1],
      ): Promise<T> {
        const payload = {
          suggest,
          offerAt2: false,
          kind: "workflow",
          name: "Save invoice",
          reason: "Copies and saves invoice",
          risk: "low",
          runMode: "save_only",
          params: [],
          steps: [{ action: "click", stepIndex: 1 }],
        };
        const parsed = schema.safeParse(payload);
        if (!parsed.success) throw new Error(parsed.error.message);
        return parsed.data as T;
      },
    });

    const onCompiledSuggestFalse = vi.fn();
    const p4a = createProposer({
      readSessionEvents: async () => twoStepEvents,
      judgeIris: async () => null,
      compileV2: (input, opts) =>
        compileWorkflow(input, {
          gemini: makeGeminiSuggest(false),
          ...opts,
        }),
      onCompiled: onCompiledSuggestFalse,
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
    });
    p4a.onEvents("sess_propose_iris");
    await new Promise((r) => setTimeout(r, 30));
    expect(onCompiledSuggestFalse).not.toHaveBeenCalled();
    p4a.close();

    const onCompiledSuggestTrue = vi.fn();
    const p4b = createProposer({
      readSessionEvents: async () => twoStepEvents,
      judgeIris: async () => null,
      compileV2: (input, opts) =>
        compileWorkflow(input, {
          gemini: makeGeminiSuggest(true),
          ...opts,
        }),
      onCompiled: onCompiledSuggestTrue,
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
    });
    p4b.onEvents("sess_propose_iris");
    await vi.waitFor(() => {
      expect(onCompiledSuggestTrue).toHaveBeenCalledTimes(1);
    });
    p4b.close();

    // 5. > 60 s gap elsewhere still includes prior steps in the window
    const gapEvents: Event[] = [
      makeTestEvent("g-1", "copy", 1_000, {
        app: "portal.local",
        url: "http://portal.local/list",
        target: { label: "Row 1", locators: [{ kind: "testid", value: "r1" }] },
        clipboard: { text: "INV-100" },
      }),
      makeTestEvent("g-2", "scroll", 125_000, {
        app: "docs.local",
        url: "http://docs.local/readme",
      }),
      makeTestEvent("g-3", "tab_switch", 245_000, {
        app: "erp.local",
        url: "http://erp.local/form",
      }),
      makeTestEvent("g-4", "paste", 246_000, {
        app: "erp.local",
        url: "http://erp.local/form",
        target: { label: "ERP ID", locators: [{ kind: "testid", value: "erp-id" }] },
        value: "INV-100",
      }),
    ];

    let capturedDigest: Record<string, unknown> | undefined;
    const p5 = createProposer({
      readSessionEvents: async () => gapEvents,
      judgeIris: async (digest) => {
        capturedDigest = digest;
        return { worthAutomating: false, pauseBeforeSubmit: false };
      },
      compileV2: async () => null,
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
    });
    p5.onEvents("sess_propose_iris");
    await vi.waitFor(() => {
      expect(capturedDigest).toBeDefined();
    });
    const stepsInWindow = capturedDigest!.steps as Array<{
      index: number;
      action: string;
      copiedFromStep?: number;
    }>;
    const gapsInWindow = capturedDigest!.gaps as Array<{
      afterIndex: number;
      marker: string;
    }>;
    expect(stepsInWindow.map((s) => s.action)).toEqual(["copy", "tab_switch", "paste"]);
    expect(stepsInWindow[2].copiedFromStep).toBe(0);
    expect(gapsInWindow).toEqual([
      { afterIndex: 0, marker: "4 min elsewhere (docs.local)" },
    ]);
    p5.close();
  });

  it("runs immediately without debounce, keeps at most one in-flight run per session, and reruns once with latest events", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let currentEvents: Event[] = twoStepEvents;
    const seenEventCounts: number[] = [];

    const proposer = createProposer({
      readSessionEvents: async () => currentEvents,
      judgeIris: async (digest) => {
        const count = (digest.steps as unknown[]).length;
        seenEventCounts.push(count);
        if (seenEventCounts.length === 1) {
          await firstGate;
        }
        return { worthAutomating: false, pauseBeforeSubmit: false };
      },
      compileV2: async () => null,
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
    });

    proposer.onEvents("sess_propose_iris");
    await vi.waitFor(() => {
      expect(seenEventCounts).toEqual([2]);
    });

    // Arrive multiple times while in flight with updated events -> coalesce into one rerun
    currentEvents = [
      ...twoStepEvents,
      makeTestEvent("p-3", "click", 3_000, {
        target: { label: "Next", locators: [{ kind: "testid", value: "next-btn" }] },
      }),
    ];
    proposer.onEvents("sess_propose_iris");
    proposer.onEvents("sess_propose_iris");
    expect(seenEventCounts).toEqual([2]);

    releaseFirst();
    await vi.waitFor(() => {
      expect(seenEventCounts).toEqual([2, 3]);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(seenEventCounts).toEqual([2, 3]);
    proposer.close();
  });
});
