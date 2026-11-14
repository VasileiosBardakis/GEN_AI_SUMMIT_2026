import type { Step, Workflow } from "@gen/shared";
import { z } from "../../../shared/node_modules/zod/index.js";
import {
  createGeminiClient,
  type GeminiClient,
  type GeminiClientOptions,
  type GeminiSdk,
} from "../llm/gemini.ts";
import {
  createIrisClient,
  type IrisClient,
  type IrisClientOptions,
  type IrisQuestions,
} from "../llm/iris.ts";

export type Candidate = {
  workflow: Workflow;
  repetitions: number;
  minutesPerWeek: number;
  stability: number;
};

export type SecondLevel = "rung0" | "rung1" | "rung2" | "do_not_automate";

export type WorkflowDigestStep = {
  action: Step["action"];
  locatorKind: string | null;
};

export type WorkflowDigest = {
  id: string;
  sourceApp: string;
  destApp: string;
  steps: WorkflowDigestStep[];
  paramNames: string[];
  repetitions: number;
  stability: number;
  features: Record<string, number>;
};

export type SecondDecision = {
  level: SecondLevel;
  risky: boolean;
  confidence: number;
  source: "iris" | "gemini";
};

export const DEFAULT_SECOND_TIMEOUT_MS = 8000;

export type DecideSecondOptions = {
  iris?: IrisClient;
  irisOptions?: IrisClientOptions;
  gemini?: GeminiClient;
  geminiOptions?: GeminiClientOptions;
  sdk?: GeminiSdk;
  timeoutMs?: number;
};

const SecondLevelSchema = z.enum([
  "rung0",
  "rung1",
  "rung2",
  "do_not_automate",
]);

export const SecondOutputSchema = z.object({
  level: SecondLevelSchema,
  risky: z.boolean(),
  confidence: z.number().min(0).max(1),
});

const SECOND_IRIS_QUESTIONS: IrisQuestions = {
  level: {
    type: "choice",
    instructions:
      "Classify the automation rung for this sanitized workflow digest.",
    criteria: {
      rung0:
        "Simple repetitive snippet insertion or deterministic copy-paste.",
      rung1:
        "Deterministic multi-step UI macro with stable locators and clear parameters.",
      rung2:
        "Variable or multi-branch workflow suited for adaptive browser automation.",
      do_not_automate:
        "Unsafe, unstable, low-value, or unsuitable for automation.",
    },
  },
  risky: {
    type: "choice",
    instructions:
      "Does automating this workflow pose notable security, privacy, or operational risk?",
    criteria: {
      yes: "Involves sensitive actions, destructive submits, auth/payment flows, or high error risk.",
      no: "Low-risk routine workflow with bounded, predictable actions.",
    },
  },
  confidence: {
    type: "score",
    instructions:
      "Rate confidence in the rung classification and risk assessment.",
    criteria: ["low", "medium", "high"],
  },
};

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function buildDigest(
  candidate: Candidate,
  features: Record<string, number> = {},
): WorkflowDigest {
  const { workflow, repetitions, stability } = candidate;
  return {
    id: workflow.id,
    sourceApp: workflow.sourceApp,
    destApp: workflow.destApp,
    steps: workflow.steps.map((step) => ({
      action: step.action,
      locatorKind: step.target?.[0]?.kind ?? null,
    })),
    paramNames: workflow.params.map((p) => p.name),
    repetitions,
    stability,
    features: { ...features },
  };
}

function parseIrisAnswers(
  answers: Record<string, unknown> | undefined,
): SecondDecision {
  if (!answers || typeof answers !== "object") {
    throw new Error("Iris response missing answers");
  }

  const levelAnswer = answers.level as Record<string, unknown> | undefined;
  const levelParsed = SecondLevelSchema.safeParse(levelAnswer?.choice);
  if (!levelParsed.success) {
    throw new Error("Iris response missing valid level choice");
  }

  const riskyAnswer = answers.risky as Record<string, unknown> | undefined;
  let risky: boolean;
  if (riskyAnswer && typeof riskyAnswer.choice === "string") {
    if (riskyAnswer.choice === "yes") {
      risky = true;
    } else if (riskyAnswer.choice === "no") {
      risky = false;
    } else {
      throw new Error("Iris response has invalid risky choice");
    }
  } else if (
    riskyAnswer &&
    typeof riskyAnswer.noul === "number" &&
    Number.isFinite(riskyAnswer.noul)
  ) {
    risky = riskyAnswer.noul >= 0.5;
  } else {
    throw new Error("Iris response missing valid risky answer");
  }

  const confidenceAnswer = answers.confidence as
    | Record<string, unknown>
    | undefined;
  let confidence: number;
  if (
    confidenceAnswer &&
    typeof confidenceAnswer.score === "number" &&
    Number.isFinite(confidenceAnswer.score)
  ) {
    confidence = clamp01(confidenceAnswer.score / 2);
  } else if (
    confidenceAnswer &&
    typeof confidenceAnswer.confidence === "number" &&
    Number.isFinite(confidenceAnswer.confidence)
  ) {
    confidence = clamp01(confidenceAnswer.confidence);
  } else if (
    confidenceAnswer &&
    typeof confidenceAnswer.noul === "number" &&
    Number.isFinite(confidenceAnswer.noul)
  ) {
    confidence = clamp01(confidenceAnswer.noul);
  } else {
    throw new Error("Iris response missing valid confidence answer");
  }

  return {
    level: levelParsed.data,
    risky,
    confidence,
    source: "iris",
  };
}

function buildGeminiPrompt(digest: WorkflowDigest): string {
  return [
    "Evaluate this sanitized workflow digest for automation suitability.",
    'Return JSON matching: {"level":"rung0"|"rung1"|"rung2"|"do_not_automate","risky":boolean,"confidence":number}.',
    "Confidence must be a number in [0, 1].",
    "",
    "Rung definitions:",
    "- rung0: simple repetitive snippet insertion or deterministic copy-paste",
    "- rung1: deterministic multi-step UI macro with stable locators and clear parameters",
    "- rung2: variable or multi-branch workflow suited for adaptive browser automation",
    "- do_not_automate: unsafe, unstable, low-value, or unsuitable for automation",
    "",
    "Workflow digest:",
    JSON.stringify(digest),
  ].join("\n");
}

function resolveGeminiClient(opts?: DecideSecondOptions): GeminiClient {
  if (opts?.gemini) {
    return opts.gemini;
  }
  const geminiOptions: GeminiClientOptions | undefined = opts?.geminiOptions
    ? opts.sdk && !opts.geminiOptions.sdk
      ? { ...opts.geminiOptions, sdk: opts.sdk }
      : opts.geminiOptions
    : opts?.sdk
      ? { sdk: opts.sdk }
      : undefined;
  return createGeminiClient(geminiOptions);
}

async function evaluateWithFallback(
  digest: WorkflowDigest,
  opts: DecideSecondOptions | undefined,
  isTimedOut: () => boolean,
): Promise<SecondDecision | null> {
  try {
    const iris = opts?.iris ?? createIrisClient(opts?.irisOptions);
    const response = await iris.ask(digest, SECOND_IRIS_QUESTIONS);
    if (isTimedOut()) {
      return null;
    }
    return parseIrisAnswers(response?.answers);
  } catch {
    if (isTimedOut()) {
      return null;
    }
  }

  try {
    const gemini = resolveGeminiClient(opts);
    const parsed = await gemini.generateJson(
      buildGeminiPrompt(digest),
      SecondOutputSchema,
    );
    if (isTimedOut()) {
      return null;
    }
    return {
      level: parsed.level,
      risky: parsed.risky,
      confidence: clamp01(parsed.confidence),
      source: "gemini",
    };
  } catch {
    return null;
  }
}

export async function decideSecond(
  digest: WorkflowDigest,
  opts?: DecideSecondOptions,
): Promise<SecondDecision | null> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SECOND_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      evaluateWithFallback(digest, opts, () => timedOut),
      timeoutPromise,
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
