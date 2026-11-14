import {
  ActionScriptSchema,
  type ActionScript,
  type ScriptDomStep as DomStep,
  type ScriptLocator as Locator,
  type ScriptLocatorKind as LocatorKind,
  type ScriptStep as Step,
} from "@gen/shared/schema.ts";

export type { ActionScript, DomStep, Locator, LocatorKind, Step };
export { ActionScriptSchema };

const LOCATOR_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["testid", "aria", "css", "text", "xpath"] },
    value: { type: "string" },
  },
  required: ["kind", "value"],
} as const;

const LEAF_STEP_PROPERTIES = {
  action: {
    type: "string",
    enum: [
      "click",
      "fill",
      "insertText",
      "select",
      "waitFor",
      "readText",
      "readValue",
      "extractList",
      "navigate",
      "wait",
    ],
  },
  target: LOCATOR_SCHEMA,
  value: { type: "string" },
  url: { type: "string" },
  ms: { type: "number" },
  timeoutMs: { type: "number" },
  bind: { type: "string" },
  fields: {
    type: "array",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        locator: LOCATOR_SCHEMA,
      },
      required: ["name", "locator"],
    },
  },
  optional: { type: "boolean" },
} as const;

/** Non-recursive JSON Schema compatible with @google/genai responseSchema / responseJsonSchema. */
export const ACTION_SCRIPT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ...LEAF_STEP_PROPERTIES,
          action: {
            type: "string",
            enum: [...LEAF_STEP_PROPERTIES.action.enum, "forEach"],
          },
          items: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: LEAF_STEP_PROPERTIES,
              required: ["action"],
            },
          },
        },
        required: ["action"],
      },
    },
  },
  required: ["steps"],
} as const;

export function parseActionScript(raw: unknown): ActionScript {
  const parsed = ActionScriptSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`ActionScript validation failed: ${details}`);
  }
  return parsed.data;
}
