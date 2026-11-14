import { afterEach, describe, expect, it, vi } from "vitest";
import { implementSolution } from "../../src/hands/implementor.ts";
import { ACTION_SCRIPT_RESPONSE_SCHEMA, parseActionScript } from "../../src/hands/types.ts";
import type { GeminiSdk } from "../../src/llm/gemini.ts";

describe("Stage 1: parseActionScript & ACTION_SCRIPT_RESPONSE_SCHEMA", () => {
  it("parses a targetless insertText action script", () => {
    const script = parseActionScript({
      name: "Quick reply",
      steps: [{ action: "insertText", value: "Thanks, your order ships Friday." }],
    });
    expect(script).toEqual({
      name: "Quick reply",
      steps: [{ action: "insertText", value: "Thanks, your order ships Friday." }],
    });
  });

  it("parses multi-step scripts and normalizes extractList fields array into Record<string, Locator>", () => {
    const script = parseActionScript({
      name: "Copy rows",
      steps: [
        { action: "navigate", url: "https://example.com/orders" },
        {
          action: "waitFor",
          target: { kind: "css", value: "table.orders tbody tr" },
          timeoutMs: 4000,
        },
        {
          action: "extractList",
          target: { kind: "css", value: "table.orders tbody tr" },
          bind: "orders",
          fields: [
            { name: "id", locator: { kind: "css", value: ".order-id" } },
            { name: "email", locator: { kind: "css", value: ".customer-email" } },
          ],
        },
        {
          action: "forEach",
          items: "orders",
          steps: [
            {
              action: "fill",
              target: { kind: "css", value: 'input[name="orderId"]' },
              value: "{{id}}",
            },
            {
              action: "click",
              target: { kind: "xpath", value: "//button[contains(., 'Save draft')]" },
              optional: true,
            },
          ],
        },
      ],
    });

    expect(script.steps[2]).toEqual({
      action: "extractList",
      target: { kind: "css", value: "table.orders tbody tr" },
      bind: "orders",
      fields: {
        id: { kind: "css", value: ".order-id" },
        email: { kind: "css", value: ".customer-email" },
      },
    });
  });

  it("rejects malformed LLM outputs via Zod", () => {
    expect(() => parseActionScript({ steps: [] })).toThrow(/steps/i);
    expect(() => parseActionScript({ steps: [{ action: "type", value: "hi" }] })).toThrow(
      /action/i,
    );
    expect(() =>
      parseActionScript({ steps: [{ action: "fill", value: "missing target" }] }),
    ).toThrow(/target/i);
    expect(() => parseActionScript({ steps: [{ action: "navigate", url: "/relative" }] })).toThrow(
      /http\(s\)/i,
    );
    expect(ACTION_SCRIPT_RESPONSE_SCHEMA.required).toContain("steps");
  });
});

describe("Stage 2: implementSolution", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of ["GEMINI_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("passes prompt, systemInstruction, and responseSchema to generator and parses JSON string output", async () => {
    let capturedPrompt = "";
    let capturedSystem = "";

    const script = await implementSolution("Insert 'Approved' into the focused box", {
      name: "Approve snippet",
      generate: async ({ systemInstruction, prompt, responseSchema }) => {
        capturedSystem = systemInstruction;
        capturedPrompt = prompt;
        expect(responseSchema).toBe(ACTION_SCRIPT_RESPONSE_SCHEMA);
        return (
          "```json\n" +
          JSON.stringify({
            steps: [{ action: "insertText", value: "Approved" }],
          }) +
          "\n```"
        );
      },
    });

    expect(capturedSystem).toContain("Implementor");
    expect(capturedPrompt).toContain("Approve snippet");
    expect(capturedPrompt).toContain("Insert 'Approved' into the focused box");
    expect(script).toEqual({
      name: "Approve snippet",
      steps: [{ action: "insertText", value: "Approved" }],
    });
  });

  it("wires into createGeminiClient by default and validates returned ActionScript", async () => {
    const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(async () => ({
      text: JSON.stringify({
        steps: [{ action: "insertText", value: "Thanks, shipping Friday." }],
      }),
    }));
    const sdk: GeminiSdk = { models: { generateContent } };

    const script = await implementSolution("Insert 'Thanks, shipping Friday.' into the reply box", {
      name: "Shipping reply",
      gemini: { sdk },
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    const callArg = generateContent.mock.calls[0]?.[0];
    expect(callArg?.config).toEqual({ responseMimeType: "application/json" });
    expect(callArg?.contents).toContain("You are the Implementor.");
    expect(callArg?.contents).toContain('"required":["steps"]');
    expect(callArg?.contents).toContain("Insert 'Thanks, shipping Friday.' into the reply box");
    expect(script).toEqual({
      name: "Shipping reply",
      steps: [{ action: "insertText", value: "Thanks, shipping Friday." }],
    });
  });

  it("rejects empty solution text, missing credentials, and invalid Gemini outputs", async () => {
    await expect(implementSolution("   ")).rejects.toThrow(/non-empty/);

    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    await expect(implementSolution("Click reply")).rejects.toThrow(/Missing Gemini credentials/);

    const badSdk: GeminiSdk = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({ steps: [{ action: "unknown" }] }),
        }),
      },
    };
    await expect(implementSolution("Click reply", { gemini: { sdk: badSdk } })).rejects.toThrow(
      /schema validation/i,
    );

    await expect(
      implementSolution("Click reply", {
        generate: async () => "not-json",
      }),
    ).rejects.toThrow(/invalid JSON/);
  });
});
