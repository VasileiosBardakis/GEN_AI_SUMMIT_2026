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

  it("skips Iris on < 2 meaningful steps, compiles when worthAutomating=true, skips when false or null, and preserves steps before > 60s gap", async () => {
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

    // 4. Iris null (no verdict / null_response or error) stops and does not call compileV2
    const compileOnNull = vi.fn(async () => makeCompiledStub());
    const onCompiledOnNull = vi.fn();
    const p4a = createProposer({
      readSessionEvents: async () => twoStepEvents,
      judgeIris: async () => null,
      compileV2: compileOnNull,
      onCompiled: onCompiledOnNull,
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
    });
    p4a.onEvents("sess_propose_iris");
    await new Promise((r) => setTimeout(r, 30));
    expect(compileOnNull).not.toHaveBeenCalled();
    expect(onCompiledOnNull).not.toHaveBeenCalled();
    p4a.close();

    const p4b = createProposer({
      readSessionEvents: async () => twoStepEvents,
      judgeIris: async () => {
        throw new Error("iris unreachable");
      },
      compileV2: compileOnNull,
      onCompiled: onCompiledOnNull,
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
    });
    p4b.onEvents("sess_propose_iris");
    await new Promise((r) => setTimeout(r, 30));
    expect(compileOnNull).not.toHaveBeenCalled();
    expect(onCompiledOnNull).not.toHaveBeenCalled();
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

  it("logs [iris] verdict/meaningful count on skip and judge calls, and passes windowed events/steps to compileV2", async () => {
    const logs: string[] = [];
    const pSkip = createProposer({
      readSessionEvents: async () => [twoStepEvents[0]],
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      compileV2: async () => null,
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
      log: (line) => logs.push(line),
    });
    pSkip.onEvents("sess_skip");
    await vi.waitFor(() => {
      expect(logs.some((l) => l.includes("[iris] session=sess_skip"))).toBe(true);
    });
    expect(logs.some((l) => l.includes("meaningful=1") && l.includes("meaningfulCount<2"))).toBe(true);
    pSkip.close();

    // 60 meaningful steps + noise -> compileV2 receives <= 41 windowed steps, not all 60+
    const manyEvents: Event[] = [];
    for (let i = 0; i < 60; i++) {
      manyEvents.push(
        makeTestEvent(`m-noise-${i}`, "mousemove", 1_000 + i * 100),
        makeTestEvent(`m-click-${i}`, "click", 1_000 + i * 100 + 10, {
          target: { label: `Btn ${i}`, locators: [{ kind: "testid", value: `btn-${i}` }] },
        }),
      );
    }
    let receivedStepsLen = 0;
    let receivedEventsLen = 0;
    const pWin = createProposer({
      readSessionEvents: async () => manyEvents,
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      compileV2: async (input) => {
        receivedStepsLen = input.steps?.length ?? 0;
        receivedEventsLen = input.events?.length ?? 0;
        return null;
      },
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      runScript: async () => ({ ok: true }),
      log: (line) => logs.push(line),
    });
    pWin.onEvents("sess_win");
    await vi.waitFor(() => {
      expect(receivedStepsLen).toBeGreaterThan(0);
    });
    expect(receivedStepsLen).toBeLessThanOrEqual(41);
    expect(receivedEventsLen).toBeLessThanOrEqual(41);
    expect(
      logs.some((l) =>
        l.includes("[iris] session=sess_win meaningful=60 verdict=yes"),
      ),
    ).toBe(true);
    pWin.close();
  });

  it("GEN-126: save_only workflow still calls requestDecision (save only, no runScript), while run_remaining and snippet still run", async () => {
    // 1. save_only workflow -> requestDecision called with runMode: save_only; approved -> onApproved called, runScript NOT called
    const decideSaveCalls: Array<{ name: string; runMode?: string }> = [];
    const onApprovedSave = vi.fn(async () => ({ shouldRun: false }));
    const runScriptSave = vi.fn(async () => ({ ok: true }));
    const pSave = createProposer({
      readSessionEvents: async () => twoStepEvents,
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      compileV2: async () => makeCompiledStub(),
      requestDecision: async (name, _sol, script) => {
        decideSaveCalls.push({ name, runMode: script.runMode });
        return { ok: true, decision: "approved" };
      },
      onApproved: onApprovedSave,
      runScript: runScriptSave,
    });
    pSave.onEvents("sess_save_only_approve");
    await vi.waitFor(() => {
      expect(onApprovedSave).toHaveBeenCalledTimes(1);
    });
    expect(decideSaveCalls).toEqual([{ name: "Copy invoice to ERP", runMode: "save_only" }]);
    expect(runScriptSave).not.toHaveBeenCalled();
    pSave.close();

    // 2. save_only workflow dismissed -> onApproved NOT called
    const onApprovedDismissed = vi.fn(async () => ({ shouldRun: false }));
    const pDismiss = createProposer({
      readSessionEvents: async () => twoStepEvents,
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      compileV2: async () => makeCompiledStub(),
      requestDecision: async () => ({ ok: true, decision: "dismissed" }),
      onApproved: onApprovedDismissed,
      runScript: async () => ({ ok: true }),
    });
    pDismiss.onEvents("sess_save_only_dismiss");
    await new Promise((r) => setTimeout(r, 30));
    expect(onApprovedDismissed).not.toHaveBeenCalled();
    pDismiss.close();

    // 3. snippet with save_only still runs on approve with decideScript.runMode = run_remaining
    const decideSnipCalls: Array<{ runMode?: string }> = [];
    const runScriptSnip = vi.fn(async () => ({ ok: true }));
    const pSnip = createProposer({
      readSessionEvents: async () => twoStepEvents,
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      compileV2: async () => ({
        ...makeCompiledStub(),
        kind: "snippet",
        steps: [{ action: "insertText", value: "Hello" }],
      }),
      requestDecision: async (_name, _sol, script) => {
        decideSnipCalls.push({ runMode: script.runMode });
        return { ok: true, decision: "approved" };
      },
      onApproved: async () => ({ shouldRun: true }),
      runScript: runScriptSnip,
    });
    pSnip.onEvents("sess_snip_run");
    await vi.waitFor(() => {
      expect(runScriptSnip).toHaveBeenCalledTimes(1);
    });
    expect(decideSnipCalls).toEqual([{ runMode: "run_remaining" }]);
    pSnip.close();
  });
});
