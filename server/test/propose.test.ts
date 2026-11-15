import { mkdtemp, readFile, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Finding } from "@gen/shared";
import { EventSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import type { ActionScript } from "../src/hands/types.ts";
import type { GeminiSdk } from "../src/llm/gemini.ts";
import { createProposer } from "../src/propose.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

function makeFakeGemini(verdict: "rung1" | "rung2" = "rung1"): GeminiSdk {
  return {
    models: {
      generateContent: vi.fn(async (params: { contents: string }) => {
        const isCrossTab = params.contents.includes("portal.local");
        return {
          text: JSON.stringify({
            verdict: isCrossTab ? "rung2" : verdict,
            confidence: 0.9,
            ...(isCrossTab ? {} : { name: "Reply snippet" }),
            risky: false,
          }),
        };
      }),
    },
  };
}

function makeSnippetScript(name = "Reply snippet"): ActionScript {
  return {
    name,
    steps: [
      {
        action: "insertText",
        value: "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
      },
    ],
  };
}

describe("auto-propose HTTP integration (POST /events -> /hands/next -> /hands/result)", () => {
  let rootDir: string;
  let tracesDir: string;
  let dataDir: string;
  let server: http.Server;
  let baseUrl: string;
  let fakeImplement: ReturnType<
    typeof vi.fn<(solution: string, opts?: { name?: string }) => Promise<ActionScript>>
  >;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "gen-propose-test-"));
    tracesDir = path.join(rootDir, "traces");
    dataDir = path.join(rootDir, "data");
    fakeImplement = vi.fn(async (_solution: string, opts?: { name?: string }) =>
      makeSnippetScript(opts?.name),
    );
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    server = createServer({
      tracesDir,
      dataDir,
      pipeline: "v1",
      gemini: { sdk: makeFakeGemini("rung1") },
      implement: fakeImplement,
      autoPropose: true,
      proposeDebounceMs: 0,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(rootDir, { recursive: true, force: true });
  });

  it("queues one decide command for reply-x3, queues run on approve, and does not re-propose on second batch", async () => {
    const replyEvents = await loadFixtureEvents("reply-x3.jsonl");

    const postRes1 = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replyEvents),
    });
    expect(postRes1.status).toBe(200);

    const nextDecide = await fetch(`${baseUrl}/hands/next?waitMs=2000`);
    expect(nextDecide.status).toBe(200);
    const decideCmd = (await nextDecide.json()) as {
      ok: boolean;
      id: string;
      kind: string;
      name: string;
      solution: string;
      script: ActionScript;
    };
    expect(decideCmd.ok).toBe(true);
    expect(decideCmd.kind).toBe("decide");
    expect(decideCmd.script.steps).toEqual(makeSnippetScript().steps);

    const approveRes = await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: decideCmd.id, ok: true, decision: "approved" }),
    });
    expect(approveRes.status).toBe(200);

    const nextRun = await fetch(`${baseUrl}/hands/next?waitMs=2000`);
    expect(nextRun.status).toBe(200);
    const runCmd = (await nextRun.json()) as {
      ok: boolean;
      id: string;
      kind?: string;
      script: ActionScript;
    };
    expect(runCmd.ok).toBe(true);
    expect(runCmd.kind).toBeUndefined();
    expect(runCmd.script).toEqual(decideCmd.script);

    const runResultRes = await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: runCmd.id, ok: true, results: [{ ok: true }] }),
    });
    expect(runResultRes.status).toBe(200);

    await vi.waitFor(() => {
      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      expect(logs).toContain(`[propose] ${decideCmd.name} -> approved`);
      expect(logs).toContain(`[propose] ${decideCmd.name} -> run ok`);
    });

    const secondBatch = replyEvents.slice(0, 3).map((ev, idx) => ({
      ...ev,
      id: `90000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
      ts: ev.ts + 100_000,
    }));
    const postRes2 = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(secondBatch),
    });
    expect(postRes2.status).toBe(200);

    const noSecondDecide = await fetch(`${baseUrl}/hands/next?waitMs=60`);
    expect(noSecondDecide.status).toBe(204);
  });

  it("queues no run command when user dismisses and remembers dismissal across batches", async () => {
    const replyEvents = await loadFixtureEvents("reply-x3.jsonl");

    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replyEvents),
    });
    expect(postRes.status).toBe(200);

    const nextDecide = await fetch(`${baseUrl}/hands/next?waitMs=2000`);
    expect(nextDecide.status).toBe(200);
    const decideCmd = (await nextDecide.json()) as { id: string; kind: string; name: string };
    expect(decideCmd.kind).toBe("decide");

    await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: decideCmd.id, ok: true, decision: "dismissed" }),
    });

    const noRun = await fetch(`${baseUrl}/hands/next?waitMs=60`);
    expect(noRun.status).toBe(204);

    await vi.waitFor(() => {
      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      expect(logs).toContain(`[propose] ${decideCmd.name} -> dismissed`);
    });

    const secondBatch = replyEvents.slice(0, 2).map((ev, idx) => ({
      ...ev,
      id: `91000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
      ts: ev.ts + 100_000,
    }));
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(secondBatch),
    });

    const noRepeatDecide = await fetch(`${baseUrl}/hands/next?waitMs=60`);
    expect(noRepeatDecide.status).toBe(204);
  });

  it("queues no decide command for dispute-x3 (Send step blocked as do_not_automate)", async () => {
    const disputeEvents = await loadFixtureEvents("dispute-x3.jsonl");

    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(disputeEvents),
    });
    expect(postRes.status).toBe(200);

    const nextRes = await fetch(`${baseUrl}/hands/next?waitMs=80`);
    expect(nextRes.status).toBe(204);
    expect(fakeImplement).not.toHaveBeenCalled();
  });

  it("queues a decide command when crosstab-x3-split is posted across 3 live session IDs", async () => {
    const splitEvents = await loadFixtureEvents("crosstab-x3-split.jsonl");
    const sessionIds = new Set(splitEvents.map((e) => e.session));
    expect(sessionIds.size).toBe(3);

    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(splitEvents),
    });
    expect(postRes.status).toBe(200);

    const nextDecide = await fetch(`${baseUrl}/hands/next?waitMs=2000`);
    expect(nextDecide.status).toBe(200);
    const decideCmd = (await nextDecide.json()) as {
      ok: boolean;
      id: string;
      kind: string;
      name: string;
      solution: string;
      script: ActionScript;
    };
    expect(decideCmd.ok).toBe(true);
    expect(decideCmd.kind).toBe("decide");
    expect(decideCmd.name).toContain("Copy 4 fields from portal.local to erp.local");
    expect(fakeImplement).toHaveBeenCalled();

    const dismissRes = await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: decideCmd.id, ok: true, decision: "dismissed" }),
    });
    expect(dismissRes.status).toBe(200);
  });
});

describe("createProposer unit tests", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("catches and logs when runReport throws without crashing or queueing commands", async () => {
    const logs: string[] = [];
    const requestDecision = vi.fn(async () => ({ ok: true, decision: "approved" as const }));
    const runScript = vi.fn(async () => ({ ok: true }));

    const proposer = createProposer({
      pipeline: "v1",
      runReport: async () => {
        throw new Error("report explosion");
      },
      requestDecision,
      runScript,
      debounceMs: 0,
      log: (line) => logs.push(line),
    });

    proposer.onEvents("sess-err");
    await vi.waitFor(() => {
      expect(logs.some((l) => l.includes("report explosion"))).toBe(true);
    });

    expect(requestDecision).not.toHaveBeenCalled();
    expect(runScript).not.toHaveBeenCalled();
    proposer.close();
  });

  it("debounces per session with fake timers and deduplicates even if finding.id changes across runs", async () => {
    vi.useFakeTimers();

    const script = makeSnippetScript("Shipping reply");
    let runCount = 0;
    const runReport = vi.fn(async (): Promise<{
      findings: Finding[];
      scripts: Map<string, ActionScript>;
    }> => {
      runCount += 1;
      const id = `snip_unstable_${runCount}`;
      const finding: Finding = {
        id,
        verdict: "rung1",
        title: "Shipping reply",
        why: "Typed 3 times.",
        whyNotNext: "Snippet.",
        stats: { repetitions: 3, minutesPerWeek: 1, stability: 1 },
        artifact: { kind: "text", path: `/script/${id}`, verified: false },
      };
      return {
        findings: [finding],
        scripts: new Map([[id, script]]),
      };
    });

    const requestDecision = vi.fn(async () => ({ ok: true, decision: "approved" as const }));
    const runScript = vi.fn(async () => ({ ok: false, error: "tab closed" }));
    const logs: string[] = [];

    const proposer = createProposer({
      pipeline: "v1",
      runReport,
      requestDecision,
      runScript,
      debounceMs: 2500,
      log: (line) => logs.push(line),
    });

    proposer.onEvents("sess-1");
    proposer.onEvents("sess-1");
    await vi.advanceTimersByTimeAsync(2499);
    expect(runReport).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(logs).toContain("[propose] Shipping reply -> approved");
      expect(logs).toContain("[propose] Shipping reply -> run failed");
    });
    expect(runReport).toHaveBeenCalledTimes(1);
    expect(requestDecision).toHaveBeenCalledTimes(1);
    expect(runScript).toHaveBeenCalledTimes(1);

    proposer.onEvents("sess-1");
    await vi.advanceTimersByTimeAsync(2500);
    await vi.waitFor(() => {
      expect(runReport).toHaveBeenCalledTimes(2);
    });
    expect(requestDecision).toHaveBeenCalledTimes(1);
    proposer.close();
  });

  it("skips rung0, rung3, do_not_automate, and missing scripts, and logs timeout without running", async () => {
    const scriptR2: ActionScript = {
      name: "Submit order",
      steps: [{ action: "click", target: { kind: "testid", value: "go-btn" } }],
    };
    const findings: Finding[] = [
      {
        id: "wf_r0",
        workflowId: "wf_r0",
        verdict: "rung0",
        title: "Show only",
        why: "Too few reps.",
        whyNotNext: "Wait.",
        stats: { repetitions: 2, minutesPerWeek: 0.5, stability: 1 },
      },
      {
        id: "wf_r3",
        workflowId: "wf_r3",
        verdict: "rung3",
        title: "Agent flow",
        why: "Branching.",
        whyNotNext: "Agent.",
        stats: { repetitions: 4, minutesPerWeek: 4, stability: 0.7 },
      },
      {
        id: "wf_dna",
        workflowId: "wf_dna",
        verdict: "do_not_automate",
        title: "Send flow",
        why: "Unsafe.",
        whyNotNext: "Unsafe.",
        stats: { repetitions: 3, minutesPerWeek: 1, stability: 1 },
      },
      {
        id: "snip_noscript",
        verdict: "rung1",
        title: "No script",
        why: "Implement failed.",
        whyNotNext: "Snippet.",
        stats: { repetitions: 3, minutesPerWeek: 1, stability: 1 },
      },
      {
        id: "wf_r2",
        workflowId: "wf_r2",
        verdict: "rung2",
        title: "Go workflow",
        why: "Observed 4 reps.",
        whyNotNext: "Script.",
        stats: { repetitions: 4, minutesPerWeek: 2, stability: 1 },
        artifact: { kind: "text", path: "/script/wf_r2", verified: false },
      },
    ];

    const scripts = new Map<string, ActionScript>([
      ["wf_r0", scriptR2],
      ["wf_r3", scriptR2],
      ["wf_dna", scriptR2],
      ["wf_r2", scriptR2],
    ]);

    const requestDecision = vi.fn(async () => ({
      ok: false,
      error: "Timed out waiting for user decision",
    }));
    const runScript = vi.fn(async () => ({ ok: true }));
    const logs: string[] = [];

    const proposer = createProposer({
      pipeline: "v1",
      runReport: async () => ({ findings, scripts }),
      requestDecision,
      runScript,
      debounceMs: 0,
      log: (line) => logs.push(line),
    });

    proposer.onEvents("sess-filter");
    await vi.waitFor(() => {
      expect(logs).toContain("[propose] Go workflow -> timeout");
    });

    expect(requestDecision).toHaveBeenCalledTimes(1);
    expect(requestDecision).toHaveBeenCalledWith("Go workflow", "Observed 4 reps.", scriptR2);
    expect(runScript).not.toHaveBeenCalled();
    proposer.close();
  });

  it("proposes multiple findings sequentially one at a time via the promise queue", async () => {
    const script1 = makeSnippetScript("First");
    const script2: ActionScript = {
      name: "Second",
      steps: [{ action: "click", target: { kind: "testid", value: "second-btn" } }],
    };
    const findings: Finding[] = [
      {
        id: "snip_first",
        verdict: "rung1",
        title: "First",
        why: "First snippet",
        whyNotNext: "Snippet.",
        stats: { repetitions: 3, minutesPerWeek: 1, stability: 1 },
      },
      {
        id: "wf_second",
        workflowId: "wf_second",
        verdict: "rung2",
        title: "Second",
        why: "Second workflow",
        whyNotNext: "Script.",
        stats: { repetitions: 4, minutesPerWeek: 2, stability: 1 },
      },
    ];

    const eventsOrder: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const requestDecision = vi.fn(async (name: string) => {
      eventsOrder.push(`decide:start:${name}`);
      if (name === "First") {
        await firstGate;
      }
      eventsOrder.push(`decide:end:${name}`);
      return { ok: true, decision: "approved" as const };
    });

    const runScript = vi.fn(async (script: ActionScript) => {
      eventsOrder.push(`run:${script.name}`);
      return { ok: true };
    });

    const proposer = createProposer({
      pipeline: "v1",
      runReport: async () => ({
        findings,
        scripts: new Map<string, ActionScript>([
          ["snip_first", script1],
          ["wf_second", script2],
        ]),
      }),
      requestDecision,
      runScript,
      debounceMs: 0,
      log: () => {},
    });

    proposer.onEvents("sess-queue");
    await vi.waitFor(() => {
      expect(eventsOrder).toEqual(["decide:start:First"]);
    });

    // Second finding must wait until First finishes deciding and running
    expect(requestDecision).toHaveBeenCalledTimes(1);
    releaseFirst();

    await vi.waitFor(() => {
      expect(eventsOrder).toEqual([
        "decide:start:First",
        "decide:end:First",
        "run:First",
        "decide:start:Second",
        "decide:end:Second",
        "run:Second",
      ]);
    });
    proposer.close();
  });

  it("disables auto-propose when BRAIN_AUTO_PROPOSE=0", async () => {
    const prev = process.env.BRAIN_AUTO_PROPOSE;
    process.env.BRAIN_AUTO_PROPOSE = "0";
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "gen-propose-env-"));
    const implementSpy = vi.fn(async () => makeSnippetScript());
    const server = createServer({
      tracesDir: path.join(rootDir, "traces"),
      dataDir: path.join(rootDir, "data"),
      pipeline: "v1",
      gemini: { sdk: makeFakeGemini("rung1") },
      implement: implementSpy,
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
      expect(implementSpy).not.toHaveBeenCalled();
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
