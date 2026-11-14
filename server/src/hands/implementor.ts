import { createHash } from "node:crypto";
import {
  createGeminiClient,
  type GeminiClientOptions,
} from "../llm/gemini.ts";
import {
  ACTION_SCRIPT_RESPONSE_SCHEMA,
  ActionScriptSchema,
  EyesDetectionSpecSchema,
  IMPLEMENTED_LIBRARY_RESPONSE_SCHEMA,
  ImplementedLibraryDraftSchema,
  LibraryEntrySchema,
  parseActionScript,
  parseImplementedLibraryDraft,
  type ActionScript,
  type EyesDetectionSpec,
  type ImplementedLibraryDraft,
  type LibraryEntry,
  type LibraryEntryKind,
  type Locator,
  type Step,
} from "./types.ts";

export type ImplementorGeneratorInput = {
  systemInstruction: string;
  prompt: string;
  responseSchema: typeof ACTION_SCRIPT_RESPONSE_SCHEMA;
};

export type ImplementorGenerator = (input: ImplementorGeneratorInput) => Promise<unknown>;

export type ImplementorOptions = {
  name?: string;
  generate?: ImplementorGenerator;
  gemini?: GeminiClientOptions;
};

export type ImplementContext = {
  app?: string;
  url?: string;
  title?: string;
  targetLabel?: string;
  targetRole?: string;
  locators?: Locator[];
};

export type ImplementLibraryGeneratorInput = {
  systemInstruction: string;
  prompt: string;
  responseSchema: typeof IMPLEMENTED_LIBRARY_RESPONSE_SCHEMA;
};

export type ImplementLibraryGenerator = (
  input: ImplementLibraryGeneratorInput,
) => Promise<unknown>;

export type ImplementForLibraryOptions = {
  name?: string;
  context?: ImplementContext;
  generate?: ImplementLibraryGenerator;
  gemini?: GeminiClientOptions;
  now?: number;
};

export const IMPLEMENTOR_SYSTEM_INSTRUCTION = `You are the Implementor. You convert a plain-text solution from the Planner into an executable browser ActionScript JSON for Hands.

Output ONLY valid JSON matching the provided schema.

Available actions:
- insertText: { action: "insertText", value, target? } -> Omit target when inserting/typing into the already-focused field or reply box.
- fill: { action: "fill", target, value } -> Sets value on <input>, <textarea>, or contenteditable. Never use fill on <select>.
- select: { action: "select", target, value } -> Picks an option on <select>.
- click: { action: "click", target } -> Clicks a button, link, or control.
- waitFor: { action: "waitFor", target, timeoutMs? } -> Emit before interacting with elements that load after navigate or modal-opening clicks (default timeoutMs: 5000).
- readText / readValue: { action: "readText" | "readValue", target, bind } -> Saves element text/value into variable <bind>, referenced later as "{{<bind>}}".
- extractList: { action: "extractList", target, bind, fields? } -> Extracts repeating row elements into <bind>; each field locator is relative to the row.
- forEach: { action: "forEach", items, steps } -> Loops over an extractList binding. Set items to the plain binding key (e.g. "rows", NOT "{{rows}}") and reference row fields as "{{fieldName}}".
- navigate: { action: "navigate", url } -> Full http:// or https:// URL only.
- wait: { action: "wait", ms } -> Short delay in ms only when explicitly needed.
- switchTab: { action: "switchTab", host } -> If the solution reads values on one site and fills them on another, use readText on the first site, then {action:'switchTab', host:'<dest host>'}, then fill with {{binding}}.

Locator rules (plain-text grounding without DOM snapshot):
- "css": Prefer resilient selectors for inputs, e.g. 'input[type="search"], input[name="q"], input[placeholder*="search" i]' or 'input[type="email"], input[name*="email" i]'.
- "xpath": Prefer for buttons, links, or labeled fields when exact text/casing on the page is uncertain, e.g. "//button[contains(normalize-space(.), 'Reply')]".
- "text" and "aria": Only use when the exact trimmed text or exact aria-label is explicitly stated.
- "testid": Only use when an explicit data-testid is given in the instructions.`;

export function buildImplementorPrompt(solutionText: string, name?: string): string {
  const header = name?.trim() ? `Script name: ${name.trim()}\n\n` : "";
  return `${header}Convert the following plain-text Planner solution into a Hands ActionScript:\n\n${solutionText.trim()}`;
}

function unwrapJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const jsonText = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "invalid JSON";
    throw new Error(`Generator returned invalid JSON: ${reason}`);
  }
}

function createGeminiGenerator(geminiOpts?: GeminiClientOptions): ImplementorGenerator {
  return async ({ systemInstruction, prompt, responseSchema }) => {
    const gemini = createGeminiClient(geminiOpts);
    const fullPrompt = [
      systemInstruction,
      "",
      "Output JSON strictly matching this JSON Schema:",
      JSON.stringify(responseSchema),
      "",
      prompt,
    ].join("\n");
    return gemini.generateJson(fullPrompt, ActionScriptSchema);
  };
}

export async function implementSolution(
  solutionText: string,
  opts: ImplementorOptions = {},
): Promise<ActionScript> {
  if (typeof solutionText !== "string" || solutionText.trim().length === 0) {
    throw new Error("solutionText must be a non-empty string");
  }

  const generate = opts.generate ?? createGeminiGenerator(opts.gemini);
  const raw = await generate({
    systemInstruction: IMPLEMENTOR_SYSTEM_INSTRUCTION,
    prompt: buildImplementorPrompt(solutionText, opts.name),
    responseSchema: ACTION_SCRIPT_RESPONSE_SCHEMA,
  });

  const script = parseActionScript(unwrapJson(raw));
  if (opts.name?.trim()) {
    return { ...script, name: opts.name.trim() };
  }
  return script;
}

export const IMPLEMENT_LIBRARY_SYSTEM_INSTRUCTION = `${IMPLEMENTOR_SYSTEM_INSTRUCTION}

In addition to \`script\`, output \`name\`, \`description\`, \`kind\`, and \`eyes\` so Eyes can recognize when the user is about to repeat this task BEFORE they finish doing it manually.

Rules for \`eyes\` (condition-driven, non-brittle, low-hallucination detection):
- \`intent\`: short snake_case semantic name, e.g. "insert_shipping_reply" or "fill_supplier_profile".
- \`scope\`:
  - \`apps\`: hostnames ONLY if known or stated (never use "*" or invent domains).
  - \`urlPatterns\`: path patterns with "*" for numeric/UUID IDs (e.g. "/tickets/*", "/orders/*"). Never hardcode one-off IDs.
  - \`pageHints\`: 1-4 lowercase domain keywords expected in the page title, heading, or URL (e.g. ["support", "ticket", "order"] or ["supplier", "profile"]).
- \`targetHints\`:
  - \`roles\`: standard ARIA roles like ["textbox"], ["button"], ["combobox"], ["searchbox"].
  - \`labelContains\`: lowercase semantic keywords likely found in the field's label, placeholder, aria-label, or name (e.g. ["reply", "customer"] or ["company", "email"]). Never use generic words like "input", "field", "box", "button", "text", "page".
  - \`locators\`: ONLY copy concrete locators from \`script.steps\` or provided context; NEVER invent fake IDs or testids.
- \`textHints\`:
  - \`prefixHints\`: for text fills/snippets, 1-2 lowercase opening phrases (8-24 chars) the user might start typing (e.g. ["hi, thanks for", "thanks, your order"]). Empty array for non-text workflows.
  - \`minCharsBeforeMatch\`: 0 for field+page scoped fills; 5-10 when relying on \`prefixHints\`.
- \`guards\`:
  - \`fieldEmptyOnly\`: true for fills/snippets so Eyes does not interrupt edits to already-filled fields.
  - \`requireClipboard\`: true only if workflow depends on clipboard contents.
  - \`cooldownMs\`: 60000 (or higher).
  - \`minSignals\`: require >= 2 agreeing signals (e.g. pageHints + labelContains, or role + prefixHints) unless both \`apps\` and concrete \`locators\`/\`urlPatterns\` are present.`;

const GENERIC_HINT_STOPWORDS = new Set([
  "input",
  "field",
  "box",
  "textbox",
  "textarea",
  "button",
  "btn",
  "link",
  "form",
  "page",
  "site",
  "app",
  "tab",
  "click",
  "type",
  "text",
  "value",
  "item",
  "data",
  "current",
  "user",
  "submit",
  "ok",
  "enter",
  "select",
  "fill",
  "insert",
  "here",
  "control",
  "element",
  "the",
  "and",
  "for",
  "with",
]);

function dedupeStrings(values: string[], limit = 10): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const val of values) {
    const clean = val.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanHintTokens(rawList: string[], limit = 8): string[] {
  const cleaned: string[] = [];
  for (const raw of rawList) {
    const norm = raw
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!norm) continue;
    const words = norm.split(" ").filter((w) => w.length >= 2 && !GENERIC_HINT_STOPWORDS.has(w));
    if (words.length === 0) continue;
    const phrase = words.join(" ");
    if (phrase.length >= 3) cleaned.push(phrase);
    if (words.length > 1) {
      for (const word of words) {
        if (word.length >= 4) cleaned.push(word);
      }
    }
  }
  return dedupeStrings(cleaned, limit);
}

function normalizeAppHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "*" || trimmed === "any" || trimmed === "all") return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }
  const host = trimmed.split("/")[0]?.split(":")[0] ?? "";
  if (!host || host === "*") return null;
  return host;
}

function normalizeUrlPattern(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*" || trimmed === "/*") return null;
  let pathname = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      pathname = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }
  pathname = pathname.split("?")[0]?.split("#")[0] ?? "";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg === "*") return "*";
      if (/^\d+$/.test(seg)) return "*";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
        return "*";
      }
      if (/^[0-9a-f]{12,}$/i.test(seg)) return "*";
      return seg.toLowerCase();
    });
  if (segments.length === 0) return null;
  return `/${segments.join("/")}`;
}

function dedupeLocators(locators: Locator[], limit = 6): Locator[] {
  const out: Locator[] = [];
  const seen = new Set<string>();
  for (const loc of locators) {
    const value = loc.value.trim();
    if (!value) continue;
    const key = `${loc.kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: loc.kind, value });
    if (out.length >= limit) break;
  }
  return out;
}

function extractLabelsFromLocator(locator: Locator): string[] {
  const hints: string[] = [];
  const v = locator.value;
  const attrMatches = v.matchAll(
    /(?:name|aria-label|placeholder|data-testid)\s*[*^$~]?=\s*["']([^"']+)["']/gi,
  );
  for (const match of attrMatches) {
    if (match[1]) hints.push(match[1]);
  }
  const idMatch = /#([A-Za-z][A-Za-z0-9_-]{2,})/.exec(v);
  if (idMatch?.[1]) hints.push(idMatch[1]);
  if (locator.kind === "text" || locator.kind === "testid") {
    hints.push(v);
  }
  const xpathTextMatches = v.matchAll(/["']([^"']{3,40})["']/g);
  if (locator.kind === "xpath") {
    for (const match of xpathTextMatches) {
      if (match[1]) hints.push(match[1]);
    }
  }
  return hints;
}

function extractPrefixHint(text: string): string | null {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length < 12 || /\{\{[^}]+\}\}/.test(collapsed)) return null;
  const lower = collapsed.toLowerCase();
  if (lower.length <= 24) return lower;
  const slice = lower.slice(0, 24);
  const lastSpace = slice.lastIndexOf(" ");
  const snapped = lastSpace >= 8 ? slice.slice(0, lastSpace) : slice;
  return snapped.trim().length >= 4 ? snapped.trim() : null;
}

function collectStepSignals(steps: Step[]): {
  locators: Locator[];
  roles: string[];
  labelHints: string[];
  apps: string[];
  urlPatterns: string[];
  prefixHints: string[];
  hasClick: boolean;
  hasTextEntry: boolean;
  hasTargetlessInsert: boolean;
  hasNavigate: boolean;
  hasExtractList: boolean;
  hasBindingRef: boolean;
} {
  const locators: Locator[] = [];
  const roles: string[] = [];
  const labelHints: string[] = [];
  const apps: string[] = [];
  const urlPatterns: string[] = [];
  const prefixHints: string[] = [];
  let hasClick = false;
  let hasTextEntry = false;
  let hasTargetlessInsert = false;
  let hasNavigate = false;
  let hasExtractList = false;
  let hasBindingRef = false;

  const visit = (list: Step[]): void => {
    for (const step of list) {
      if ("target" in step && step.target) {
        if (step.action !== "waitFor") {
          locators.push(step.target);
        }
        labelHints.push(...extractLabelsFromLocator(step.target));
      }
      switch (step.action) {
        case "fill":
        case "insertText": {
          hasTextEntry = true;
          roles.push("textbox");
          if (step.action === "insertText" && !step.target) {
            hasTargetlessInsert = true;
          }
          if (/\{\{[^}]+\}\}/.test(step.value)) {
            hasBindingRef = true;
          } else {
            const prefix = extractPrefixHint(step.value);
            if (prefix) prefixHints.push(prefix);
          }
          break;
        }
        case "select":
          roles.push("combobox");
          break;
        case "click":
          hasClick = true;
          roles.push("button");
          break;
        case "navigate": {
          hasNavigate = true;
          const host = normalizeAppHost(step.url);
          if (host) apps.push(host);
          const pat = normalizeUrlPattern(step.url);
          if (pat) urlPatterns.push(pat);
          break;
        }
        case "extractList":
          hasExtractList = true;
          break;
        case "forEach":
          visit(step.steps);
          break;
        default:
          break;
      }
    }
  };

  visit(steps);
  return {
    locators: dedupeLocators(locators),
    roles: dedupeStrings(roles, 4),
    labelHints,
    apps: dedupeStrings(apps, 6),
    urlPatterns: dedupeStrings(urlPatterns, 6),
    prefixHints: dedupeStrings(prefixHints, 4),
    hasClick,
    hasTextEntry,
    hasTargetlessInsert,
    hasNavigate,
    hasExtractList,
    hasBindingRef,
  };
}

function inferKind(script: ActionScript, explicitKind?: LibraryEntryKind): LibraryEntryKind {
  if (explicitKind) return explicitKind;
  if (
    script.steps.length === 1 &&
    script.steps[0]?.action === "insertText" &&
    !script.steps[0].target
  ) {
    return "snippet";
  }
  return "workflow";
}

function toIntentSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "saved_automation";
}

export function buildGroundedEyesSpec(input: {
  rawEyes?: ImplementedLibraryDraft["eyes"];
  script: ActionScript;
  solution: string;
  name?: string;
  kind?: LibraryEntryKind;
  context?: ImplementContext;
}): EyesDetectionSpec {
  const { rawEyes, script, solution, name, context } = input;
  const kind = inferKind(script, input.kind);
  const signals = collectStepSignals(script.steps);

  const rawApps = [
    ...(rawEyes?.scope?.apps ?? []),
    ...(context?.app ? [context.app] : []),
    ...(context?.url ? [context.url] : []),
    ...signals.apps,
  ]
    .map(normalizeAppHost)
    .filter((v): v is string => v !== null);
  const apps = dedupeStrings(rawApps, 6);

  const rawPatterns = [
    ...(rawEyes?.scope?.urlPatterns ?? []),
    ...(context?.url ? [context.url] : []),
    ...signals.urlPatterns,
  ]
    .map(normalizeUrlPattern)
    .filter((v): v is string => v !== null);
  const urlPatterns = dedupeStrings(rawPatterns, 6);

  const pageHints = cleanHintTokens(
    [...(rawEyes?.scope?.pageHints ?? []), ...(context?.title ? [context.title] : [])],
    8,
  );

  const roles = dedupeStrings(
    [
      ...(rawEyes?.targetHints?.roles ?? []).map((r) => r.toLowerCase().trim()),
      ...(context?.targetRole ? [context.targetRole.toLowerCase().trim()] : []),
      ...signals.roles,
    ].filter(Boolean),
    5,
  );

  const labelContains = cleanHintTokens(
    [
      ...(rawEyes?.targetHints?.labelContains ?? []),
      ...(context?.targetLabel ? [context.targetLabel] : []),
      ...signals.labelHints,
    ],
    8,
  );

  const locators = dedupeLocators(
    [
      ...(context?.locators ?? []),
      ...signals.locators,
      ...(rawEyes?.targetHints?.locators ?? []),
    ],
    6,
  );

  const prefixHints = dedupeStrings(
    [...(rawEyes?.textHints?.prefixHints ?? []), ...signals.prefixHints]
      .map((p) => p.toLowerCase().replace(/\s+/g, " ").trim())
      .filter((p) => p.length >= 4 && !/\{\{[^}]+\}\}/.test(p)),
    4,
  );

  let minCharsBeforeMatch = rawEyes?.textHints?.minCharsBeforeMatch ?? 0;
  const hasScopeAnchor = apps.length > 0 || urlPatterns.length > 0 || pageHints.length > 0;
  const hasTargetAnchor = locators.length > 0 || labelContains.length > 0;

  if (
    prefixHints.length > 0 &&
    (!hasScopeAnchor || kind === "snippet" || signals.hasTargetlessInsert)
  ) {
    minCharsBeforeMatch = Math.max(minCharsBeforeMatch, 5);
  }

  const rawMinSignals = rawEyes?.guards?.minSignals ?? 2;
  let minSignals = Math.min(4, Math.max(1, Math.round(rawMinSignals)));
  if (!hasScopeAnchor) {
    minSignals = Math.max(minSignals, hasTargetAnchor ? 2 : 3);
  } else if (!(apps.length > 0 && (urlPatterns.length > 0 || locators.length > 0))) {
    minSignals = Math.max(minSignals, 2);
  }

  const fieldEmptyOnly =
    rawEyes?.guards?.fieldEmptyOnly ?? (signals.hasTextEntry || kind === "snippet");
  const requireClipboard = rawEyes?.guards?.requireClipboard ?? false;
  const cooldownMs = Math.max(10_000, Math.round(rawEyes?.guards?.cooldownMs ?? 60_000));

  const intent = toIntentSlug(rawEyes?.intent?.trim() || name || script.name || solution);

  return EyesDetectionSpecSchema.parse({
    intent,
    scope: { apps, urlPatterns, pageHints },
    targetHints: { roles, labelContains, locators },
    textHints: { prefixHints, minCharsBeforeMatch },
    guards: { fieldEmptyOnly, requireClipboard, cooldownMs, minSignals },
  });
}

export function buildLibraryEntryFromScript(input: {
  name?: string;
  description?: string;
  kind?: LibraryEntryKind;
  solution: string;
  script: ActionScript;
  eyes?: ImplementedLibraryDraft["eyes"];
  context?: ImplementContext;
  status?: LibraryEntry["status"];
  now?: number;
}): LibraryEntry {
  const now = input.now ?? Date.now();
  const cleanSolution = input.solution.trim();
  const name =
    input.name?.trim() || input.script.name?.trim() || cleanSolution.slice(0, 48) || "Automation";
  const script: ActionScript = input.script.name ? input.script : { ...input.script, name };
  const kind = inferKind(script, input.kind);
  const eyes = buildGroundedEyesSpec({
    rawEyes: input.eyes,
    script,
    solution: cleanSolution,
    name,
    kind,
    context: input.context,
  });
  const description =
    input.description?.trim() ||
    (cleanSolution.length > 140 ? `${cleanSolution.slice(0, 137).trim()}...` : cleanSolution);
  const idHash = createHash("sha256")
    .update(`${name.toLowerCase()}::${cleanSolution.toLowerCase()}`)
    .digest("hex")
    .slice(0, 10);

  return LibraryEntrySchema.parse({
    id: `lib_${idHash}`,
    name,
    description,
    kind,
    status: input.status ?? "suggested",
    solution: cleanSolution,
    script,
    eyes,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  });
}

export function buildImplementLibraryPrompt(
  solutionText: string,
  opts: { name?: string; context?: ImplementContext } = {},
): string {
  const lines: string[] = [];
  if (opts.name?.trim()) lines.push(`Name: ${opts.name.trim()}`);
  if (opts.context) {
    const ctxParts: string[] = [];
    if (opts.context.app) ctxParts.push(`app=${opts.context.app}`);
    if (opts.context.url) ctxParts.push(`url=${opts.context.url}`);
    if (opts.context.title) ctxParts.push(`title=${opts.context.title}`);
    if (opts.context.targetLabel) ctxParts.push(`targetLabel=${opts.context.targetLabel}`);
    if (opts.context.targetRole) ctxParts.push(`targetRole=${opts.context.targetRole}`);
    if (opts.context.locators?.length) {
      ctxParts.push(`locators=${JSON.stringify(opts.context.locators)}`);
    }
    if (ctxParts.length > 0) lines.push(`Observed context: ${ctxParts.join(", ")}`);
  }
  lines.push(
    "Compile the following Planner solution into a Hands ActionScript and Eyes detection metadata:",
  );
  lines.push("");
  lines.push(solutionText.trim());
  return lines.join("\n");
}

function createGeminiLibraryGenerator(
  geminiOpts?: GeminiClientOptions,
): ImplementLibraryGenerator {
  return async ({ systemInstruction, prompt, responseSchema }) => {
    const gemini = createGeminiClient(geminiOpts);
    const fullPrompt = [
      systemInstruction,
      "",
      "Output JSON strictly matching this JSON Schema:",
      JSON.stringify(responseSchema),
      "",
      prompt,
    ].join("\n");
    return gemini.generateJson(fullPrompt, ImplementedLibraryDraftSchema);
  };
}

export async function implementForLibrary(
  solutionText: string,
  opts: ImplementForLibraryOptions = {},
): Promise<LibraryEntry> {
  if (typeof solutionText !== "string" || solutionText.trim().length === 0) {
    throw new Error("solutionText must be a non-empty string");
  }

  const generate = opts.generate ?? createGeminiLibraryGenerator(opts.gemini);
  const raw = await generate({
    systemInstruction: IMPLEMENT_LIBRARY_SYSTEM_INSTRUCTION,
    prompt: buildImplementLibraryPrompt(solutionText, {
      name: opts.name,
      context: opts.context,
    }),
    responseSchema: IMPLEMENTED_LIBRARY_RESPONSE_SCHEMA,
  });

  const draft = parseImplementedLibraryDraft(unwrapJson(raw));
  return buildLibraryEntryFromScript({
    name: opts.name ?? draft.name,
    description: draft.description,
    kind: draft.kind,
    solution: solutionText,
    script: draft.script,
    eyes: draft.eyes,
    context: opts.context,
    now: opts.now,
  });
}
