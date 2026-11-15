import type { Locator, Step } from "@gen/shared";
import {
  createGeminiClient,
  type GeminiClient,
  type ZodLikeSchema,
} from "../llm/gemini.ts";

export type RefindPageElement = {
  locators: Locator[];
  label?: string;
  role?: string;
  tag?: string;
};

export type RefindInput = {
  step: {
    action?: Step["action"];
    locators: Locator[];
    label?: string;
    role?: string;
  };
  pageSummary: RefindPageElement[] | string;
};

export type RefindResult = {
  locators: Locator[] | null;
  why: string;
};

type SchemaIssue = {
  path: ReadonlyArray<PropertyKey>;
  message: string;
};

const VALID_LOCATOR_KINDS = new Set<Locator["kind"]>([
  "testid",
  "aria",
  "css",
  "text",
  "uia",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export const RefindResultSchema: ZodLikeSchema<RefindResult> = {
  safeParse(data: unknown) {
    if (!isPlainObject(data)) {
      return {
        success: false,
        error: {
          message: "Expected an object",
          issues: [{ path: [], message: "Expected an object" }],
        },
      };
    }

    const issues: SchemaIssue[] = [];
    let parsedLocators: Locator[] | null = null;

    if (data.locators === null) {
      parsedLocators = null;
    } else if (Array.isArray(data.locators)) {
      const items: Locator[] = [];
      for (let i = 0; i < data.locators.length; i += 1) {
        const entry = data.locators[i];
        if (!isPlainObject(entry)) {
          issues.push({
            path: ["locators", i],
            message: "Expected a locator object",
          });
          continue;
        }

        const kind = entry.kind;
        if (typeof kind !== "string" || !VALID_LOCATOR_KINDS.has(kind as Locator["kind"])) {
          issues.push({
            path: ["locators", i, "kind"],
            message: 'Expected one of "testid", "aria", "css", "text", "uia"',
          });
        }

        const value = entry.value;
        if (!isNonEmptyString(value)) {
          issues.push({
            path: ["locators", i, "value"],
            message: "Expected a non-empty string",
          });
        }

        if (
          typeof kind === "string" &&
          VALID_LOCATOR_KINDS.has(kind as Locator["kind"]) &&
          isNonEmptyString(value)
        ) {
          items.push({ kind: kind as Locator["kind"], value });
        }
      }
      parsedLocators = items;
    } else {
      issues.push({
        path: ["locators"],
        message: "Expected an array of locators or null",
      });
    }

    let why = "";
    if (isNonEmptyString(data.why)) {
      why = data.why.trim();
    } else {
      issues.push({
        path: ["why"],
        message: "Expected a non-empty string",
      });
    }

    if (issues.length > 0) {
      return {
        success: false,
        error: {
          message: issues
            .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
            .join("; "),
          issues,
        },
      };
    }

    return {
      success: true,
      data: {
        locators: parsedLocators,
        why,
      },
    };
  },
};

function isEmptyPageSummary(pageSummary: RefindPageElement[] | string): boolean {
  if (Array.isArray(pageSummary)) {
    return pageSummary.length === 0;
  }
  return pageSummary.trim().length === 0;
}

function buildRefindPrompt(input: RefindInput): string {
  const stepSummary: Record<string, unknown> = {
    locators: input.step.locators,
  };
  if (input.step.action !== undefined) stepSummary.action = input.step.action;
  if (input.step.label !== undefined) stepSummary.label = input.step.label;
  if (input.step.role !== undefined) stepSummary.role = input.step.role;

  const formattedPageSummary = Array.isArray(input.pageSummary)
    ? JSON.stringify(input.pageSummary, null, 2)
    : input.pageSummary.trim();

  return [
    "You are helping replay recover a missing or renamed UI element from the current page summary.",
    "Given the original step and the current page summary, find the single element on the current page that represents the same UI control, or report that no safe match exists.",
    "",
    "Return ONLY valid JSON matching:",
    '{ "locators": [{ "kind": "testid" | "aria" | "css" | "text" | "uia", "value": string }] | null, "why": string }',
    "",
    "Rules:",
    "- Match ONLY an element with the same role and purpose as the original step.",
    "- NEVER match destructive or opposite actions (for example, never match Delete or Cancel for a Save or Submit step).",
    "- If nothing fits safely and unambiguously, return locators: null and explain why.",
    "- Only return locators that are present verbatim in the page summary (never invent, modify, or mix locators from different elements).",
    '- "why" must always be a non-empty string.',
    "",
    "Original step:",
    JSON.stringify(stepSummary, null, 2),
    "",
    "Current page summary:",
    formattedPageSummary,
  ].join("\n");
}

function locatorMatches(a: Locator, b: Locator): boolean {
  return a.kind === b.kind && a.value === b.value;
}

function hasConflictingRole(stepRole: string | undefined, elementRole: string | undefined): boolean {
  const normalizedStepRole = stepRole?.trim().toLowerCase();
  const normalizedElementRole = elementRole?.trim().toLowerCase();
  if (!normalizedStepRole || !normalizedElementRole) {
    return false;
  }
  return normalizedStepRole !== normalizedElementRole;
}

function validateAgainstPageSummary(
  result: RefindResult,
  input: RefindInput,
): RefindResult {
  if (result.locators === null) {
    return result;
  }

  if (result.locators.length === 0) {
    return {
      locators: null,
      why: result.why || "Model returned an empty locator list",
    };
  }

  if (Array.isArray(input.pageSummary)) {
    const matchingElements = input.pageSummary.filter((element) =>
      result.locators!.every((returnedLoc) =>
        element.locators.some((elementLoc) => locatorMatches(returnedLoc, elementLoc)),
      ),
    );

    if (matchingElements.length === 0) {
      return {
        locators: null,
        why: "Rejected: returned locators do not belong to a single element in page summary",
      };
    }

    const compatibleElement = matchingElements.find(
      (element) => !hasConflictingRole(input.step.role, element.role),
    );

    if (!compatibleElement) {
      return {
        locators: null,
        why: "Rejected: matched element role conflicts with original step role",
      };
    }

    return result;
  }

  const pageText = input.pageSummary;
  const allPresent = result.locators.every((loc) => pageText.includes(loc.value));
  if (!allPresent) {
    return {
      locators: null,
      why: "Rejected: returned locator value does not appear in page summary",
    };
  }

  return result;
}

export async function refindElement(
  input: RefindInput,
  client?: GeminiClient,
): Promise<RefindResult> {
  if (isEmptyPageSummary(input.pageSummary)) {
    return { locators: null, why: "Empty page summary" };
  }

  const prompt = buildRefindPrompt(input);
  const gemini = client ?? createGeminiClient();
  const raw = await gemini.generateJson(prompt, RefindResultSchema);

  return validateAgainstPageSummary(raw, input);
}
