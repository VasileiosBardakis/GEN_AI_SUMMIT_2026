import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Event } from "@gen/shared";
import { EventsSchema } from "@gen/shared/schema.ts";
import type { GeminiClient, GeminiSdk } from "../src/llm/gemini.ts";
import { createProposer } from "../src/propose.ts";
import { compiledWorkflowToActionScript } from "../src/report.ts";
import {
  COMPILER_RESPONSE_SCHEMA,
  compileWorkflow,
  detectRepeatedCandidates,
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
      expect(wf!.steps[0]).toEqual({ action: "switchTab", host: "freight.local" });
      const loop = wf!.steps[1];
      expect(loop.action).toBe("forEach");
      if (loop.action === "forEach") {
        expect(Array.isArray(loop.items)).toBe(true);
        if (Array.isArray(loop.items)) {
          expect(loop.items).toHaveLength(2);
          expect(loop.items.map((r) => r.selector)).toEqual(["#row-4", "#row-5"]);
          expect(loop.items.map((r) => r.col1)).toEqual(["WB-9044", "WB-9045"]);
        }
      }
      expect(prompts[0]).toContain("#row-4");
      expect(prompts[0]).toContain("#row-5");
      expect(wf!.stats.repetitions).toBe(3);
      expect(wf!.stats.manualSeconds).toBeGreaterThan(wf!.stats.replaySeconds);
      expect(wf!.stats.minutesPerWeek).toBeGreaterThan(0);
    }

    // 2. unseen-sheet-loop.jsonl: generic within exact-text + forEach list loop + 127.0.0.1 -> localhost
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
      expect(wf!.apps).toEqual(["localhost"]);
      expect(wf!.startUrl).toBe("http://localhost:5173/sheet.html");
      expect(wf!.steps[0]).toEqual({ action: "switchTab", host: "localhost" });

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
      expect(wf!.steps[0]).toEqual({ action: "switchTab", host: "lims.local" });
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

    // 7. unseen-pii-risky.jsonl: local PII restored, no <email> / [REDACTED:, pauseBeforeSubmit: true
    {
      const events = await loadFixture("unseen-pii-risky.jsonl");
      const piiMap = new Map<string, string>([
        ["[REDACTED:EMAIL#h_3f82a19b]", "billing@northstar.example"],
      ]);
      const { client, prompts } = makeMockGemini({
        suggest: true,
        offerAt2: false,
        kind: "workflow",
        name: "Send outbound vendor wire",
        reason: "Transfers approved wire details into Treasury Portal",
        risk: "high",
        runMode: "save_only",
        params: [
          { name: "wireAmount", example: "14500.00" },
          { name: "sampleEmail", example: "__PII_EMAIL_1__" },
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
        { events, piiMap },
        {
          gemini: client,
          iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: true }),
        },
      );

      expect(prompts[0]).not.toContain("billing@northstar.example");
      expect(prompts[0]).not.toContain("[REDACTED:");
      expect(prompts[0]).toContain("__PII_EMAIL_1__");

      expect(wf).not.toBeNull();
      expect(wf!.pauseBeforeSubmit).toBe(true);
      expect(wf!.params.find((p) => p.name === "sampleEmail")?.example).toBe(
        "billing@northstar.example",
      );
      const serialized = JSON.stringify(wf);
      expect(serialized).not.toContain("<email>");
      expect(serialized).not.toContain("[REDACTED:");
      expect(serialized).not.toMatch(/__PII_[A-Za-z0-9_]+__/);
    }

    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("drops popup (returns null) when Iris worthAutomating === false or !suggest", async () => {
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

  it("keeps raw PII out of Gemini & Iris prompts and restores local PII from piiMap", async () => {
    const events: Event[] = [
      {
        v: 1,
        id: "1",
        ts: 1000,
        session: "s_pii",
        source: "browser",
        app: "crm.local",
        url: "http://crm.local/contact",
        type: "input",
        target: {
          tag: "input",
          label: "Email",
          locators: [{ kind: "testid", value: "contact-email" }],
        },
        value: "ana@acme.com",
      },
      {
        v: 1,
        id: "2",
        ts: 2000,
        session: "s_pii",
        source: "browser",
        app: "crm.local",
        url: "http://crm.local/contact",
        type: "click",
        target: {
          tag: "button",
          label: "Send Invite",
          locators: [{ kind: "testid", value: "send-invite" }],
        },
      },
    ];

    const seenIrisDigests: Array<Record<string, unknown>> = [];
    const { client, prompts } = makeMockGemini({
      suggest: true,
      offerAt2: false,
      kind: "workflow",
      name: "Invite contact",
      reason: "Fills email and sends invite",
      risk: "high",
      runMode: "save_only",
      params: [],
      steps: [
        { action: "fill", stepIndex: 0, value: "__PII_EMAIL_1__" },
        { action: "click", stepIndex: 1 },
      ],
    });

    const wf = await compileWorkflow(
      { events },
      {
        gemini: client,
        iris: async (digest) => {
          seenIrisDigests.push(digest);
          return { worthAutomating: true, pauseBeforeSubmit: true };
        },
      },
    );

    expect(prompts[0]).toContain("__PII_EMAIL_1__");
    expect(prompts[0]).not.toContain("ana@acme.com");
    expect(JSON.stringify(seenIrisDigests)).not.toContain("ana@acme.com");

    expect(wf).not.toBeNull();
    expect(wf!.pauseBeforeSubmit).toBe(true);
    const fillStep = wf!.steps[1];
    expect(fillStep.action).toBe("fill");
    if (fillStep.action === "fill") {
      expect(fillStep.value).toBe("ana@acme.com");
    }
  });

  it("scrubs emails, card numbers, and [REDACTED: markers in target labels, inferred labels, and container itemKeys before Gemini/Iris prompts", async () => {
    const events: Event[] = [
      {
        v: 1,
        id: "lbl-1",
        ts: 1000,
        session: "s_lbl_pii",
        source: "browser",
        app: "billing.local",
        url: "http://billing.local/pay",
        type: "input",
        target: {
          tag: "input",
          label: "Receipt for vip@acme.example",
          locators: [{ kind: "testid", value: "receipt-note" }],
        },
        value: "Invoice paid",
        meta: {
          container: {
            testid: "invoice-row",
            itemKey: "owner@acme.example",
          },
        },
      },
      {
        v: 1,
        id: "lbl-2",
        ts: 2000,
        session: "s_lbl_pii",
        source: "browser",
        app: "billing.local",
        url: "http://billing.local/pay",
        type: "click",
        target: {
          tag: "button",
          locators: [
            { kind: "aria", value: 'button[name="Pay with 4111-1111-1111-1111"]' },
          ],
        },
        meta: {
          container: {
            testid: "card-row",
            itemKey: "4532-1234-5678-9012",
          },
        },
      },
      {
        v: 1,
        id: "lbl-3",
        ts: 3000,
        session: "s_lbl_pii",
        source: "browser",
        app: "billing.local",
        url: "http://billing.local/pay",
        type: "click",
        target: {
          tag: "button",
          label: "Confirm [REDACTED:CARD#h_99887766]",
          locators: [{ kind: "testid", value: "confirm-pay" }],
        },
      },
    ];

    const seenIrisDigests: Array<Record<string, unknown>> = [];
    const { client, prompts } = makeMockGemini({
      suggest: true,
      offerAt2: false,
      kind: "workflow",
      name: "Submit payment",
      reason: "Fills receipt note and submits payment",
      risk: "high",
      runMode: "save_only",
      params: [],
      steps: [
        { action: "fill", stepIndex: 0, value: "Invoice paid" },
        { action: "click", stepIndex: 1 },
        { action: "click", stepIndex: 2 },
      ],
    });

    const wf = await compileWorkflow(
      { events },
      {
        gemini: client,
        iris: async (digest) => {
          seenIrisDigests.push(digest);
          return { worthAutomating: true, pauseBeforeSubmit: true };
        },
      },
    );

    expect(wf).not.toBeNull();

    const prompt = prompts[0] ?? "";
    const irisText = JSON.stringify(seenIrisDigests);

    expect(prompt).not.toContain("vip@acme.example");
    expect(prompt).not.toContain("owner@acme.example");
    expect(prompt).not.toContain("4111-1111-1111-1111");
    expect(prompt).not.toContain("4532-1234-5678-9012");
    expect(prompt).not.toContain("[REDACTED:");
    expect(prompt).toContain("__PII_EMAIL_1__");
    expect(prompt).toContain("__PII_EMAIL_2__");
    expect(prompt).toContain("__PII_CARD_");

    expect(irisText).not.toContain("vip@acme.example");
    expect(irisText).not.toContain("4111-1111-1111-1111");
    expect(irisText).not.toContain("[REDACTED:");
    expect(irisText).toContain("__PII_EMAIL_1__");
    expect(irisText).toContain("__PII_CARD_");
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
    expect(normalizeHost("127.0.0.1")).toBe("localhost");
    expect(normalizeHost("127.0.0.1:5173")).toBe("localhost:5173");
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
        { action: "switchTab", host: "localhost" },
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
        steps: [{ action: "switchTab", host: "127.0.0.1" }],
      }).ok,
    ).toBe(false);

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
    for (const badVal of ["<email>", "[REDACTED:EMAIL#h_1234]", "__PII_EMAIL_1__"]) {
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

    const candidates = detectRepeatedCandidates(steps);
    expect(candidates.some((c) => c.signature === "fill->key" && c.count === 3)).toBe(true);

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

    expect(prompts[0]).toContain("click/fill/select/readText/key/submit");
    expect(prompts[0]).toContain("Enter");
    expect(wf).not.toBeNull();

    const script = compiledWorkflowToActionScript(wf!);
    expect(script.steps).toEqual([
      { action: "switchTab", host: "search.local" },
      { action: "fill", target: searchLocators, value: "{{query}}" },
      { action: "pressKey", key: "Enter", target: searchLocators },
    ]);

    let visibleCount = 4; // 2 reps first
    const decided: Array<{ name: string; script: ReturnType<typeof compiledWorkflowToActionScript> }> = [];
    const proposer = createProposer({
      pipeline: "v2",
      debounceMs: 10,
      readSessionEvents: async () => events.slice(0, visibleCount),
      compileV2: (input) =>
        compileWorkflow(input, {
          gemini: client,
          iris: async () => ({ worthAutomating: true, pauseBeforeSubmit: false }),
        }),
      requestDecision: async (name, _solution, decidedScript) => {
        decided.push({ name, script: decidedScript });
        return { ok: true, decision: "approved" };
      },
      runScript: async () => ({ ok: true }),
    });

    try {
      proposer.onEvents("s_enter_search");
      await new Promise((r) => setTimeout(r, 60));
      expect(decided).toHaveLength(0);

      visibleCount = 6; // rep 3 arrives
      proposer.onEvents("s_enter_search");
      await new Promise((r) => setTimeout(r, 60));
      expect(decided).toHaveLength(1);
      expect(decided[0].script.steps).toEqual(script.steps);
    } finally {
      proposer.close();
    }
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
      url: "http://localhost:4173/form.html",
    });

    // 2) Without stepIndex, model returns bare "http://localhost"
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
            { action: "navigate", url: "http://localhost" },
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
      url: "http://localhost:4173/form.html",
    });

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
        { action: "navigate", url: "http://localhost/other" },
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
      url: "http://localhost:4173/other",
    });
    expect(differentPathPromptCheck.prompts[0]).toContain("full URL including port and path");
  });
});
