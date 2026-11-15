import { describe, expect, it, vi } from "vitest";
import type { Event, Workflow } from "@gen/shared";
import {
  buildTipPrompt,
  suggestTip,
  TipSuggestionSchema,
  type TipSuggestion,
} from "../src/exp/tips.ts";
import type { GeminiClient, GeminiSdk, ZodLikeSchema } from "../src/llm/gemini.ts";

function makeSheetFillDownWorkflow(): { workflow: Workflow; events: Event[] } {
  const workflow: Workflow = {
    id: "wf-sheet-fill-down",
    name: "Copy and fill down row total formula in Google Sheets",
    sourceApp: "docs.google.com",
    destApp: "docs.google.com",
    steps: [
      {
        action: "click",
        target: [{ kind: "aria", value: "Cell C2" }],
      },
      {
        action: "copy",
        target: [{ kind: "aria", value: "Cell C2" }],
        value: "=SUM(A2:B2)",
      },
      {
        action: "click",
        target: [{ kind: "aria", value: "Cell C3" }],
      },
      {
        action: "paste",
        target: [{ kind: "aria", value: "Cell C3" }],
        value: { param: "formula" },
      },
    ],
    params: [{ name: "formula", example: "=SUM(A2:B2)" }],
    instances: [
      { startTs: 1740000000000, endTs: 1740000004000, bindings: { formula: "=SUM(A2:B2)" } },
      { startTs: 1740000010000, endTs: 1740000014000, bindings: { formula: "=SUM(A3:B3)" } },
      { startTs: 1740000020000, endTs: 1740000024000, bindings: { formula: "=SUM(A4:B4)" } },
      { startTs: 1740000030000, endTs: 1740000034000, bindings: { formula: "=SUM(A5:B5)" } },
    ],
  };

  const events: Event[] = [
    {
      v: 1,
      id: "ev-grid-1",
      ts: 1740000000000,
      session: "sess-sheet-1",
      source: "browser",
      app: "docs.google.com",
      window: "Q1 Budget - Google Sheets",
      type: "copy",
      target: { locators: [{ kind: "aria", value: "Cell C2" }], label: "C2", role: "gridcell" },
      meta: {
        grid: {
          cellRef: "C2",
          rowIndex: 2,
          colIndex: 3,
          sheetName: "Q1 Budget",
          isFormula: true,
          formulaFunc: "SUM",
        },
      },
    },
    {
      v: 1,
      id: "ev-grid-2",
      ts: 1740000002000,
      session: "sess-sheet-1",
      source: "browser",
      app: "docs.google.com",
      window: "Q1 Budget - Google Sheets",
      type: "contextmenu",
      target: { locators: [{ kind: "aria", value: "Cell C3" }], label: "C3", role: "gridcell" },
      meta: {
        grid: {
          cellRef: "C3",
          rowIndex: 3,
          colIndex: 3,
          sheetName: "Q1 Budget",
          isFormula: false,
        },
        menu: {
          trigger: "right_click",
          menuItemText: "Paste",
          displayedShortcut: "Ctrl+V",
        },
      },
    },
  ];

  return { workflow, events };
}

function makeNonShortcutWorkflow(): Workflow {
  return {
    id: "wf-bespoke-crm",
    name: "Copy custom intake notes from email to CRM",
    sourceApp: "mail.local",
    destApp: "crm.local",
    steps: [
      { action: "copy", target: [{ kind: "testid", value: "email-body" }], value: { param: "notes" } },
      { action: "nav", value: "https://crm.local/accounts/edit" },
      { action: "paste", target: [{ kind: "testid", value: "crm-notes" }], value: { param: "notes" } },
      { action: "click", target: [{ kind: "testid", value: "save-account" }] },
    ],
    params: [{ name: "notes", example: "Customer requested quarterly billing." }],
    instances: [
      { startTs: 1740000100000, endTs: 1740000110000, bindings: { notes: "Quarterly billing" } },
      { startTs: 1740000200000, endTs: 1740000210000, bindings: { notes: "Net-30 terms" } },
      { startTs: 1740000300000, endTs: 1740000310000, bindings: { notes: "Needs onboarding call" } },
    ],
  };
}

function makeFakeSdk(responseText: string | undefined) {
  const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(async () => ({
    text: responseText,
  }));
  const sdk: GeminiSdk = {
    models: {
      generateContent,
    },
  };
  return { sdk, generateContent };
}

describe("exp/tips (show-only shortcut & menu tip suggester)", () => {
  it("buildTipPrompt summarizes sourceApp, destApp, steps, instances.length, and event menu/grid metadata", () => {
    const { workflow, events } = makeSheetFillDownWorkflow();
    const prompt = buildTipPrompt(workflow, events);

    expect(prompt).toContain("docs.google.com");
    expect(prompt).toContain('"instanceCount": 4');
    expect(prompt).toContain("copy");
    expect(prompt).toContain("paste");
    expect(prompt).toContain("Q1 Budget");
    expect(prompt).toContain('"cellRef": "C2"');
    expect(prompt).toContain('"menuItemText": "Paste"');
    expect(prompt).toContain('"tip": null, "keys": null, "why"');
  });

  it("suggestTip returns non-null tip and keys for a repeated sheet fill-down workflow in a single generateJson call", async () => {
    const { workflow, events } = makeSheetFillDownWorkflow();
    const expected: TipSuggestion = {
      tip: "Select the formula cell and target range below it, then press Ctrl+D (Fill Down) instead of copying and pasting row by row.",
      keys: ["Ctrl+D"],
      why: "Observed 4 repetitions of copying and pasting =SUM formulas down column C in Google Sheets.",
    };

    const generateJsonSpy = vi.fn(
      async (_prompt: string, schema: ZodLikeSchema<TipSuggestion>): Promise<TipSuggestion> => {
        const parsed = schema.safeParse(expected);
        if (!parsed.success) throw new Error("unexpected schema failure");
        return parsed.data;
      },
    );
    const mockClient: GeminiClient = {
      generateText: vi.fn(),
      generateJson: async <T>(prompt: string, schema: ZodLikeSchema<T>): Promise<T> =>
        (await generateJsonSpy(prompt, schema as unknown as ZodLikeSchema<TipSuggestion>)) as unknown as T,
    };

    const result = await suggestTip(workflow, { client: mockClient, events });

    expect(result).toEqual(expected);
    expect(result.tip).not.toBeNull();
    expect(result.keys).not.toBeNull();
    expect(generateJsonSpy).toHaveBeenCalledTimes(1);
    const [prompt, schema] = generateJsonSpy.mock.calls[0];
    expect(schema).toBe(TipSuggestionSchema);
    expect(prompt).toContain("docs.google.com");
    expect(prompt).toContain('"cellRef": "C2"');

    // Also verify end-to-end with createGeminiClient via mocked GeminiSdk
    const { sdk, generateContent } = makeFakeSdk(JSON.stringify(expected));
    const sdkResult = await suggestTip(workflow, { gemini: { sdk }, events });
    expect(sdkResult).toEqual(expected);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0]?.[0]?.config).toEqual({
      responseMimeType: "application/json",
    });
  });

  it("suggestTip returns { tip: null, keys: null, why } cleanly for a non-shortcut workflow", async () => {
    const workflow = makeNonShortcutWorkflow();
    const expected: TipSuggestion = {
      tip: null,
      keys: null,
      why: "This workflow transfers custom text across two separate web apps (mail.local to crm.local), so no single built-in shortcut or menu item replaces it.",
    };

    const { sdk, generateContent } = makeFakeSdk(JSON.stringify(expected));
    const result = await suggestTip(workflow, { gemini: { sdk } });

    expect(result).toEqual(expected);
    expect(result.tip).toBeNull();
    expect(result.keys).toBeNull();
    expect(result.why.length).toBeGreaterThan(0);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid JSON and schema-violating responses via TipSuggestionSchema", async () => {
    const { workflow } = makeSheetFillDownWorkflow();

    const malformedSdk = makeFakeSdk("{not-valid-json");
    await expect(
      suggestTip(workflow, { gemini: { sdk: malformedSdk.sdk } }),
    ).rejects.toThrow(/malformed JSON/i);

    const wrongKeysTypeSdk = makeFakeSdk(
      JSON.stringify({
        tip: "Press Ctrl+D",
        keys: "Ctrl+D",
        why: "Repeated sheet fill-down.",
      }),
    );
    await expect(
      suggestTip(workflow, { gemini: { sdk: wrongKeysTypeSdk.sdk } }),
    ).rejects.toThrow(/schema validation.*keys/i);

    const emptyWhySdk = makeFakeSdk(
      JSON.stringify({
        tip: null,
        keys: null,
        why: "   ",
      }),
    );
    await expect(
      suggestTip(workflow, { gemini: { sdk: emptyWhySdk.sdk } }),
    ).rejects.toThrow(/schema validation.*why/i);

    const badTipSdk = makeFakeSdk(
      JSON.stringify({
        tip: "",
        keys: null,
        why: "Empty tip string should fail validation.",
      }),
    );
    await expect(
      suggestTip(workflow, { gemini: { sdk: badTipSdk.sdk } }),
    ).rejects.toThrow(/schema validation.*tip/i);
  });
});

describe.skipIf(!process.env.GOOGLE_CLOUD_PROJECT)(
  "exp/tips live Vertex AI ADC check",
  () => {
    it(
      "suggestTip calls Vertex AI ADC and returns a valid TipSuggestion",
      async () => {
        const { workflow, events } = makeSheetFillDownWorkflow();
        const prevUseVertexAi = process.env.GOOGLE_GENAI_USE_VERTEXAI;
        if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_GENAI_USE_VERTEXAI !== "true") {
          process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
        }

        try {
          const result = await suggestTip(workflow, {
            events,
            gemini: { thinkingBudget: 0 },
          });
          const validated = TipSuggestionSchema.safeParse(result);
          expect(validated.success).toBe(true);
          expect(typeof result.why).toBe("string");
          expect(result.why.trim().length).toBeGreaterThan(0);
        } finally {
          if (prevUseVertexAi === undefined) {
            delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
          } else {
            process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertexAi;
          }
        }
      },
      30_000,
    );
  },
);
