import {
  ACTION_SCRIPT_RESPONSE_SCHEMA,
  parseActionScript,
  type ActionScript,
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

Locator rules (plain-text grounding without DOM snapshot):
- "css": Prefer resilient selectors for inputs, e.g. 'input[type="email"], input[name*="email" i], input[placeholder*="email" i]' or 'textarea'.
- "xpath": Prefer for buttons, links, or labeled fields when exact text/casing on the page is uncertain, e.g. "//button[contains(normalize-space(.), 'Reply')]".
- "text" and "aria": Only use when the exact trimmed text or exact aria-label is explicitly stated.
- "testid": Only use when an explicit data-testid is given in the instructions.

Safety rules:
- Stop BEFORE irreversible actions (Send, Submit, Delete, Remove, Pay, Checkout, Purchase, Confirm). Fill/prepare everything, then stop so the human confirms.
- Never read, fill, or target password or payment-card fields.`;

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

const unconfiguredGenerator: ImplementorGenerator = async () => {
  throw new Error("Gemini generator is not wired yet; pass { generate } to implementSolution");
};

export async function implementSolution(
  solutionText: string,
  opts: ImplementorOptions = {},
): Promise<ActionScript> {
  if (typeof solutionText !== "string" || solutionText.trim().length === 0) {
    throw new Error("solutionText must be a non-empty string");
  }

  const generate = opts.generate ?? unconfiguredGenerator;
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
