import type { Step, Verdict, Workflow } from "@gen/shared";
import { z } from "../../../shared/node_modules/zod/index.js";
import {
  createGeminiClient,
  type GeminiClient,
  type GeminiClientOptions,
  type GeminiSdk,
} from "../llm/gemini.ts";

export type Candidate = {
  workflow: Workflow;
  repetitions: number;
  minutesPerWeek: number;
  stability: number;
};

export type PlannedSolution = {
  name: string;
  solution: string;
};

export type PlannerOptions = {
  snippetText?: string;
  client?: GeminiClient;
  gemini?: GeminiClientOptions;
  sdk?: GeminiSdk;
};

const PlannedSolutionSchema = z.object({
  name: z.string().trim().min(1),
  solution: z.string().trim().min(1),
});

function isParamValue(value: Step["value"]): value is { param: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "param" in value &&
    typeof value.param === "string"
  );
}

function firstLiteralStepValue(workflow: Workflow): string | undefined {
  for (const step of workflow.steps) {
    if (typeof step.value === "string" && step.value.trim().length > 0) {
      return step.value;
    }
  }
  return undefined;
}

function buildStructuralDigest(candidate: Candidate) {
  const { workflow, repetitions, stability } = candidate;
  return {
    sourceApp: workflow.sourceApp,
    destApp: workflow.destApp,
    paramNames: workflow.params.map((p) => p.name),
    repetitions,
    stability,
    steps: workflow.steps.map((step) => ({
      action: step.action,
      locatorKind: step.target?.[0]?.kind ?? null,
      ...(isParamValue(step.value) ? { param: step.value.param } : {}),
    })),
  };
}

export function buildPlannerPrompt(
  candidate: Candidate,
  verdict: Verdict,
  snippetText?: string,
): string {
  if (verdict !== "rung1" && verdict !== "rung2") {
    throw new Error(
      `Cannot plan solution for verdict "${verdict}": only "rung1" and "rung2" produce executable solutions.`,
    );
  }

  const structuralDigest = buildStructuralDigest(candidate);

  if (verdict === "rung1") {
    const rawSnippet = snippetText ?? firstLiteralStepValue(candidate.workflow);
    if (typeof rawSnippet !== "string" || rawSnippet.trim().length === 0) {
      throw new Error("Missing or empty snippet text for rung1 planning.");
    }
    if (rawSnippet.includes("[REDACTED")) {
      throw new Error("Snippet text for rung1 planning must not contain redacted tokens.");
    }

    const snippet = rawSnippet.trim();
    return [
      "You are the Brain Planner. Convert this verified rung1 snippet workflow into a short name and plain-text solution for POST /implement.",
      "",
      'Return ONLY valid JSON matching: { "name": "<short descriptive name>", "solution": "<plain-text instruction>" }',
      "",
      "Format rules for rung1:",
      `- Match the reply-box style: "Insert '<snippet>' into the currently focused field."`,
      "- Preserve the exact snippet text below inside single quotes in solution so POST /implement can compile it into an insertText ActionScript.",
      "- Keep name and solution non-empty.",
      "",
      "Snippet text:",
      JSON.stringify(snippet),
      "",
      "Structural digest:",
      JSON.stringify(structuralDigest, null, 2),
    ].join("\n");
  }

  return [
    "You are the Brain Planner. Convert this parameterized rung2 workflow into a short name and plain-text step-by-step solution for POST /implement.",
    "",
    'Return ONLY valid JSON matching: { "name": "<short descriptive name>", "solution": "<plain-text step-by-step instruction>" }',
    "",
    "Format rules for rung2:",
    "- Write clear, concise plain-text step-by-step instructions so POST /implement can compile them into an ActionScript (click, fill, select, copy/read, paste, navigate, submit).",
    "- Use {param} placeholders (for example {invoice_id}, {amount}) matching paramNames and step.param in the structural digest.",
    "- Do NOT invent concrete example values, personal data, or secrets.",
    "- Keep name and solution non-empty.",
    "",
    "Structural digest:",
    JSON.stringify(structuralDigest, null, 2),
  ].join("\n");
}

export async function planSolution(
  candidate: Candidate,
  verdict: Verdict,
  opts?: PlannerOptions,
): Promise<PlannedSolution> {
  const prompt = buildPlannerPrompt(candidate, verdict, opts?.snippetText);
  const geminiOptions = opts?.gemini
    ? opts.sdk && !opts.gemini.sdk
      ? { ...opts.gemini, sdk: opts.sdk }
      : opts.gemini
    : opts?.sdk
      ? { sdk: opts.sdk }
      : undefined;
  const client = opts?.client ?? createGeminiClient(geminiOptions);
  const planned = await client.generateJson(prompt, PlannedSolutionSchema);
  return {
    name: planned.name,
    solution: planned.solution,
  };
}
