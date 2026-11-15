import type { Locator } from "@gen/shared";
import { z } from "../../../shared/node_modules/zod/index.js";

export const DEFAULT_MAX_COMPILED_STEPS = 30;

const nonEmptyString = z
  .string()
  .refine((s) => s.trim().length > 0, "expected non-empty string");

const CompiledLocatorSchema = z.object({
  kind: z.enum(["testid", "aria", "css", "text", "uia"]),
  value: nonEmptyString,
});

export type CompiledParam = {
  name: string;
  description?: string;
  example?: string;
  piiHash?: string;
};

export const CompiledParamSchema = z.object({
  name: nonEmptyString,
  description: z.string().optional(),
  example: z.string().optional(),
  piiHash: z.string().min(1).optional(),
});

export type CompiledLeafStep =
  | {
      action: "click";
      target: Locator[];
      within?: Locator[];
      optional?: boolean;
    }
  | {
      action: "fill";
      target: Locator[];
      within?: Locator[];
      value: string;
      optional?: boolean;
    }
  | {
      action: "insertText";
      target?: Locator[];
      within?: Locator[];
      value: string;
      optional?: boolean;
    }
  | {
      action: "select";
      target: Locator[];
      within?: Locator[];
      value: string;
      optional?: boolean;
    }
  | {
      action: "waitFor";
      target: Locator[];
      within?: Locator[];
      timeoutMs?: number;
      optional?: boolean;
    }
  | {
      action: "readText";
      target: Locator[];
      within?: Locator[];
      bind: string;
      optional?: boolean;
    }
  | {
      action: "readValue";
      target: Locator[];
      within?: Locator[];
      bind: string;
      optional?: boolean;
    }
  | {
      action: "extractList";
      target: Locator[];
      within?: Locator[];
      bind: string;
      fields?: Record<string, Locator[]>;
      optional?: boolean;
    }
  | {
      action: "navigate";
      url: string;
      optional?: boolean;
    }
  | {
      action: "wait";
      ms: number;
      optional?: boolean;
    }
  | {
      action: "switchTab";
      host: string;
      url?: string;
      optional?: boolean;
    }
  | {
      action: "key";
      target?: Locator[];
      within?: Locator[];
      key: string;
      optional?: boolean;
    }
  | {
      action: "submit";
      target?: Locator[];
      within?: Locator[];
      optional?: boolean;
    };

export type CompiledStep =
  | CompiledLeafStep
  | {
      action: "forEach";
      items: string | Record<string, string>[];
      steps: CompiledStep[];
      optional?: boolean;
    };

export type CompiledWorkflowStats = {
  repetitions: number;
  minutesPerWeek: number;
  manualSeconds: number;
  replaySeconds: number;
};

export type CompiledWorkflow = {
  kind: "snippet" | "workflow";
  name: string;
  reason: string;
  risk: "low" | "medium" | "high";
  offerAt2: boolean;
  runMode: "run_remaining" | "save_only";
  pauseBeforeSubmit: boolean;
  startUrl?: string;
  apps: string[];
  params: CompiledParam[];
  steps: CompiledStep[];
  stats: CompiledWorkflowStats;
};

const LocatorArraySchema = z.array(CompiledLocatorSchema).min(1);

const CompiledLeafStepSchema: z.ZodType<CompiledLeafStep> = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("click"),
      target: LocatorArraySchema,
      within: LocatorArraySchema.optional(),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("fill"),
      target: LocatorArraySchema,
      within: LocatorArraySchema.optional(),
      value: z.string(),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("insertText"),
      target: LocatorArraySchema.optional(),
      within: LocatorArraySchema.optional(),
      value: z.string(),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("select"),
      target: LocatorArraySchema,
      within: LocatorArraySchema.optional(),
      value: z.string(),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("waitFor"),
      target: LocatorArraySchema,
      within: LocatorArraySchema.optional(),
      timeoutMs: z.number().positive().optional(),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("readText"),
      target: LocatorArraySchema,
      within: LocatorArraySchema.optional(),
      bind: nonEmptyString,
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("readValue"),
      target: LocatorArraySchema,
      within: LocatorArraySchema.optional(),
      bind: nonEmptyString,
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("extractList"),
      target: LocatorArraySchema,
      within: LocatorArraySchema.optional(),
      bind: nonEmptyString,
      fields: z.record(nonEmptyString, LocatorArraySchema).optional(),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("navigate"),
      url: z.string().regex(/^https?:\/\//i, "expected http(s) URL"),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("wait"),
      ms: z.number().nonnegative(),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("switchTab"),
      host: nonEmptyString,
      url: z.string().regex(/^https?:\/\//i, "expected http(s) URL").optional(),
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("key"),
      target: LocatorArraySchema.optional(),
      within: LocatorArraySchema.optional(),
      key: nonEmptyString,
      optional: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("submit"),
      target: LocatorArraySchema.optional(),
      within: LocatorArraySchema.optional(),
      optional: z.boolean().optional(),
    }),
  ],
);

const ForEachItemsSchema = z.union([
  nonEmptyString,
  z.array(z.record(nonEmptyString, z.string())).min(1),
]);

export const CompiledStepSchema: z.ZodType<CompiledStep> = z.lazy(() =>
  z.union([
    CompiledLeafStepSchema,
    z.object({
      action: z.literal("forEach"),
      items: ForEachItemsSchema,
      steps: z.array(CompiledStepSchema).min(1),
      optional: z.boolean().optional(),
    }),
  ]),
);

export const CompiledWorkflowStatsSchema = z.object({
  repetitions: z.number().int().min(1),
  minutesPerWeek: z.number().finite().nonnegative(),
  manualSeconds: z.number().finite().nonnegative(),
  replaySeconds: z.number().finite().nonnegative(),
});

export const CompiledWorkflowSchema: z.ZodType<CompiledWorkflow> = z.object({
  kind: z.enum(["snippet", "workflow"]),
  name: nonEmptyString,
  reason: nonEmptyString,
  risk: z.enum(["low", "medium", "high"]),
  offerAt2: z.boolean(),
  runMode: z.enum(["run_remaining", "save_only"]),
  pauseBeforeSubmit: z.boolean(),
  startUrl: z
    .string()
    .regex(/^https?:\/\//i, "expected http(s) URL")
    .optional(),
  apps: z.array(nonEmptyString),
  params: z.array(CompiledParamSchema),
  steps: z.array(CompiledStepSchema).min(1),
  stats: CompiledWorkflowStatsSchema,
});

const PLACEHOLDER_HOSTS = new Set(["", "browser", "unknown", "local-page"]);

export function isPlaceholderHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  const hostname = trimmed.split(":")[0] ?? "";
  return PLACEHOLDER_HOSTS.has(trimmed) || PLACEHOLDER_HOSTS.has(hostname);
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed === "127.0.0.1") {
    return "localhost";
  }
  if (trimmed.startsWith("127.0.0.1:")) {
    return `localhost${trimmed.slice("127.0.0.1".length)}`;
  }
  return trimmed;
}

function countSteps(steps: readonly CompiledStep[]): number {
  let total = 0;
  for (const step of steps) {
    total += 1;
    if (step.action === "forEach") {
      total += countSteps(step.steps);
    }
  }
  return total;
}

const PLACEHOLDER_EMAIL_RE = /<email>/i;
const REDACTED_MARKER_RE = /\[REDACTED:/i;
const PII_TOKEN_RE = /__PII_[A-Za-z0-9_]+__/;

function findForbiddenLeak(value: unknown, pathLabel: string): string | null {
  if (typeof value === "string") {
    if (PLACEHOLDER_EMAIL_RE.test(value)) {
      return `Forbidden placeholder "<email>" at ${pathLabel}`;
    }
    if (REDACTED_MARKER_RE.test(value)) {
      return `Forbidden "[REDACTED:" marker at ${pathLabel}`;
    }
    const piiMatch = PII_TOKEN_RE.exec(value);
    if (piiMatch) {
      return `Unrestored PII token "${piiMatch[0]}" at ${pathLabel}`;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = findForbiddenLeak(value[i], `${pathLabel}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const err = findForbiddenLeak(entry, `${pathLabel}.${key}`);
      if (err) return err;
    }
  }
  return null;
}

function checkTemplateStrings(
  str: string,
  bindings: ReadonlySet<string>,
  pathLabel: string,
): string | null {
  let idx = 0;
  while (idx < str.length) {
    const open = str.indexOf("{{", idx);
    if (open === -1) {
      if (str.indexOf("}}", idx) !== -1) {
        return `Unmatched "}}" template delimiter at ${pathLabel}`;
      }
      break;
    }
    const close = str.indexOf("}}", open + 2);
    if (close === -1) {
      return `Unclosed "{{" template delimiter at ${pathLabel}`;
    }
    const rawName = str.slice(open + 2, close).trim();
    if (!rawName) {
      return `Empty "{{}}" binding at ${pathLabel}`;
    }
    if (!bindings.has(rawName)) {
      return `Unbound parameter "{{${rawName}}}" at ${pathLabel}`;
    }
    idx = close + 2;
  }
  return null;
}

function checkLocatorsTemplates(
  locators: readonly Locator[] | undefined,
  bindings: ReadonlySet<string>,
  pathLabel: string,
): string | null {
  if (!locators) return null;
  for (let i = 0; i < locators.length; i++) {
    const err = checkTemplateStrings(
      locators[i].value,
      bindings,
      `${pathLabel}[${i}].value`,
    );
    if (err) return err;
  }
  return null;
}

function checkUrlHost(rawUrl: string, pathLabel: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `Invalid URL "${rawUrl}" at ${pathLabel}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Unsupported URL protocol at ${pathLabel}`;
  }
  if (parsed.hostname !== normalizeHost(parsed.hostname)) {
    return `Unnormalized host "${parsed.hostname}" at ${pathLabel}`;
  }
  return null;
}

function checkSteps(
  steps: readonly CompiledStep[],
  bindings: Set<string>,
  extractFieldsByBind: Map<string, string[]>,
  pathPrefix: string,
): string | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepPath = `${pathPrefix}[${i}]`;

    if (step.action === "forEach") {
      const loopBindings = new Set<string>(bindings);
      if (typeof step.items === "string") {
        if (step.items.includes("{{") || step.items.includes("}}")) {
          return `forEach.items must be a plain binding name at ${stepPath}`;
        }
        if (!bindings.has(step.items)) {
          return `forEach.items references unknown binding "${step.items}" at ${stepPath}`;
        }
        const extractedFields = extractFieldsByBind.get(step.items);
        if (extractedFields) {
          for (const field of extractedFields) {
            loopBindings.add(field);
          }
        }
      } else {
        const firstRow = step.items[0];
        if (firstRow) {
          for (const key of Object.keys(firstRow)) {
            if (step.items.every((row) => Object.prototype.hasOwnProperty.call(row, key))) {
              loopBindings.add(key);
            }
          }
        }
      }

      const nestedErr = checkSteps(
        step.steps,
        loopBindings,
        extractFieldsByBind,
        `${stepPath}.steps`,
      );
      if (nestedErr) return nestedErr;
      continue;
    }

    if (step.action === "switchTab") {
      if (step.host.includes("://") || step.host.includes("/")) {
        return `switchTab.host must be a hostname without scheme/path at ${stepPath}`;
      }
      if (isPlaceholderHost(step.host)) {
        return `Invalid placeholder switchTab host "${step.host}" at ${stepPath}`;
      }
      if (step.host !== normalizeHost(step.host)) {
        return `Unnormalized switchTab host "${step.host}" at ${stepPath}`;
      }
      if (step.url !== undefined) {
        const urlErr = checkUrlHost(step.url, `${stepPath}.url`);
        if (urlErr) return urlErr;
        const tmplErr = checkTemplateStrings(step.url, bindings, `${stepPath}.url`);
        if (tmplErr) return tmplErr;
      }
    }

    if (step.action === "navigate") {
      const urlErr = checkUrlHost(step.url, `${stepPath}.url`);
      if (urlErr) return urlErr;
      const tmplErr = checkTemplateStrings(step.url, bindings, `${stepPath}.url`);
      if (tmplErr) return tmplErr;
    }

    if ("target" in step && step.target) {
      const err = checkLocatorsTemplates(step.target, bindings, `${stepPath}.target`);
      if (err) return err;
    }

    if ("within" in step && step.within) {
      const err = checkLocatorsTemplates(step.within, bindings, `${stepPath}.within`);
      if (err) return err;
    }

    if ("value" in step && typeof step.value === "string") {
      const err = checkTemplateStrings(step.value, bindings, `${stepPath}.value`);
      if (err) return err;
    }

    if (
      step.action === "readText" ||
      step.action === "readValue" ||
      step.action === "extractList"
    ) {
      if (step.bind.includes("{{") || step.bind.includes("}}")) {
        return `Invalid bind name "${step.bind}" at ${stepPath}.bind`;
      }
      bindings.add(step.bind);
      if (step.action === "extractList" && step.fields) {
        extractFieldsByBind.set(step.bind, Object.keys(step.fields));
      }
    }
  }

  return null;
}

export function validateCompiledWorkflow(
  workflow: CompiledWorkflow,
  opts?: { maxSteps?: number },
): { ok: true; value: CompiledWorkflow } | { ok: false; error: string } {
  const parsed = CompiledWorkflowSchema.safeParse(workflow);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `Schema validation failed: ${details}` };
  }

  const data = parsed.data;
  const maxSteps = opts?.maxSteps ?? DEFAULT_MAX_COMPILED_STEPS;
  const totalSteps = countSteps(data.steps);
  if (totalSteps > maxSteps) {
    return {
      ok: false,
      error: `Step count ${totalSteps} exceeds maxSteps (${maxSteps})`,
    };
  }

  const leakErr = findForbiddenLeak(data, "workflow");
  if (leakErr) {
    return { ok: false, error: leakErr };
  }

  for (let i = 0; i < data.apps.length; i++) {
    const app = data.apps[i];
    if (app.includes("://") || app.includes("/")) {
      return { ok: false, error: `Invalid app host "${app}" at apps[${i}]` };
    }
    if (app !== normalizeHost(app)) {
      return { ok: false, error: `Unnormalized host "${app}" at apps[${i}]` };
    }
  }

  if (data.startUrl !== undefined) {
    const urlErr = checkUrlHost(data.startUrl, "startUrl");
    if (urlErr) {
      return { ok: false, error: urlErr };
    }
  }

  const paramNames = new Set<string>();
  for (let i = 0; i < data.params.length; i++) {
    const name = data.params[i].name.trim();
    if (name.includes("{{") || name.includes("}}")) {
      return { ok: false, error: `Invalid param name "${name}" at params[${i}]` };
    }
    if (paramNames.has(name)) {
      return { ok: false, error: `Duplicate param name "${name}"` };
    }
    paramNames.add(name);
  }

  const stepErr = checkSteps(data.steps, new Set(paramNames), new Map(), "steps");
  if (stepErr) {
    return { ok: false, error: stepErr };
  }

  return { ok: true, value: data };
}
