export type LocatorKind = "testid" | "aria" | "css" | "text" | "xpath";

export type Locator = {
  kind: LocatorKind;
  value: string;
};

export type DomStep =
  | { action: "click"; target: Locator; optional?: boolean }
  | { action: "fill"; target: Locator; value: string; optional?: boolean }
  | { action: "insertText"; target?: Locator; value: string; optional?: boolean }
  | { action: "select"; target: Locator; value: string; optional?: boolean }
  | { action: "waitFor"; target: Locator; timeoutMs?: number; optional?: boolean }
  | { action: "readText"; target: Locator; bind: string; optional?: boolean }
  | { action: "readValue"; target: Locator; bind: string; optional?: boolean }
  | {
      action: "extractList";
      target: Locator;
      bind: string;
      fields?: Record<string, Locator>;
      optional?: boolean;
    };

export type Step =
  | DomStep
  | { action: "navigate"; url: string; optional?: boolean }
  | { action: "wait"; ms: number; optional?: boolean }
  | {
      action: "forEach";
      items: Record<string, string>[] | string;
      steps: Step[];
      optional?: boolean;
    };

export type ActionScript = {
  name?: string;
  steps: Step[];
};

const LOCATOR_KINDS = new Set<LocatorKind>(["testid", "aria", "css", "text", "xpath"]);

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

function isRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function parseLocator(raw: unknown, path: string): Locator {
  if (!isRecord(raw)) throw new Error(`${path}: expected locator object`);
  const { kind, value } = raw;
  if (typeof kind !== "string" || !LOCATOR_KINDS.has(kind as LocatorKind)) {
    throw new Error(`${path}.kind: invalid locator kind`);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path}.value: expected non-empty string`);
  }
  return { kind: kind as LocatorKind, value };
}

function parseFields(raw: unknown, path: string): Record<string, Locator> | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const out: Record<string, Locator> = {};
    raw.forEach((entry, i) => {
      if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) {
        throw new Error(`${path}[${i}].name: expected non-empty string`);
      }
      out[entry.name] = parseLocator(entry.locator, `${path}[${i}].locator`);
    });
    return out;
  }
  if (isRecord(raw)) {
    const out: Record<string, Locator> = {};
    for (const [key, loc] of Object.entries(raw)) {
      out[key] = parseLocator(loc, `${path}.${key}`);
    }
    return out;
  }
  throw new Error(`${path}: expected fields object or array`);
}

function parseStep(raw: unknown, path: string): Step {
  if (!isRecord(raw) || typeof raw.action !== "string") {
    throw new Error(`${path}: expected step object with action`);
  }
  const optional = typeof raw.optional === "boolean" ? { optional: raw.optional } : {};

  switch (raw.action) {
    case "click":
      return { action: "click", target: parseLocator(raw.target, `${path}.target`), ...optional };

    case "fill":
      if (typeof raw.value !== "string") throw new Error(`${path}.value: expected string`);
      return {
        action: "fill",
        target: parseLocator(raw.target, `${path}.target`),
        value: raw.value,
        ...optional,
      };

    case "insertText":
      if (typeof raw.value !== "string") throw new Error(`${path}.value: expected string`);
      return {
        action: "insertText",
        ...(raw.target !== undefined ? { target: parseLocator(raw.target, `${path}.target`) } : {}),
        value: raw.value,
        ...optional,
      };

    case "select":
      if (typeof raw.value !== "string") throw new Error(`${path}.value: expected string`);
      return {
        action: "select",
        target: parseLocator(raw.target, `${path}.target`),
        value: raw.value,
        ...optional,
      };

    case "waitFor": {
      if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== "number" || raw.timeoutMs <= 0)) {
        throw new Error(`${path}.timeoutMs: expected positive number`);
      }
      return {
        action: "waitFor",
        target: parseLocator(raw.target, `${path}.target`),
        ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
        ...optional,
      };
    }

    case "readText":
    case "readValue":
      if (typeof raw.bind !== "string" || !raw.bind.trim()) {
        throw new Error(`${path}.bind: expected non-empty string`);
      }
      return {
        action: raw.action,
        target: parseLocator(raw.target, `${path}.target`),
        bind: raw.bind,
        ...optional,
      };

    case "extractList": {
      if (typeof raw.bind !== "string" || !raw.bind.trim()) {
        throw new Error(`${path}.bind: expected non-empty string`);
      }
      const fields = parseFields(raw.fields, `${path}.fields`);
      return {
        action: "extractList",
        target: parseLocator(raw.target, `${path}.target`),
        bind: raw.bind,
        ...(fields ? { fields } : {}),
        ...optional,
      };
    }

    case "navigate":
      if (typeof raw.url !== "string" || !/^https?:\/\//i.test(raw.url)) {
        throw new Error(`${path}.url: expected http(s) URL`);
      }
      return { action: "navigate", url: raw.url, ...optional };

    case "wait":
      if (typeof raw.ms !== "number" || raw.ms < 0) {
        throw new Error(`${path}.ms: expected non-negative number`);
      }
      return { action: "wait", ms: raw.ms, ...optional };

    case "forEach": {
      if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
        throw new Error(`${path}.steps: expected non-empty step array`);
      }
      let items: Record<string, string>[] | string;
      if (typeof raw.items === "string" && raw.items.trim()) {
        items = raw.items;
      } else if (Array.isArray(raw.items)) {
        items = raw.items.map((item, i) => {
          if (!isRecord(item)) throw new Error(`${path}.items[${i}]: expected object`);
          const rec: Record<string, string> = {};
          for (const [k, v] of Object.entries(item)) rec[k] = String(v);
          return rec;
        });
      } else {
        throw new Error(`${path}.items: expected binding name or item array`);
      }
      return {
        action: "forEach",
        items,
        steps: raw.steps.map((s, i) => parseStep(s, `${path}.steps[${i}]`)),
        ...optional,
      };
    }

    default:
      throw new Error(`${path}.action: unsupported action "${raw.action}"`);
  }
}

export function parseActionScript(raw: unknown): ActionScript {
  if (!isRecord(raw)) throw new Error("script: expected object");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error("script.steps: expected non-empty array");
  }
  if (raw.name !== undefined && typeof raw.name !== "string") {
    throw new Error("script.name: expected string");
  }
  return {
    ...(raw.name ? { name: raw.name } : {}),
    steps: raw.steps.map((step, i) => parseStep(step, `script.steps[${i}]`)),
  };
}
