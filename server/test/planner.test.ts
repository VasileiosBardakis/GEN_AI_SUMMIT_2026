import { describe, expect, it, vi } from "vitest";
import type { GeminiSdk } from "../src/llm/gemini.ts";
import {
  buildPlannerPrompt,
  planSolution,
  type Candidate,
} from "../src/plan/planner.ts";

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

function makeRung1Candidate(snippet = "Thanks, your order ships Friday."): Candidate {
  return {
    workflow: {
      id: "wf-reply-snippet",
      name: "Reply shipping snippet",
      sourceApp: "mail.example",
      destApp: "mail.example",
      steps: [
        {
          action: "click",
          target: [{ kind: "testid", value: "reply-box" }],
        },
        {
          action: "fill",
          target: [{ kind: "testid", value: "reply-box" }],
          value: snippet,
        },
      ],
      params: [],
      instances: [
        {
          startTs: 1740000000000,
          endTs: 1740000005000,
          bindings: {},
        },
      ],
    },
    repetitions: 5,
    minutesPerWeek: 10,
    stability: 0.96,
  };
}

function makeRung2Candidate(): Candidate {
  return {
    workflow: {
      id: "wf-invoice-entry",
      name: "Copy invoice from mail to billing",
      sourceApp: "mail.example",
      destApp: "billing.example",
      steps: [
        {
          action: "nav",
          value: "https://billing.example/invoices/new",
        },
        {
          action: "fill",
          target: [{ kind: "css", value: 'input[name="invoice_id"]' }],
          value: { param: "invoice_id" },
        },
        {
          action: "fill",
          target: [{ kind: "aria", value: "Amount" }],
          value: { param: "amount" },
        },
        {
          action: "submit",
          target: [{ kind: "testid", value: "submit-invoice" }],
        },
      ],
      params: [
        { name: "invoice_id", example: "INV-9001-SECRET" },
        { name: "amount", example: "4200.50" },
      ],
      instances: [
        {
          startTs: 1740000100000,
          endTs: 1740000120000,
          bindings: {
            invoice_id: "INV-9001-SECRET",
            amount: "4200.50",
          },
        },
      ],
    },
    repetitions: 8,
    minutesPerWeek: 24,
    stability: 0.92,
  };
}

describe("Brain Planner (buildPlannerPrompt & planSolution)", () => {
  it("plans a rung1 snippet solution using fake GeminiSdk with responseMimeType application/json", async () => {
    const snippet = "Thanks, your order ships Friday.";
    const candidate = makeRung1Candidate(snippet);
    const { sdk, generateContent } = makeFakeSdk(
      JSON.stringify({
        name: "Insert reply snippet",
        solution: `Insert '${snippet}' into the currently focused field.`,
      }),
    );

    const prompt = buildPlannerPrompt(candidate, "rung1");
    expect(prompt).toContain(snippet);
    expect(prompt).toContain("Insert '<snippet>' into the currently focused field.");

    const planned = await planSolution(candidate, "rung1", { sdk });
    expect(planned).toEqual({
      name: "Insert reply snippet",
      solution: "Insert 'Thanks, your order ships Friday.' into the currently focused field.",
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    const call = generateContent.mock.calls[0]?.[0];
    expect(call?.config).toEqual({ responseMimeType: "application/json" });
    expect(call?.contents).toContain(snippet);
  });

  it("plans a rung1 solution when snippetText is supplied via opts", async () => {
    const candidate: Candidate = {
      workflow: {
        id: "wf-empty-steps",
        name: "Focused reply",
        sourceApp: "support.example",
        destApp: "support.example",
        steps: [{ action: "click", target: [{ kind: "aria", value: "Reply" }] }],
        params: [],
        instances: [],
      },
      repetitions: 4,
      minutesPerWeek: 6,
      stability: 0.9,
    };
    const snippet = "Thanks, your order ships Friday.";
    const { sdk, generateContent } = makeFakeSdk(
      JSON.stringify({
        name: "Insert reply snippet",
        solution: `Insert '${snippet}' into the currently focused field.`,
      }),
    );

    const planned = await planSolution(candidate, "rung1", {
      snippetText: snippet,
      sdk,
    });
    expect(planned).toEqual({
      name: "Insert reply snippet",
      solution: `Insert '${snippet}' into the currently focused field.`,
    });
    expect(generateContent.mock.calls[0]?.[0]?.contents).toContain(snippet);
  });

  it("plans a rung2 parameterized multi-step solution preserving {param} placeholders", async () => {
    const candidate = makeRung2Candidate();
    const { sdk, generateContent } = makeFakeSdk(
      JSON.stringify({
        name: "Submit invoice entry",
        solution:
          "Navigate to the billing invoice form, fill the invoice ID input with {invoice_id}, fill the Amount field with {amount}, and submit the form.",
      }),
    );

    const prompt = buildPlannerPrompt(candidate, "rung2");
    expect(prompt).toContain('"invoice_id"');
    expect(prompt).toContain('"amount"');
    expect(prompt).toContain('"locatorKind": "css"');
    expect(prompt).toContain('"locatorKind": "aria"');
    expect(prompt).toContain('"locatorKind": "testid"');

    const planned = await planSolution(candidate, "rung2", { sdk });
    expect(planned.name).toBe("Submit invoice entry");
    expect(planned.solution).toContain("{invoice_id}");
    expect(planned.solution).toContain("{amount}");

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0]?.[0]?.config).toEqual({
      responseMimeType: "application/json",
    });
  });

  it("never leaks literal step values, params[].example, instances[].bindings, or [REDACTED tokens", async () => {
    const secretLiteral = "SUPER-SECRET-TOKEN-999";
    const secretExample = "EXAMPLE-SECRET-444";
    const secretBinding = "BINDING-SECRET-777";
    const redactedToken = "[REDACTED:EMAIL#1]";
    const secretWorkflowName = "WORKFLOW-SECRET-NAME";

    const candidate: Candidate = {
      workflow: {
        id: "wf-privacy",
        name: secretWorkflowName,
        sourceApp: "crm.example",
        destApp: "erp.example",
        steps: [
          {
            action: "nav",
            value: `https://erp.example/${secretLiteral}`,
          },
          {
            action: "fill",
            target: [{ kind: "testid", value: "email-input" }],
            value: redactedToken,
          },
          {
            action: "fill",
            target: [{ kind: "css", value: 'input[name="account_code"]' }],
            value: { param: "account_code" },
          },
          {
            action: "paste",
            target: [{ kind: "aria", value: "Notes" }],
            value: secretLiteral,
          },
        ],
        params: [{ name: "account_code", example: secretExample }],
        instances: [
          {
            startTs: 1740000200000,
            endTs: 1740000220000,
            bindings: { account_code: secretBinding },
          },
        ],
      },
      repetitions: 6,
      minutesPerWeek: 15,
      stability: 0.94,
    };

    const rung2Sdk = makeFakeSdk(
      JSON.stringify({
        name: "Update ERP account",
        solution: "Fill the account code field with {account_code} and submit.",
      }),
    );

    const rung2Prompt = buildPlannerPrompt(candidate, "rung2");
    await planSolution(candidate, "rung2", { sdk: rung2Sdk.sdk });
    const rung2Sent = rung2Sdk.generateContent.mock.calls[0]?.[0]?.contents ?? "";

    for (const p of [rung2Prompt, rung2Sent]) {
      expect(p).not.toContain(secretLiteral);
      expect(p).not.toContain(secretExample);
      expect(p).not.toContain(secretBinding);
      expect(p).not.toContain(redactedToken);
      expect(p).not.toContain("[REDACTED");
      expect(p).not.toContain(secretWorkflowName);
      expect(p).not.toContain("email-input");
    }

    const safeSnippet = "Thanks, your order ships Friday.";
    const rung1Sdk = makeFakeSdk(
      JSON.stringify({
        name: "Insert reply snippet",
        solution: `Insert '${safeSnippet}' into the currently focused field.`,
      }),
    );

    const rung1Prompt = buildPlannerPrompt(candidate, "rung1", safeSnippet);
    await planSolution(candidate, "rung1", {
      snippetText: safeSnippet,
      sdk: rung1Sdk.sdk,
    });
    const rung1Sent = rung1Sdk.generateContent.mock.calls[0]?.[0]?.contents ?? "";

    for (const p of [rung1Prompt, rung1Sent]) {
      expect(p).toContain(safeSnippet);
      expect(p).not.toContain(secretLiteral);
      expect(p).not.toContain(secretExample);
      expect(p).not.toContain(secretBinding);
      expect(p).not.toContain(redactedToken);
      expect(p).not.toContain("[REDACTED");
      expect(p).not.toContain(secretWorkflowName);
    }
  });

  it("rejects unsupported verdicts, missing or redacted rung1 snippets, and empty/malformed SDK JSON", async () => {
    const rung2Candidate = makeRung2Candidate();
    const { sdk: validSdk } = makeFakeSdk(
      JSON.stringify({ name: "Test", solution: "Do thing" }),
    );

    await expect(planSolution(rung2Candidate, "rung0", { sdk: validSdk })).rejects.toThrow(
      /rung0.*rung1.*rung2/i,
    );
    await expect(planSolution(rung2Candidate, "rung3", { sdk: validSdk })).rejects.toThrow(
      /rung3.*rung1.*rung2/i,
    );
    await expect(
      planSolution(rung2Candidate, "do_not_automate", { sdk: validSdk }),
    ).rejects.toThrow(/do_not_automate.*rung1.*rung2/i);

    const noSnippetCandidate: Candidate = {
      workflow: {
        id: "wf-no-literal",
        name: "No literal step",
        sourceApp: "app.example",
        destApp: "app.example",
        steps: [
          { action: "click", target: [{ kind: "testid", value: "btn" }] },
          { action: "fill", value: { param: "code" } },
        ],
        params: [{ name: "code", example: "ABC" }],
        instances: [],
      },
      repetitions: 3,
      minutesPerWeek: 5,
      stability: 0.9,
    };

    await expect(planSolution(noSnippetCandidate, "rung1", { sdk: validSdk })).rejects.toThrow(
      /snippet/i,
    );
    await expect(
      planSolution(noSnippetCandidate, "rung1", { snippetText: "   ", sdk: validSdk }),
    ).rejects.toThrow(/snippet/i);
    await expect(
      planSolution(noSnippetCandidate, "rung1", {
        snippetText: "Reach me at [REDACTED:EMAIL#1]",
        sdk: validSdk,
      }),
    ).rejects.toThrow(/redacted/i);

    const emptySdk = makeFakeSdk("");
    await expect(planSolution(rung2Candidate, "rung2", { sdk: emptySdk.sdk })).rejects.toThrow(
      /empty/i,
    );

    const malformedSdk = makeFakeSdk("{not-json");
    await expect(
      planSolution(rung2Candidate, "rung2", { sdk: malformedSdk.sdk }),
    ).rejects.toThrow(/malformed JSON/i);

    const blankFieldSdk = makeFakeSdk(JSON.stringify({ name: "   ", solution: "Click" }));
    await expect(
      planSolution(rung2Candidate, "rung2", { sdk: blankFieldSdk.sdk }),
    ).rejects.toThrow(/schema validation/i);
  });
});
