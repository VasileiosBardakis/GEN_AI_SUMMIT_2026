import { describe, expect, it } from "vitest";
import { implementSolution, implementSolutionWithSafety } from "../../src/hands/implementor.ts";
import { sanitizeActionScript } from "../../src/hands/safety.ts";
import type { ActionScript } from "../../src/hands/types.ts";

describe("Stage 3: sanitizeActionScript safety policy", () => {
  it("strips irreversible clicks (Send, Submit, Delete, Pay) while keeping safe steps", () => {
    const raw: ActionScript = {
      name: "Reply to supplier",
      steps: [
        { action: "click", target: { kind: "xpath", value: "//button[contains(., 'Reply')]" } },
        { action: "insertText", value: "Thanks, shipping Friday." },
        { action: "click", target: { kind: "text", value: "Send" } },
        { action: "click", target: { kind: "css", value: 'button[type="submit"]' } },
        { action: "click", target: { kind: "aria", value: "Delete draft" } },
        { action: "click", target: { kind: "text", value: "Pay Now" } },
      ],
    };

    const { script, blockedSteps } = sanitizeActionScript(raw);
    expect(script).toEqual({
      name: "Reply to supplier",
      steps: [
        { action: "click", target: { kind: "xpath", value: "//button[contains(., 'Reply')]" } },
        { action: "insertText", value: "Thanks, shipping Friday." },
      ],
    });
    expect(blockedSteps).toHaveLength(4);
    expect(blockedSteps.map((b) => b.reason)).toEqual([
      'Blocked irreversible click target "Send"',
      'Blocked irreversible click target "button[type="submit"]"',
      'Blocked irreversible click target "Delete draft"',
      'Blocked irreversible click target "Pay Now"',
    ]);
  });

  it("blocks password/payment fields and redacted secret values", () => {
    const raw: ActionScript = {
      steps: [
        {
          action: "fill",
          target: { kind: "css", value: 'input[type="email"]' },
          value: "user@example.com",
        },
        {
          action: "fill",
          target: { kind: "css", value: 'input[type="password"]' },
          value: "hunter2",
        },
        {
          action: "insertText",
          target: { kind: "css", value: "#cvv" },
          value: "123",
        },
        {
          action: "insertText",
          value: "[REDACTED:PASSWORD#h_1234abcd]",
        },
      ],
    };

    const { script, blockedSteps } = sanitizeActionScript(raw);
    expect(script.steps).toEqual([
      {
        action: "fill",
        target: { kind: "css", value: 'input[type="email"]' },
        value: "user@example.com",
      },
    ]);
    expect(blockedSteps).toHaveLength(3);
  });

  it("sanitizes nested forEach steps and drops empty forEach loops", () => {
    const raw: ActionScript = {
      steps: [
        {
          action: "forEach",
          items: "rows",
          steps: [
            {
              action: "fill",
              target: { kind: "css", value: 'input[name="note"]' },
              value: "{{note}}",
            },
            {
              action: "click",
              target: { kind: "text", value: "Confirm" },
            },
          ],
        },
        {
          action: "forEach",
          items: "onlyDeletes",
          steps: [{ action: "click", target: { kind: "text", value: "Delete" } }],
        },
      ],
    };

    const { script, blockedSteps } = sanitizeActionScript(raw);
    expect(script.steps).toEqual([
      {
        action: "forEach",
        items: "rows",
        steps: [
          {
            action: "fill",
            target: { kind: "css", value: 'input[name="note"]' },
            value: "{{note}}",
          },
        ],
      },
    ]);
    expect(blockedSteps).toHaveLength(2);
  });

  it("integrates into implementSolutionWithSafety and implementSolution", async () => {
    const { script, blockedSteps } = await implementSolutionWithSafety("Reply and send", {
      generate: async () => ({
        steps: [
          { action: "insertText", value: "Approved" },
          { action: "click", target: { kind: "text", value: "Send" } },
        ],
      }),
    });

    expect(script.steps).toEqual([{ action: "insertText", value: "Approved" }]);
    expect(blockedSteps).toHaveLength(1);

    await expect(
      implementSolution("Click Send", {
        generate: async () => ({
          steps: [{ action: "click", target: { kind: "text", value: "Send" } }],
        }),
      }),
    ).rejects.toThrow(/All steps blocked by safety policy/);
  });
});
