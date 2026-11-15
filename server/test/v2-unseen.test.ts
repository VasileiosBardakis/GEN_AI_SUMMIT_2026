import { mkdtemp, readFile, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Report } from "@gen/shared";
import { EventSchema, LibraryEntrySchema, type LibraryEntry } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import type { ActionScript } from "../src/hands/types.ts";
import type { GeminiClient } from "../src/llm/gemini.ts";
import type { StageLogEvent } from "../src/propose.ts";
import { readLibrary } from "../src/hands/library.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

type HandsNextResponse = {
  ok: boolean;
  id: string;
  kind?: "run" | "decide" | "precheck";
  name?: string;
  solution?: string;
  script?: ActionScript;
  steps?: ActionScript["steps"];
  url?: string;
};

async function pollHandsNext(
  baseUrl: string,
  waitMs = 1500,
): Promise<{ status: number; cmd?: HandsNextResponse }> {
  const res = await fetch(`${baseUrl}/hands/next?waitMs=${waitMs}`);
  if (res.status === 204) {
    return { status: 204 };
  }
  const cmd = (await res.json()) as HandsNextResponse;
  return { status: res.status, cmd };
}

async function postHandsResult(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${baseUrl}/hands/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

function makeFixtureGeminiRouter(overrides?: {
  offerAt2TwoRepeats?: boolean;
}): {
  client: GeminiClient;
  prompts: string[];
  callCount: () => number;
} {
  const prompts: string[] = [];
  let calls = 0;

  const client: GeminiClient = {
    async generateText() {
      throw new Error("unexpected generateText call");
    },
    async generateJson<T>(
      prompt: string,
      schema: Parameters<GeminiClient["generateJson"]>[1],
    ): Promise<T> {
      calls += 1;
      prompts.push(prompt);

      let payload: unknown;
      if (prompt.includes("freight.local")) {
        payload = {
          suggest: true,
          offerAt2: true,
          kind: "workflow",
          name: "File pending freight declarations",
          reason: "Copies pending rows from Freight Manifest to Customs Filing",
          risk: "low",
          runMode: "run_remaining",
          params: [
            { name: "col1", description: "Waybill number" },
            { name: "col2", description: "Declared weight" },
          ],
          steps: [
            {
              action: "forEach",
              itemIds: ["item_1_4", "item_1_5"],
              steps: [
                { action: "switchTab", stepIndex: 3 },
                { action: "fill", stepIndex: 4, value: "{{col1}}" },
                { action: "fill", stepIndex: 5, value: "{{col2}}" },
                { action: "click", stepIndex: 6 },
              ],
            },
          ],
        };
      } else if (prompt.includes("lims.local")) {
        payload = {
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Submit 3-field assay reading",
          reason: "Fills all three Entry Value fields via Tab order and saves",
          risk: "low",
          runMode: "save_only",
          params: [
            { name: "ph", example: "7.12" },
            { name: "cond", example: "410" },
            { name: "turb", example: "0.8" },
          ],
          steps: [
            { action: "fill", stepIndex: 4, value: "{{ph}}" },
            { action: "fill", stepIndex: 5, value: "{{cond}}" },
            { action: "fill", stepIndex: 6, value: "{{turb}}" },
            { action: "click", stepIndex: 7 },
          ],
        };
      } else if (prompt.includes("claims.local")) {
        payload = {
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Record claim approval",
          reason: "Copies claim ID and ref from Claims Queue to Payout Ledger",
          risk: "low",
          runMode: "save_only",
          params: [],
          steps: [
            { action: "readText", stepIndex: 1, bind: "claimId" },
            { action: "readText", stepIndex: 2, bind: "claimantRef" },
            { action: "switchTab", stepIndex: 3 },
            { action: "fill", stepIndex: 4, value: "{{claimId}}" },
            { action: "fill", stepIndex: 5, value: "{{claimantRef}}" },
            { action: "click", stepIndex: 6 },
          ],
        };
      } else if (prompt.includes("warehouse.local")) {
        payload = {
          suggest: true,
          offerAt2: overrides?.offerAt2TwoRepeats ?? false,
          kind: "workflow",
          name: "Post pending stock transfers",
          reason: "Transfers remaining SKU/Bin pairs from Stock Transfers to ERP",
          risk: "low",
          runMode: "run_remaining",
          params: [],
          steps: [
            {
              action: "forEach",
              itemIds: ["item_1_3", "item_1_4", "item_1_5", "item_1_6"],
              steps: [
                { action: "switchTab", stepIndex: 3 },
                { action: "fill", stepIndex: 4, value: "{{SKU}}" },
                { action: "fill", stepIndex: 5, value: "{{Bin}}" },
                { action: "click", stepIndex: 6 },
              ],
            },
          ],
        };
      } else if (prompt.includes("intake.local")) {
        payload = {
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Assign triage ticket",
          reason: "Copies ticket ID, picks priority, toggles notify, submits via Enter",
          risk: "low",
          runMode: "save_only",
          params: [{ name: "priority", example: "expedited" }],
          steps: [
            { action: "readText", stepIndex: 1, bind: "ticketId" },
            { action: "switchTab", stepIndex: 2 },
            { action: "fill", stepIndex: 3, value: "{{ticketId}}" },
            { action: "select", stepIndex: 4, value: "{{priority}}" },
            { action: "click", stepIndex: 5 },
            { action: "key", stepIndex: 7, key: "Enter" },
          ],
        };
      } else if (prompt.includes("ap-inbox.local")) {
        payload = {
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Send outbound vendor wire",
          reason: "Transfers approved wire details into Treasury Portal",
          risk: "high",
          runMode: "save_only",
          params: [{ name: "wireAmount", example: "14500.00" }],
          steps: [
            { action: "readText", stepIndex: 1, bind: "wireRef" },
            { action: "readText", stepIndex: 2, bind: "beneficiaryEmail" },
            { action: "switchTab", stepIndex: 3 },
            { action: "fill", stepIndex: 4, value: "{{wireRef}}" },
            { action: "fill", stepIndex: 5, value: "{{beneficiaryEmail}}" },
            { action: "fill", stepIndex: 6, value: "{{wireAmount}}" },
            { action: "click", stepIndex: 7 },
          ],
        };
      } else if (prompt.includes("helpdesk.local")) {
        payload = {
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Log helpdesk resolution note",
          reason: "Opens Add Note and submits resolution note in Helpdesk Queue",
          risk: "low",
          runMode: "save_only",
          params: [{ name: "note", example: "Reset MFA token" }],
          steps: [
            { action: "click", stepIndex: 6 },
            { action: "fill", stepIndex: 7, value: "{{note}}" },
            { action: "key", stepIndex: 8, key: "Enter" },
          ],
        };
      } else if (prompt.includes("sheet-table")) {
        payload = {
          suggest: true,
          offerAt2: true,
          kind: "workflow",
          name: "Sync client lookup values from sheet",
          reason: "Opens each pending client, copies sheet lookup rate, and saves",
          risk: "low",
          runMode: "run_remaining",
          params: [{ name: "clientName" }, { name: "lookupValue" }],
          steps: [
            {
              action: "forEach",
              itemIds: ["item_1_4"],
              steps: [
                {
                  action: "click",
                  withinId: "ps_1",
                  withinTextParam: "clientName",
                  stepIndex: 1,
                },
                { action: "click", stepIndex: 2 },
                {
                  action: "readText",
                  withinId: "ps_4",
                  withinTextParam: "clientName",
                  targetTextParam: "clientName",
                  bind: "matchedRow",
                },
                { action: "click", stepIndex: 4 },
                { action: "fill", stepIndex: 5, value: "{{lookupValue}}" },
                { action: "click", stepIndex: 6 },
                { action: "click", stepIndex: 7 },
              ],
            },
          ],
        };
      } else {
        payload = {
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Generic workflow",
          reason: "Repeated browser workflow",
          risk: "low",
          runMode: "save_only",
          params: [{ name: "shipping", example: "Standard" }],
          steps: [
            { action: "fill", stepIndex: 0, value: "{{shipping}}" },
            { action: "click", stepIndex: 1 },
          ],
        };
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`mock schema fail: ${parsed.error.message ?? "invalid"}`);
      }
      return parsed.data as T;
    },
  };

  return { client, prompts, callCount: () => calls };
}

describe("Brain+Hands v2 HTTP integration (BRAIN_PIPELINE=v2)", () => {
  let prevPipelineEnv: string | undefined;
  let rootDir: string;
  let tracesDir: string;
  let dataDir: string;
  let servers: http.Server[] = [];

  beforeEach(async () => {
    prevPipelineEnv = process.env.BRAIN_PIPELINE;
    process.env.BRAIN_PIPELINE = "v2";
    rootDir = await mkdtemp(path.join(os.tmpdir(), "gen-v2-unseen-"));
    tracesDir = path.join(rootDir, "traces");
    dataDir = path.join(rootDir, "data");
    servers = [];
  });

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (prevPipelineEnv === undefined) {
      delete process.env.BRAIN_PIPELINE;
    } else {
      process.env.BRAIN_PIPELINE = prevPipelineEnv;
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  async function startV2Server(opts?: {
    gemini?: GeminiClient;
    iris?: () => Promise<{ worthAutomating: boolean; pauseBeforeSubmit: boolean }>;
    siteCooldownMs?: number;
    now?: () => number;
    stageLogs?: StageLogEvent[];
    subDir?: string;
  }): Promise<{ baseUrl: string; dataDir: string; tracesDir: string }> {
    const subTraces = opts?.subDir ? path.join(tracesDir, opts.subDir) : tracesDir;
    const subData = opts?.subDir ? path.join(dataDir, opts.subDir) : dataDir;
    const server = createServer({
      tracesDir: subTraces,
      dataDir: subData,
      gemini: opts?.gemini,
      iris:
        opts?.iris ??
        (async () => ({ worthAutomating: true, pauseBeforeSubmit: false })),
      autoPropose: true,
      proposeDebounceMs: 0,
      siteCooldownMs: opts?.siteCooldownMs,
      now: opts?.now,
      stageLog: opts?.stageLogs ? (ev) => opts.stageLogs!.push(ev) : undefined,
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      dataDir: subData,
      tracesDir: subTraces,
    };
  }

  it("runs all 6 unseen fixtures + unseen-interleaved + unseen-sheet-loop over HTTP in < 1 s with precheck, skill save, startSignature, and runMode", async () => {
    const started = performance.now();
    const { client: gemini, callCount } = makeFixtureGeminiRouter();
    const stageLogs: StageLogEvent[] = [];

    const { baseUrl, dataDir: srvDataDir } = await startV2Server({
      gemini,
      iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      siteCooldownMs: 5 * 60 * 1000,
      stageLogs,
    });

    // GET /health reports v2 pipeline, autoPropose, model
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      pipeline: string;
      autoPropose: boolean;
      model: string;
    };
    expect(health.ok).toBe(true);
    expect(health.pipeline).toBe("v2");
    expect(health.autoPropose).toBe(true);
    expect(typeof health.model).toBe("string");
    expect(health.model.length).toBeGreaterThan(0);

    // 1. unseen-two-repeats.jsonl -> rep-2 silent cache (no popup), then rep-3 instant reuse -> precheck -> decide -> run_remaining
    {
      const twoRepEvents = await loadFixtureEvents("unseen-two-repeats.jsonl");
      const post2 = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(twoRepEvents),
      });
      expect(post2.status).toBe(200);

      await vi.waitFor(() => {
        expect(
          stageLogs.some(
            (e) => e.stage === "precompile" && e.session === "sess_unseen_two_repeats",
          ),
        ).toBe(true);
      });
      expect(callCount()).toBe(1);
      const noPopupAt2 = await pollHandsNext(baseUrl, 20);
      expect(noPopupAt2.status).toBe(204);

      // Post rep 3 events on same session (constants/targets unchanged)
      const rep3Events: Event[] = twoRepEvents.slice(7, 14).map((ev, idx) => ({
        ...ev,
        id: `d4000004-0000-4000-8000-9900000000${String(idx + 1).padStart(2, "0")}`,
        ts: ev.ts + 10_000,
        value: ev.value
          ? ev.value === "SKU-4402"
            ? "SKU-4403"
            : ev.value === "BIN-B07"
              ? "BIN-C04"
              : ev.value
          : undefined,
      }));
      await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rep3Events),
      });

      const precheckPoll = await pollHandsNext(baseUrl);
      expect(precheckPoll.status).toBe(200);
      expect(precheckPoll.cmd?.kind).toBe("precheck");
      await postHandsResult(baseUrl, {
        id: precheckPoll.cmd!.id,
        ok: true,
        results: [{ index: 0, action: "fill", ok: true, matchCount: 1, unique: true }],
      });

      const decidePoll = await pollHandsNext(baseUrl);
      expect(decidePoll.status).toBe(200);
      expect(decidePoll.cmd?.kind).toBe("decide");
      expect(decidePoll.cmd?.script?.runMode).toBe("run_remaining");
      expect(
        stageLogs.some(
          (e) => e.stage === "cache_hit" && e.session === "sess_unseen_two_repeats",
        ),
      ).toBe(true);
      // Instant reuse did NOT call Gemini a second time
      expect(callCount()).toBe(1);

      await postHandsResult(baseUrl, {
        id: decidePoll.cmd!.id,
        ok: true,
        decision: "approved",
      });

      const runPoll = await pollHandsNext(baseUrl);
      expect(runPoll.status).toBe(200);
      expect(runPoll.cmd?.kind).toBeUndefined();
      await postHandsResult(baseUrl, {
        id: runPoll.cmd!.id,
        ok: true,
        results: [{ ok: true }],
      });
    }

    // 2..8: Remaining 7 fixtures (each on distinct site so 5-min site rate limit does not block)
    const fixtures: Array<{
      file: string;
      expectedRunMode: "run_remaining" | "save_only";
      approve: boolean;
    }> = [
      { file: "unseen-rows-wrongtab.jsonl", expectedRunMode: "run_remaining", approve: true },
      { file: "unseen-multifield-tab.jsonl", expectedRunMode: "save_only", approve: true },
      { file: "unseen-extra-click.jsonl", expectedRunMode: "save_only", approve: true },
      { file: "unseen-enter-controls.jsonl", expectedRunMode: "save_only", approve: false },
      { file: "unseen-pii-risky.jsonl", expectedRunMode: "save_only", approve: false },
      { file: "unseen-interleaved.jsonl", expectedRunMode: "save_only", approve: false },
      { file: "unseen-sheet-loop.jsonl", expectedRunMode: "run_remaining", approve: true },
    ];

    for (const fx of fixtures) {
      const events = await loadFixtureEvents(fx.file);
      const postRes = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(events),
      });
      expect(postRes.status).toBe(200);

      const precheckPoll = await pollHandsNext(baseUrl);
      expect(precheckPoll.status).toBe(200);
      expect(precheckPoll.cmd?.kind).toBe("precheck");
      await postHandsResult(baseUrl, {
        id: precheckPoll.cmd!.id,
        ok: true,
        results: [{ index: 0, action: "click", ok: true, matchCount: 1, unique: true }],
      });

      const decidePoll = await pollHandsNext(baseUrl);
      expect(decidePoll.status).toBe(200);
      expect(decidePoll.cmd?.kind).toBe("decide");
      expect(decidePoll.cmd?.script?.runMode).toBe(fx.expectedRunMode);

      if (fx.file === "unseen-pii-risky.jsonl") {
        expect(decidePoll.cmd?.script?.pauseBeforeSubmit).toBe(true);
      }

      await postHandsResult(baseUrl, {
        id: decidePoll.cmd!.id,
        ok: true,
        decision: fx.approve ? "approved" : "dismissed",
      });

      if (fx.approve && fx.expectedRunMode === "run_remaining") {
        const runPoll = await pollHandsNext(baseUrl);
        expect(runPoll.status).toBe(200);
        expect(runPoll.cmd?.kind).toBeUndefined();
        await postHandsResult(baseUrl, {
          id: runPoll.cmd!.id,
          ok: true,
          results: [{ ok: true }],
        });
      }
    }

    // Wait for save_only entries to finish persisting
    await vi.waitFor(async () => {
      const lib = await readLibrary(srvDataDir);
      expect(lib.length).toBeGreaterThanOrEqual(5);
    });

    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(1000);

    // Verify library.json entries are valid and carry non-empty startSignature
    const savedEntries = await readLibrary(srvDataDir);
    for (const entry of savedEntries) {
      const parsed = LibraryEntrySchema.parse(entry);
      expect(parsed.status).toBe("active");
      expect(typeof parsed.startSignature).toBe("string");
      expect(parsed.startSignature!.length).toBeGreaterThan(0);
    }
    const saveOnlyEntry = savedEntries.find((e) => e.name === "Submit 3-field assay reading");
    expect(saveOnlyEntry).toBeDefined();
    expect(saveOnlyEntry!.script.runMode).toBe("save_only");

    // Verify no spurious run command was left queued for save_only approved workflows
    const trailing = await pollHandsNext(baseUrl, 20);
    expect(trailing.status).toBe(204);
  });

  it("recompiles on rep-3 when a constant changes between rep 2 and rep 3", async () => {
    let calls = 0;
    const gemini: GeminiClient = {
      async generateText() {
        throw new Error("unexpected");
      },
      async generateJson<T>(
        _prompt: string,
        schema: Parameters<GeminiClient["generateJson"]>[1],
      ): Promise<T> {
        calls += 1;
        const payload =
          calls === 1
            ? {
                suggest: true,
                offerAt2: false,
                kind: "workflow",
                name: "Submit order form",
                reason: "Fills shipping tier and saves",
                risk: "low",
                runMode: "save_only",
                params: [],
                steps: [
                  { action: "fill", stepIndex: 0, value: "Standard" },
                  { action: "click", stepIndex: 1 },
                ],
              }
            : {
                suggest: true,
                offerAt2: false,
                kind: "workflow",
                name: "Submit order form (parameterized)",
                reason: "Fills dynamic shipping tier and saves",
                risk: "low",
                runMode: "save_only",
                params: [{ name: "tier", example: "Express" }],
                steps: [
                  { action: "fill", stepIndex: 0, value: "{{tier}}" },
                  { action: "click", stepIndex: 1 },
                ],
              };
        return schema.safeParse(payload).success
          ? (payload as T)
          : (() => {
              throw new Error("invalid mock");
            })();
      },
    };

    const stageLogs: StageLogEvent[] = [];
    const { baseUrl } = await startV2Server({ gemini, stageLogs });

    const makePair = (rep: number, tierValue: string): Event[] => [
      {
        v: 1,
        id: `e0000000-0000-4000-8000-0000000000${rep}1`,
        ts: 1743000000000 + rep * 1000,
        session: "sess_diff_const",
        source: "browser",
        app: "shop.local",
        url: "http://shop.local/order",
        type: "input",
        target: {
          tag: "input",
          role: "textbox",
          label: "Tier",
          locators: [{ kind: "testid", value: "tier-input" }],
        },
        value: tierValue,
      },
      {
        v: 1,
        id: `e0000000-0000-4000-8000-0000000000${rep}2`,
        ts: 1743000000500 + rep * 1000,
        session: "sess_diff_const",
        source: "browser",
        app: "shop.local",
        url: "http://shop.local/order",
        type: "click",
        target: {
          tag: "button",
          role: "button",
          label: "Save",
          locators: [{ kind: "testid", value: "save-btn" }],
        },
      },
    ];

    // Send rep 1 & rep 2 with identical constant "Standard"
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([...makePair(1, "Standard"), ...makePair(2, "Standard")]),
    });

    await vi.waitFor(() => {
      expect(stageLogs.some((e) => e.stage === "precompile")).toBe(true);
    });
    expect(calls).toBe(1);

    // Rep 3 changes constant "Standard" -> "Express"
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makePair(3, "Express")),
    });

    const precheckPoll = await pollHandsNext(baseUrl);
    expect(precheckPoll.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: precheckPoll.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "fill", ok: true, matchCount: 1, unique: true }],
    });

    const decidePoll = await pollHandsNext(baseUrl);
    expect(decidePoll.cmd?.kind).toBe("decide");
    expect(decidePoll.cmd?.name).toBe("Submit order form (parameterized)");
    expect(calls).toBe(2);
    expect(stageLogs.some((e) => e.stage === "diff_recompile")).toBe(true);

    await postHandsResult(baseUrl, {
      id: decidePoll.cmd!.id,
      ok: true,
      decision: "dismissed",
    });
  });

  it("gates decide on precheck matchCount === 1 (blocks 0 and >1)", async () => {
    const { client: gemini } = makeFixtureGeminiRouter();
    const stageLogs: StageLogEvent[] = [];
    const { baseUrl } = await startV2Server({ gemini, stageLogs });

    const events = await loadFixtureEvents("unseen-extra-click.jsonl");
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    });

    // Ambiguous precheck (matchCount: 2) -> must NOT emit decide
    const pre1 = await pollHandsNext(baseUrl);
    expect(pre1.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: pre1.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 2, unique: false }],
    });

    const blocked = await pollHandsNext(baseUrl, 50);
    expect(blocked.status).toBe(204);
    expect(
      stageLogs.some((e) => e.stage === "precheck" && e.passed === false),
    ).toBe(true);

    // Send one more event batch for the same session -> now precheck passes with matchCount: 1
    const extraEvt: Event = {
      ...events[events.length - 1],
      id: "e9999999-0000-4000-8000-000000000001",
      ts: events[events.length - 1].ts + 1000,
    };
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([extraEvt]),
    });

    const pre2 = await pollHandsNext(baseUrl);
    expect(pre2.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: pre2.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 1, unique: true }],
    });

    const decide = await pollHandsNext(baseUrl);
    expect(decide.status).toBe(200);
    expect(decide.cmd?.kind).toBe("decide");
    await postHandsResult(baseUrl, {
      id: decide.cmd!.id,
      ok: true,
      decision: "dismissed",
    });
  });

  it("enforces 1 popup / site / 5 min rate limit and resets after 5 min", async () => {
    let fakeNow = 1_000_000;
    const { client: gemini } = makeFixtureGeminiRouter();
    const stageLogs: StageLogEvent[] = [];
    const { baseUrl } = await startV2Server({
      gemini,
      siteCooldownMs: 5 * 60 * 1000,
      now: () => fakeNow,
      stageLogs,
    });

    const baseEvents = await loadFixtureEvents("unseen-extra-click.jsonl");
    // Session 1 on claims.local -> succeeds
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseEvents),
    });

    const pre1 = await pollHandsNext(baseUrl);
    expect(pre1.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: pre1.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 1 }],
    });
    const dec1 = await pollHandsNext(baseUrl);
    expect(dec1.cmd?.kind).toBe("decide");
    await postHandsResult(baseUrl, {
      id: dec1.cmd!.id,
      ok: true,
      decision: "dismissed",
    });

    // Advance 2 min (< 5 min): Session 2 on SAME site (claims.local) -> rate limited!
    fakeNow += 2 * 60 * 1000;
    const sess2Events = baseEvents.map((e, i) => ({
      ...e,
      id: `b2000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      session: "sess_claims_2",
    }));
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sess2Events),
    });

    await vi.waitFor(() => {
      expect(
        stageLogs.some(
          (e) => e.stage === "rate_limit" && e.session === "sess_claims_2",
        ),
      ).toBe(true);
    });
    const rateLimitedPoll = await pollHandsNext(baseUrl, 40);
    expect(rateLimitedPoll.status).toBe(204);

    // Advance past 5 min: Session 3 on claims.local -> allowed!
    fakeNow += 4 * 60 * 1000;
    const sess3Events = baseEvents.map((e, i) => ({
      ...e,
      id: `b3000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      session: "sess_claims_3",
    }));
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sess3Events),
    });

    const pre3 = await pollHandsNext(baseUrl);
    expect(pre3.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: pre3.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 1 }],
    });
    const dec3 = await pollHandsNext(baseUrl);
    expect(dec3.cmd?.kind).toBe("decide");
    await postHandsResult(baseUrl, {
      id: dec3.cmd!.id,
      ok: true,
      decision: "dismissed",
    });
  });

  it("isolates distinct sessions (never merges 2+1 across sessions) and keeps queued decide across nav page_load", async () => {
    const { client: gemini } = makeFixtureGeminiRouter();
    const { baseUrl } = await startV2Server({ gemini });

    const allEvents = await loadFixtureEvents("unseen-extra-click.jsonl");
    // Split 2 reps into sess-iso-A and 1 rep into sess-iso-B
    const rep1And2 = allEvents.slice(0, 15).map((e) => ({ ...e, session: "sess-iso-A" }));
    const rep3 = allEvents.slice(15).map((e) => ({ ...e, session: "sess-iso-B" }));

    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([...rep1And2, ...rep3]),
    });

    // Neither session reached 3 repeats -> no popup
    const noPopup = await pollHandsNext(baseUrl, 60);
    expect(noPopup.status).toBe(204);

    // GET /report in v2 mode must NOT merge sess-iso-A and sess-iso-B
    const reportRes = await fetch(`${baseUrl}/report`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(report.findings).toEqual([]);

    // Also test keeping queued decide across nav page_load in v2 mode:
    const fullSessEvents = allEvents.map((e, i) => ({
      ...e,
      id: `c1000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      session: "sess-nav-keep",
    }));
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fullSessEvents),
    });

    const pre = await pollHandsNext(baseUrl);
    expect(pre.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: pre.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 1 }],
    });

    // Give proposer a tick to enqueue decide, then send nav page_load before polling decide
    await new Promise((r) => setTimeout(r, 30));
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          v: 1,
          id: "c9000000-0000-4000-8000-000000000001",
          ts: 1741000999000,
          session: "sess-nav-keep-other",
          source: "browser",
          app: "claims.local",
          url: "http://claims.local:4200/queue",
          type: "nav",
          meta: { subType: "page_load" },
        } satisfies Event,
      ]),
    });

    const keptDecide = await pollHandsNext(baseUrl);
    expect(keptDecide.status).toBe(200);
    expect(keptDecide.cmd?.kind).toBe("decide");
    await postHandsResult(baseUrl, {
      id: keptDecide.cmd!.id,
      ok: true,
      decision: "dismissed",
    });
  });

  it("saves snippet with save_only and runs immediately, and triggers move-1 recall from saved library entry", async () => {
    const snippetGemini: GeminiClient = {
      async generateText() {
        throw new Error("unexpected");
      },
      async generateJson<T>(
        _prompt: string,
        schema: Parameters<GeminiClient["generateJson"]>[1],
      ): Promise<T> {
        const payload = {
          suggest: true,
          offerAt2: false,
          kind: "snippet",
          name: "Reply snippet",
          reason: "Inserts shipping reply",
          risk: "low",
          runMode: "save_only",
          params: [],
          steps: [
            {
              action: "insertText",
              stepIndex: 0,
              value: "Hi, thanks for your order.",
            },
          ],
        };
        return schema.safeParse(payload).success
          ? (payload as T)
          : (() => {
              throw new Error("invalid mock");
            })();
      },
    };

    const { baseUrl, dataDir: srvDataDir } = await startV2Server({
      gemini: snippetGemini,
      subDir: "snippet-and-recall",
    });

    // Part A: Snippet with save_only still runs immediately on approve
    const makeReplyEv = (rep: number): Event[] => [
      {
        v: 1,
        id: `a0000000-0000-4000-8000-0000000000${rep}1`,
        ts: 1744000000000 + rep * 1000,
        session: "sess_snip",
        source: "browser",
        app: "mail.local",
        url: "http://mail.local/tickets/1",
        type: "input",
        target: {
          tag: "textarea",
          role: "textbox",
          label: "Reply",
          locators: [{ kind: "testid", value: "reply-box" }],
        },
        value: "Hi, thanks for your order.",
      },
      {
        v: 1,
        id: `a0000000-0000-4000-8000-0000000000${rep}2`,
        ts: 1744000000500 + rep * 1000,
        session: "sess_snip",
        source: "browser",
        app: "mail.local",
        url: "http://mail.local/tickets/1",
        type: "click",
        target: {
          tag: "button",
          role: "button",
          label: "Send",
          locators: [{ kind: "testid", value: "send-reply" }],
        },
      },
    ];

    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([...makeReplyEv(1), ...makeReplyEv(2), ...makeReplyEv(3)]),
    });

    const pre = await pollHandsNext(baseUrl);
    expect(pre.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: pre.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "insertText", ok: true, matchCount: 1 }],
    });

    const dec = await pollHandsNext(baseUrl);
    expect(dec.cmd?.kind).toBe("decide");
    await postHandsResult(baseUrl, {
      id: dec.cmd!.id,
      ok: true,
      decision: "approved",
    });

    // Even with runMode: "save_only", kind: "snippet" runs immediately
    const run = await pollHandsNext(baseUrl);
    expect(run.status).toBe(200);
    expect(run.cmd?.kind).toBeUndefined();
    await postHandsResult(baseUrl, {
      id: run.cmd!.id,
      ok: true,
      results: [{ ok: true }],
    });

    const saved = await readLibrary(srvDataDir);
    expect(saved).toHaveLength(1);
    expect(saved[0].kind).toBe("snippet");
    expect(saved[0].startSignature).toContain("mail.local");

    // Part B: Save a workflow (from unseen-extra-click) and verify Move-1 recall fires
    const { client: claimGemini } = makeFixtureGeminiRouter();
    const { baseUrl: recallUrl, dataDir: recallDataDir } = await startV2Server({
      gemini: claimGemini,
      subDir: "move1-recall",
    });
    const claimEvents = await loadFixtureEvents("unseen-extra-click.jsonl");
    await fetch(`${recallUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimEvents),
    });

    const cPre = await pollHandsNext(recallUrl);
    expect(cPre.cmd?.kind).toBe("precheck");
    await postHandsResult(recallUrl, {
      id: cPre.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 1 }],
    });
    const cDec = await pollHandsNext(recallUrl);
    expect(cDec.cmd?.kind).toBe("decide");
    await postHandsResult(recallUrl, {
      id: cDec.cmd!.id,
      ok: true,
      decision: "approved",
    });

    await vi.waitFor(async () => {
      const lib = await readLibrary(recallDataDir);
      expect(lib).toHaveLength(1);
    });
    const [claimEntry] = (await readLibrary(recallDataDir)) as LibraryEntry[];
    expect(claimEntry.startSignature).toContain("claims.local");

    // Now post Move-1 (single copy event) in a brand new session on claims.local
    const move1Event: Event = {
      v: 1,
      id: "f9000000-0000-4000-8000-000000000001",
      ts: 1745000000000,
      session: "sess_move1_recall",
      source: "browser",
      app: "claims.local",
      window: "Claims Queue",
      url: "http://claims.local:4200/queue",
      type: "copy",
      value: "CLM-9901",
      target: {
        tag: "span",
        label: "Claim ID",
        locators: [{ kind: "testid", value: "claim-id" }],
      },
    };
    const recallPollPromise = pollHandsNext(recallUrl);
    await fetch(`${recallUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([move1Event]),
    });

    const recallDecide = await recallPollPromise;
    expect(recallDecide.status).toBe(200);
    expect(recallDecide.cmd?.kind).toBe("decide");
    expect(recallDecide.cmd?.name).toBe("Record claim approval");
    expect(recallDecide.cmd?.script?.runMode).toBe("run_remaining");

    await postHandsResult(recallUrl, {
      id: recallDecide.cmd!.id,
      ok: true,
      decision: "approved",
      params: { claimId: "CLM-9901" },
    });

    const recallRun = await pollHandsNext(recallUrl);
    expect(recallRun.status).toBe(200);
    expect(recallRun.cmd?.kind).toBeUndefined();
    expect((recallRun.cmd as unknown as { paramValues?: Record<string, string> })?.paramValues).toEqual({
      claimId: "CLM-9901",
    });
    await postHandsResult(recallUrl, {
      id: recallRun.cmd!.id,
      ok: true,
      results: [{ ok: true }],
    });
  });

  it("offers at rep 2 when offerAt2 === true, blocks precheck matchCount === 0, and builds GET /report across >10-min gaps", async () => {
    const { client: gemini } = makeFixtureGeminiRouter({ offerAt2TwoRepeats: true });
    const { baseUrl } = await startV2Server({
      gemini,
      subDir: "offer-at-2-and-gap",
    });

    const twoRepEvents = await loadFixtureEvents("unseen-two-repeats.jsonl");
    // Space rep 1 and rep 2 by 15 minutes (> 10-min v1 merge gap) to prove v2 counts across full timeline
    const spacedEvents = twoRepEvents.map((ev, idx) =>
      idx >= 7 ? { ...ev, ts: ev.ts + 15 * 60 * 1000 } : ev,
    );

    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spacedEvents),
    });

    // matchCount === 0 blocks decide
    const pre0 = await pollHandsNext(baseUrl);
    expect(pre0.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: pre0.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "fill", ok: true, matchCount: 0, unique: false }],
    });
    const blocked = await pollHandsNext(baseUrl, 40);
    expect(blocked.status).toBe(204);

    // Trigger again with matchCount === 1 -> offers at rep 2
    const pingEvt: Event = {
      ...spacedEvents[spacedEvents.length - 1],
      id: "d4000004-0000-4000-8000-880000000001",
      ts: spacedEvents[spacedEvents.length - 1].ts + 500,
    };
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([pingEvt]),
    });

    const pre1 = await pollHandsNext(baseUrl);
    expect(pre1.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: pre1.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "fill", ok: true, matchCount: 1, unique: true }],
    });
    const decideAt2 = await pollHandsNext(baseUrl);
    expect(decideAt2.status).toBe(200);
    expect(decideAt2.cmd?.kind).toBe("decide");
    expect(decideAt2.cmd?.name).toBe("Post pending stock transfers");
    await postHandsResult(baseUrl, {
      id: decideAt2.cmd!.id,
      ok: true,
      decision: "dismissed",
    });

    // Also verify GET /report works in v2 mode for 3+ repeats across >10-min gap
    const rep3 = await loadFixtureEvents("unseen-extra-click.jsonl");
    const spaced3 = rep3.map((ev, idx) =>
      idx >= 15 ? { ...ev, ts: ev.ts + 20 * 60 * 1000 } : ev,
    );
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spaced3),
    });

    const pre3 = await pollHandsNext(baseUrl);
    expect(pre3.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: pre3.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 1 }],
    });
    const dec3 = await pollHandsNext(baseUrl);
    expect(dec3.cmd?.kind).toBe("decide");
    await postHandsResult(baseUrl, {
      id: dec3.cmd!.id,
      ok: true,
      decision: "dismissed",
    });

    const reportRes = await fetch(
      `${baseUrl}/report?session=sess_unseen_extra_click`,
    );
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].title).toBe("Record claim approval");
  });
});
