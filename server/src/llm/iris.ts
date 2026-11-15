/**
 * Oumi Iris HTTP client for the M1 Brain planner.
 *
 * Iris evaluates a workflow state against a set of decision questions. Provide
 * credentials via the environment:
 *
 *   OUMI_API_KEY=...      API key for the Oumi inference service.
 *   OUMI_PROJECT_ID=...   Project id from the Oumi hackathon dashboard
 *                         (https://labs.oumi.ai/hackathon-village/genai-summit-athens-2026).
 *
 * Both values can also be passed explicitly to `createIrisClient`. Credentials
 * are never logged or included in error messages.
 *
 * Example:
 *
 *   import { createIrisClient } from "./iris.ts";
 *
 *   const iris = createIrisClient();
 *   const response = await iris.ask(
 *     { screen: "checkout", attempt: 2, error: "card declined" },
 *     {
 *       stuck: {
 *         type: "noul",
 *         instructions: "Is the user stuck on this step?",
 *         criteria: { true: "The same error keeps blocking progress.", false: "Progress is possible." },
 *       },
 *       nextAction: {
 *         type: "choice",
 *         instructions: "What should the planner do next?",
 *         criteria: { retry: "Try the same action again.", help: "Offer contextual help." },
 *       },
 *       confidence: {
 *         type: "score",
 *         instructions: "Rate how confident the plan is.",
 *         criteria: ["low", "medium", "high"],
 *       },
 *     },
 *   );
 *
 *   response.answers.stuck; // { noul: number }
 *   response.answers.nextAction; // { choice, probabilities, confidence }
 *   response.answers.confidence; // { score, probabilities, legend, confidence }
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "../../../shared/node_modules/zod/index.js";

export const IRIS_ENDPOINT = "https://inference.oumi.ai/v1/systemone";
export const OUMI_ORGANIZATIONS_ENDPOINT =
  "https://inference.oumi.ai/v1/organizations";
export const OUMI_PROJECTS_ENDPOINT = "https://inference.oumi.ai/v1/projects";
export const DEFAULT_OUMI_PROJECT_ID = "7HBTQDVH6J-30";
export const IRIS_TIMEOUT_MS = 1500;

export type IrisState = string | Record<string, unknown> | unknown[];

export type IrisNoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type IrisChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type IrisScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};

export type IrisQuestion =
  | IrisNoulQuestion
  | IrisChoiceQuestion
  | IrisScoreQuestion;

export type IrisQuestions = Record<string, IrisQuestion>;

export const IrisNoulAnswerSchema = z.object({
  noul: z.number().min(0).max(1),
});
export type IrisNoulAnswer = z.infer<typeof IrisNoulAnswerSchema>;

export const IrisChoiceAnswerSchema = z.object({
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
export type IrisChoiceAnswer = z.infer<typeof IrisChoiceAnswerSchema>;

export const IrisScoreAnswerSchema = z.object({
  score: z.number(),
  probabilities: z.union([
    z.record(z.string(), z.number()),
    z.array(z.number()),
  ]),
  legend: z.union([z.record(z.string(), z.string()), z.array(z.string())]),
  confidence: z.number(),
});
export type IrisScoreAnswer = z.infer<typeof IrisScoreAnswerSchema>;

export const IrisAnswerSchema = z.union([
  IrisNoulAnswerSchema,
  IrisChoiceAnswerSchema,
  IrisScoreAnswerSchema,
]);
export type IrisAnswer = z.infer<typeof IrisAnswerSchema>;

export const IrisUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type IrisUsage = z.infer<typeof IrisUsageSchema>;

export const IrisResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), IrisAnswerSchema),
  usage: IrisUsageSchema,
});
export type IrisResponse = z.infer<typeof IrisResponseSchema>;

export type IrisClientOptions = {
  apiKey?: string;
  projectId?: string;
  fetch?: typeof globalThis.fetch;
};

export type IrisClient = {
  ask(state: IrisState, questions: IrisQuestions): Promise<IrisResponse>;
};

export type IrisJudgeOptions = {
  apiKey?: string;
  projectId?: string;
  envPath?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export type WorkflowIrisJudgment = {
  worthAutomating: boolean;
  pauseBeforeSubmit: boolean;
};

export type RecallIrisJudgment = {
  match: boolean;
};

export type SameTaskIrisJudgment = {
  sameTask: boolean;
};

const WORKFLOW_JUDGE_QUESTIONS: IrisQuestions = {
  worthAutomating: {
    type: "noul",
    instructions:
      "Is this workflow worth automating for the user based on repetition, structure, and practical time savings? Same text pasted repeatedly into a field (even with clears in between) = snippet candidate, which IS worth automating.",
    criteria: {
      true: "The workflow is repetitive and worth automating, including same text pasted repeatedly (snippet candidate) or a repeated multi-step workflow.",
      false: "The workflow is one-off, unstable, trivial, or unsuitable for automation.",
    },
  },
  pauseBeforeSubmit: {
    type: "noul",
    instructions:
      "Would executing the final click or submit step automatically without user confirmation be risky because it triggers an irreversible action or external side effect?",
    criteria: {
      true: "The final action commits an irreversible external side effect, financial transaction, permanent removal, or outbound communication to others.",
      false: "The final action is safe, reversible, or routine internal record entry.",
    },
  },
};

const RECALL_JUDGE_QUESTIONS: IrisQuestions = {
  match: {
    type: "noul",
    instructions:
      "Does the recall candidate match the user's current activity well enough to suggest reusing it?",
    criteria: {
      true: "The candidate workflow matches the context, goal, and sequence.",
      false: "The candidate workflow does not match the current context or goal.",
    },
  },
};

const SAME_TASK_JUDGE_QUESTIONS: IrisQuestions = {
  sameTask: {
    type: "noul",
    instructions:
      "Do the candidate workflow and the existing library workflow automate the same user task (even if one starts on an earlier or portal site and continues onto a shared site, is a rotated or partial cycle, starts or ends at a different step, or has slightly different naming)?",
    criteria: {
      true: "Both workflows automate the same user task, including partial, rotated, or multi-site variants of the same workflow.",
      false: "They automate genuinely different tasks.",
    },
  },
};

type LoadedEnvCredentials = {
  apiKey?: string;
  projectId?: string;
};

async function readOumiEnvFile(
  envPath: string,
): Promise<LoadedEnvCredentials> {
  try {
    const content = await readFile(envPath, "utf8");
    const result: LoadedEnvCredentials = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const normalized = trimmed.startsWith("export ")
        ? trimmed.slice("export ".length).trim()
        : trimmed;
      const eqIndex = normalized.indexOf("=");
      if (eqIndex <= 0) {
        continue;
      }
      const key = normalized.slice(0, eqIndex).trim();
      let value = normalized.slice(eqIndex + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1).trim();
      }
      if (!value) {
        continue;
      }
      if (key === "OUMI_API_KEY") {
        result.apiKey = value;
      } else if (key === "OUMI_PROJECT_ID") {
        result.projectId = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function resolveJudgeCredentials(opts?: IrisJudgeOptions): Promise<{
  apiKey: string | null;
  projectId: string;
  hasExplicitProjectId: boolean;
}> {
  let apiKey = opts?.apiKey?.trim() || process.env.OUMI_API_KEY?.trim() || "";
  let envFileProjectId: string | undefined;

  if (!apiKey) {
    const envPath =
      opts?.envPath ?? path.join(os.homedir(), ".config/oumi/env");
    const loaded = await readOumiEnvFile(envPath);
    apiKey = loaded.apiKey ?? "";
    envFileProjectId = loaded.projectId;
  }

  const explicitOptionProject = opts?.projectId?.trim() || "";
  const envProcessProject = process.env.OUMI_PROJECT_ID?.trim() || "";
  const fileProject = envFileProjectId?.trim() || "";

  const projectId =
    explicitOptionProject ||
    envProcessProject ||
    fileProject ||
    DEFAULT_OUMI_PROJECT_ID;

  return {
    apiKey: apiKey || null,
    projectId,
    hasExplicitProjectId: Boolean(explicitOptionProject || envProcessProject),
  };
}

function extractList(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(record[key])) {
        return record[key] as unknown[];
      }
    }
    return [record];
  }
  return [];
}

function extractId(
  item: unknown,
  keys: string[],
  stripPrefix?: string,
): string | null {
  if (typeof item === "string") {
    const trimmed = item.trim();
    if (!trimmed) return null;
    if (stripPrefix && trimmed.startsWith(stripPrefix)) {
      return trimmed.slice(stripPrefix.length).trim() || null;
    }
    return trimmed;
  }
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    for (const key of keys) {
      const raw = record[key];
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (stripPrefix && trimmed.startsWith(stripPrefix)) {
          const stripped = trimmed.slice(stripPrefix.length).trim();
          if (stripped) return stripped;
        } else {
          return trimmed;
        }
      }
    }
  }
  return null;
}

async function discoverProjectId(
  apiKey: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const orgResponse = await fetchImpl(OUMI_ORGANIZATIONS_ENDPOINT, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
      },
      signal,
    });
    if (!orgResponse.ok || signal.aborted) {
      return null;
    }
    const orgJson: unknown = await orgResponse.json();
    const orgs = extractList(orgJson, ["organizations", "data", "items"]);
    const orgId =
      orgs
        .map((item) =>
          extractId(
            item,
            ["id", "organization_id", "organizationId", "org_id", "name"],
            "organizations/",
          ),
        )
        .find((id): id is string => Boolean(id)) ?? null;

    if (signal.aborted) {
      return null;
    }

    const projResponse = await fetchImpl(OUMI_PROJECTS_ENDPOINT, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
      },
      signal,
    });
    if (!projResponse.ok || signal.aborted) {
      return null;
    }
    const projJson: unknown = await projResponse.json();
    const projects = extractList(projJson, ["projects", "data", "items"]);

    if (orgId) {
      for (const item of projects) {
        if (item && typeof item === "object") {
          const itemOrgId = extractId(
            item,
            ["organization_id", "organizationId", "org_id"],
            "organizations/",
          );
          if (itemOrgId === orgId) {
            const matchedId = extractId(
              item,
              ["id", "project_id", "projectId", "name"],
              "projects/",
            );
            if (matchedId) {
              return matchedId;
            }
          }
        }
      }
    }

    for (const item of projects) {
      const id = extractId(
        item,
        ["id", "project_id", "projectId", "name"],
        "projects/",
      );
      if (id) {
        return id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function raceWithAbort<T>(
  promise: Promise<T | null>,
  signal: AbortSignal,
): Promise<T | null> {
  if (signal.aborted) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      },
    );
  });
}

async function postSystemOne(
  apiKey: string,
  projectId: string,
  state: IrisState,
  questions: IrisQuestions,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<
  | { ok: true; data: IrisResponse }
  | { ok: false; status?: number }
> {
  const response = await fetchImpl(IRIS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      model: `projects/${projectId}/models/iris-latest`,
      state,
      questions,
    }),
    signal,
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  const parsed = IrisResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { ok: false };
  }
  return { ok: true, data: parsed.data };
}

async function askIrisSafely(
  state: IrisState,
  questions: IrisQuestions,
  opts?: IrisJudgeOptions,
): Promise<IrisResponse | null> {
  const timeoutMs = opts?.timeoutMs ?? IRIS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }

  const signal = AbortSignal.timeout(timeoutMs);

  const run = async (): Promise<IrisResponse | null> => {
    try {
      const { apiKey, projectId, hasExplicitProjectId } =
        await resolveJudgeCredentials(opts);
      if (!apiKey || signal.aborted) {
        return null;
      }

      const fetchImpl = opts?.fetch ?? globalThis.fetch;
      const first = await postSystemOne(
        apiKey,
        projectId,
        state,
        questions,
        fetchImpl,
        signal,
      );
      if (first.ok) {
        return first.data;
      }

      if (
        (first.status === 403 || first.status === 404) &&
        !hasExplicitProjectId &&
        !signal.aborted
      ) {
        const discovered = await discoverProjectId(apiKey, fetchImpl, signal);
        if (!discovered || discovered === projectId || signal.aborted) {
          return null;
        }
        const retry = await postSystemOne(
          apiKey,
          discovered,
          state,
          questions,
          fetchImpl,
          signal,
        );
        return retry.ok ? retry.data : null;
      }

      return null;
    } catch {
      return null;
    }
  };

  return raceWithAbort(run(), signal);
}

function parseBooleanAnswer(answer: IrisAnswer | undefined): boolean | null {
  if (!answer || typeof answer !== "object") {
    return null;
  }
  if ("noul" in answer && typeof answer.noul === "number") {
    return answer.noul >= 0.5;
  }
  if ("choice" in answer && typeof answer.choice === "string") {
    const normalized = answer.choice.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "no") {
      return false;
    }
  }
  return null;
}

export async function judgeWorkflowIris(
  digest: IrisState,
  opts?: IrisJudgeOptions,
): Promise<WorkflowIrisJudgment | null> {
  const response = await askIrisSafely(digest, WORKFLOW_JUDGE_QUESTIONS, opts);
  if (!response) {
    return null;
  }
  const worthAutomating = parseBooleanAnswer(
    response.answers.worthAutomating,
  );
  const pauseBeforeSubmit = parseBooleanAnswer(
    response.answers.pauseBeforeSubmit,
  );
  if (worthAutomating === null || pauseBeforeSubmit === null) {
    return null;
  }
  return { worthAutomating, pauseBeforeSubmit };
}

export async function judgeRecallIris(
  candidate: IrisState,
  opts?: IrisJudgeOptions,
): Promise<RecallIrisJudgment | null> {
  const response = await askIrisSafely(candidate, RECALL_JUDGE_QUESTIONS, opts);
  if (!response) {
    return null;
  }
  const match = parseBooleanAnswer(response.answers.match);
  if (match === null) {
    return null;
  }
  return { match };
}

export async function judgeSameTaskIris(
  comparison: IrisState,
  opts?: IrisJudgeOptions,
): Promise<SameTaskIrisJudgment | null> {
  const response = await askIrisSafely(
    comparison,
    SAME_TASK_JUDGE_QUESTIONS,
    opts,
  );
  if (!response) {
    return null;
  }
  const sameTask = parseBooleanAnswer(response.answers.sameTask);
  if (sameTask === null) {
    return null;
  }
  return { sameTask };
}

export function createIrisClient(options: IrisClientOptions = {}): IrisClient {
  const apiKey = options.apiKey?.trim() || process.env.OUMI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing OUMI_API_KEY");
  }

  const projectId =
    options.projectId?.trim() || process.env.OUMI_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error("Missing OUMI_PROJECT_ID");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async ask(state, questions) {
      const response = await fetchImpl(IRIS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({
          model: `projects/${projectId}/models/iris-latest`,
          state,
          questions,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Iris HTTP ${response.status}: ${text}`);
      }

      const parsed = IrisResponseSchema.parse(await response.json());
      return {
        model: parsed.model,
        answers: parsed.answers,
        usage: parsed.usage,
      };
    },
  };
}
