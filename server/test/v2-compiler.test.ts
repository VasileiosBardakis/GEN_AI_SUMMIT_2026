import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@gen/shared";
import { EventsSchema } from "@gen/shared/schema.ts";
import type { GeminiClient, GeminiSdk } from "../src/llm/gemini.ts";
import { createProposer } from "../src/propose.ts";
import { compiledWorkflowToActionScript } from "../src/report.ts";
import {
  COMPILER_RESPONSE_SCHEMA,
  compileWorkflow,
  eventsToSteps,
  normalizeHost,
  validateCompiledWorkflow,
  type CompiledWorkflow,
} from "../src/v2/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixture(filename: string): Promise<Event[]> {
  const raw = await readFile(path.join(__dirname, "fixtures", filename), "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return EventsSchema.parse(lines.map((l) => JSON.parse(l) as unknown));
}

function makeMockGemini(payload: unknown): {
  client: GeminiClient;
  prompts: string[];
} {
  const prompts: string[] = [];
  const client: GeminiClient = {
    async generateText() {
      throw new Error("unexpected generateText call");
    },
    async generateJson<T>(prompt: string, schema: Parameters<GeminiClient["generateJson"]>[1]) {
      prompts.push(prompt);
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`mock schema fail: ${parsed.error.message ?? "invalid"}`);
      }
      return parsed.data as T;
    },
  };
  return { client, prompts };
}

function makeMockSdk(payload: unknown): {
  sdk: GeminiSdk;
  generateContent: ReturnType<typeof vi.fn>;
} {
  const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(async () => ({
    text: JSON.stringify(payload),
  }));
  return {
    sdk: { models: { generateContent } },
    generateContent,
  };
}

describe("Brain v2 compiler and validator", () => {
  it("compiles all 6 unseen-*.jsonl fixtures + unseen-sheet-loop.jsonl offline in <1 s", async () => {
    const started = performance.now();

    // 1. unseen-rows-wrongtab.jsonl: remaining rows (#row-4, #row-5) from pageSummary + start-URL switchTab
    {
      const events = await loadFixture("unseen-rows-wrongtab.jsonl");
      const { client, prompts } = makeMockGemini({
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
      });

      const wf = await compileWorkflow(
        { events },
        {
          gemini: client,
          iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
        },
      );

      expect(wf).not.toBeNull();
      expect(wf!.runMode).toBe("run_remaining");
      expect(wf!.startUrl).toBe("http://freight.local:4100/manifest");
      expect(wf!.steps[0]).toEqual({
        action: "switchTab",
        host: "freight.local",
        url: "http://freight.local:4100/manifest",
      });
      const loop = wf!.steps[1];
      expect(loop.action).toBe("forEach");
      if (loop.action === "forEach") {
        expect(loop.steps[0]).toEqual({
          action: "switchTab",
          host: "customs.local",
          url: "http://customs.local:4100/entry",
        });
        expect(Array.isArray(loop.items)).toBe(true);
        if (Array.isArray(loop.items)) {
          expect(loop.items).toHaveLength(2);
          expect(loop.items.map((r) => r.selector)).toEqual(["#row-4", "#row-5"]);
          expect(loop.items.map((r) => r.col1)).toEqual(["WB-9044", "WB-9045"]);
        }
      }
      expect(prompts[0]).toContain("#row-4");
      expect(prompts[0]).toContain("#row-5");
      expect(wf!.stats.repetitions).toBeGreaterThanOrEqual(1);
      expect(wf!.stats.manualSeconds).toBeGreaterThan(wf!.stats.replaySeconds);
      expect(wf!.stats.minutesPerWeek).toBeGreaterThan(0);
    }

    // 2. unseen-sheet-loop.jsonl: generic within exact-text + forEach list loop + 127.0.0.1 kept distinct from localhost
    {
      const events = await loadFixture("unseen-sheet-loop.jsonl");
      const { client } = makeMockGemini({
        suggest: true,
        offerAt2: true,
        kind: "workflow",
        name: "Sync client lookup values from sheet",
        reason: "Opens each pending client, copies sheet lookup rate, and saves",
        risk: "low",
        runMode: "run_remaining",
        params: [
          { name: "clientName" },
          { name: "lookupValue" },
        ],
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
      });

      const wf = await compileWorkflow(
        { events },
        {
          gemini: client,
          iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
        },
      );

      expect(wf).not.toBeNull();
      expect(wf!.apps).toEqual(["127.0.0.1"]);
      expect(wf!.startUrl).toBe("http://127.0.0.1:5173/sheet.html");
      expect(wf!.steps[0]).toEqual({
        action: "switchTab",
        host: "127.0.0.1",
        url: "http://127.0.0.1:5173/sheet.html",
      });

      const loop = wf!.steps[1];
      expect(loop.action).toBe("forEach");
      if (loop.action === "forEach") {
        expect(loop.items).toEqual([
          { clientName: "Vanguard Marine Inc", status: "Pending" },
        ]);
        const openStep = loop.steps[0];
        expect(openStep.action).toBe("click");
        if (openStep.action === "click") {
          expect(openStep.within).toEqual([
            { kind: "testid", value: "client-list" },
            { kind: "text", value: "{{clientName}}" },
          ]);
          expect(openStep.target).toEqual([
            { kind: "aria", value: 'button[name="Open"]' },
            { kind: "text", value: "Open" },
          ]);
        }
        const scopedExactTextStep = loop.steps[2];
        expect(scopedExactTextStep.action).toBe("readText");
        if (scopedExactTextStep.action === "readText") {
          expect(scopedExactTextStep.within).toEqual([
            { kind: "testid", value: "sheet-table" },
            { kind: "text", value: "{{clientName}}" },
          ]);
          expect(scopedExactTextStep.target).toEqual([
            { kind: "text", value: "{{clientName}}" },
          ]);
        }
      }
    }

    // 3. unseen-multifield-tab.jsonl: 3-field Tab form keeps 3 fills & invariant selectors first
    {
      const events = await loadFixture("unseen-multifield-tab.jsonl");
      const { client } = makeMockGemini({
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
      });

      const wf = await compileWorkflow(
        { events },
        {
          gemini: client,
          iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
        },
      );

      expect(wf).not.toBeNull();
      expect(wf!.steps[0]).toEqual({
        action: "switchTab",
        host: "lims.local",
        url: "http://lims.local:4150/assay",
      });
      const fills = wf!.steps.filter((s) => s.action === "fill");
      expect(fills).toHaveLength(3);
      if (
        fills[0]?.action === "fill" &&
        fills[1]?.action === "fill" &&
        fills[2]?.action === "fill"
      ) {
        expect(fills[0].target[0]?.value).toContain("nth-of-type(1)");
        expect(fills[1].target[0]?.value).toContain("nth-of-type(2)");
        expect(fills[2].target[0]?.value).toContain("nth-of-type(3)");
      }
      expect(
        JSON.stringify(wf!.steps).includes("assay-guidelines-banner"),
      ).toBe(false);
    }

    // 4. unseen-extra-click.jsonl: stray click in rep 2 dropped
    {
      const events = await loadFixture("unseen-extra-click.jsonl");
      const { client } = makeMockGemini({
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

      const wf = await compileWorkflow(
        { events },
        {
          gemini: client,
          iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
        },
      );

      expect(wf).not.toBeNull();
      expect(JSON.stringify(wf!.steps)).not.toContain("policy-tooltip-toggle");
      expect(wf!.steps.map((s) => s.action)).toEqual([
        "switchTab",
        "readText",
        "readText",
        "switchTab",
        "fill",
        "fill",
        "click",
      ]);
    }

    // 5. unseen-two-repeats.jsonl: 2 repeats compiled with remaining rows from pageSummary
    {
      const events = await loadFixture("unseen-two-repeats.jsonl");
      const { client } = makeMockGemini({
        suggest: true,
        offerAt2: true,
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
      });

      const wf = await compileWorkflow(
        { events, repeatCount: 2 },
        {
          gemini: client,
          iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
        },
      );

      expect(wf).not.toBeNull();
      expect(wf!.offerAt2).toBe(true);
      expect(wf!.stats.repetitions).toBe(2);
      const loop = wf!.steps[1];
      expect(loop.action).toBe("forEach");
      if (loop.action === "forEach" && Array.isArray(loop.items)) {
        expect(loop.items).toHaveLength(4);
        expect(loop.items[0].SKU).toBe("SKU-4403");
      }
    }

    // 6. unseen-enter-controls.jsonl: select, checkbox, and Enter submission preserved
    {
      const events = await loadFixture("unseen-enter-controls.jsonl");
      const { client } = makeMockGemini({
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
      });

      const wf = await compileWorkflow(
        { events },
        {
          gemini: client,
          iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
        },
      );

      expect(wf).not.toBeNull();
      expect(wf!.steps.map((s) => s.action)).toEqual([
        "switchTab",
        "readText",
        "switchTab",
        "fill",
        "select",
        "click",
        "key",
      ]);
    }

    // 7. unseen-pii-risky.jsonl: no <email> / [REDACTED: in compiled output, pauseBeforeSubmit: true
    {
      const events = await loadFixture("unseen-pii-risky.jsonl");
      const { client } = makeMockGemini({
        suggest: true,
        offerAt2: false,
        kind: "workflow",
        name: "Send outbound vendor wire",
        reason: "Transfers approved wire details into Treasury Portal",
        risk: "high",
        runMode: "save_only",
        params: [
          { name: "wireAmount", example: "14500.00" },
        ],
        steps: [
          { action: "readText", stepIndex: 1, bind: "wireRef" },
          { action: "readText", stepIndex: 2, bind: "beneficiaryEmail" },
          { action: "switchTab", stepIndex: 3 },
          { action: "fill", stepIndex: 4, value: "{{wireRef}}" },
          { action: "fill", stepIndex: 5, value: "{{beneficiaryEmail}}" },
          { action: "fill", stepIndex: 6, value: "{{wireAmount}}" },
          { action: "click", stepIndex: 7 },
        ],
      });

      const wf = await compileWorkflow(
        { events },
        {
          gemini: client,
          iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: true }),
        },
      );

      expect(wf).not.toBeNull();
      expect(wf!.pauseBeforeSubmit).toBe(true);
      const serialized = JSON.stringify(wf);
      expect(serialized).not.toContain("<email>");
      expect(serialized).not.toContain("[REDACTED:");
    }

    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(1000);
  });

  // skipped: Gemini no longer vetoes when Iris says yes (decision 002)
  it.skip("drops popup (returns null) when Iris worthAutomating === false or !suggest", async () => {
    const events = await loadFixture("unseen-extra-click.jsonl");
    const validModelPayload = {
      suggest: true,
      offerAt2: false,
      kind: "workflow" as const,
      name: "Record claim",
      reason: "Copies claim fields",
      risk: "low" as const,
      runMode: "save_only" as const,
      params: [],
      steps: [{ action: "click" as const, stepIndex: 6 }],
    };

    const irisReject = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini(validModelPayload).client,
        iris: async () => ({ worthAutomating: false, pauseBeforeSubmit: false }),
      },
    );
    expect(irisReject).toBeNull();

    const modelNoSuggest = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini({ ...validModelPayload, suggest: false }).client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );
    expect(modelNoSuggest).toBeNull();
  });

  it("sets pauseBeforeSubmit: true from Iris even when model risk is low, and ignores Iris errors/null", async () => {
    const events = await loadFixture("unseen-extra-click.jsonl");
    const payload = {
      suggest: true,
      offerAt2: false,
      kind: "workflow" as const,
      name: "Record claim",
      reason: "Copies claim fields",
      risk: "low" as const,
      runMode: "save_only" as const,
      params: [],
      steps: [{ action: "click" as const, stepIndex: 6 }],
    };

    const withIrisPause = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini(payload).client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: true }),
      },
    );
    expect(withIrisPause?.pauseBeforeSubmit).toBe(true);

    const withIrisError = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini(payload).client,
        iris: async () => {
          throw new Error("Iris down");
        },
      },
    );
    expect(withIrisError).not.toBeNull();
    expect(withIrisError?.pauseBeforeSubmit).toBe(false);

    const withIrisNull = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini(payload).client,
        iris: async () => null,
      },
    );
    expect(withIrisNull).not.toBeNull();
  });

  it("forwards thinkingBudget: 0, COMPILER_RESPONSE_SCHEMA, and timeoutMs through GeminiSdk", async () => {
    const events = await loadFixture("unseen-extra-click.jsonl");
    const { sdk, generateContent } = makeMockSdk({
      suggest: true,
      offerAt2: false,
      kind: "workflow",
      name: "Record claim",
      reason: "Copies claim fields",
      risk: "low",
      runMode: "save_only",
      params: [],
      steps: [{ action: "click", stepIndex: 6 }],
    });

    const wf = await compileWorkflow(
      { events },
      {
        gemini: { sdk, apiKey: "mock-key" },
        iris: async () => null,
        timeoutMs: 2400,
      },
    );

    expect(wf).not.toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(1);
    const config = generateContent.mock.calls[0]?.[0]?.config;
    expect(config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(config?.responseSchema).toBeDefined();
    expect((config?.responseSchema as { required?: string[] })?.required).toEqual(
      COMPILER_RESPONSE_SCHEMA.required,
    );
    expect(config?.abortSignal).toBeInstanceOf(AbortSignal);

    await compileWorkflow(
      { events },
      {
        gemini: {
          sdk,
          apiKey: "mock-key",
          responseSchema: COMPILER_RESPONSE_SCHEMA,
        },
        iris: async () => null,
        timeoutMs: 2400,
      },
    );
    expect(generateContent.mock.calls[1]?.[0]?.config?.responseSchema).toEqual(
      COMPILER_RESPONSE_SCHEMA,
    );
  });

  it("validateCompiledWorkflow checks normalizeHost, step cap, {{param}} bindings, and PII markers", () => {
    expect(normalizeHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeHost("127.0.0.1:5173")).toBe("127.0.0.1:5173");
    expect(normalizeHost(" LocalHost ")).toBe("localhost");
    expect(normalizeHost(" Freight.Local ")).toBe("freight.local");

    const base: CompiledWorkflow = {
      kind: "workflow",
      name: "Test workflow",
      reason: "Repeated steps",
      risk: "low",
      offerAt2: false,
      runMode: "save_only",
      pauseBeforeSubmit: false,
      startUrl: "http://localhost:5173/app",
      apps: ["localhost"],
      params: [{ name: "query" }],
      steps: [
        { action: "switchTab", host: "localhost", url: "http://localhost:5173/app" },
        {
          action: "fill",
          target: [{ kind: "testid", value: "q" }],
          value: "{{query}}",
        },
      ],
      stats: {
        repetitions: 3,
        minutesPerWeek: 1.5,
        manualSeconds: 18,
        replaySeconds: 2,
      },
    };

    expect(validateCompiledWorkflow(base).ok).toBe(true);

    // Unnormalized host
    expect(
      validateCompiledWorkflow({
        ...base,
        steps: [{ action: "switchTab", host: "LOCALHOST" }],
      }).ok,
    ).toBe(false);

    // Placeholder hosts rejected
    for (const badHost of ["browser", "unknown", "local-page"]) {
      expect(
        validateCompiledWorkflow({
          ...base,
          steps: [{ action: "switchTab", host: badHost }],
        }).ok,
      ).toBe(false);
    }

    // switchTab with optional url accepted when normalized
    expect(
      validateCompiledWorkflow({
        ...base,
        steps: [
          {
            action: "switchTab",
            host: "localhost",
            url: "http://localhost:4173/erp.html",
          },
          {
            action: "fill",
            target: [{ kind: "testid", value: "q" }],
            value: "{{query}}",
          },
        ],
      }).ok,
    ).toBe(true);

    // Step cap
    expect(validateCompiledWorkflow(base, { maxSteps: 1 }).ok).toBe(false);

    // Unbound {{param}}
    expect(
      validateCompiledWorkflow({
        ...base,
        steps: [
          { action: "switchTab", host: "localhost" },
          {
            action: "fill",
            target: [{ kind: "testid", value: "q" }],
            value: "{{missing}}",
          },
        ],
      }).ok,
    ).toBe(false);

    // Forbidden PII placeholders / markers
    for (const badVal of ["<email>", "[REDACTED:EMAIL#h_1234]"]) {
      expect(
        validateCompiledWorkflow({
          ...base,
          params: [],
          steps: [
            { action: "switchTab", host: "localhost" },
            {
              action: "fill",
              target: [{ kind: "testid", value: "q" }],
              value: badVal,
            },
          ],
        }).ok,
      ).toBe(false);
    }
  });

  it("resolves real host + url for switchTab when events use localhost/127.0.0.1 or 'browser' app fallback, and omits switchTab when only placeholder exists", async () => {
    const events: Event[] = [1, 2].flatMap((row) => [
      {
        v: 1 as const,
        id: `c-${row}`,
        ts: row * 10_000 + 100,
        session: "s_loopback_browser",
        source: "browser" as const,
        app: "browser",
        url: "http://localhost:4173/portal.html",
        type: "copy" as const,
        target: {
          tag: "span",
          locators: [{ kind: "testid" as const, value: `portal-id-${row}` }],
        },
        value: `INV-${row}`,
      },
      {
        v: 1 as const,
        id: `ts-${row}`,
        ts: row * 10_000 + 200,
        session: "s_loopback_browser",
        source: "browser" as const,
        app: "browser",
        url: "http://127.0.0.1:4173/erp.html",
        type: "tab_switch" as const,
      },
      {
        v: 1 as const,
        id: `p-${row}`,
        ts: row * 10_000 + 300,
        session: "s_loopback_browser",
        source: "browser" as const,
        app: "127.0.0.1",
        url: "http://127.0.0.1:4173/erp.html",
        type: "paste" as const,
        target: {
          tag: "input",
          locators: [{ kind: "testid" as const, value: "erp-id" }],
        },
        value: `INV-${row}`,
      },
      {
        v: 1 as const,
        id: `s-${row}`,
        ts: row * 10_000 + 400,
        session: "s_loopback_browser",
        source: "browser" as const,
        app: "127.0.0.1",
        url: "http://127.0.0.1:4173/erp.html",
        type: "click" as const,
        target: {
          tag: "button",
          locators: [{ kind: "testid" as const, value: "save-btn" }],
        },
      },
    ]);

    const { client } = makeMockGemini({
      suggest: true,
      offerAt2: true,
      kind: "workflow",
      name: "Copy invoice to ERP",
      reason: "Copies invoice ID from portal to ERP",
      risk: "low",
      runMode: "save_only",
      params: [],
      steps: [
        { action: "readText", stepIndex: 0, bind: "invoiceId" },
        { action: "switchTab", host: "browser", stepIndex: 1 },
        { action: "fill", stepIndex: 2, value: "{{invoiceId}}" },
        { action: "click", stepIndex: 3 },
      ],
    });

    const wf = await compileWorkflow(
      { events, repeatCount: 2 },
      {
        gemini: client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(wf).not.toBeNull();
    expect(wf!.apps).toEqual(["localhost", "127.0.0.1"]);
    expect(wf!.startUrl).toBe("http://localhost:4173/portal.html");
    expect(wf!.steps[0]).toEqual({
      action: "switchTab",
      host: "localhost",
      url: "http://localhost:4173/portal.html",
    });
    expect(wf!.steps[2]).toEqual({
      action: "switchTab",
      host: "127.0.0.1",
      url: "http://127.0.0.1:4173/erp.html",
    });

    // When events only have placeholder app ("browser") and no URL, omit prepending switchTab and drop placeholder switchTab
    const placeholderOnlyEvents: Event[] = [1, 2].flatMap((row) => [
      {
        v: 1 as const,
        id: `ph-fill-${row}`,
        ts: row * 10_000 + 100,
        session: "s_placeholder_only",
        source: "browser" as const,
        app: "browser",
        type: "input" as const,
        target: {
          tag: "input",
          locators: [{ kind: "testid" as const, value: "field-a" }],
        },
        value: `val-${row}`,
      },
      {
        v: 1 as const,
        id: `ph-click-${row}`,
        ts: row * 10_000 + 200,
        session: "s_placeholder_only",
        source: "browser" as const,
        app: "local-page",
        type: "click" as const,
        target: {
          tag: "button",
          locators: [{ kind: "testid" as const, value: "btn-ok" }],
        },
      },
    ]);

    const { client: phClient } = makeMockGemini({
      suggest: true,
      offerAt2: true,
      kind: "workflow",
      name: "Fill and confirm",
      reason: "Fills field and clicks OK",
      risk: "low",
      runMode: "save_only",
      params: [{ name: "val", example: "val-1" }],
      steps: [
        { action: "switchTab", host: "browser" },
        { action: "fill", stepIndex: 0, value: "{{val}}" },
        { action: "click", stepIndex: 1 },
      ],
    });

    const phWf = await compileWorkflow(
      { events: placeholderOnlyEvents, repeatCount: 2 },
      {
        gemini: phClient,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(phWf).not.toBeNull();
    expect(phWf!.apps).toEqual([]);
    expect(phWf!.steps.some((s) => s.action === "switchTab")).toBe(false);
    expect(phWf!.steps.map((s) => s.action)).toEqual(["fill", "click"]);
  });

  it("compiles a 3-repeat form trace with repeated Help click + excursion without navigate or extra click", async () => {
    const events: Event[] = [];
    for (let rep = 1; rep <= 3; rep += 1) {
      const baseTs = rep * 10_000;
      events.push(
        {
          v: 1,
          id: `hc-${rep}-1`,
          ts: baseTs + 100,
          session: "s_help_excursion",
          source: "browser",
          app: "localhost",
          url: "http://localhost:4173/form",
          type: "input",
          target: {
            tag: "input",
            label: "Item Name",
            locators: [{ kind: "testid", value: "item-name" }],
          },
          value: "Printer Paper",
        },
        {
          v: 1,
          id: `hc-${rep}-2`,
          ts: baseTs + 200,
          session: "s_help_excursion",
          source: "browser",
          app: "localhost",
          url: "http://localhost:4173/form",
          type: "input",
          target: {
            tag: "input",
            label: "Note",
            locators: [{ kind: "testid", value: "item-note" }],
          },
          value: "Re-order",
        },
        {
          v: 1,
          id: `hc-${rep}-3`,
          ts: baseTs + 300,
          session: "s_help_excursion",
          source: "browser",
          app: "localhost",
          url: "http://localhost:4173/form",
          type: "click",
          target: {
            tag: "a",
            label: "Help",
            locators: [
              { kind: "css", value: 'a[href="/help-missing"]' },
              { kind: "text", value: "Help" },
            ],
          },
        },
        {
          v: 1,
          id: `hc-${rep}-4`,
          ts: baseTs + 400,
          session: "s_help_excursion",
          source: "browser",
          app: "localhost",
          url: "http://localhost:4173/help-missing",
          type: "nav",
        },
        {
          v: 1,
          id: `hc-${rep}-5`,
          ts: baseTs + 500,
          session: "s_help_excursion",
          source: "browser",
          app: "localhost",
          url: "http://localhost:4173/form",
          type: "nav",
        },
        {
          v: 1,
          id: `hc-${rep}-6`,
          ts: baseTs + 600,
          session: "s_help_excursion",
          source: "browser",
          app: "localhost",
          url: "http://localhost:4173/form",
          type: "click",
          target: {
            tag: "button",
            label: "Save Entry",
            locators: [{ kind: "testid", value: "save-entry-btn" }],
          },
        },
      );
    }

    const { client, prompts } = makeMockGemini({
      suggest: true,
      offerAt2: false,
      kind: "workflow",
      name: "Submit inventory item",
      reason: "Fills item name and note and saves entry",
      risk: "low",
      runMode: "save_only",
      params: [],
      steps: [
        { action: "fill", stepIndex: 0, value: "Printer Paper" },
        { action: "fill", stepIndex: 1, value: "Re-order" },
        { action: "click", stepIndex: 5 },
      ],
    });

    const wf = await compileWorkflow(
      { events, repeatCount: 3 },
      {
        gemini: client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(prompts[0]).toContain("stray clicks");
    expect(prompts[0]).toContain("side excursions");

    expect(wf).not.toBeNull();
    expect(wf!.steps.some((s) => s.action === "navigate")).toBe(false);
    expect(JSON.stringify(wf!.steps)).not.toContain("help-missing");
    expect(JSON.stringify(wf!.steps)).not.toContain("Help");
    expect(wf!.steps.map((s) => s.action)).toEqual([
      "switchTab",
      "fill",
      "fill",
      "click",
    ]);
  });

  it("compiles a 3-rep input + keydown(Enter) search trace, converts to pressKey(Enter), and triggers proposer at rep 3", async () => {
    const searchLocators = [
      { kind: "testid" as const, value: "search-input" },
      { kind: "css" as const, value: "#search-input" },
    ];
    const queries = ["laptop", "monitor", "keyboard"];
    const events: Event[] = [];
    queries.forEach((query, idx) => {
      const baseTs = 10_000 + idx * 5_000;
      events.push(
        {
          v: 1,
          id: `search-in-${idx}`,
          ts: baseTs,
          session: "s_enter_search",
          source: "browser",
          app: "search.local",
          url: "http://search.local/",
          type: "input",
          target: {
            tag: "input",
            role: "searchbox",
            label: "Search",
            locators: searchLocators,
          },
          value: query,
        },
        {
          v: 1,
          id: `search-key-${idx}`,
          ts: baseTs + 300,
          session: "s_enter_search",
          source: "browser",
          app: "search.local",
          url: "http://search.local/",
          type: "keydown",
          target: {
            tag: "input",
            role: "searchbox",
            label: "Search",
            locators: searchLocators,
          },
          meta: { key: "Enter", code: "Enter" },
        },
      );
    });

    const { steps } = eventsToSteps(events);
    expect(steps.map((s) => s.action)).toEqual([
      "fill",
      "key",
      "fill",
      "key",
      "fill",
      "key",
    ]);
    for (const keyStep of steps.filter((s) => s.action === "key")) {
      expect(keyStep.key).toBe("Enter");
      expect(keyStep.target).toEqual(searchLocators);
    }

    const { client, prompts } = makeMockGemini({
      suggest: true,
      offerAt2: false,
      kind: "workflow",
      name: "Search catalog",
      reason: "Fills the search box and submits with Enter",
      risk: "low",
      runMode: "save_only",
      params: [{ name: "query", example: "laptop" }],
      steps: [
        { action: "fill", stepIndex: 0, value: "{{query}}" },
        { action: "key", stepIndex: 1, key: "Enter" },
      ],
    });

    const wf = await compileWorkflow(
      { events },
      {
        gemini: client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(prompts[0]).toContain("`key`");
    expect(prompts[0]).toContain("Enter");
    expect(wf).not.toBeNull();

    const script = compiledWorkflowToActionScript(wf!);
    expect(script.steps).toEqual([
      { action: "switchTab", host: "search.local", url: "http://search.local/" },
      { action: "fill", target: searchLocators, value: "{{query}}" },
      { action: "pressKey", key: "Enter", target: searchLocators },
    ]);

    const decided: Array<{ name: string; script: ReturnType<typeof compiledWorkflowToActionScript> }> = [];
    const saved: Array<{ script: ReturnType<typeof compiledWorkflowToActionScript> }> = [];
    const proposer = createProposer({
      readSessionEvents: async () => events,
      judgeIris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      compileV2: (input, compileOpts) =>
        compileWorkflow(input, {
          gemini: client,
          ...compileOpts,
        }),
      onApproved: async ({ script: approvedScript }) => {
        saved.push({ script: approvedScript });
        return { shouldRun: false };
      },
      requestDecision: async (name, _solution, decidedScript) => {
        decided.push({ name, script: decidedScript });
        return { ok: true, decision: "approved" };
      },
      runScript: async () => ({ ok: true }),
    });

    try {
      proposer.onEvents("s_enter_search");
      await vi.waitFor(() => {
        expect(saved).toHaveLength(1);
      });
      expect(decided).toHaveLength(0);
      expect(saved[0].script.steps).toEqual(script.steps);
    } finally {
      proposer.close();
    }
  });

  it("parses real-sheet-capture.jsonl {source, target} pageSummary objects (masked) into containers/targets/lists and resolves readText column", async () => {
    const events = await loadFixture("real-sheet-capture.jsonl");
    // Inject an email into a copy of the fixture's {source, target} summaries to verify PII scrubbing
    const lastCopyIdx = events.map((e) => e.type).lastIndexOf("copy");
    const eventsWithPii = events.map((ev, idx) => {
      if (idx === lastCopyIdx && ev.meta?.pageSummary && typeof ev.meta.pageSummary === "object") {
        const cloned = JSON.parse(JSON.stringify(ev)) as Event;
        const ps = cloned.meta!.pageSummary as {
          source: { rows: Array<{ cells: Array<{ text: string }> }> };
        };
        ps.source.rows[2].cells[0].text = "boreal@example.com";
        return cloned;
      }
      return ev;
    });

    const { client, prompts } = makeMockGemini({
      suggest: true,
      offerAt2: true,
      kind: "workflow",
      name: "Sync real sheet rates",
      reason: "Copies lookup values from sheet-table to client-detail",
      risk: "low",
      runMode: "run_remaining",
      params: [{ name: "clientName" }, { name: "lookupValue" }],
      steps: [
        {
          action: "forEach",
          itemIds: ["item_2_3", "item_2_4"],
          steps: [
            {
              action: "click",
              withinId: "ps_1",
              withinTextParam: "clientName",
              stepIndex: 2,
            },
            { action: "click", stepIndex: 3 },
            {
              action: "readText",
              withinId: "ps_2",
              withinTextParam: "clientName",
              stepIndex: 5,
              bind: "lookupValue",
            },
            { action: "click", stepIndex: 6 },
            { action: "fill", stepIndex: 8, value: "{{lookupValue}}" },
            { action: "click", stepIndex: 9 },
            { action: "click", stepIndex: 10 },
          ],
        },
      ],
    });

    const wf = await compileWorkflow(
      { events: eventsWithPii },
      {
        gemini: client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(prompts[0]).toContain("PageSummary Containers");
    expect(prompts[0]).toContain("PageSummary Targets:");
    expect(prompts[0]).toContain("PageSummary Lists:");
    expect(prompts[0]).toContain("client-list");
    expect(prompts[0]).toContain("sheet-table");
    expect(prompts[0]).toContain("submit form");
    expect(prompts[0]).toContain("boreal@example.com");

    expect(wf).not.toBeNull();
    expect(wf!.runMode).toBe("run_remaining");
    const extract = wf!.steps[1];
    expect(extract.action).toBe("extractList");
    if (extract.action === "extractList") {
      expect(extract.target).toEqual([{ kind: "css", value: "tr:has(td)" }]);
      expect(extract.within).toEqual([
        { kind: "testid", value: "sheet-table" },
        { kind: "css", value: "#sheet-panel > section > table" },
      ]);
      expect(extract.bind).toBe("rows");
      expect(extract.fields).toEqual({
        col1: [{ kind: "css", value: "td:nth-of-type(1)" }],
        col2: [{ kind: "css", value: "td:nth-of-type(2)" }],
        col3: [{ kind: "aria", value: 'gridcell[name="Copy"]' }],
      });
    }

    const loop = wf!.steps[2];
    expect(loop.action).toBe("forEach");
    if (loop.action === "forEach") {
      expect(loop.items).toBe("rows");

      const openStep = loop.steps[0];
      expect(openStep.action).toBe("click");
      if (openStep.action === "click") {
        expect(openStep.within).toEqual([
          { kind: "testid", value: "client-list" },
          { kind: "css", value: "#client-list-section" },
          { kind: "text", value: "{{col1}}" },
        ]);
      }

      const readStep = loop.steps[2];
      expect(readStep.action).toBe("readText");
      if (readStep.action === "readText") {
        expect(readStep.target).toEqual([{ kind: "css", value: "td:nth-of-type(2)" }]);
        expect(readStep.within).toEqual([
          { kind: "testid", value: "sheet-table" },
          { kind: "css", value: "#sheet-panel > section > table" },
          { kind: "text", value: "{{col1}}" },
        ]);
        expect(readStep.bind).toBe("lookupValue");
      }
    }
  });

  it("skips internal Iris call when irisJudgment is provided (including null) and lets Gemini suggest decide on null", async () => {
    const events = await loadFixture("unseen-extra-click.jsonl");
    const irisSpy = vi.fn(async () => ({ worthAutomating: true, pauseBeforeSubmit: false }));
    const payload = {
      suggest: true,
      offerAt2: false,
      kind: "workflow" as const,
      name: "Record claim",
      reason: "Copies claim fields",
      risk: "low" as const,
      runMode: "save_only" as const,
      params: [],
      steps: [{ action: "click" as const, stepIndex: 6 }],
    };

    const wfFromNull = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini(payload).client,
        iris: irisSpy,
        irisJudgment: null,
      },
    );
    expect(wfFromNull).not.toBeNull();
    expect(irisSpy).not.toHaveBeenCalled();

    const wfDeclined = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini({ ...payload, suggest: false }).client,
        iris: irisSpy,
        irisJudgment: null,
      },
    );
    expect(wfDeclined).toBeNull();
    expect(irisSpy).not.toHaveBeenCalled();
  });

  it("preserves port and path on navigate when model returns bare origin (with or without stepIndex) and keeps deliberate different paths with captured port", async () => {
    const events: Event[] = [
      {
        v: 1,
        id: "nav-1",
        ts: 1000,
        session: "s_nav_port",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:4173/form.html",
        type: "nav",
      },
      {
        v: 1,
        id: "fill-1",
        ts: 2000,
        session: "s_nav_port",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:4173/form.html",
        type: "input",
        target: {
          tag: "input",
          label: "Name",
          locators: [{ kind: "css", value: "#name" }],
        },
        value: "Ada",
      },
      {
        v: 1,
        id: "click-1",
        ts: 3000,
        session: "s_nav_port",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:4173/form.html",
        type: "click",
        target: {
          tag: "button",
          label: "Save",
          locators: [{ kind: "css", value: "#save" }],
        },
      },
    ];

    // 1) With stepIndex, model returns bare "http://127.0.0.1"
    const withStepIndex = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini({
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Open form and save",
          reason: "Navigates to form and saves",
          risk: "low",
          runMode: "save_only",
          params: [],
          steps: [
            { action: "navigate", stepIndex: 0, url: "http://127.0.0.1" },
            { action: "fill", stepIndex: 1, value: "Ada" },
            { action: "click", stepIndex: 2 },
          ],
        }).client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(withStepIndex).not.toBeNull();
    expect(withStepIndex!.steps[1]).toEqual({
      action: "navigate",
      url: "http://127.0.0.1:4173/form.html",
    });

    // 2) Without stepIndex, model returns bare "http://127.0.0.1"
    const withoutStepIndex = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini({
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Open form and save",
          reason: "Navigates to form and saves",
          risk: "low",
          runMode: "save_only",
          params: [],
          steps: [
            { action: "navigate", url: "http://127.0.0.1" },
            { action: "fill", stepIndex: 1, value: "Ada" },
            { action: "click", stepIndex: 2 },
          ],
        }).client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(withoutStepIndex).not.toBeNull();
    expect(withoutStepIndex!.steps[1]).toEqual({
      action: "navigate",
      url: "http://127.0.0.1:4173/form.html",
    });

    // 2b) Without stepIndex, model returns bare "http://localhost" when only 127.0.0.1 was seen -> rejected
    const localhostMismatch = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini({
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Open form and save",
          reason: "Navigates to form and saves",
          risk: "low",
          runMode: "save_only",
          params: [],
          steps: [
            { action: "navigate", url: "http://localhost" },
            { action: "fill", stepIndex: 1, value: "Ada" },
            { action: "click", stepIndex: 2 },
          ],
        }).client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );
    expect(localhostMismatch).toBeNull();

    // 3) Deliberate different path on same host keeps /other + captured port
    const differentPathPromptCheck = makeMockGemini({
      suggest: true,
      offerAt2: false,
      kind: "workflow",
      name: "Open other path and save",
      reason: "Navigates to /other and saves",
      risk: "low",
      runMode: "save_only",
      params: [],
      steps: [
        { action: "navigate", url: "http://127.0.0.1/other" },
        { action: "fill", stepIndex: 1, value: "Ada" },
        { action: "click", stepIndex: 2 },
      ],
    });
    const differentPath = await compileWorkflow(
      { events },
      {
        gemini: differentPathPromptCheck.client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(differentPath).not.toBeNull();
    expect(differentPath!.steps[1]).toEqual({
      action: "navigate",
      url: "http://127.0.0.1:4173/other",
    });
    expect(differentPathPromptCheck.prompts[0]).toContain("preserve the full URL (scheme, host, port, path)");
  });

  it("validateCompiledWorkflow enforces seenHosts (including port) on startUrl, navigate, switchTab, and apps", () => {
    const validWithPort: CompiledWorkflow = {
      kind: "workflow",
      name: "Open form",
      reason: "Navigates to form and saves",
      risk: "low",
      offerAt2: false,
      runMode: "save_only",
      pauseBeforeSubmit: false,
      startUrl: "http://localhost:4173/form.html",
      apps: ["localhost"],
      params: [],
      steps: [
        { action: "switchTab", host: "localhost" },
        { action: "navigate", url: "http://localhost:4173/form.html" },
        {
          action: "click",
          target: [{ kind: "css", value: "#save" }],
        },
      ],
      stats: {
        repetitions: 3,
        minutesPerWeek: 1.5,
        manualSeconds: 18,
        replaySeconds: 2,
      },
    };

    expect(
      validateCompiledWorkflow(validWithPort, { seenHosts: ["127.0.0.1:4173"] })
        .ok,
    ).toBe(false);
    expect(
      validateCompiledWorkflow(validWithPort, {
        seenHosts: new Set(["localhost:4173"]),
      }).ok,
    ).toBe(true);
    // Reject switchTab.url with wrong port or 127.0.0.1 vs localhost mismatch
    expect(
      validateCompiledWorkflow(
        {
          ...validWithPort,
          steps: [
            {
              action: "switchTab",
              host: "localhost",
              url: "http://localhost:9999/form.html",
            },
          ],
        },
        { seenHosts: ["localhost:4173"] },
      ).ok,
    ).toBe(false);
    expect(
      validateCompiledWorkflow(
        {
          ...validWithPort,
          steps: [
            {
              action: "switchTab",
              host: "localhost",
              url: "http://127.0.0.1:4173/form.html",
            },
          ],
        },
        { seenHosts: ["localhost:4173"] },
      ).ok,
    ).toBe(false);

    // Reject navigate.url with unseen host
    expect(
      validateCompiledWorkflow(
        {
          ...validWithPort,
          steps: [
            { action: "switchTab", host: "localhost" },
            { action: "navigate", url: "https://invented.example/form.html" },
          ],
        },
        { seenHosts: ["localhost:4173"] },
      ).ok,
    ).toBe(false);

    // Reject navigate.url inside forEach with unseen host
    expect(
      validateCompiledWorkflow(
        {
          ...validWithPort,
          steps: [
            { action: "switchTab", host: "localhost" },
            {
              action: "forEach",
              items: [{ item: "row1" }],
              steps: [
                { action: "navigate", url: "https://invented.example/form.html" },
              ],
            },
          ],
        },
        { seenHosts: ["localhost:4173"] },
      ).ok,
    ).toBe(false);

    // Reject startUrl with unseen host or lost port
    expect(
      validateCompiledWorkflow(
        {
          ...validWithPort,
          startUrl: "https://invented.example/form.html",
        },
        { seenHosts: ["localhost:4173"] },
      ).ok,
    ).toBe(false);
    expect(
      validateCompiledWorkflow(
        {
          ...validWithPort,
          startUrl: "http://localhost/form.html",
        },
        { seenHosts: ["localhost:4173"] },
      ).ok,
    ).toBe(false);

    // Reject navigate.url that drops captured port or changes port
    expect(
      validateCompiledWorkflow(
        {
          ...validWithPort,
          steps: [
            { action: "switchTab", host: "localhost" },
            { action: "navigate", url: "http://localhost/form.html" },
          ],
        },
        { seenHosts: ["localhost:4173"] },
      ).ok,
    ).toBe(false);
    expect(
      validateCompiledWorkflow(
        {
          ...validWithPort,
          steps: [
            { action: "switchTab", host: "localhost" },
            { action: "navigate", url: "http://localhost:9999/form.html" },
          ],
        },
        { seenHosts: ["localhost:4173"] },
      ).ok,
    ).toBe(false);

    // Reject switchTab.host with unseen host
    expect(
      validateCompiledWorkflow(
        {
          ...validWithPort,
          steps: [
            { action: "switchTab", host: "invented.example" },
            { action: "navigate", url: "http://localhost:4173/form.html" },
          ],
        },
        { seenHosts: ["localhost:4173"] },
      ).ok,
    ).toBe(false);

    // Reject apps with unseen host
    expect(
      validateCompiledWorkflow(
        {
          ...validWithPort,
          apps: ["localhost", "invented.example"],
        },
        { seenHosts: ["localhost:4173"] },
      ).ok,
    ).toBe(false);
  });

  it("compileWorkflow uses captured.url when stepIndex is set and model invents raw.url, and rejects invented-host navigate without stepIndex", async () => {
    const events: Event[] = [
      {
        v: 1,
        id: "inv-nav-1",
        ts: 1000,
        session: "s_invented_nav",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:4173/form.html",
        type: "nav",
      },
      {
        v: 1,
        id: "inv-fill-1",
        ts: 2000,
        session: "s_invented_nav",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:4173/form.html",
        type: "input",
        target: {
          tag: "input",
          label: "Name",
          locators: [{ kind: "css", value: "#name" }],
        },
        value: "Ada",
      },
      {
        v: 1,
        id: "inv-click-1",
        ts: 3000,
        session: "s_invented_nav",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:4173/form.html",
        type: "click",
        target: {
          tag: "button",
          label: "Save",
          locators: [{ kind: "css", value: "#save" }],
        },
      },
    ];

    // 1) stepIndex is set and model invents an unseen URL -> uses captured.url
    const withStepIndexInvented = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini({
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Open form and save",
          reason: "Navigates to form and saves",
          risk: "low",
          runMode: "save_only",
          params: [],
          steps: [
            {
              action: "navigate",
              stepIndex: 0,
              url: "https://invented.example/phishing",
            },
            { action: "fill", stepIndex: 1, value: "Ada" },
            { action: "click", stepIndex: 2 },
          ],
        }).client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(withStepIndexInvented).not.toBeNull();
    expect(withStepIndexInvented!.steps[1]).toEqual({
      action: "navigate",
      url: "http://127.0.0.1:4173/form.html",
    });

    // 2) stepIndex is absent and model invents an unseen host -> dropped/rejected (null)
    const withoutStepIndexInvented = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini({
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Open form and save",
          reason: "Navigates to form and saves",
          risk: "low",
          runMode: "save_only",
          params: [],
          steps: [
            { action: "navigate", url: "https://invented.example/phishing" },
            { action: "fill", stepIndex: 1, value: "Ada" },
            { action: "click", stepIndex: 2 },
          ],
        }).client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(withoutStepIndexInvented).toBeNull();

    // 3) stepIndex is absent and model emits seen host with wrong port -> rejected by validator (null)
    const withoutStepIndexWrongPort = await compileWorkflow(
      { events },
      {
        gemini: makeMockGemini({
          suggest: true,
          offerAt2: false,
          kind: "workflow",
          name: "Open form and save",
          reason: "Navigates to form and saves",
          risk: "low",
          runMode: "save_only",
          params: [],
          steps: [
            { action: "navigate", url: "http://localhost:9999/form.html" },
            { action: "fill", stepIndex: 1, value: "Ada" },
            { action: "click", stepIndex: 2 },
          ],
        }).client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(withoutStepIndexWrongPort).toBeNull();
  });

  it("keeps 127.0.0.1 vs localhost vs distinct ports separate across compiler and validator, and carries switchTab.url through compiledWorkflowToActionScript", async () => {
    expect(normalizeHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeHost("localhost")).toBe("localhost");
    expect(normalizeHost("127.0.0.1:4173")).not.toBe(normalizeHost("localhost:4173"));
    expect(normalizeHost("127.0.0.1:4173")).not.toBe(normalizeHost("127.0.0.1:5173"));

    const events: Event[] = [
      {
        v: 1,
        id: "xt-1",
        ts: 1000,
        session: "s_xtab_ports",
        source: "browser",
        app: "localhost",
        url: "http://localhost:4173/portal.html",
        type: "copy",
        target: {
          tag: "span",
          label: "Invoice",
          locators: [{ kind: "testid", value: "portal-inv" }],
        },
        value: "INV-100",
      },
      {
        v: 1,
        id: "xt-2",
        ts: 2000,
        session: "s_xtab_ports",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:5173/erp.html",
        type: "tab_switch",
        meta: { tabId: 2, subType: "cross_app_switch" },
      },
      {
        v: 1,
        id: "xt-3",
        ts: 3000,
        session: "s_xtab_ports",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:5173/erp.html",
        type: "paste",
        target: {
          tag: "input",
          label: "Invoice",
          locators: [{ kind: "testid", value: "erp-inv" }],
        },
        value: "INV-100",
      },
      {
        v: 1,
        id: "xt-4",
        ts: 4000,
        session: "s_xtab_ports",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:5173/erp.html",
        type: "click",
        target: {
          tag: "button",
          label: "Save",
          locators: [{ kind: "testid", value: "erp-save" }],
        },
      },
    ];

    const { client } = makeMockGemini({
      suggest: true,
      offerAt2: false,
      kind: "workflow",
      name: "Portal to ERP",
      reason: "Copies invoice from localhost portal to 127.0.0.1 ERP",
      risk: "low",
      runMode: "save_only",
      params: [],
      steps: [
        { action: "readText", stepIndex: 0, bind: "inv" },
        { action: "switchTab", host: "127.0.0.1" },
        { action: "fill", stepIndex: 2, value: "{{inv}}" },
        { action: "click", stepIndex: 3 },
      ],
    });

    const wf = await compileWorkflow(
      { events },
      {
        gemini: client,
        iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
      },
    );

    expect(wf).not.toBeNull();
    expect(wf!.apps).toEqual(["localhost", "127.0.0.1"]);
    expect(wf!.startUrl).toBe("http://localhost:4173/portal.html");
    expect(wf!.steps[0]).toEqual({
      action: "switchTab",
      host: "localhost",
      url: "http://localhost:4173/portal.html",
    });
    expect(wf!.steps[2]).toEqual({
      action: "switchTab",
      host: "127.0.0.1",
      url: "http://127.0.0.1:5173/erp.html",
    });

    const script = compiledWorkflowToActionScript(wf!);
    expect(script.steps[0]).toEqual({
      action: "switchTab",
      host: "localhost",
      url: "http://localhost:4173/portal.html",
    });
    expect(script.steps[2]).toEqual({
      action: "switchTab",
      host: "127.0.0.1",
      url: "http://127.0.0.1:5173/erp.html",
    });
  });
});

describe("v2 compiler model and timeout configuration", () => {
  const validPayload = {
    suggest: true,
    offerAt2: false,
    kind: "workflow" as const,
    name: "Record claim",
    reason: "Copies claim fields",
    risk: "low" as const,
    runMode: "save_only" as const,
    params: [],
    steps: [{ action: "click" as const, stepIndex: 6 }],
  };

  let prevGeminiModel: string | undefined;
  let prevV2Model: string | undefined;
  let prevV2Timeout: string | undefined;

  beforeEach(() => {
    prevGeminiModel = process.env.GEMINI_MODEL;
    prevV2Model = process.env.V2_COMPILE_MODEL;
    prevV2Timeout = process.env.V2_COMPILE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (prevGeminiModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevGeminiModel;

    if (prevV2Model === undefined) delete process.env.V2_COMPILE_MODEL;
    else process.env.V2_COMPILE_MODEL = prevV2Model;

    if (prevV2Timeout === undefined) delete process.env.V2_COMPILE_TIMEOUT_MS;
    else process.env.V2_COMPILE_TIMEOUT_MS = prevV2Timeout;

    vi.useRealTimers();
  });

  it("uses GEMINI_MODEL when V2_COMPILE_MODEL is unset, falling back to DEFAULT_GEMINI_MODEL", async () => {
    delete process.env.V2_COMPILE_MODEL;
    process.env.GEMINI_MODEL = "gemini-3-flash-preview";

    const events = await loadFixture("unseen-extra-click.jsonl");
    const { sdk, generateContent } = makeMockSdk(validPayload);

    const wf = await compileWorkflow(
      { events },
      {
        gemini: { sdk, apiKey: "mock-key" },
        iris: async () => null,
      },
    );

    expect(wf).not.toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0]?.[0]?.model).toBe(
      "gemini-3-flash-preview",
    );
  });

  it("overrides default model with V2_COMPILE_MODEL env var", async () => {
    process.env.V2_COMPILE_MODEL = "gemini-2.5-flash";

    const events = await loadFixture("unseen-extra-click.jsonl");
    const { sdk, generateContent } = makeMockSdk(validPayload);

    const wf = await compileWorkflow(
      { events },
      {
        gemini: { sdk, apiKey: "mock-key" },
        iris: async () => null,
      },
    );

    expect(wf).not.toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0]?.[0]?.model).toBe("gemini-2.5-flash");
  });

  it("gives opts.model precedence over V2_COMPILE_MODEL", async () => {
    process.env.V2_COMPILE_MODEL = "gemini-2.5-flash";

    const events = await loadFixture("unseen-extra-click.jsonl");
    const { sdk, generateContent } = makeMockSdk(validPayload);

    const wf = await compileWorkflow(
      { events },
      {
        gemini: { sdk, apiKey: "mock-key" },
        iris: async () => null,
        model: "gemini-3-flash-preview",
      },
    );

    expect(wf).not.toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0]?.[0]?.model).toBe(
      "gemini-3-flash-preview",
    );
  });

  it("overrides default 20000 ms timeout with V2_COMPILE_TIMEOUT_MS", async () => {
    process.env.V2_COMPILE_TIMEOUT_MS = "35";

    const events = await loadFixture("unseen-extra-click.jsonl");
    const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(
      async ({ config }) => {
        expect(config?.abortSignal).toBeInstanceOf(AbortSignal);
        return await new Promise<never>(() => {});
      },
    );
    const sdk: GeminiSdk = { models: { generateContent } };

    await expect(
      compileWorkflow(
        { events },
        {
          gemini: { sdk, apiKey: "mock-key" },
          iris: async () => null,
        },
      ),
    ).rejects.toThrow("Gemini request timed out after 35 ms");
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("rejects self-read in validateCompiledWorkflow, resolves copy-button to nearest source cell, and strips self-reads to params when no source exists", async () => {
    const selfReadValidation = validateCompiledWorkflow({
      kind: "workflow",
      name: "Self read bad",
      reason: "Invalid self read",
      risk: "low",
      offerAt2: false,
      runMode: "save_only",
      pauseBeforeSubmit: false,
      apps: ["erp.local"],
      params: [],
      steps: [
        { action: "readText", target: [{ kind: "testid", value: "erp-amount" }], bind: "amount" },
        { action: "fill", target: [{ kind: "testid", value: "erp-amount" }], value: "{{amount}}" },
      ],
      stats: { repetitions: 1, minutesPerWeek: 0.1, manualSeconds: 2, replaySeconds: 0 },
    });
    expect(selfReadValidation.ok).toBe(false);
    if (!selfReadValidation.ok) {
      expect(selfReadValidation.error).toContain("Self-read");
    }

    // Copy button with source pageSummary -> exposes sourceTargetId & resolves readText to portal cell, NOT copy button
    const portalEvents: Event[] = [
      {
        v: 1,
        id: "cb-1",
        ts: 1000,
        session: "sess_cb",
        source: "browser",
        app: "localhost",
        url: "http://localhost:5173/portal.html",
        type: "copy",
        value: "1250.00 EUR",
        target: {
          tag: "button",
          role: "button",
          label: "Copy",
          locators: [
            { kind: "testid", value: "copy-portal-amount-1" },
            { kind: "text", value: "Copy" },
          ],
        },
        meta: {
          pageSummary: {
            source: {
              containerLocators: [{ kind: "css", value: "tbody" }],
              rowTag: "tr",
              rows: [
                {
                  locators: [{ kind: "css", value: "tr:nth-of-type(1)" }],
                  cells: [
                    { text: "INV-2026-001", locators: [{ kind: "testid", value: "portal-invoice-id-1" }] },
                    { text: "1250.00 EUR", locators: [{ kind: "testid", value: "portal-amount-1" }] },
                  ],
                },
              ],
            },
          },
        },
      },
      {
        v: 1,
        id: "cb-2",
        ts: 2000,
        session: "sess_cb",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:5173/erp.html",
        type: "tab_switch",
      },
      {
        v: 1,
        id: "cb-3",
        ts: 3000,
        session: "sess_cb",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:5173/erp.html",
        type: "paste",
        value: "1250.00 EUR",
        target: {
          tag: "input",
          role: "textbox",
          label: "Amount",
          locators: [{ kind: "testid", value: "erp-amount" }],
        },
      },
    ];

    const { client: cbGemini, prompts: cbPrompts } = makeMockGemini({
      suggest: true,
      offerAt2: false,
      kind: "workflow",
      name: "Portal Amount to ERP",
      reason: "Copies amount from portal cell to ERP",
      risk: "low",
      runMode: "save_only",
      params: [],
      steps: [
        { action: "readText", stepIndex: 0, bind: "amount" },
        { action: "switchTab", host: "127.0.0.1" },
        { action: "fill", stepIndex: 2, value: "{{amount}}" },
      ],
    });
    const cbWf = await compileWorkflow(
      { events: portalEvents },
      { gemini: cbGemini, iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }) },
    );
    expect(cbWf).not.toBeNull();
    expect(cbPrompts[0]).toContain('"sourceTargetId":');
    const readStep = cbWf!.steps.find((s) => s.action === "readText");
    expect(readStep).toEqual({
      action: "readText",
      target: [{ kind: "testid", value: "portal-amount-1" }],
      bind: "amount",
    });

    // Copy button with NO source pageSummary -> Gemini self-read is stripped to params instead of self-read
    const noSourceEvents: Event[] = [
      { ...portalEvents[0], meta: undefined },
      portalEvents[1],
      portalEvents[2],
    ];
    const { client: nsGemini, prompts: nsPrompts } = makeMockGemini({
      suggest: true,
      offerAt2: false,
      kind: "workflow",
      name: "Fill Amount",
      reason: "Fills ERP amount",
      risk: "low",
      runMode: "save_only",
      params: [],
      steps: [
        { action: "readText", stepIndex: 2, bind: "amount" },
        { action: "fill", stepIndex: 2, value: "{{amount}}" },
      ],
    });
    const nsWf = await compileWorkflow(
      { events: noSourceEvents },
      { gemini: nsGemini, iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }) },
    );
    expect(nsWf).not.toBeNull();
    expect(nsPrompts[0]).toContain('"noReadableSource":true');
    expect(nsWf!.steps.some((s) => s.action === "readText")).toBe(false);
    expect(nsWf!.params.some((p) => p.name === "amount")).toBe(true);
  });
});
