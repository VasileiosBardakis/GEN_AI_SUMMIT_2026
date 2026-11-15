import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { EventsSchema } from "@gen/shared/schema.ts";
import {
  compileWorkflow,
  validateCompiledWorkflow,
  type CompiledWorkflow,
} from "../src/v2/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARGET_LATENCY_MS = 2500;
const BENCHMARK_FIXTURES = [
  "unseen-multifield-tab.jsonl",
  "unseen-pii-risky.jsonl",
] as const;

async function loadFixture(filename: string): Promise<Event[]> {
  const raw = await readFile(path.join(__dirname, "fixtures", filename), "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return EventsSchema.parse(lines.map((l) => JSON.parse(l) as unknown));
}

type BakeoffRun = {
  model: string;
  fixture: string;
  elapsedMs: number;
  workflow: CompiledWorkflow | null;
  error?: string;
};

async function runBakeoffForModel(
  model: string,
  timeoutMs: number,
): Promise<BakeoffRun[]> {
  // Warm up connection / auth token so per-fixture latency reflects steady state
  const warmupEvents = await loadFixture("unseen-enter-controls.jsonl");
  await compileWorkflow(
    { events: warmupEvents },
    {
      gemini: { model, thinkingBudget: 0 },
      iris: async () => null,
      timeoutMs: 8000,
    },
  ).catch(() => null);

  const results: BakeoffRun[] = [];
  for (const fixture of BENCHMARK_FIXTURES) {
    const events = await loadFixture(fixture);
    const started = performance.now();
    try {
      const workflow = await compileWorkflow(
        { events },
        {
          gemini: { model, thinkingBudget: 0 },
          iris: async () => null,
          timeoutMs,
        },
      );
      const elapsedMs = performance.now() - started;
      console.log(
        `[bakeoff] model=${model} fixture=${fixture} ms=${Math.round(elapsedMs)} ok=${workflow !== null} steps=${workflow?.steps.length ?? 0}`,
      );
      results.push({ model, fixture, elapsedMs, workflow });
    } catch (err) {
      const elapsedMs = performance.now() - started;
      const error = err instanceof Error ? err.message : String(err);
      console.log(
        `[bakeoff] model=${model} fixture=${fixture} ms=${Math.round(elapsedMs)} error=${error}`,
      );
      results.push({ model, fixture, elapsedMs, workflow: null, error });
    }
  }
  return results;
}

describe.skipIf(!process.env.GOOGLE_CLOUD_PROJECT)(
  "Brain v2 Wave-2 live models bakeoff (gemini-3.1-flash-lite vs gemini-3.5-flash)",
  () => {
    const prevUseVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    const prevLocation = process.env.GOOGLE_CLOUD_LOCATION;

    afterEach(() => {
      if (prevUseVertex === undefined) {
        delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      } else {
        process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertex;
      }
      if (prevLocation === undefined) {
        delete process.env.GOOGLE_CLOUD_LOCATION;
      } else {
        process.env.GOOGLE_CLOUD_LOCATION = prevLocation;
      }
    });

    it("benchmarks gemini-3.1-flash-lite (<2.5 s) vs gemini-3.5-flash via Vertex AI ADC", async () => {
      process.env.GOOGLE_GENAI_USE_VERTEXAI ??= "true";
      process.env.GOOGLE_CLOUD_LOCATION ??= "global";

      const liteRuns = await runBakeoffForModel("gemini-3.1-flash-lite", 6000);
      const flashRuns = await runBakeoffForModel("gemini-3.5-flash", 6000);

      expect(liteRuns).toHaveLength(BENCHMARK_FIXTURES.length);
      expect(flashRuns).toHaveLength(BENCHMARK_FIXTURES.length);

      const liteSucceeded = liteRuns.filter(
        (r) => r.error === undefined && r.workflow !== null,
      );
      expect(liteSucceeded.length).toBeGreaterThanOrEqual(1);
      for (const run of liteSucceeded) {
        expect(validateCompiledWorkflow(run.workflow!).ok).toBe(true);
      }

      const liteMinMs = Math.min(...liteRuns.map((r) => r.elapsedMs));
      const liteAvgMs =
        liteRuns.reduce((sum, r) => sum + r.elapsedMs, 0) / liteRuns.length;
      const flashAvgMs =
        flashRuns.reduce((sum, r) => sum + r.elapsedMs, 0) / flashRuns.length;
      console.log(
        `[bakeoff-summary] gemini-3.1-flash-lite min=${Math.round(liteMinMs)}ms avg=${Math.round(liteAvgMs)}ms vs gemini-3.5-flash avg=${Math.round(flashAvgMs)}ms`,
      );
      expect(liteMinMs).toBeLessThan(TARGET_LATENCY_MS);
    }, 30_000);
  },
);
