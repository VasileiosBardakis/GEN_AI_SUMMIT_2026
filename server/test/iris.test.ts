import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OUMI_PROJECT_ID,
  IRIS_ENDPOINT,
  IRIS_TIMEOUT_MS,
  createIrisClient,
  judgeRecallIris,
  judgeWorkflowIris,
  type IrisQuestions,
  type IrisState,
} from "../src/llm/iris.ts";

const originalApiKey = process.env.OUMI_API_KEY;
const originalProjectId = process.env.OUMI_PROJECT_ID;
const originalHome = process.env.HOME;

let tempHomes: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "iris-test-home-"));
  tempHomes.push(dir);
  return dir;
}

function restoreEnv(): void {
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
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
}

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
  for (const dir of tempHomes) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempHomes = [];
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
  beforeEach(() => {
    process.env.HOME = makeTempHome();
  });
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

describe("judgeWorkflowIris & judgeRecallIris", () => {
  beforeEach(() => {
    delete process.env.OUMI_API_KEY;
    delete process.env.OUMI_PROJECT_ID;
    process.env.HOME = makeTempHome();
  });

  it("exposes DEFAULT_OUMI_PROJECT_ID and IRIS_TIMEOUT_MS", () => {
    expect(DEFAULT_OUMI_PROJECT_ID).toBe("7HBTQDVH6J-30");
    expect(IRIS_TIMEOUT_MS).toBe(1500);
  });

  it("auto-loads OUMI_API_KEY from envPath and uses DEFAULT_OUMI_PROJECT_ID", async () => {
    const tempDir = makeTempHome();
    const envPath = path.join(tempDir, "oumi.env");
    writeFileSync(envPath, 'export OUMI_API_KEY="file-secret-key"\n', "utf8");

    const calls: FetchCall[] = [];
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({
        model: "projects/7HBTQDVH6J-30/models/iris-latest",
        answers: {
          worthAutomating: { noul: 0.88 },
          pauseBeforeSubmit: { noul: 0.12 },
        },
        usage: { inputTokens: 100, outputTokens: 20 },
      });
    };

    const result = await judgeWorkflowIris(
      {
        sourceApp: "sheets.google.com",
        destApp: "crm.internal",
        repetitions: 5,
        steps: [
          { action: "copy", label: "Customer Name" },
          { action: "fill", label: "Account Name" },
          { action: "click", label: "Save draft" },
        ],
      },
      { envPath, fetch: fakeFetch },
    );

    expect(result).toEqual({
      worthAutomating: true,
      pauseBeforeSubmit: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(IRIS_ENDPOINT);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("file-secret-key");
    const parsedBody = JSON.parse(String(calls[0]?.init?.body));
    expect(parsedBody.model).toBe("projects/7HBTQDVH6J-30/models/iris-latest");
    expect(Object.keys(parsedBody.questions).sort()).toEqual([
      "pauseBeforeSubmit",
      "worthAutomating",
    ]);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("auto-loads from ~/.config/oumi/env when HOME has credentials and envPath is omitted", async () => {
    const homeDir = process.env.HOME!;
    const configDir = path.join(homeDir, ".config", "oumi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "env"),
      "OUMI_API_KEY=home-env-key\n",
      "utf8",
    );

    const calls: FetchCall[] = [];
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({
        model: "projects/7HBTQDVH6J-30/models/iris-latest",
        answers: {
          worthAutomating: { noul: 0.9 },
          pauseBeforeSubmit: { noul: 0.85 },
        },
        usage: { inputTokens: 80, outputTokens: 12 },
      });
    };

    const result = await judgeWorkflowIris(
      {
        steps: [
          { action: "fill", label: "Recipient" },
          { action: "click", label: "Send" },
        ],
      },
      { fetch: fakeFetch },
    );

    expect(result).toEqual({
      worthAutomating: true,
      pauseBeforeSubmit: true,
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("home-env-key");
  });

  it("returns pauseBeforeSubmit: true for risky final click like Send or Pay", async () => {
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.state).toEqual({
        app: "bank.example",
        steps: [
          { action: "fill", label: "Amount" },
          { action: "click", label: "Pay" },
        ],
      });
      return jsonResponse({
        model: "projects/7HBTQDVH6J-30/models/iris-latest",
        answers: {
          worthAutomating: { noul: 0.76 },
          pauseBeforeSubmit: { noul: 0.94 },
        },
        usage: { inputTokens: 95, outputTokens: 16 },
      });
    };

    const result = await judgeWorkflowIris(
      {
        app: "bank.example",
        steps: [
          { action: "fill", label: "Amount" },
          { action: "click", label: "Pay" },
        ],
      },
      { apiKey: "test-key", fetch: fakeFetch },
    );

    expect(result).toEqual({
      worthAutomating: true,
      pauseBeforeSubmit: true,
    });
  });

  it("falls back to GET /v1/organizations then GET /v1/projects when default project returns 404", async () => {
    const calls: FetchCall[] = [];
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      if (
        input === IRIS_ENDPOINT &&
        JSON.parse(String(init?.body)).model ===
          "projects/7HBTQDVH6J-30/models/iris-latest"
      ) {
        return new Response("project not found", { status: 404 });
      }
      if (input === "https://inference.oumi.ai/v1/organizations") {
        return jsonResponse([{ id: "org-abc" }]);
      }
      if (input === "https://inference.oumi.ai/v1/projects") {
        return jsonResponse({
          projects: [
            { id: "proj-discovered-99", organization_id: "org-abc" },
          ],
        });
      }
      if (
        input === IRIS_ENDPOINT &&
        JSON.parse(String(init?.body)).model ===
          "projects/proj-discovered-99/models/iris-latest"
      ) {
        return jsonResponse({
          model: "projects/proj-discovered-99/models/iris-latest",
          answers: {
            worthAutomating: { noul: 0.7 },
            pauseBeforeSubmit: { noul: 0.2 },
          },
          usage: { inputTokens: 90, outputTokens: 15 },
        });
      }
      return new Response("unexpected call", { status: 500 });
    };

    const result = await judgeWorkflowIris(
      { steps: [{ action: "click", label: "Save" }] },
      { apiKey: "disc-key", fetch: fakeFetch },
    );

    expect(result).toEqual({
      worthAutomating: true,
      pauseBeforeSubmit: false,
    });
    expect(calls.map((c) => c.input)).toEqual([
      IRIS_ENDPOINT,
      "https://inference.oumi.ai/v1/organizations",
      "https://inference.oumi.ai/v1/projects",
      IRIS_ENDPOINT,
    ]);
    expect(calls[1]?.init?.method).toBe("GET");
    expect((calls[1]?.init?.headers as Record<string, string>)["X-API-Key"]).toBe(
      "disc-key",
    );
    expect(calls[2]?.init?.method).toBe("GET");
    expect((calls[2]?.init?.headers as Record<string, string>)["X-API-Key"]).toBe(
      "disc-key",
    );
  });

  it("returns null within 1.6 s when fetch hangs >1500 ms", async () => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const hungFetch: typeof globalThis.fetch = async () =>
      new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          resolve(jsonResponse({}));
        }, 5000);
        timer.unref?.();
        timers.push(timer);
      });

    const started = Date.now();
    const result = await judgeWorkflowIris(
      { steps: [{ action: "click", label: "Save" }] },
      { apiKey: "test-key", fetch: hungFetch },
    );
    const elapsed = Date.now() - started;

    for (const timer of timers) {
      clearTimeout(timer);
    }

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(1600);
  });

  it("returns null without leaking secrets when key is missing or HTTP/parse fails", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    const missingKeyResult = await judgeWorkflowIris(
      { steps: [] },
      { fetch: fetchSpy },
    );
    expect(missingKeyResult).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    const secretKey = "oumi-secret-do-not-leak";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const httpErrorFetch: typeof globalThis.fetch = async () =>
      new Response("internal server error", { status: 500 });
    await expect(
      judgeWorkflowIris(
        { steps: [] },
        { apiKey: secretKey, fetch: httpErrorFetch },
      ),
    ).resolves.toBeNull();

    const invalidJsonFetch: typeof globalThis.fetch = async () =>
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await expect(
      judgeWorkflowIris(
        { steps: [] },
        { apiKey: secretKey, fetch: invalidJsonFetch },
      ),
    ).resolves.toBeNull();

    const invalidSchemaFetch: typeof globalThis.fetch = async () =>
      jsonResponse({
        model: "projects/7HBTQDVH6J-30/models/iris-latest",
        answers: {
          worthAutomating: { noul: 0.8 },
          // missing pauseBeforeSubmit
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    await expect(
      judgeWorkflowIris(
        { steps: [] },
        { apiKey: secretKey, fetch: invalidSchemaFetch },
      ),
    ).resolves.toBeNull();

    const networkErrorFetch: typeof globalThis.fetch = async () => {
      throw new Error(`network fail with ${secretKey}`);
    };
    await expect(
      judgeWorkflowIris(
        { steps: [] },
        { apiKey: secretKey, fetch: networkErrorFetch },
      ),
    ).resolves.toBeNull();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("judgeRecallIris returns { match: true/false } and null on errors/timeout", async () => {
    const matchTrueFetch: typeof globalThis.fetch = async (input, init) => {
      expect(input).toBe(IRIS_ENDPOINT);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("projects/7HBTQDVH6J-30/models/iris-latest");
      expect(Object.keys(body.questions)).toEqual(["match"]);
      return jsonResponse({
        model: "projects/7HBTQDVH6J-30/models/iris-latest",
        answers: { match: { noul: 0.84 } },
        usage: { inputTokens: 60, outputTokens: 10 },
      });
    };
    await expect(
      judgeRecallIris(
        { currentApp: "crm.internal", savedWorkflow: "Sync CRM account" },
        { apiKey: "test-key", fetch: matchTrueFetch },
      ),
    ).resolves.toEqual({ match: true });

    const matchFalseFetch: typeof globalThis.fetch = async () =>
      jsonResponse({
        model: "projects/7HBTQDVH6J-30/models/iris-latest",
        answers: { match: { noul: 0.21 } },
        usage: { inputTokens: 60, outputTokens: 10 },
      });
    await expect(
      judgeRecallIris(
        { currentApp: "news.example", savedWorkflow: "Sync CRM account" },
        { apiKey: "test-key", fetch: matchFalseFetch },
      ),
    ).resolves.toEqual({ match: false });

    const httpErrorFetch: typeof globalThis.fetch = async () =>
      new Response("bad gateway", { status: 502 });
    await expect(
      judgeRecallIris(
        { currentApp: "crm.internal" },
        { apiKey: "test-key", fetch: httpErrorFetch },
      ),
    ).resolves.toBeNull();

    const hungTimers: ReturnType<typeof setTimeout>[] = [];
    const hungFetch: typeof globalThis.fetch = async () =>
      new Promise<Response>((resolve) => {
        const t = setTimeout(() => resolve(jsonResponse({})), 5000);
        t.unref?.();
        hungTimers.push(t);
      });
    const started = Date.now();
    await expect(
      judgeRecallIris(
        { currentApp: "crm.internal" },
        { apiKey: "test-key", fetch: hungFetch },
      ),
    ).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1600);
    for (const t of hungTimers) {
      clearTimeout(t);
    }
  });
});

describe.skipIf(!process.env.OUMI_LIVE)("Oumi Iris live smoke", () => {
  it("judges workflow and recall against live Iris endpoint", async () => {
    restoreEnv();

    const wfResult = await judgeWorkflowIris(
      {
        sourceApp: "sheets.google.com",
        destApp: "crm.internal",
        repetitions: 5,
        steps: [
          { action: "copy", label: "Customer email" },
          { action: "fill", label: "Email" },
          { action: "click", label: "Send invoice" },
        ],
      },
      { timeoutMs: 5000 },
    );
    expect(wfResult).not.toBeNull();
    expect(typeof wfResult?.worthAutomating).toBe("boolean");
    expect(typeof wfResult?.pauseBeforeSubmit).toBe("boolean");

    const recallResult = await judgeRecallIris(
      {
        currentPage: "crm.internal/accounts",
        candidateWorkflow: "Copy customer row from Google Sheets to CRM",
      },
      { timeoutMs: 5000 },
    );
    expect(recallResult).not.toBeNull();
    expect(typeof recallResult?.match).toBe("boolean");
  });
});
