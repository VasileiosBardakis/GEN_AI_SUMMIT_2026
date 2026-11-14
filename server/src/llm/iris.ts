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
import { z } from "../../../shared/node_modules/zod/index.js";

export const IRIS_ENDPOINT = "https://inference.oumi.ai/v1/systemone";

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
