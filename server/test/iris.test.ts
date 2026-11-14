import { afterEach, describe, expect, it } from "vitest";
import {
  IRIS_ENDPOINT,
  createIrisClient,
  type IrisQuestions,
  type IrisState,
} from "../src/llm/iris.ts";

const originalApiKey = process.env.OUMI_API_KEY;
const originalProjectId = process.env.OUMI_PROJECT_ID;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.OUMI_API_KEY;
  } else {
    process.env.OUMI_API_KEY = originalApiKey;
  }
  if (originalProjectId === undefined) {
    delete process.env.OUMI_PROJECT_ID;
  } else {
    process.env.OUMI_PROJECT_ID = originalProjectId;
  }
});

const state: IrisState = {
  screen: "checkout",
  attempt: 2,
  error: "card declined",
};

const questions: IrisQuestions = {
  stuck: {
    type: "noul",
    instructions: "Is the user stuck on this step?",
    criteria: {
      true: "The same error keeps blocking progress.",
      false: "Progress is possible.",
    },
  },
  nextAction: {
    type: "choice",
    instructions: "What should the planner do next?",
    criteria: {
      retry: "Try the same action again.",
      help: "Offer contextual help.",
    },
  },
  confidence: {
    type: "score",
    instructions: "Rate how confident the plan is.",
    criteria: ["low", "medium", "high"],
  },
};

const validPayload = {
  model: "projects/test-project/models/iris-latest",
  answers: {
    stuck: { noul: 0.72 },
    nextAction: {
      choice: "help",
      probabilities: { retry: 0.2, help: 0.8 },
      confidence: 0.91,
    },
    confidence: {
      score: 2,
      probabilities: { low: 0.1, medium: 0.2, high: 0.7 },
      legend: { low: "Low", medium: "Medium", high: "High" },
      confidence: 0.88,
    },
  },
  usage: { inputTokens: 321, outputTokens: 45 },
};

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createIrisClient", () => {
  it("POSTs the model, state and questions and returns validated answers", async () => {
    const calls: FetchCall[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return jsonResponse(validPayload);
    };

    const iris = createIrisClient({
      apiKey: "test-key",
      projectId: "test-project",
      fetch: fakeFetch,
    });
    const response = await iris.ask(state, questions);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.input).toBe(IRIS_ENDPOINT);
    expect(call.input).toBe("https://inference.oumi.ai/v1/systemone");
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      model: "projects/test-project/models/iris-latest",
      state,
      questions,
    });

    expect(response).toEqual(validPayload);
    expect(response.answers.stuck).toEqual({ noul: 0.72 });
    expect(response.answers.nextAction).toEqual({
      choice: "help",
      probabilities: { retry: 0.2, help: 0.8 },
      confidence: 0.91,
    });
    expect(response.answers.confidence).toEqual({
      score: 2,
      probabilities: { low: 0.1, medium: 0.2, high: 0.7 },
      legend: { low: "Low", medium: "Medium", high: "High" },
      confidence: 0.88,
    });
    expect(response.usage).toEqual({ inputTokens: 321, outputTokens: 45 });
  });

  it("throws with the HTTP status and response text on non-2xx responses", async () => {
    const apiKey = "super-secret-key";
    const fakeFetch = async () =>
      new Response("upstream unavailable", { status: 503 });

    const iris = createIrisClient({
      apiKey,
      projectId: "test-project",
      fetch: fakeFetch,
    });

    let error: unknown;
    try {
      await iris.ask(state, questions);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("503");
    expect(message).toContain("upstream unavailable");
    expect(message).not.toContain(apiKey);
  });

  it("rejects response payloads that fail Zod validation", async () => {
    const fakeFetch = async () =>
      jsonResponse({
        ...validPayload,
        answers: {
          stuck: { noul: 2 },
        },
      });

    const iris = createIrisClient({
      apiKey: "test-key",
      projectId: "test-project",
      fetch: fakeFetch,
    });

    await expect(iris.ask(state, questions)).rejects.toBeInstanceOf(Error);
  });

  it("throws an error naming OUMI_API_KEY when the key is missing", () => {
    delete process.env.OUMI_API_KEY;

    expect(() => createIrisClient({ projectId: "test-project" })).toThrow(
      /OUMI_API_KEY/,
    );
  });

  it("throws an error naming OUMI_PROJECT_ID when the project id is missing", () => {
    delete process.env.OUMI_PROJECT_ID;

    expect(() =>
      createIrisClient({ apiKey: "test-key", projectId: "  " }),
    ).toThrow(/OUMI_PROJECT_ID/);
  });

  it("falls back to process.env when options omit the credentials", async () => {
    process.env.OUMI_API_KEY = "env-key";
    process.env.OUMI_PROJECT_ID = "env-project";

    let capturedInit: RequestInit | undefined;
    const fakeFetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedInit = init;
      return jsonResponse(validPayload);
    };

    const iris = createIrisClient({ fetch: fakeFetch });
    const response = await iris.ask(state, questions);

    expect(response.usage).toEqual({ inputTokens: 321, outputTokens: 45 });
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("env-key");
    expect(JSON.parse(String(capturedInit?.body)).model).toBe(
      "projects/env-project/models/iris-latest",
    );
  });
});
