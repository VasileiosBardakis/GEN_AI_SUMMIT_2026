import { mkdtemp, readFile, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Report, Step } from "@gen/shared";
import { EventSchema, ReportSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import { normalize } from "../src/detect/normalize.ts";
import type { ActionScript } from "../src/hands/types.ts";
import type { GeminiSdk } from "../src/llm/gemini.ts";
import {
  DEFAULT_PIPELINE_CONFIG,
  filterNoisySteps,
  runPipeline,
} from "../src/pipeline.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

function makeFakeActionScript(name = "Compiled Routine"): ActionScript {
  return {
    name,
    steps: [
      {
        action: "click",
        target: { kind: "css", value: 'td[data-cell="R1"]' },
      },
    ],
  };
}

function makeSendCopyOfRoutine20Noisy(
  rawEvents: Event[],
  mode: "locator" | "labelOnly",
): Event[] {
  return rawEvents.map((ev) => {
    const isStep20 =
      ev.type === "click" &&
      ev.target?.locators.some(
        (l) => l.kind === "testid" && l.value === "routine-cell-20",
      );
    if (!isStep20) return ev;

    if (mode === "labelOnly") {
      return {
        ...ev,
        target: {
          ...ev.target!,
          label: "Send",
        },
      };
    }

    return {
      ...ev,
      target: {
        tag: "button",
        role: "button",
        label: "Send",
        locators: [
          { kind: "testid", value: "send-btn" },
          { kind: "text", value: "Send" },
        ],
      },
    };
  });
}

describe("pipeline unit & config tests", () => {
  it("exports expected config defaults (minBigramShare=0.5, confidenceThreshold=0.6, safetyWords)", () => {
    expect(DEFAULT_PIPELINE_CONFIG.minBigramShare).toBe(0.5);
    expect(DEFAULT_PIPELINE_CONFIG.confidenceThreshold).toBe(0.6);
    expect(DEFAULT_PIPELINE_CONFIG.safetyWords).toEqual([
      "send",
      "pay",
      "payment",
      "delete",
      "remove",
      "transfer",
      "purchase",
      "confirm order",
    ]);
  });

  it("filters out noisy transitions appearing in < 50% of sequences before detectWorkflows", async () => {
    const events = await loadFixtureEvents("routine-20-noisy.jsonl");
    const steps = normalize(events);
    expect(steps).toHaveLength(83);

    const { filteredSteps } = filterNoisySteps(steps, { events });
    expect(filteredSteps).toHaveLength(80);
    expect(
      filteredSteps.some((s) =>
        s.target?.some((l) => l.value === "stray-toolbar"),
      ),
    ).toBe(false);
  });

  it("keeps stats result when Gemini throws and sends a digest with no typed values", async () => {
    const replyEvents = await loadFixtureEvents("reply-x3.jsonl");
    const steps = normalize(replyEvents);

    const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(
      async () => {
        throw new Error("Gemini network outage");
      },
    );
    const implement = vi.fn(async (_solution: string, opts?: { name?: string }) =>
      makeFakeActionScript(opts?.name),
    );

    const findings = await runPipeline(steps, {
      llm: true,
      events: replyEvents,
      gemini: { sdk: { models: { generateContent } } },
      implement,
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    const promptArg = generateContent.mock.calls[0]?.[0]?.contents ?? "";
    expect(promptArg).not.toContain("Hi, thanks for your order");

    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("rung1");
    expect(implement).toHaveBeenCalledTimes(1);
  });

  it("maps Gemini risky=true to do_not_automate and keeps stats result on Gemini timeout", async () => {
    const lowConfidenceSteps: Step[] = [1, 2, 3].flatMap((rep) => [
      {
        action: "fill" as const,
        target: [{ kind: "testid" as const, value: "search-box" }],
        value: `query-${rep}`,
      },
      {
        action: "click" as const,
        target: [{ kind: "testid" as const, value: "filter-btn" }],
      },
      {
        action: "click" as const,
        target: [{ kind: "testid" as const, value: "open-row" }],
      },
      {
        action: "submit" as const,
        target: [{ kind: "testid" as const, value: "view-form" }],
      },
    ]);

    const riskySdk: GeminiSdk = {
      models: {
        generateContent: vi.fn(async () => ({
          text: JSON.stringify({
            verdict: "rung2",
            confidence: 0.9,
            name: "Risky search routine",
            risky: true,
          }),
        })),
      },
    };
    const implement = vi.fn(async () => makeFakeActionScript("Should not run"));

    const riskyFindings = await runPipeline(lowConfidenceSteps, {
      llm: true,
      gemini: { sdk: riskySdk },
      implement,
    });
    expect(riskyFindings).toHaveLength(1);
    expect(riskyFindings[0].verdict).toBe("do_not_automate");
    expect(implement).not.toHaveBeenCalled();

    const slowSdk: GeminiSdk = {
      models: {
        generateContent: () => new Promise(() => {}),
      },
    };
    const timeoutFindings = await runPipeline(lowConfidenceSteps, {
      llm: true,
      gemini: { sdk: slowSdk },
      implement,
      config: { llmTimeoutMs: 25 },
    });
    expect(timeoutFindings).toHaveLength(1);
    expect(timeoutFindings[0].verdict).toBe("rung2");
  });

  it("blocks candidates clicking/submitting any safety word even when llm=true and stats are confident", async () => {
    for (const word of ["pay", "payment", "delete", "remove", "transfer", "purchase", "confirm order"]) {
      const steps: Step[] = [1, 2, 3, 4].flatMap(() => [
        { action: "click" as const, target: [{ kind: "testid" as const, value: "select-item" }] },
        { action: "click" as const, target: [{ kind: "testid" as const, value: "review-item" }] },
        { action: "click" as const, target: [{ kind: "text" as const, value: word }] },
        { action: "submit" as const, target: [{ kind: "testid" as const, value: "item-form" }] },
      ]);

      const geminiSpy = vi.fn(async () => ({
        text: JSON.stringify({
          verdict: "rung2",
          confidence: 0.99,
          name: "Safe?",
          risky: false,
        }),
      }));
      const implementSpy = vi.fn(async () => makeFakeActionScript());

      const findings = await runPipeline(steps, {
        llm: true,
        gemini: { sdk: { models: { generateContent: geminiSpy } } },
        implement: implementSpy,
      });

      expect(findings).toHaveLength(1);
      expect(findings[0].verdict).toBe("do_not_automate");
      expect(findings[0].why).toMatch(/step 3/i);
      expect(geminiSpy).not.toHaveBeenCalled();
      expect(implementSpy).not.toHaveBeenCalled();
    }
  });

  it("includes {param} placeholders in plain-text solution passed to implement for parameterized rung2 workflows", async () => {
    const steps: Step[] = [1, 2, 3, 4, 5].flatMap((i) => [
      {
        action: "fill" as const,
        target: [{ kind: "testid" as const, value: "erp-order-id" }],
        value: `ORD-${i}`,
      },
      {
        action: "click" as const,
        target: [{ kind: "testid" as const, value: "lookup-btn" }],
      },
      {
        action: "click" as const,
        target: [{ kind: "testid" as const, value: "mark-reviewed" }],
      },
      {
        action: "submit" as const,
        target: [{ kind: "testid" as const, value: "review-form" }],
      },
    ]);

    let capturedSolution = "";
    const implement = vi.fn(async (solution: string, opts?: { name?: string }) => {
      capturedSolution = solution;
      return makeFakeActionScript(opts?.name);
    });

    const findings = await runPipeline(steps, {
      llm: true,
      gemini: {
        sdk: {
          models: {
            generateContent: async () => ({
              text: JSON.stringify({
                verdict: "rung2",
                confidence: 0.9,
                name: "Review order workflow",
                risky: false,
              }),
            }),
          },
        },
      },
      implement,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("rung2");
    expect(implement).toHaveBeenCalledTimes(1);
    expect(capturedSolution).toContain("{erp_order_id}");
    expect(capturedSolution).toContain('testid="lookup-btn"');
  });
});

describe("pipeline HTTP integration (GET /report & GET /script/:findingId)", () => {
  let rootDir: string;
  let tracesDir: string;
  let dataDir: string;
  let server: http.Server;
  let baseUrl: string;
  let fakeGeminiFn: ReturnType<typeof vi.fn<GeminiSdk["models"]["generateContent"]>>;
  let fakeImplementFn: ReturnType<
    typeof vi.fn<(solution: string, opts?: { name?: string }) => Promise<ActionScript>>
  >;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "gen-pipeline-http-"));
    tracesDir = path.join(rootDir, "traces");
    dataDir = path.join(rootDir, "data");

    fakeGeminiFn = vi.fn<GeminiSdk["models"]["generateContent"]>(async () => ({
      text: JSON.stringify({
        verdict: "rung1",
        confidence: 0.9,
        name: "Reply template",
        risky: false,
      }),
    }));

    fakeImplementFn = vi.fn(
      async (solution: string, opts?: { name?: string }) => ({
        name: opts?.name ?? "Compiled Script",
        steps: [
          {
            action: "insertText",
            value: solution.slice(0, 40),
          },
        ],
      }),
    );

    server = createServer({
      tracesDir,
      dataDir,
      gemini: { sdk: { models: { generateContent: fakeGeminiFn } } },
      implement: fakeImplementFn,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(rootDir, { recursive: true, force: true });
  });

  it("routine-20-noisy -> rung2 finding with /script/<id> and GET /script/<id> 200, unknown id 404", async () => {
    const events = await loadFixtureEvents("routine-20-noisy.jsonl");
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    });

    const reportRes = await fetch(
      `${baseUrl}/report?session=sess_routine_20_noisy`,
    );
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);

    const [finding] = report.findings;
    expect(finding.verdict).toBe("rung2");
    expect(finding.stats.repetitions).toBe(4);
    expect(finding.artifact).toEqual({
      kind: "text",
      path: `/script/${finding.id}`,
      verified: false,
    });
    expect(fakeGeminiFn).not.toHaveBeenCalled();
    expect(fakeImplementFn).toHaveBeenCalledTimes(1);
    const solutionArg = fakeImplementFn.mock.calls[0]?.[0] ?? "";
    expect(solutionArg).toContain('td[data-cell="R1"]');
    expect(solutionArg).toContain('td[data-cell="R20"]');

    const scriptRes = await fetch(`${baseUrl}/script/${finding.id}`);
    expect(scriptRes.status).toBe(200);
    const scriptBody = (await scriptRes.json()) as {
      ok: boolean;
      script: ActionScript;
    };
    expect(scriptBody.ok).toBe(true);
    expect(scriptBody.script.steps.length).toBeGreaterThan(0);

    const unknownRes = await fetch(`${baseUrl}/script/wf_does_not_exist`);
    expect(unknownRes.status).toBe(404);
    expect(await unknownRes.json()).toEqual({
      ok: false,
      error: "Script not found",
    });
  });

  it("routine-20-noisy copy whose last click target is a Send button -> do_not_automate with ?llm=0", async () => {
    const rawEvents = await loadFixtureEvents("routine-20-noisy.jsonl");

    for (const mode of ["locator", "labelOnly"] as const) {
      const session = `sess_routine_send_${mode}`;
      const sendEvents = makeSendCopyOfRoutine20Noisy(rawEvents, mode).map(
        (ev) => ({ ...ev, session }),
      );

      await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sendEvents),
      });

      const reportRes = await fetch(
        `${baseUrl}/report?session=${session}&llm=0`,
      );
      expect(reportRes.status).toBe(200);
      const report = (await reportRes.json()) as Report;
      expect(ReportSchema.parse(report)).toEqual(report);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].verdict).toBe("do_not_automate");
      expect(report.findings[0].why).toMatch(/step 20/i);
      expect(report.findings[0].why.toLowerCase()).toContain("send");
      expect(report.findings[0].artifact).toBeUndefined();
      expect(fakeGeminiFn).not.toHaveBeenCalled();
      expect(fakeImplementFn).not.toHaveBeenCalled();
    }
  });

  it("one-off -> no finding", async () => {
    const events = await loadFixtureEvents("one-off.jsonl");
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    });

    const reportRes = await fetch(`${baseUrl}/report?session=sess_one_off`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toEqual([]);
    expect(fakeGeminiFn).not.toHaveBeenCalled();
    expect(fakeImplementFn).not.toHaveBeenCalled();
  });

  it("Gemini throwing -> keeps stats result", async () => {
    fakeGeminiFn.mockRejectedValueOnce(new Error("Gemini 503"));

    const events = await loadFixtureEvents("reply-x3.jsonl");
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    });

    const reportRes = await fetch(`${baseUrl}/report?session=sess_reply_x3`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].verdict).toBe("rung1");
    expect(fakeGeminiFn).toHaveBeenCalledTimes(1);
  });

  it("reply-x3 -> rung1 snippet with ?llm=0 and with llm=1", async () => {
    const events = await loadFixtureEvents("reply-x3.jsonl");
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    });

    const noLlmRes = await fetch(
      `${baseUrl}/report?session=sess_reply_x3&llm=0`,
    );
    expect(noLlmRes.status).toBe(200);
    const noLlmReport = (await noLlmRes.json()) as Report;
    expect(noLlmReport.findings).toHaveLength(1);
    expect(noLlmReport.findings[0].verdict).toBe("rung1");
    expect(noLlmReport.findings[0].artifact).toEqual({
      kind: "snippet",
      path: `snippets/${noLlmReport.findings[0].id}.txt`,
      verified: true,
    });
    expect(fakeGeminiFn).not.toHaveBeenCalled();
    expect(fakeImplementFn).not.toHaveBeenCalled();

    const llmRes = await fetch(`${baseUrl}/report?session=sess_reply_x3`);
    expect(llmRes.status).toBe(200);
    const llmReport = (await llmRes.json()) as Report;
    expect(llmReport.findings).toHaveLength(1);
    expect(llmReport.findings[0].verdict).toBe("rung1");
    expect(llmReport.findings[0].artifact).toEqual({
      kind: "text",
      path: `/script/${llmReport.findings[0].id}`,
      verified: false,
    });
    expect(fakeImplementFn).toHaveBeenCalledTimes(1);

    const scriptRes = await fetch(
      `${baseUrl}/script/${llmReport.findings[0].id}`,
    );
    expect(scriptRes.status).toBe(200);
    const scriptBody = (await scriptRes.json()) as {
      ok: boolean;
      script: ActionScript;
    };
    expect(scriptBody.ok).toBe(true);
  });
});
