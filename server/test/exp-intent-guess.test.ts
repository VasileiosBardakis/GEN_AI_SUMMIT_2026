import { describe, expect, it, vi } from "vitest";
import type { Event } from "@gen/shared";
import {
  createGeminiClient,
  type GeminiClient,
  type GeminiSdk,
} from "../src/llm/gemini.ts";
import {
  guessIntent,
  IntentGuessSchema,
} from "../src/exp/intent-guess.ts";

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    v: 1,
    id: "evt-1",
    ts: 1_700_000_000_000,
    session: "sess-1",
    source: "browser",
    app: "erp.internal",
    window: "Invoices - ERP",
    url: "https://erp.internal/invoices",
    type: "click",
    target: {
      locators: [{ kind: "aria", value: "New Invoice" }],
      label: "New Invoice",
      role: "button",
      tag: "button",
    },
    ...overrides,
  };
}

function makeMockClient(): {
  client: GeminiClient;
  generateText: ReturnType<typeof vi.fn>;
  generateJson: ReturnType<typeof vi.fn>;
} {
  const generateText = vi.fn();
  const generateJson = vi.fn();
  const client: GeminiClient = {
    generateText: generateText as GeminiClient["generateText"],
    generateJson: generateJson as GeminiClient["generateJson"],
  };
  return { client, generateText, generateJson };
}

describe("IntentGuessSchema", () => {
  it("accepts valid { guess, confidence } payloads", () => {
    expect(
      IntentGuessSchema.safeParse({ guess: "Create customer invoice", confidence: 0.85 }),
    ).toEqual({
      success: true,
      data: { guess: "Create customer invoice", confidence: 0.85 },
    });

    expect(
      IntentGuessSchema.safeParse({ guess: null, confidence: 0 }),
    ).toEqual({
      success: true,
      data: { guess: null, confidence: 0 },
    });

    expect(
      IntentGuessSchema.safeParse({ guess: "Export report", confidence: 1 }),
    ).toEqual({
      success: true,
      data: { guess: "Export report", confidence: 1 },
    });
  });

  it("rejects non-objects, invalid guess types, and out-of-range or non-finite confidence", () => {
    expect(IntentGuessSchema.safeParse(null).success).toBe(false);
    expect(IntentGuessSchema.safeParse([]).success).toBe(false);
    expect(IntentGuessSchema.safeParse({ guess: 123, confidence: 0.7 }).success).toBe(false);
    expect(IntentGuessSchema.safeParse({ confidence: 0.7 }).success).toBe(false);
    expect(IntentGuessSchema.safeParse({ guess: "Test", confidence: -0.1 }).success).toBe(false);
    expect(IntentGuessSchema.safeParse({ guess: "Test", confidence: 1.1 }).success).toBe(false);
    expect(IntentGuessSchema.safeParse({ guess: "Test", confidence: Number.NaN }).success).toBe(false);
    expect(IntentGuessSchema.safeParse({ guess: "Test", confidence: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(IntentGuessSchema.safeParse({ guess: "Test", confidence: "0.8" }).success).toBe(false);
  });
});

describe("guessIntent (offline)", () => {
  it("(a) returns { guess: null, confidence: 0 } with 0 Gemini calls when moves is empty", async () => {
    const { client, generateText, generateJson } = makeMockClient();

    const result = await guessIntent(
      { moves: [], pageSummary: "Invoices dashboard" },
      client,
    );

    expect(result).toEqual({ guess: null, confidence: 0 });
    expect(generateJson).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();

    // Also works with no injected client and no credentials
    await expect(guessIntent({ moves: [] })).resolves.toEqual({
      guess: null,
      confidence: 0,
    });
  });

  it("(b) summarizes 1 move + pageSummary in 1 generateJson call and returns { guess, confidence }", async () => {
    const { client, generateText, generateJson } = makeMockClient();
    generateJson.mockResolvedValueOnce({
      guess: "  Create new invoice  ",
      confidence: 0.82,
    });

    const move1 = makeEvent({
      type: "click",
      app: "erp.internal",
      window: "Invoices - ERP",
      url: "https://erp.internal/invoices",
      target: {
        locators: [{ kind: "testid", value: "new-invoice-btn" }],
        label: "New Invoice",
        role: "button",
        tag: "button",
      },
    });

    const result = await guessIntent(
      {
        moves: [move1],
        pageSummary: "ERP Invoices page with New Invoice button and table of open invoices.",
      },
      client,
    );

    expect(result).toEqual({
      guess: "Create new invoice",
      confidence: 0.82,
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(generateJson).toHaveBeenCalledTimes(1);

    const [prompt, schema] = generateJson.mock.calls[0];
    expect(schema).toBe(IntentGuessSchema);
    expect(prompt).toContain("click");
    expect(prompt).toContain("erp.internal");
    expect(prompt).toContain("Invoices - ERP");
    expect(prompt).toContain("https://erp.internal/invoices");
    expect(prompt).toContain("New Invoice");
    expect(prompt).toContain("button");
    expect(prompt).toContain("ERP Invoices page with New Invoice button");
  });

  it("(b) slices to first 2 moves and omits redacted or PII-marked values", async () => {
    const { client, generateJson } = makeMockClient();
    generateJson.mockResolvedValueOnce({
      guess: "Search customer billing records",
      confidence: 0.76,
    });

    const move1 = makeEvent({
      id: "evt-1",
      type: "input",
      target: {
        locators: [],
        label: "Customer Search",
        role: "textbox",
        tag: "input",
      },
      value: "Acme Corp",
    });
    const move2 = makeEvent({
      id: "evt-2",
      type: "input",
      target: {
        locators: [],
        label: "API Key",
        role: "textbox",
        tag: "input",
      },
      value: "[REDACTED:SECRET_TOKEN#h_12345678]",
      meta: { privacy: { redacted: true, reason: "secret_field" } },
    });
    const move3 = makeEvent({
      id: "evt-3",
      type: "click",
      target: {
        locators: [],
        label: "THIRD_MOVE_SHOULD_BE_IGNORED",
        role: "button",
        tag: "button",
      },
    });

    const result = await guessIntent(
      { moves: [move1, move2, move3], pageSummary: "Customer billing portal" },
      client,
    );

    expect(result).toEqual({
      guess: "Search customer billing records",
      confidence: 0.76,
    });
    expect(generateJson).toHaveBeenCalledTimes(1);

    const [prompt] = generateJson.mock.calls[0];
    expect(prompt).toContain("Acme Corp");
    expect(prompt).toContain("API Key");
    expect(prompt).not.toContain("[REDACTED");
    expect(prompt).not.toContain("THIRD_MOVE_SHOULD_BE_IGNORED");
  });

  it("(c) normalizes null, empty/whitespace guess, or confidence below minConfidence to guess: null", async () => {
    const { client, generateJson } = makeMockClient();

    generateJson.mockResolvedValueOnce({ guess: null, confidence: 0.9 });
    await expect(
      guessIntent({ moves: [makeEvent()] }, client),
    ).resolves.toEqual({ guess: null, confidence: 0.9 });

    generateJson.mockResolvedValueOnce({ guess: "   \t\n ", confidence: 0.88 });
    await expect(
      guessIntent({ moves: [makeEvent()] }, client),
    ).resolves.toEqual({ guess: null, confidence: 0.88 });

    generateJson.mockResolvedValueOnce({ guess: "Send weekly update", confidence: 0.49 });
    await expect(
      guessIntent({ moves: [makeEvent()] }, client),
    ).resolves.toEqual({ guess: null, confidence: 0.49 });

    generateJson.mockResolvedValueOnce({ guess: "Send weekly update", confidence: 0.65 });
    await expect(
      guessIntent({ moves: [makeEvent()], minConfidence: 0.7 }, client),
    ).resolves.toEqual({ guess: null, confidence: 0.65 });

    generateJson.mockResolvedValueOnce({ guess: "Send weekly update", confidence: 0.7 });
    await expect(
      guessIntent({ moves: [makeEvent()], minConfidence: 0.7 }, client),
    ).resolves.toEqual({ guess: "Send weekly update", confidence: 0.7 });
  });

  it("(d) rejects cleanly on schema validation failures and client errors", async () => {
    const sdkInvalidSchema: GeminiSdk = {
      models: {
        generateContent: vi.fn(async () => ({
          text: JSON.stringify({ guess: "Bad confidence", confidence: 1.5 }),
        })),
      },
    };
    const schemaFailingClient = createGeminiClient({ sdk: sdkInvalidSchema });

    await expect(
      guessIntent({ moves: [makeEvent()] }, schemaFailingClient),
    ).rejects.toThrow(/schema validation/i);

    const { client: errorClient, generateJson } = makeMockClient();
    generateJson.mockRejectedValueOnce(new Error("Vertex AI unavailable"));

    await expect(
      guessIntent({ moves: [makeEvent()] }, errorClient),
    ).rejects.toThrow("Vertex AI unavailable");
  });
});

describe.skipIf(!process.env.GOOGLE_CLOUD_PROJECT)("guessIntent (live Gemini)", () => {
  it("infers a valid IntentGuessResult using Vertex AI ADC", async () => {
    const prevUseVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    process.env.GOOGLE_GENAI_USE_VERTEXAI ??= "true";
    try {
      const client = createGeminiClient();

      const result = await guessIntent(
        {
          moves: [
            makeEvent({
              type: "click",
              app: "mail.internal",
              window: "Inbox - Mail",
              url: "https://mail.internal/inbox",
              target: {
                locators: [{ kind: "aria", value: "Compose" }],
                label: "Compose",
                role: "button",
                tag: "button",
              },
            }),
            makeEvent({
              id: "evt-2",
              type: "input",
              app: "mail.internal",
              window: "Inbox - Mail",
              url: "https://mail.internal/inbox",
              target: {
                locators: [{ kind: "aria", value: "Subject" }],
                label: "Subject",
                role: "textbox",
                tag: "input",
              },
              value: "Weekly status report",
            }),
          ],
          pageSummary: "Webmail client with Inbox list and Compose email modal open.",
        },
        client,
      );

      expect(IntentGuessSchema.safeParse(result).success).toBe(true);
      expect(result.guess === null || typeof result.guess === "string").toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    } finally {
      if (prevUseVertex === undefined) {
        delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      } else {
        process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertex;
      }
    }
  }, 20_000);
});
