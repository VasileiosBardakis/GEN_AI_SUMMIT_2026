import { describe, expect, it } from "vitest";
import { implementSolution } from "../../src/hands/implementor.ts";
import { ACTION_SCRIPT_RESPONSE_SCHEMA, parseActionScript } from "../../src/hands/types.ts";

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

  it("rejects malformed LLM outputs", () => {
    expect(() => parseActionScript({ steps: [] })).toThrow(/non-empty/);
    expect(() => parseActionScript({ steps: [{ action: "type", value: "hi" }] })).toThrow(
      /unsupported/,
    );
    expect(() =>
      parseActionScript({ steps: [{ action: "fill", value: "missing target" }] }),
    ).toThrow(/target/);
    expect(() => parseActionScript({ steps: [{ action: "navigate", url: "/relative" }] })).toThrow(
      /http\(s\)/,
    );
    expect(ACTION_SCRIPT_RESPONSE_SCHEMA.required).toContain("steps");
  });
});

describe("Stage 2: implementSolution", () => {
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
    expect(capturedSystem).toContain("Stop BEFORE irreversible actions");
    expect(capturedPrompt).toContain("Approve snippet");
    expect(capturedPrompt).toContain("Insert 'Approved' into the focused box");
    expect(script).toEqual({
      name: "Approve snippet",
      steps: [{ action: "insertText", value: "Approved" }],
    });
  });

  it("rejects empty solution text and invalid JSON from generator", async () => {
    await expect(implementSolution("   ")).rejects.toThrow(/non-empty/);
    await expect(
      implementSolution("Click reply", {
        generate: async () => "not-json",
      }),
    ).rejects.toThrow(/invalid JSON/);
  });
});
