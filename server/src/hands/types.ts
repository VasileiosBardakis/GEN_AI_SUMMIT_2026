import {
  ActionScriptSchema,
  EyesDetectionSpecSchema,
  ImplementedLibraryDraftSchema,
  LibraryEntrySchema,
  type ActionScript,
  type EyesDetectionSpec,
  type EyesTriggerEvent,
  type ImplementedLibraryDraft,
  type LibraryEntry,
  type LibraryEntryKind,
  type LibraryEntryStatus,
  type ScriptDomStep as DomStep,
  type ScriptLocator as Locator,
  type ScriptLocatorKind as LocatorKind,
  type ScriptStep as Step,
} from "@gen/shared/schema.ts";

export type {
  ActionScript,
  DomStep,
  EyesDetectionSpec,
  EyesTriggerEvent,
  ImplementedLibraryDraft,
  LibraryEntry,
  LibraryEntryKind,
  LibraryEntryStatus,
  Locator,
  LocatorKind,
  Step,
};
export {
  ActionScriptSchema,
  EyesDetectionSpecSchema,
  ImplementedLibraryDraftSchema,
  LibraryEntrySchema,
};

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

/** Non-recursive JSON Schema for Gemini when compiling a library entry + Eyes trigger metadata. */
export const IMPLEMENTED_LIBRARY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    kind: { type: "string", enum: ["snippet", "workflow"] },
    script: ACTION_SCRIPT_RESPONSE_SCHEMA,
    eyes: {
      type: "object",
      properties: {
        triggerEvent: {
          type: "string",
          enum: ["focus", "typing_prefix", "click", "copy", "nav"],
        },
        intent: { type: "string" },
        scope: {
          type: "object",
          properties: {
            apps: { type: "array", items: { type: "string" } },
            urlPatterns: { type: "array", items: { type: "string" } },
            pageHints: { type: "array", items: { type: "string" } },
          },
        },
        targetHints: {
          type: "object",
          properties: {
            roles: { type: "array", items: { type: "string" } },
            labelContains: { type: "array", items: { type: "string" } },
            locators: { type: "array", items: LOCATOR_SCHEMA },
          },
        },
        textHints: {
          type: "object",
          properties: {
            prefixHints: { type: "array", items: { type: "string" } },
            minCharsBeforeMatch: { type: "number" },
          },
        },
        guards: {
          type: "object",
          properties: {
            fieldEmptyOnly: { type: "boolean" },
            requireClipboard: { type: "boolean" },
            cooldownMs: { type: "number" },
            minSignals: { type: "number" },
          },
        },
      },
      required: ["triggerEvent", "intent"],
    },
  },
  required: ["script", "eyes"],
} as const;

export function parseImplementedLibraryDraft(raw: unknown): ImplementedLibraryDraft {
  const parsed = ImplementedLibraryDraftSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`ImplementedLibraryDraft validation failed: ${details}`);
  }
  return parsed.data;
}
