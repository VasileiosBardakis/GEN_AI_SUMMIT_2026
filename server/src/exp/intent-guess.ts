import type { Event } from "@gen/shared";
import {
  createGeminiClient,
  type GeminiClient,
  type ZodLikeSchema,
} from "../llm/gemini.ts";

export type IntentGuessResult = {
  guess: string | null;
  confidence: number;
};

export type IntentGuessInput = {
  moves: Event[];
  pageSummary?: string;
  minConfidence?: number;
};

const DEFAULT_MIN_CONFIDENCE = 0.5;

export const IntentGuessSchema: ZodLikeSchema<IntentGuessResult> = {
  safeParse(data: unknown) {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return {
        success: false,
        error: {
          message: "Expected an object",
          issues: [{ path: [], message: "Expected an object" }],
        },
      };
    }

    const record = data as Record<string, unknown>;
    const issues: Array<{ path: ReadonlyArray<PropertyKey>; message: string }> = [];

    const guess = record.guess;
    if (guess !== null && typeof guess !== "string") {
      issues.push({
        path: ["guess"],
        message: "Expected string or null",
      });
    }

    const confidence = record.confidence;
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      issues.push({
        path: ["confidence"],
        message: "Expected a finite number in [0, 1]",
      });
    }

    if (issues.length > 0) {
      return {
        success: false,
        error: {
          message: issues.map((issue) => issue.message).join("; "),
          issues,
        },
      };
    }

    return {
      success: true,
      data: {
        guess: guess as string | null,
        confidence: confidence as number,
      },
    };
  },
};

type MoveSummary = {
  type: Event["type"];
  app: string;
  window?: string;
  url?: string;
  target?: {
    label?: string;
    role?: string;
    tag?: string;
  };
  value?: string;
};

function getNonPiiValue(move: Event): string | undefined {
  if (typeof move.value !== "string") return undefined;
  if (move.meta?.privacy?.redacted) return undefined;
  if (move.meta?.typing?.inputTypeAttr === "password") return undefined;

  const trimmed = move.value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("[REDACTED") || trimmed.includes("__PII_")) return undefined;

  return trimmed.slice(0, 120);
}

function summarizeMove(move: Event): MoveSummary {
  const summary: MoveSummary = {
    type: move.type,
    app: move.app,
  };

  const windowTitle = move.window?.trim();
  if (windowTitle) {
    summary.window = windowTitle.slice(0, 160);
  }

  const url = move.url?.trim();
  if (url) {
    summary.url = url.slice(0, 240);
  }

  if (move.target) {
    const target: NonNullable<MoveSummary["target"]> = {};
    const label = move.target.label?.trim();
    const role = move.target.role?.trim();
    const tag = move.target.tag?.trim();
    if (label) target.label = label.slice(0, 120);
    if (role) target.role = role.slice(0, 60);
    if (tag) target.tag = tag.slice(0, 40);
    if (Object.keys(target).length > 0) {
      summary.target = target;
    }
  }

  const safeValue = getNonPiiValue(move);
  if (safeValue !== undefined) {
    summary.value = safeValue;
  }

  return summary;
}

function buildIntentGuessPrompt(moves: Event[], pageSummary?: string): string {
  const summaries = moves.slice(0, 2).map(summarizeMove);
  const trimmedPageSummary = pageSummary?.trim();

  const lines = [
    "Infer a short, display-only task hint from the user's first 1-2 moves and optional page summary.",
    'Return ONLY valid JSON matching: { "guess": string | null, "confidence": number }.',
    "Rules:",
    "- guess: concise 3-8 word display-only hint describing the likely task, or null if unclear.",
    "- Never propose or execute actions.",
    "- confidence: finite number between 0 and 1.",
    "- Never invent personal data or secrets.",
    "",
    "Moves:",
    JSON.stringify(summaries, null, 2),
  ];

  if (trimmedPageSummary) {
    lines.push("", "Page summary:", trimmedPageSummary.slice(0, 4000));
  }

  return lines.join("\n");
}

export async function guessIntent(
  input: IntentGuessInput,
  client?: GeminiClient,
): Promise<IntentGuessResult> {
  if (input.moves.length === 0) {
    return { guess: null, confidence: 0 };
  }

  const firstMoves = input.moves.slice(0, 2);
  const prompt = buildIntentGuessPrompt(firstMoves, input.pageSummary);
  const gemini = client ?? createGeminiClient();
  const raw = await gemini.generateJson(prompt, IntentGuessSchema);

  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const trimmedGuess = typeof raw.guess === "string" ? raw.guess.trim() : null;
  const guess =
    trimmedGuess && trimmedGuess.length > 0 && raw.confidence >= minConfidence
      ? trimmedGuess
      : null;

  return {
    guess,
    confidence: raw.confidence,
  };
}
