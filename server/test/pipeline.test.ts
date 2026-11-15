import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Report, Step, Workflow } from "@gen/shared";
import { EventSchema, ReportSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import { normalize } from "../src/detect/normalize.ts";
import type { ActionScript } from "../src/hands/types.ts";
import type { LibraryEntry } from "../src/library.ts";
import type { GeminiClient, GeminiSdk } from "../src/llm/gemini.ts";
import {
  buildSolutionText,
  DEFAULT_PIPELINE_CONFIG,
  describeCandidate,
  filterNoisySteps,
  isSelectStep,
  runPipeline,
} from "../src/pipeline.ts";
import { buildReport } from "../src/report.ts";

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
    expect(capturedSolution).toContain('fill testid="erp-order-id" with "ORD-1"');
    expect(capturedSolution).toContain('testid="lookup-btn"');
  });

  it("buildSolutionText prefers css/testid over aria, formats cross-host switchTab and {{param}} bindings, and substitutes single-host param examples", () => {
    const crossHostWf: Workflow = {
      id: "wf_cross",
      name: "portal.local -> erp.local (3 steps)",
      sourceApp: "portal.local",
      destApp: "erp.local",
      steps: [
        {
          action: "copy",
          target: [
            { kind: "aria", value: 'textbox[name="Company name"]' },
            { kind: "css", value: "#portal-company" },
          ],
          value: { param: "company_name" },
        },
        {
          action: "paste",
          target: [
            { kind: "aria", value: 'textbox[name="Vendor"]' },
            { kind: "testid", value: "erp-vendor" },
            { kind: "css", value: 'input[name="vendor"]' },
          ],
          value: { param: "company_name" },
        },
        {
          action: "click",
          target: [
            { kind: "aria", value: 'button[name="Save"]' },
            { kind: "text", value: "Save" },
          ],
        },
      ],
      params: [{ name: "company_name", example: "Acme Corp" }],
      instances: [],
    };

    const crossSolution = buildSolutionText("rung2", crossHostWf);
    expect(crossSolution).toContain(
      "Read values on portal.local, switch to erp.local, and fill on erp.local:",
    );
    expect(crossSolution).toContain('1. switchTab host="portal.local"');
    expect(crossSolution).toContain(
      '2. readText from css="#portal-company" into "{{company_name}}"',
    );
    expect(crossSolution).toContain('3. switchTab host="erp.local"');
    expect(crossSolution).toContain(
      '4. fill testid="erp-vendor" with "{{company_name}}"',
    );
    expect(crossSolution).toContain('5. click text="Save"');
    expect(crossSolution).not.toContain("aria=");

    const singleHostWf: Workflow = {
      id: "wf_single",
      name: "erp.local workflow (2 steps)",
      sourceApp: "erp.local",
      destApp: "erp.local",
      steps: [
        {
          action: "fill",
          target: [
            { kind: "aria", value: 'textbox[name="Company"]' },
            { kind: "css", value: "#company-input" },
          ],
          value: { param: "company" },
        },
        {
          action: "fill",
          target: [{ kind: "testid", value: "fallback-field" }],
          value: { param: "no_example" },
        },
      ],
      params: [{ name: "company", example: "Globex" }],
      instances: [],
    };

    const singleSolution = buildSolutionText("rung2", singleHostWf);
    expect(singleSolution).toContain(
      'Execute the workflow "erp.local workflow (2 steps)" on erp.local:',
    );
    expect(singleSolution).toContain(
      '1. fill css="#company-input" with "Globex"',
    );
    expect(singleSolution).not.toContain("{company}");
    expect(singleSolution).toContain(
      '2. fill testid="fallback-field" with {no_example}',
    );
  });

  it("runPipeline times out a hanging implement mock via implementTimeoutMs without failing the report", async () => {
    const events = await loadFixtureEvents("routine-20-noisy.jsonl");
    const steps = normalize(events);
    const scriptStore = new Map<string, ActionScript>();
    const hangingImplement = vi.fn(
      () => new Promise<ActionScript>(() => {}),
    );

    const findings = await runPipeline(steps, {
      llm: true,
      events,
      implement: hangingImplement,
      scriptStore,
      config: { implementTimeoutMs: 25 },
    });

    expect(hangingImplement).toHaveBeenCalledTimes(1);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("rung2");
    expect(findings[0].artifact).toBeUndefined();
    expect(scriptStore.size).toBe(0);
  });

  it("runPipeline forwards opts.gemini (GeminiClient) to default implementSolution and writes snippets/<id>.txt alongside scriptStore when llm=true and dataDir is set", async () => {
    const replyEvents = await loadFixtureEvents("reply-x3.jsonl");
    const steps = normalize(replyEvents);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "gen-pipeline-snip-llm-"));

    try {
      const generateJson = vi.fn(async (prompt: string) => {
        if (prompt.includes("ActionScript")) {
          return {
            name: "Compiled Reply Script",
            steps: [
              {
                action: "insertText",
                value:
                  "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
              },
            ],
          };
        }
        return {
          level: "rung1",
          risky: false,
          confidence: 0.95,
          name: "Reply snippet",
        };
      }) as GeminiClient["generateJson"];

      const geminiClient: GeminiClient = {
        generateText: vi.fn(async () => "ok"),
        generateJson,
      };
      const scriptStore = new Map<string, ActionScript>();

      const findings = await runPipeline(steps, {
        llm: true,
        events: replyEvents,
        gemini: geminiClient,
        dataDir: tempDir,
        scriptStore,
      });

      expect(findings).toHaveLength(1);
      const [finding] = findings;
      expect(finding.verdict).toBe("rung1");
      expect(finding.artifact).toEqual({
        kind: "text",
        path: `/script/${finding.id}`,
        verified: false,
      });
      expect(scriptStore.get(finding.id)).toEqual({
        name: finding.title,
        steps: [
          {
            action: "insertText",
            value:
              "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
          },
        ],
      });

      const snippetFile = path.join(tempDir, "snippets", `${finding.id}.txt`);
      expect(existsSync(snippetFile)).toBe(true);
      expect(await readFile(snippetFile, "utf8")).toBe(
        "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
      );
      expect(generateJson).toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reply-x3 with a fake model that returns risky=true -> still a snippet (rung1)", async () => {
    const replyEvents = await loadFixtureEvents("reply-x3.jsonl");
    const steps = normalize(replyEvents);

    const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(
      async () => ({
        text: JSON.stringify({
          level: "rung1",
          risky: true,
          confidence: 0.9,
        }),
      }),
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
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("rung1");
    expect(findings[0].title).toBe(
      'Insert reply: "Hi, thanks for your order. It ships Frid..."',
    );
  });

  it("dispute-x3 -> do_not_automate (safety list), with and without the model", async () => {
    const disputeEvents = await loadFixtureEvents("dispute-x3.jsonl");
    const steps = normalize(disputeEvents);

    const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(
      async () => ({
        text: JSON.stringify({
          level: "rung2",
          risky: false,
          confidence: 0.99,
          name: "Reply to disputes",
        }),
      }),
    );
    const implement = vi.fn(async () => makeFakeActionScript());

    const withModel = await runPipeline(steps, {
      llm: true,
      events: disputeEvents,
      gemini: { sdk: { models: { generateContent } } },
      implement,
    });
    expect(withModel).toHaveLength(1);
    expect(withModel[0].verdict).toBe("do_not_automate");
    expect(withModel[0].why.toLowerCase()).toContain("send");
    expect(generateContent).not.toHaveBeenCalled();
    expect(implement).not.toHaveBeenCalled();

    const withoutModel = await runPipeline(steps, {
      llm: false,
      events: disputeEvents,
      implement,
    });
    expect(withoutModel).toHaveLength(1);
    expect(withoutModel[0].verdict).toBe("do_not_automate");
    expect(withoutModel[0].why.toLowerCase()).toContain("send");
    expect(implement).not.toHaveBeenCalled();
  });

  it("a fake second layer that throws -> stats result kept", async () => {
    const replyEvents = await loadFixtureEvents("reply-x3.jsonl");
    const steps = normalize(replyEvents);

    const throwingSecondLayer = vi.fn(async () => {
      throw new Error("Second layer crashed");
    });

    const findings = await runPipeline(steps, {
      llm: true,
      events: replyEvents,
      decideSecond: throwingSecondLayer,
      implement: vi.fn(async (_s: string, opts?: { name?: string }) =>
        makeFakeActionScript(opts?.name),
      ),
    });

    expect(throwingSecondLayer).toHaveBeenCalledTimes(1);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("rung1");
  });

  it("a library file in a temp dataDir that matches invoice-x9 -> finding uses the library script, implement is not called", async () => {
    const invoiceEvents = await loadFixtureEvents("invoice-x9.jsonl");
    const steps = normalize(invoiceEvents);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "gen-pipeline-lib-"));
    try {
      const savedScript: ActionScript = {
        name: "Saved Invoice Copier",
        steps: [
          {
            action: "click",
            target: { kind: "testid", value: "save-btn" },
          },
        ],
      };
      const entry: LibraryEntry = {
        id: "lib-invoice-x9",
        signature: {
          host: "portal.local->erp.local",
          steps: [
            "copy:testid",
            "copy:testid",
            "copy:testid",
            "copy:testid",
            "paste:testid",
            "paste:testid",
            "paste:testid",
            "paste:testid",
            "click:testid",
          ],
        },
        name: "Invoice Portal to ERP",
        solution: "Copy 4 invoice fields from portal.local to erp.local and click Save.",
        script: savedScript,
      };
      await writeFile(
        path.join(tempDir, "library.json"),
        JSON.stringify([entry]),
        "utf8",
      );

      const scriptStore = new Map<string, ActionScript>();
      const implement = vi.fn(async () => makeFakeActionScript("Should not be called"));

      const findings = await runPipeline(steps, {
        llm: true,
        events: invoiceEvents,
        dataDir: tempDir,
        scriptStore,
        implement,
      });

      expect(implement).not.toHaveBeenCalled();
      expect(findings).toHaveLength(1);
      expect(findings[0].verdict).toBe("rung2");
      expect(findings[0].title).toMatch(/^Copy 4 fields from/);
      expect(findings[0].why).toContain(
        "Matched saved automation Invoice Portal to ERP",
      );
      expect(findings[0].artifact).toEqual({
        kind: "text",
        path: `/script/${findings[0].id}`,
        verified: false,
      });
      expect(scriptStore.get(findings[0].id)).toEqual(savedScript);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("invoice-x9 title starts with 'Copy 4 fields from' and describeCandidate formats deterministic titles", async () => {
    const invoiceEvents = await loadFixtureEvents("invoice-x9.jsonl");
    const steps = normalize(invoiceEvents);

    const findings = await runPipeline(steps, {
      llm: false,
      events: invoiceEvents,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].title).toMatch(/^Copy 4 fields from/);
    expect(findings[0].title).toBe("Copy 4 fields from portal.local to erp.local");

    expect(
      describeCandidate({
        workflow: {
          id: "wf-clicks",
          name: "sheets.local workflow (3 steps)",
          sourceApp: "sheets.local",
          destApp: "sheets.local",
          steps: [
            { action: "click", target: [{ kind: "css", value: "td.a" }] },
            { action: "click", target: [{ kind: "css", value: "td.b" }] },
            { action: "click", target: [{ kind: "css", value: "td.c" }] },
          ],
          params: [],
          instances: [],
        },
        repetitions: 4,
        minutesPerWeek: 2,
        stability: 1,
      }),
    ).toBe("Click 3 items on sheets.local");

    expect(
      describeCandidate({
        workflow: {
          id: "snip-1",
          name: "Save a snippet",
          sourceApp: "mail.local",
          destApp: "mail.local",
          steps: [
            {
              action: "fill",
              value:
                "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
            },
          ],
          params: [],
          instances: [],
        },
        repetitions: 3,
        minutesPerWeek: 1,
        stability: 0.9,
      }),
    ).toBe('Insert reply: "Hi, thanks for your order. It ships Frid..."');
  });

  it("buildSolutionText emits select <select> for <select> targets (css, combobox aria, or matching events) while keeping fill for <input>", () => {
    const wf: Workflow = {
      id: "wf_dropdown",
      name: "erp.local workflow (4 steps)",
      sourceApp: "erp.local",
      destApp: "erp.local",
      steps: [
        {
          action: "fill",
          target: [{ kind: "css", value: 'select[name="priority"]' }],
          value: "urgent",
        },
        {
          action: "fill",
          target: [
            { kind: "testid", value: "status-select" },
            { kind: "css", value: "#status" },
          ],
          value: { param: "status" },
        },
        {
          action: "fill",
          target: [
            { kind: "aria", value: 'combobox[name="Region"]' },
            { kind: "css", value: "#region-picker" },
          ],
          value: "eu-west",
        },
        {
          action: "fill",
          target: [
            { kind: "testid", value: "note-input" },
            { kind: "css", value: 'input[name="note"]' },
          ],
          value: { param: "note" },
        },
        {
          action: "submit",
          target: [{ kind: "css", value: "#entry-form" }],
        },
      ],
      params: [
        { name: "status", example: "approved" },
        { name: "note", example: "Verified invoice" },
      ],
      instances: [],
    };

    const events: Event[] = [
      {
        v: 1,
        id: "ev-status",
        ts: 1000,
        session: "sess_drop",
        source: "browser",
        app: "erp.local",
        type: "change",
        target: {
          tag: "select",
          role: "combobox",
          locators: [
            { kind: "testid", value: "status-select" },
            { kind: "css", value: "#status" },
          ],
        },
        value: "approved",
        meta: { selectedValue: "approved", selectedLabel: "Approved" },
      },
      {
        v: 1,
        id: "ev-note",
        ts: 1100,
        session: "sess_drop",
        source: "browser",
        app: "erp.local",
        type: "input",
        target: {
          tag: "input",
          role: "textbox",
          locators: [
            { kind: "testid", value: "note-input" },
            { kind: "css", value: 'input[name="note"]' },
          ],
        },
        value: "Verified invoice",
      },
    ];

    expect(isSelectStep(wf.steps[0])).toBe(true);
    expect(isSelectStep(wf.steps[1])).toBe(false);
    expect(isSelectStep(wf.steps[1], events)).toBe(true);
    expect(isSelectStep(wf.steps[2])).toBe(true);
    expect(isSelectStep(wf.steps[3], events)).toBe(false);

    const solution = buildSolutionText("rung2", wf, undefined, events);
    expect(solution).not.toBeNull();
    expect(solution).toContain(
      '1. select <select> css="select[name="priority"]" with "urgent"',
    );
    expect(solution).toContain(
      '2. select <select> testid="status-select" with "approved"',
    );
    expect(solution).toContain(
      '3. select <select> css="#region-picker" with "eu-west"',
    );
    expect(solution).toContain(
      '4. fill testid="note-input" with "Verified invoice"',
    );
    expect(solution).not.toContain('fill css="select[name="priority"]"');
    expect(solution).not.toContain('fill testid="status-select"');
    expect(solution).not.toContain('select <select> testid="note-input"');
  });

  it("buildSolutionText resolves real hosts from events and never emits switchTab host='browser', 'unknown', or 'local-page'", () => {
    for (const placeholder of ["browser", "unknown", "local-page"]) {
      const wfWithPlaceholder: Workflow = {
        id: `wf_${placeholder}`,
        name: "Placeholder flow",
        sourceApp: placeholder,
        destApp: placeholder,
        steps: [
          {
            action: "copy",
            target: [{ kind: "testid", value: "portal-id" }],
            value: { param: "id" },
          },
          {
            action: "paste",
            target: [{ kind: "testid", value: "erp-id" }],
            value: { param: "id" },
          },
          {
            action: "click",
            target: [{ kind: "testid", value: "save-btn" }],
          },
        ],
        params: [{ name: "id", example: "INV-1" }],
        instances: [],
      };

      // Without events having real hosts, omit switchTab host="browser" / "unknown" / "local-page"
      const noHostSolution = buildSolutionText("rung2", wfWithPlaceholder);
      expect(noHostSolution).not.toBeNull();
      expect(noHostSolution).not.toContain(`switchTab host="${placeholder}"`);
      expect(noHostSolution).not.toContain("switchTab");

      // With events having real URLs despite placeholder app, resolve real hosts
      const eventsWithUrls: Event[] = [
        {
          v: 1,
          id: "ev-copy",
          ts: 1000,
          session: "sess_real",
          source: "browser",
          app: placeholder,
          url: "http://localhost:4173/portal.html",
          type: "copy",
          target: { locators: [{ kind: "testid", value: "portal-id" }] },
          value: "INV-1",
        },
        {
          v: 1,
          id: "ev-paste",
          ts: 2000,
          session: "sess_real",
          source: "browser",
          app: placeholder,
          url: "http://127.0.0.1:4173/erp.html",
          type: "paste",
          target: { locators: [{ kind: "testid", value: "erp-id" }] },
          value: "INV-1",
        },
      ];
      const resolvedSolution = buildSolutionText(
        "rung2",
        wfWithPlaceholder,
        undefined,
        eventsWithUrls,
      );
      expect(resolvedSolution).not.toBeNull();
      expect(resolvedSolution).toContain('switchTab host="localhost"');
      expect(resolvedSolution).toContain('switchTab host="127.0.0.1"');
      expect(resolvedSolution).not.toContain(`host="${placeholder}"`);
    }
  });

  it("runPipeline passes events to buildSolutionText so implementor receives select <select> for dropdowns", async () => {
    const baseTs = 1_700_000_000_000;
    const events: Event[] = [0, 1, 2].flatMap((i) => [
      {
        v: 1 as const,
        id: `sel-${i}`,
        ts: baseTs + i * 5000,
        session: "sess_dropdown_pipe",
        source: "browser" as const,
        app: "erp.local",
        type: "change" as const,
        target: {
          tag: "select",
          role: "combobox",
          locators: [{ kind: "css" as const, value: "#priority" }],
        },
        value: "high",
        meta: { selectedValue: "high", selectedLabel: "High" },
      },
      {
        v: 1 as const,
        id: `inp-${i}`,
        ts: baseTs + i * 5000 + 200,
        session: "sess_dropdown_pipe",
        source: "browser" as const,
        app: "erp.local",
        type: "input" as const,
        target: {
          tag: "input",
          role: "textbox",
          locators: [{ kind: "css" as const, value: "#summary" }],
        },
        value: `Item ${i + 1}`,
      },
      {
        v: 1 as const,
        id: `sub-${i}`,
        ts: baseTs + i * 5000 + 400,
        session: "sess_dropdown_pipe",
        source: "browser" as const,
        app: "erp.local",
        type: "submit" as const,
        target: {
          tag: "form",
          locators: [{ kind: "css" as const, value: "#ticket-form" }],
        },
      },
    ]);

    const steps = normalize(events);
    let capturedSolution = "";
    const implement = vi.fn(async (solution: string, opts?: { name?: string }) => {
      capturedSolution = solution;
      return makeFakeActionScript(opts?.name);
    });

    const findings = await runPipeline(steps, {
      llm: true,
      events,
      gemini: {
        sdk: {
          models: {
            generateContent: async () => ({
              text: JSON.stringify({
                level: "rung2",
                confidence: 0.95,
                name: "Submit priority ticket",
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
    expect(capturedSolution).toContain('select <select> css="#priority" with "high"');
    expect(capturedSolution).toContain('fill css="#summary" with "Item 1"');
  });

  it("buildSolutionText emits pressKey \"Enter\" for submit steps and buildReport detects the 3-tag-plus-Save workflow", async () => {
    const tagLocators = [{ kind: "testid" as const, value: "tag-input" }];
    const saveLocators = [{ kind: "testid" as const, value: "save-tags" }];

    const wf: Workflow = {
      id: "wf_tags",
      name: "tags.local workflow (8 steps)",
      sourceApp: "tags.local",
      destApp: "tags.local",
      steps: [
        { action: "click", target: tagLocators },
        { action: "fill", target: tagLocators, value: { param: "tag_1" } },
        { action: "submit", target: tagLocators, value: "Enter" },
        { action: "fill", target: tagLocators, value: { param: "tag_2" } },
        { action: "submit", target: tagLocators, value: "Enter" },
        { action: "fill", target: tagLocators, value: { param: "tag_3" } },
        { action: "submit", target: tagLocators, value: "Enter" },
        { action: "click", target: saveLocators },
      ],
      params: [
        { name: "tag_1", example: "alpha" },
        { name: "tag_2", example: "beta" },
        { name: "tag_3", example: "gamma" },
      ],
      instances: [],
    };

    const solution = buildSolutionText("rung2", wf);
    expect(solution).not.toBeNull();
    expect(solution).toContain('pressKey "Enter" on testid="tag-input"');
    expect(solution?.match(/pressKey "Enter" on testid="tag-input"/g)).toHaveLength(3);
    expect(solution).toContain('click testid="save-tags"');

    const baseTs = 1_750_000_000_000;
    const tagTriples = [
      ["alpha", "beta", "gamma"],
      ["delta", "epsilon", "zeta"],
      ["eta", "theta", "iota"],
    ];
    let idx = 0;
    const nextEvent = (
      type: Event["type"],
      extra: Partial<Omit<Event, "type">>,
    ): Event => {
      idx += 1;
      return {
        v: 1,
        id: `tag-ev-${idx}`,
        ts: baseTs + idx * 500,
        session: "sess_tags_v1",
        source: "browser",
        app: "tags.local",
        type,
        ...extra,
      };
    };

    const events: Event[] = tagTriples.flatMap(([t1, t2, t3]) => [
      nextEvent("click", { target: { tag: "input", locators: tagLocators } }),
      nextEvent("input", { target: { tag: "input", locators: tagLocators }, value: t1 }),
      nextEvent("keydown", { target: { tag: "input", locators: tagLocators }, meta: { key: "Enter" } }),
      nextEvent("input", { target: { tag: "input", locators: tagLocators }, value: t2 }),
      nextEvent("keydown", { target: { tag: "input", locators: tagLocators }, meta: { key: "Enter" } }),
      nextEvent("input", { target: { tag: "input", locators: tagLocators }, value: t3 }),
      nextEvent("keydown", { target: { tag: "input", locators: tagLocators }, meta: { key: "Enter" } }),
      nextEvent("click", { target: { tag: "button", locators: saveLocators } }),
    ]);

    let capturedSolution = "";
    const scriptStore = new Map<string, ActionScript>();
    const report = await buildReport("sess_tags_v1", events, {
      pipeline: "v1",
      llm: true,
      gemini: {
        sdk: {
          models: {
            generateContent: async () => ({
              text: JSON.stringify({
                verdict: "rung2",
                confidence: 0.95,
                name: "Add 3 tags and save",
                risky: false,
              }),
            }),
          },
        },
      },
      implement: async (sol, opts) => {
        capturedSolution = sol;
        return makeFakeActionScript(opts?.name);
      },
      scriptStore,
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].verdict).toBe("rung2");
    expect(report.findings[0].stats.repetitions).toBe(3);
    expect(capturedSolution.match(/pressKey "Enter" on testid="tag-input"/g)).toHaveLength(3);
    expect(capturedSolution).toContain('click testid="save-tags"');
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
