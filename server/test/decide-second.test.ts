import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDigest,
  decideSecond,
  DEFAULT_SECOND_TIMEOUT_MS,
  type Candidate,
  type WorkflowDigest,
} from "../src/decide/second.ts";
import type { GeminiSdk } from "../src/llm/gemini.ts";
import type { IrisClient, IrisQuestions, IrisState } from "../src/llm/iris.ts";

const ENV_KEYS = [
  "OUMI_API_KEY",
  "OUMI_PROJECT_ID",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of ENV_KEYS) {
    const val = originalEnv[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

function makeSampleDigest(
  overrides: Partial<WorkflowDigest> = {},
): WorkflowDigest {
  return {
    id: "wf-crm-copy",
    sourceApp: "sheets.google.com",
    destApp: "crm.internal",
    steps: [
      { action: "copy", locatorKind: "testid" },
      { action: "fill", locatorKind: "aria" },
      { action: "submit", locatorKind: null },
    ],
    paramNames: ["account_id"],
    repetitions: 5,
    stability: 0.78,
    features: { crossApp: 1, stepCount: 3 },
    ...overrides,
  };
}

describe("buildDigest", () => {
  it("strips private values, names, examples, bindings, and redacted tokens", () => {
    const candidate: Candidate = {
      workflow: {
        id: "wf-invoice-sync",
        name: "Private Workflow Name [REDACTED:SECRET#1]",
        sourceApp: "sheets.google.com",
        destApp: "erp.internal",
        steps: [
          {
            action: "copy",
            target: [{ kind: "testid", value: "secret-cell-b4" }],
            value: "literal-secret-typed-value",
          },
          {
            action: "fill",
            target: [
              { kind: "aria", value: "Customer Email" },
              { kind: "css", value: "#email-input" },
            ],
            value: "<email>",
          },
          {
            action: "paste",
            target: [{ kind: "css", value: "#phone-input" }],
            value: "<phone>",
          },
          {
            action: "submit",
            value: "[REDACTED:SECRET#1]",
          },
          {
            action: "click",
            target: [],
          },
        ],
        params: [
          { name: "customer_email", example: "alice@private.example" },
          { name: "phone_number", example: "+1-555-0199" },
          { name: "api_secret", example: "[REDACTED:SECRET#1]" },
        ],
        instances: [
          {
            startTs: 1000,
            endTs: 5000,
            bindings: {
              customer_email: "bob@secret.example",
              phone_number: "+1-555-0100",
              api_secret: "sk-secret-instance-binding",
            },
          },
        ],
      },
      repetitions: 4,
      minutesPerWeek: 15,
      stability: 0.74,
    };

    const digest = buildDigest(candidate, { crossApp: 1, stepCount: 5 });

    expect(Object.keys(digest).sort()).toEqual([
      "destApp",
      "features",
      "id",
      "paramNames",
      "repetitions",
      "sourceApp",
      "stability",
      "steps",
    ]);
    expect(digest).toEqual({
      id: "wf-invoice-sync",
      sourceApp: "sheets.google.com",
      destApp: "erp.internal",
      steps: [
        { action: "copy", locatorKind: "testid" },
        { action: "fill", locatorKind: "aria" },
        { action: "paste", locatorKind: "css" },
        { action: "submit", locatorKind: null },
        { action: "click", locatorKind: null },
      ],
      paramNames: ["customer_email", "phone_number", "api_secret"],
      repetitions: 4,
      stability: 0.74,
      features: { crossApp: 1, stepCount: 5 },
    });

    for (const step of digest.steps) {
      expect(Object.keys(step).sort()).toEqual(["action", "locatorKind"]);
    }

    const serialized = JSON.stringify(digest);
    for (const forbidden of [
      "Private Workflow Name",
      "literal-secret-typed-value",
      "secret-cell-b4",
      "Customer Email",
      "#email-input",
      "#phone-input",
      "alice@private.example",
      "bob@secret.example",
      "+1-555-0199",
      "+1-555-0100",
      "sk-secret-instance-binding",
      "[REDACTED",
      "<email>",
      "<phone>",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(buildDigest(candidate).features).toEqual({});
  });
});

describe("decideSecond", () => {
  it("uses Iris first with closed questions and digest, returning source: iris", async () => {
    const digest = makeSampleDigest();
    let capturedState: IrisState | undefined;
    let capturedQuestions: IrisQuestions | undefined;

    const fakeIris: IrisClient = {
      async ask(state, questions) {
        capturedState = state;
        capturedQuestions = questions;
        return {
          model: "projects/test/models/iris-latest",
          answers: {
            level: {
              choice: "rung1",
              probabilities: {
                rung0: 0.1,
                rung1: 0.75,
                rung2: 0.1,
                do_not_automate: 0.05,
              },
              confidence: 0.85,
            },
            risky: {
              choice: "no",
              probabilities: { yes: 0.1, no: 0.9 },
              confidence: 0.9,
            },
            confidence: {
              score: 2,
              probabilities: { low: 0.05, medium: 0.15, high: 0.8 },
              legend: { low: "Low", medium: "Medium", high: "High" },
              confidence: 0.82,
            },
          },
          usage: { inputTokens: 120, outputTokens: 20 },
        };
      },
    };

    const result = await decideSecond(digest, { iris: fakeIris });

    expect(result).toEqual({
      level: "rung1",
      risky: false,
      confidence: 1,
      source: "iris",
    });
    expect(capturedState).toEqual(digest);
    expect(capturedQuestions?.level.type).toBe("choice");
    expect(capturedQuestions?.risky.type).toBe("choice");
    expect(capturedQuestions?.confidence).toMatchObject({
      type: "score",
      criteria: ["low", "medium", "high"],
    });
  });

  it("falls back to Gemini when Iris credentials are not configured", async () => {
    delete process.env.OUMI_API_KEY;
    delete process.env.OUMI_PROJECT_ID;

    const digest = makeSampleDigest();
    const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(
      async () => ({
        text: JSON.stringify({
          level: "rung2",
          risky: true,
          confidence: 0.78,
        }),
      }),
    );
    const sdk: GeminiSdk = { models: { generateContent } };

    const result = await decideSecond(digest, { sdk });

    expect(result).toEqual({
      level: "rung2",
      risky: true,
      confidence: 0.78,
      source: "gemini",
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
    const call = generateContent.mock.calls[0]?.[0];
    expect(call?.config).toEqual({ responseMimeType: "application/json" });
    expect(call?.contents).toContain(JSON.stringify(digest));
  });

  it("falls back to Gemini when Iris returns an HTTP 503 error", async () => {
    const digest = makeSampleDigest();
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response("upstream unavailable", { status: 503 });

    const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(
      async () => ({
        text: JSON.stringify({
          level: "do_not_automate",
          risky: true,
          confidence: 0.91,
        }),
      }),
    );
    const sdk: GeminiSdk = { models: { generateContent } };

    const result = await decideSecond(digest, {
      irisOptions: {
        apiKey: "test-key",
        projectId: "test-project",
        fetch: fakeFetch,
      },
      sdk,
    });

    expect(result).toEqual({
      level: "do_not_automate",
      risky: true,
      confidence: 0.91,
      source: "gemini",
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("returns null when both Iris and Gemini fail or return invalid JSON/schema", async () => {
    const digest = makeSampleDigest();

    // Missing both Iris and Gemini credentials
    delete process.env.OUMI_API_KEY;
    delete process.env.OUMI_PROJECT_ID;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    await expect(decideSecond(digest)).resolves.toBeNull();

    // Iris fails with invalid answer shape and Gemini returns malformed JSON
    const badShapeIris: IrisClient = {
      async ask() {
        return {
          model: "iris-latest",
          answers: {
            level: {
              choice: "unknown_rung",
              probabilities: {},
              confidence: 0.5,
            },
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };
    const malformedSdk: GeminiSdk = {
      models: {
        generateContent: async () => ({ text: "{not valid json" }),
      },
    };
    await expect(
      decideSecond(digest, { iris: badShapeIris, sdk: malformedSdk }),
    ).resolves.toBeNull();

    // Iris throws and Gemini fails schema validation
    const throwingIris: IrisClient = {
      async ask() {
        throw new Error("Iris failure");
      },
    };
    const badSchemaSdk: GeminiSdk = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({ level: "rung1", risky: "yes", confidence: 2 }),
        }),
      },
    };
    await expect(
      decideSecond(digest, { iris: throwingIris, sdk: badSchemaSdk }),
    ).resolves.toBeNull();
  });

  it("enforces DEFAULT_SECOND_TIMEOUT_MS = 8000 and returns null on timeout", async () => {
    expect(DEFAULT_SECOND_TIMEOUT_MS).toBe(8000);

    const digest = makeSampleDigest();
    const geminiSpy = vi.fn<GeminiSdk["models"]["generateContent"]>(
      async () => ({
        text: JSON.stringify({ level: "rung1", risky: false, confidence: 0.8 }),
      }),
    );

    const slowIris: IrisClient = {
      async ask() {
        await new Promise((resolve) => setTimeout(resolve, 150));
        throw new Error("slow iris failure");
      },
    };

    const started = Date.now();
    const result = await decideSecond(digest, {
      iris: slowIris,
      sdk: { models: { generateContent: geminiSpy } },
      timeoutMs: 25,
    });
    const elapsed = Date.now() - started;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(120);

    // Ensure delayed rejection from Iris does not trigger Gemini after timeout
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(geminiSpy).not.toHaveBeenCalled();
  });
});
