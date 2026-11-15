import crypto from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
import { createGeminiClient, type GeminiClient, type ZodLikeSchema } from "../src/llm/gemini.ts";
import type { StageLogEvent } from "../src/propose.ts";
import { readLibrary } from "../src/hands/library.ts";
import { COMPILER_RESPONSE_SCHEMA } from "../src/v2/compiler.ts";

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

const DEFAULT_POLL_WAIT_MS = process.env.V2_UNSEEN_LIVE === "1" ? 8000 : 1500;

async function pollHandsNext(
  baseUrl: string,
  waitMs = DEFAULT_POLL_WAIT_MS,
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

type RecordedAnswer = {
  file: string;
  promptHash: string;
  response: unknown;
};

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function loadRecordedAnswers(): Promise<RecordedAnswer[]> {
  const fixturesDir = path.join(__dirname, "fixtures");
  const files = (await readdir(fixturesDir))
    .filter((f) => f.startsWith("unseen-") && f.endsWith(".answer.json"))
    .sort();
  return Promise.all(
    files.map(async (f) => {
      const raw = await readFile(path.join(fixturesDir, f), "utf-8");
      const parsed = JSON.parse(raw) as { promptHash: string; response: unknown };
      return { file: f, promptHash: parsed.promptHash, response: parsed.response };
    }),
  );
}

const COMPILER_LEAF_ACTIONS = [
  "click",
  "fill",
  "insertText",
  "select",
  "waitFor",
  "readText",
  "readValue",
  "extractList",
  "navigate",
  "wait",
  "switchTab",
  "key",
  "submit",
] as const;

function buildCompilerSchemaForPrompt(prompt: string): Record<string, unknown> {
  const lines = prompt.split("\n");
  const hasContainers = lines.includes(
    "PageSummary Containers (for withinId ONLY, NEVER targetId):",
  );
  const hasTargets = lines.includes("PageSummary Targets:") || hasContainers;
  const hasLists = lines.includes("PageSummary Lists:");
  if (hasTargets && hasLists) {
    return COMPILER_RESPONSE_SCHEMA as unknown as Record<string, unknown>;
  }

  const leafProps: Record<string, unknown> = {
    action: { type: "string", enum: [...COMPILER_LEAF_ACTIONS] },
    stepIndex: { type: "integer" },
    bind: { type: "string", description: "Plain identifier e.g. itemId" },
    value: { type: "string" },
    host: { type: "string" },
    url: { type: "string" },
    key: { type: "string" },
    ...(hasTargets
      ? {
          targetId: { type: "string" },
          withinId: { type: "string" },
          targetTextParam: { type: "string" },
          withinTextParam: { type: "string" },
        }
      : {}),
  };

  const topStepProps: Record<string, unknown> = {
    ...leafProps,
    ...(hasLists
      ? {
          action: { type: "string", enum: [...COMPILER_LEAF_ACTIONS, "forEach"] },
          items: { type: "string" },
          itemIds: { type: "array", items: { type: "string" } },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: leafProps,
              required: ["action"],
            },
          },
        }
      : {}),
  };

  return {
    type: "object",
    properties: {
      suggest: { type: "boolean" },
      offerAt2: { type: "boolean" },
      kind: { type: "string", enum: ["snippet", "workflow"] },
      name: { type: "string" },
      reason: { type: "string" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      runMode: { type: "string", enum: ["run_remaining", "save_only"] },
      params: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            example: { type: "string" },
          },
          required: ["name"],
        },
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: topStepProps,
          required: ["action"],
        },
      },
    },
    required: [
      "suggest",
      "offerAt2",
      "kind",
      "name",
      "reason",
      "risk",
      "runMode",
      "params",
      "steps",
    ],
  };
}

const FIXTURE_PROMPT_MARKERS: ReadonlyArray<[marker: string, file: string]> = [
  ["intake.local", "unseen-enter-controls.answer.json"],
  ["claims.local", "unseen-extra-click.answer.json"],
  ["portal.local", "unseen-interleaved.answer.json"],
  ["lims.local", "unseen-multifield-tab.answer.json"],
  ["ap-inbox.local", "unseen-pii-risky.answer.json"],
  ["orders.local", "unseen-realcapture.answer.json"],
  ["freight.local", "unseen-rows-wrongtab.answer.json"],
  ["sheet.html", "unseen-sheet-loop.answer.json"],
  ["warehouse.local", "unseen-two-repeats.answer.json"],
];

function makeRecordedGeminiClient(records: readonly RecordedAnswer[]): {
  client: GeminiClient;
  prompts: string[];
  matchedFiles: string[];
  callCount: () => number;
} {
  const byHash = new Map<string, RecordedAnswer>();
  const byFile = new Map<string, RecordedAnswer>();
  for (const rec of records) {
    byHash.set(rec.promptHash, rec);
    byFile.set(rec.file, rec);
  }
  const prompts: string[] = [];
  const matchedFiles: string[] = [];
  let calls = 0;

  const client: GeminiClient = {
    async generateText() {
      throw new Error("unexpected generateText call");
    },
    async generateJson<T>(
      prompt: string,
      schema: ZodLikeSchema<T>,
    ): Promise<T> {
      calls += 1;
      prompts.push(prompt);
      const hash = sha256Hex(prompt);
      let rec = byHash.get(hash);
      if (!rec) {
        const hit = FIXTURE_PROMPT_MARKERS.find(([marker]) => prompt.includes(marker));
        if (hit) rec = byFile.get(hit[1]);
      }
      if (!rec) {
        throw new Error(`No recorded Gemini answer for prompt sha256=${hash}`);
      }
      matchedFiles.push(rec.file);
      const parsed = schema.safeParse(rec.response);
      if (!parsed.success) {
        const msg = parsed.error.message ?? "invalid";
        throw new Error(`Recorded Gemini answer failed schema validation: ${msg}`);
      }
      return parsed.data as T;
    },
  };

  return { client, prompts, matchedFiles, callCount: () => calls };
}

function makeLiveGeminiClient(): {
  client: GeminiClient;
  prompts: string[];
  matchedFiles: string[];
  callCount: () => number;
} {
  const prompts: string[] = [];
  const matchedFiles: string[] = [];
  let calls = 0;

  const client: GeminiClient = {
    async generateText(prompt: string) {
      return createGeminiClient({
        model: "gemini-3.1-flash-lite",
        thinkingBudget: 0,
      }).generateText(prompt);
    },
    async generateJson<T>(
      prompt: string,
      schema: ZodLikeSchema<T>,
    ): Promise<T> {
      calls += 1;
      prompts.push(prompt);
      const live = createGeminiClient({
        model: "gemini-3.1-flash-lite",
        thinkingBudget: 0,
        responseSchema: buildCompilerSchemaForPrompt(prompt),
        timeoutMs: 25_000,
      });
      return live.generateJson<T>(prompt, schema);
    },
  };

  return { client, prompts, matchedFiles, callCount: () => calls };
}

const TEST_TIMEOUT_MS = process.env.V2_UNSEEN_LIVE === "1" ? 30_000 : 10_000;

async function getUnseenGeminiClient(): Promise<{
  client: GeminiClient;
  prompts: string[];
  matchedFiles: string[];
  callCount: () => number;
}> {
  if (process.env.V2_UNSEEN_LIVE === "1") {
    return makeLiveGeminiClient();
  }
  const records = await loadRecordedAnswers();
  return makeRecordedGeminiClient(records);
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

  async function runUnseenFixtureHttp(opts: {
    file: string;
    expectedRunMode: "run_remaining" | "save_only";
    approve: boolean;
    expectPauseBeforeSubmit?: boolean;
    expectedAnswerFile?: string;
  }) {
    const answerFile =
      opts.expectedAnswerFile ?? opts.file.replace(/\.jsonl$/, ".answer.json");
    if (process.env.V2_UNSEEN_LIVE !== "1") {
      await access(path.join(__dirname, "fixtures", answerFile));
    }

    const { client: gemini, matchedFiles, callCount } = await getUnseenGeminiClient();
    const { baseUrl, dataDir: srvDataDir } = await startV2Server({
      gemini,
      iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      siteCooldownMs: 5 * 60 * 1000,
    });

    const events = await loadFixtureEvents(opts.file);
    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    });
    expect(postRes.status).toBe(200);

    const waitMs = process.env.V2_UNSEEN_LIVE === "1" ? 8000 : 1500;
    const precheckPoll = await pollHandsNext(baseUrl, waitMs);
    expect(precheckPoll.status).toBe(200);
    expect(precheckPoll.cmd?.kind).toBe("precheck");
    expect(callCount()).toBe(1);
    if (process.env.V2_UNSEEN_LIVE !== "1") {
      expect(matchedFiles).toEqual([answerFile]);
    }
    await postHandsResult(baseUrl, {
      id: precheckPoll.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 1, unique: true }],
    });

    if (opts.expectedRunMode === "save_only") {
      await vi.waitFor(async () => {
        const lib = await readLibrary(srvDataDir);
        expect(lib.length).toBe(1);
      });
      const [savedEntry] = await readLibrary(srvDataDir);
      const parsed = LibraryEntrySchema.parse(savedEntry);
      expect(parsed.status).toBe("active");
      expect(typeof parsed.startSignature).toBe("string");
      expect(parsed.startSignature!.length).toBeGreaterThan(0);
      expect(parsed.script.runMode).toBe("save_only");
      if (opts.expectPauseBeforeSubmit) {
        expect(parsed.script.pauseBeforeSubmit).toBe(true);
      }

      // Never asks the user to save the skill — no decide command queued
      const trailing = await pollHandsNext(baseUrl, 40);
      expect(trailing.status).toBe(204);
      return;
    }

    const decidePoll = await pollHandsNext(baseUrl, waitMs);
    expect(decidePoll.status).toBe(200);
    expect(decidePoll.cmd?.kind).toBe("decide");
    expect(decidePoll.cmd?.script?.runMode).toBe(opts.expectedRunMode);

    if (opts.expectPauseBeforeSubmit) {
      expect(decidePoll.cmd?.script?.pauseBeforeSubmit).toBe(true);
    }

    await postHandsResult(baseUrl, {
      id: decidePoll.cmd!.id,
      ok: true,
      decision: opts.approve ? "approved" : "dismissed",
    });

    if (opts.approve) {
      const runPoll = await pollHandsNext(baseUrl, waitMs);
      expect(runPoll.status).toBe(200);
      expect(runPoll.cmd?.kind).toBeUndefined();
      await postHandsResult(baseUrl, {
        id: runPoll.cmd!.id,
        ok: true,
        results: [{ ok: true }],
      });

      await vi.waitFor(async () => {
        const lib = await readLibrary(srvDataDir);
        expect(lib.length).toBe(1);
      });
      const [savedEntry] = await readLibrary(srvDataDir);
      const parsed = LibraryEntrySchema.parse(savedEntry);
      expect(parsed.status).toBe("active");
      expect(typeof parsed.startSignature).toBe("string");
      expect(parsed.startSignature!.length).toBeGreaterThan(0);
      expect(parsed.script.runMode).toBe(opts.expectedRunMode);
    }
  }

  it("GET /health reports v2 pipeline, autoPropose, and model", async () => {
    const { client: gemini } = await getUnseenGeminiClient();
    const { baseUrl } = await startV2Server({ gemini });

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
  });

  it("unseen-realcapture.jsonl uses real extension { source, target } pageSummary object shape and passes EventSchema.parse", async () => {
    const events = await loadFixtureEvents("unseen-realcapture.jsonl");
    expect(events.length).toBeGreaterThan(0);

    const summaries = events
      .map((e) => e.meta?.pageSummary)
      .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null);
    expect(summaries.length).toBeGreaterThan(0);

    const sourceSummary = summaries.find((s) => "source" in s)?.source as
      | { rowTag?: string; rows?: Array<{ locators: unknown[]; cells: Array<{ text: string; locators: unknown[] }> }> }
      | undefined;
    expect(sourceSummary).toBeDefined();
    expect(sourceSummary?.rowTag).toBe("tr");
    expect(sourceSummary?.rows?.length).toBe(5);
    expect(sourceSummary?.rows?.[0].cells.length).toBeGreaterThan(0);

    const targetSummary = summaries.find((s) => "target" in s)?.target as
      | { containerTag?: string; emptyControls?: unknown[]; submitLocators?: unknown[] }
      | undefined;
    expect(targetSummary).toBeDefined();
    expect(targetSummary?.containerTag).toBe("form");
    expect(Array.isArray(targetSummary?.emptyControls)).toBe(true);
    expect((targetSummary?.submitLocators ?? []).length).toBeGreaterThan(0);

    for (const summary of summaries) {
      expect(Buffer.byteLength(JSON.stringify(summary), "utf8")).toBeLessThanOrEqual(4096);
    }
  });

  it(
    "unseen-two-repeats.jsonl: compiles and executes run_remaining workflow with recorded real Gemini output",
    async () => {
      await runUnseenFixtureHttp({
        file: "unseen-two-repeats.jsonl",
        expectedRunMode: "run_remaining",
        approve: true,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "unseen-rows-wrongtab.jsonl: compiles and executes run_remaining workflow with recorded real Gemini output",
    async () => {
      await runUnseenFixtureHttp({
        file: "unseen-rows-wrongtab.jsonl",
        expectedRunMode: "run_remaining",
        approve: true,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "unseen-enter-controls.jsonl: compiles and proposes save_only workflow with recorded real Gemini output",
    async () => {
      await runUnseenFixtureHttp({
        file: "unseen-enter-controls.jsonl",
        expectedRunMode: "save_only",
        approve: false,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "unseen-pii-risky.jsonl: compiles and proposes save_only workflow with pauseBeforeSubmit: true",
    async () => {
      await runUnseenFixtureHttp({
        file: "unseen-pii-risky.jsonl",
        expectedRunMode: "save_only",
        approve: false,
        expectPauseBeforeSubmit: true,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "unseen-interleaved.jsonl: compiles and proposes save_only workflow with recorded real Gemini output",
    async () => {
      await runUnseenFixtureHttp({
        file: "unseen-interleaved.jsonl",
        expectedRunMode: "save_only",
        approve: false,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "unseen-sheet-loop.jsonl: compiles and executes run_remaining workflow with recorded real Gemini output",
    async () => {
      await runUnseenFixtureHttp({
        file: "unseen-sheet-loop.jsonl",
        expectedRunMode: "run_remaining",
        approve: true,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "unseen-realcapture.jsonl: compiles and executes run_remaining workflow from { source, target } pageSummary",
    async () => {
      await runUnseenFixtureHttp({
        file: "unseen-realcapture.jsonl",
        expectedRunMode: "run_remaining",
        approve: true,
      });
    },
    TEST_TIMEOUT_MS,
  );

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
      const { baseUrl, dataDir: srvDataDir } = await startV2Server({ gemini, stageLogs });

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

    await vi.waitFor(async () => {
      const lib = await readLibrary(srvDataDir);
      expect(lib.length).toBe(1);
    });
    const [saved] = await readLibrary(srvDataDir);
    expect(saved.name).toBe("Submit order form (parameterized)");
    expect(calls).toBe(2);
    expect(stageLogs.some((e) => e.stage === "diff_recompile")).toBe(true);
    const noDecide = await pollHandsNext(baseUrl, 40);
    expect(noDecide.status).toBe(204);
  });

  it("checks index 2 constant diff on rep-4 when REPEAT_COUNT=4 and does not skip instance 2", async () => {
    const prevRepeatCount = process.env.REPEAT_COUNT;
    process.env.REPEAT_COUNT = "4";
    try {
      let calls = 0;
      const gemini: GeminiClient = {
        async generateText() {
          throw new Error("unexpected generateText");
        },
        async generateJson<T>(
          _prompt: string,
          schema: Parameters<GeminiClient["generateJson"]>[1],
        ): Promise<T> {
          calls += 1;
          const isFirst = calls === 1;
          const payload = {
            suggest: true,
            offerAt2: false,
            kind: "workflow",
            name: isFirst
              ? "Submit order form"
              : "Submit order form (parameterized)",
            reason: "Fills tier and saves",
            risk: "low",
            runMode: "save_only",
            params: isFirst ? [] : [{ name: "tier", example: "Standard" }],
            steps: [
              {
                action: "fill",
                stepIndex: 0,
                value: isFirst ? "Standard" : "{{tier}}",
              },
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
    const { baseUrl, dataDir: repeat4DataDir } = await startV2Server({ gemini, stageLogs });

      const makePair = (rep: number, tierValue: string): Event[] => [
        {
          v: 1,
          id: `f0000000-0000-4000-8000-0000000000${rep}1`,
          ts: 1743100000000 + rep * 1000,
          session: "sess_repeat4_diff",
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
          id: `f0000000-0000-4000-8000-0000000000${rep}2`,
          ts: 1743100000500 + rep * 1000,
          session: "sess_repeat4_diff",
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

      // Send reps 1..3: instances[0..1] = "Standard", instance[2] = "Express"
      await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          ...makePair(1, "Standard"),
          ...makePair(2, "Standard"),
          ...makePair(3, "Express"),
        ]),
      });

      await vi.waitFor(() => {
        expect(stageLogs.some((e) => e.stage === "precompile")).toBe(true);
      });
      expect(calls).toBe(1);

      // Rep 4 has "Standard" (same as 0/1). Constant diff MUST still inspect instance[2] ("Express") and recompile!
      await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makePair(4, "Standard")),
      });

      const precheckPoll = await pollHandsNext(baseUrl);
      expect(precheckPoll.cmd?.kind).toBe("precheck");
      await postHandsResult(baseUrl, {
        id: precheckPoll.cmd!.id,
        ok: true,
        results: [{ index: 0, action: "fill", ok: true, matchCount: 1, unique: true }],
      });

      await vi.waitFor(async () => {
        const lib = await readLibrary(repeat4DataDir);
        expect(lib.length).toBe(1);
      });
      const [saved] = await readLibrary(repeat4DataDir);
      expect(saved.name).toBe("Submit order form (parameterized)");
      expect(calls).toBe(2);
      expect(stageLogs.some((e) => e.stage === "diff_recompile")).toBe(true);
      const noDecide = await pollHandsNext(baseUrl, 40);
      expect(noDecide.status).toBe(204);
    } finally {
      if (prevRepeatCount === undefined) {
        delete process.env.REPEAT_COUNT;
      } else {
        process.env.REPEAT_COUNT = prevRepeatCount;
      }
    }
  });

  function makeStaticGemini(payload: unknown): GeminiClient {
    return {
      async generateText() {
        throw new Error("unexpected");
      },
      async generateJson<T>(
        _prompt: string,
        schema: Parameters<GeminiClient["generateJson"]>[1],
      ): Promise<T> {
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          throw new Error(`invalid mock: ${parsed.error.message ?? "invalid"}`);
        }
        return parsed.data as T;
      },
    };
  }

  it("gates auto-save and decide on precheck matchCount === 1 (blocks 0 and >1)", async () => {
    const gemini = makeStaticGemini({
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
    });
    const stageLogs: StageLogEvent[] = [];
    const { baseUrl, dataDir: precheckDataDir } = await startV2Server({ gemini, stageLogs });

    const events = await loadFixtureEvents("unseen-extra-click.jsonl");
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    });

    // Ambiguous precheck (matchCount: 2) -> must NOT auto-save or emit decide
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
    expect(await readLibrary(precheckDataDir)).toHaveLength(0);

    // Send one more event batch for the same session -> now precheck passes with matchCount: 1 -> auto-saves without decide
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

    await vi.waitFor(async () => {
      const lib = await readLibrary(precheckDataDir);
      expect(lib).toHaveLength(1);
    });
    const noDecide = await pollHandsNext(baseUrl, 40);
    expect(noDecide.status).toBe(204);
  });

  it(
    "enforces 1 popup / site / 5 min rate limit and resets after 5 min (without blocking auto-save)",
    async () => {
      let fakeNow = 1_000_000;
    const { client: gemini, matchedFiles } = await getUnseenGeminiClient();
    const stageLogs: StageLogEvent[] = [];
    const { baseUrl, dataDir: rateDataDir } = await startV2Server({
      gemini,
      siteCooldownMs: 5 * 60 * 1000,
      now: () => fakeNow,
      stageLogs,
    });

    const baseEvents = await loadFixtureEvents("unseen-two-repeats.jsonl");
    // Session 1 on erp-stock.local (run_remaining) -> shows popup
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseEvents),
    });

    const pre1 = await pollHandsNext(baseUrl);
    expect(pre1.cmd?.kind).toBe("precheck");
    if (process.env.V2_UNSEEN_LIVE !== "1") {
      expect(matchedFiles[0]).toBe("unseen-two-repeats.answer.json");
    }
    await postHandsResult(baseUrl, {
      id: pre1.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "fill", ok: true, matchCount: 1 }],
    });
    const dec1 = await pollHandsNext(baseUrl);
    expect(dec1.cmd?.kind).toBe("decide");
    await postHandsResult(baseUrl, {
      id: dec1.cmd!.id,
      ok: true,
      decision: "dismissed",
    });

    // Advance 2 min (< 5 min): Session 2 on SAME site -> rate limited!
    fakeNow += 2 * 60 * 1000;
    const sess2Events = baseEvents.map((e, i) => ({
      ...e,
      id: `b2000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      session: "sess_erp_2",
    }));
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sess2Events),
    });

    await vi.waitFor(
      () => {
        expect(
          stageLogs.some(
            (e) => e.stage === "rate_limit" && e.session === "sess_erp_2",
          ),
        ).toBe(true);
      },
      { timeout: process.env.V2_UNSEEN_LIVE === "1" ? 15_000 : 1500 },
    );
    const rateLimitedPoll = await pollHandsNext(baseUrl, 40);
    expect(rateLimitedPoll.status).toBe(204);

    // A save_only workflow on a site is auto-saved silently even without popup quota
    const saveOnlyEvents = await loadFixtureEvents("unseen-enter-controls.jsonl");
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(saveOnlyEvents),
    });
    const preSaveOnly = await pollHandsNext(baseUrl);
    expect(preSaveOnly.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: preSaveOnly.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 1 }],
    });
    await vi.waitFor(async () => {
      expect(await readLibrary(rateDataDir)).toHaveLength(1);
    });

    // Advance past 5 min: Session 3 on erp-stock.local -> allowed!
    fakeNow += 4 * 60 * 1000;
    const sess3Events = baseEvents.map((e, i) => ({
      ...e,
      id: `b3000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      session: "sess_erp_3",
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
      results: [{ index: 0, action: "fill", ok: true, matchCount: 1 }],
    });
    const dec3 = await pollHandsNext(baseUrl);
    expect(dec3.cmd?.kind).toBe("decide");
    await postHandsResult(baseUrl, {
      id: dec3.cmd!.id,
      ok: true,
      decision: "dismissed",
    });
  }, TEST_TIMEOUT_MS);

  it("isolates distinct sessions (never merges 2+1 across sessions) and keeps queued decide across nav page_load", async () => {
    const gemini = makeStaticGemini({
      suggest: true,
      offerAt2: false,
      kind: "workflow",
      name: "Record claim approval",
      reason: "Copies claim ID and ref from Claims Queue to Payout Ledger",
      risk: "low",
      runMode: "run_remaining",
      params: [],
      steps: [
        { action: "readText", stepIndex: 1, bind: "claimId" },
        { action: "readText", stepIndex: 2, bind: "claimantRef" },
        { action: "switchTab", stepIndex: 3 },
        { action: "fill", stepIndex: 4, value: "{{claimId}}" },
        { action: "fill", stepIndex: 5, value: "{{claimantRef}}" },
        { action: "click", stepIndex: 6 },
      ],
    });
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

    // Part B: Save a workflow (from good unseen-enter-controls recording) and verify Move-1 recall fires
    const { client: ticketGemini, matchedFiles: ticketMatchedFiles } =
      await getUnseenGeminiClient();
    const { baseUrl: recallUrl, dataDir: recallDataDir } = await startV2Server({
      gemini: ticketGemini,
      subDir: "move1-recall",
    });
    const ticketEvents = await loadFixtureEvents("unseen-enter-controls.jsonl");
    await fetch(`${recallUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ticketEvents),
    });

    const cPre = await pollHandsNext(recallUrl);
    expect(cPre.cmd?.kind).toBe("precheck");
    if (process.env.V2_UNSEEN_LIVE !== "1") {
      expect(ticketMatchedFiles).toEqual(["unseen-enter-controls.answer.json"]);
    }
    await postHandsResult(recallUrl, {
      id: cPre.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 1 }],
    });

    await vi.waitFor(async () => {
      const lib = await readLibrary(recallDataDir);
      expect(lib).toHaveLength(1);
    });
    const noSaveDecide = await pollHandsNext(recallUrl, 40);
    expect(noSaveDecide.status).toBe(204);
    const [ticketEntry] = (await readLibrary(recallDataDir)) as LibraryEntry[];
    expect(ticketEntry.startSignature).toContain("intake.local");

    // Now post Move-1 (single copy event) in a brand new session on intake.local
    const move1Event: Event = {
      v: 1,
      id: "f9000000-0000-4000-8000-000000000001",
      ts: 1745000000000,
      session: "sess_move1_recall",
      source: "browser",
      app: "intake.local",
      window: "Ticket Triage — Incoming Requests",
      url: "http://intake.local:4400/triage",
      type: "copy",
      value: "TKT-8199",
      target: {
        tag: "span",
        label: "Ticket ID",
        locators: [{ kind: "testid", value: "triage-ticket-id" }],
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
    expect(recallDecide.cmd?.name).toBe(ticketEntry.name);
    expect((recallDecide.cmd?.name ?? "").length).toBeGreaterThan(0);
    expect(recallDecide.cmd?.script?.runMode).toBe("run_remaining");

    await postHandsResult(recallUrl, {
      id: recallDecide.cmd!.id,
      ok: true,
      decision: "approved",
      params: { priority: "critical" },
    });

    const recallRun = await pollHandsNext(recallUrl);
    expect(recallRun.status).toBe(200);
    expect(recallRun.cmd?.kind).toBeUndefined();
    expect((recallRun.cmd as unknown as { paramValues?: Record<string, string> })?.paramValues).toEqual({
      priority: "critical",
    });
    await postHandsResult(recallUrl, {
      id: recallRun.cmd!.id,
      ok: true,
      results: [{ ok: true }],
    });
  }, TEST_TIMEOUT_MS);

  it(
    "offers at rep 2 when offerAt2 === true, blocks precheck matchCount === 0, and builds GET /report across >10-min gaps",
    async () => {
    const { client: gemini, matchedFiles } = await getUnseenGeminiClient();
    const { baseUrl, dataDir: offer2DataDir } = await startV2Server({
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
    if (process.env.V2_UNSEEN_LIVE !== "1") {
      expect(matchedFiles[0]).toBe("unseen-two-repeats.answer.json");
    }
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
    expect((decideAt2.cmd?.name ?? "").length).toBeGreaterThan(0);
    await postHandsResult(baseUrl, {
      id: decideAt2.cmd!.id,
      ok: true,
      decision: "dismissed",
    });

    // Also verify GET /report works in v2 mode for 3+ repeats across >10-min gap (using good unseen-enter-controls recording)
    const rep3 = await loadFixtureEvents("unseen-enter-controls.jsonl");
    const spaced3 = rep3.map((ev, idx) =>
      idx >= 18 ? { ...ev, ts: ev.ts + 20 * 60 * 1000 } : ev,
    );
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spaced3),
    });

    const pre3 = await pollHandsNext(baseUrl);
    expect(pre3.cmd?.kind).toBe("precheck");
    if (process.env.V2_UNSEEN_LIVE !== "1") {
      expect(matchedFiles).toContain("unseen-enter-controls.answer.json");
    }
    await postHandsResult(baseUrl, {
      id: pre3.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "click", ok: true, matchCount: 1 }],
    });
    await vi.waitFor(async () => {
      const lib = await readLibrary(offer2DataDir);
      expect(lib.length).toBeGreaterThanOrEqual(1);
    });
    const noDec3 = await pollHandsNext(baseUrl, 40);
    expect(noDec3.status).toBe(204);
    const [savedTicketEntry] = await readLibrary(offer2DataDir);

    const reportRes = await fetch(
      `${baseUrl}/report?session=sess_unseen_enter_controls`,
    );
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].title).toBe(savedTicketEntry.name);
  }, TEST_TIMEOUT_MS);

  it("caches rep-2 precompile when offerAt2 === false and reuses on rep-3 via cache_hit without a second Gemini call", async () => {
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
        const payload = {
          suggest: true,
          offerAt2: false,
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
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          throw new Error(`invalid mock: ${parsed.error.message ?? "invalid"}`);
        }
        return parsed.data as T;
      },
    };

    const stageLogs: StageLogEvent[] = [];
    const { baseUrl } = await startV2Server({
      gemini,
      stageLogs,
      subDir: "rep2-cache-hit",
    });

    const twoRepEvents = await loadFixtureEvents("unseen-two-repeats.jsonl");
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(twoRepEvents),
    });

    await vi.waitFor(() => {
      expect(
        stageLogs.some(
          (e) => e.stage === "precompile" && e.session === "sess_unseen_two_repeats",
        ),
      ).toBe(true);
    });
    expect(calls).toBe(1);
    const noPopupAt2 = await pollHandsNext(baseUrl, 20);
    expect(noPopupAt2.status).toBe(204);

    // Post rep-3 events with identical constants/targets
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
    expect(
      stageLogs.some(
        (e) => e.stage === "cache_hit" && e.session === "sess_unseen_two_repeats",
      ),
    ).toBe(true);
    expect(calls).toBe(1);

    await postHandsResult(baseUrl, {
      id: decidePoll.cmd!.id,
      ok: true,
      decision: "dismissed",
    });
  });

  it("attaches flow start url and last workflow tabId to decide, and start url to run (ignoring trailing unrelated clicks)", async () => {
    const { client: unseenGemini } = await getUnseenGeminiClient();
    const { baseUrl } = await startV2Server({
      gemini: unseenGemini,
      subDir: "decide-tab-and-starturl",
    });

    const events = await loadFixtureEvents("unseen-two-repeats.jsonl");
    const lastFlowIdx = events.length - 1;
    const eventsWithTabs: Event[] = [
      ...events.map((ev, idx) => ({
        ...ev,
        meta: {
          ...(ev.meta ?? {}),
          tabId: idx === lastFlowIdx || ev.app === "erp-stock.local" ? 502 : 501,
        },
      })),
      {
        v: 1,
        id: "f9000000-0000-4000-8000-000000000099",
        ts: events[events.length - 1]!.ts + 500,
        session: events[0]!.session,
        source: "browser",
        app: "mail.google.com",
        url: "https://mail.google.com/mail/u/0/#inbox",
        type: "click",
        target: {
          tag: "div",
          locators: [{ kind: "css", value: "div.email-row" }],
        },
        meta: { tabId: 999 },
      },
    ];

    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventsWithTabs),
    });

    const pre = await pollHandsNext(baseUrl);
    expect(pre.cmd?.kind).toBe("precheck");
    await postHandsResult(baseUrl, {
      id: pre.cmd!.id,
      ok: true,
      results: [{ index: 0, action: "readText", ok: true, matchCount: 1, unique: true }],
    });

    const dec = await pollHandsNext(baseUrl);
    expect(dec.status).toBe(200);
    expect(dec.cmd?.kind).toBe("decide");
    const decExtra = dec.cmd as unknown as { url?: string; tabId?: number };
    expect(decExtra.tabId).toBe(502);
    expect(decExtra.url).toContain("warehouse.local");

    await postHandsResult(baseUrl, {
      id: dec.cmd!.id,
      ok: true,
      decision: "approved",
    });

    const run = await pollHandsNext(baseUrl);
    expect(run.status).toBe(200);
    const runExtra = run.cmd as unknown as { url?: string; script?: { steps: Array<{ action: string; url?: string }> } };
    expect(runExtra.url).toContain("warehouse.local");
    expect(runExtra.script?.steps[0]?.action).toBe("switchTab");
    expect(runExtra.script?.steps[0]?.url).toContain("warehouse.local");

    await postHandsResult(baseUrl, {
      id: run.cmd!.id,
      ok: true,
      results: [{ ok: true }],
    });
  }, TEST_TIMEOUT_MS);
});
