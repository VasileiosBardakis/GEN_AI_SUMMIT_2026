import type { ActionScript } from "./types.ts";

export type SuggestionKind = "text" | "click";

export type FlowNodeKind =
  | "click"
  | "input"
  | "tab"
  | "paste"
  | "loop"
  | "ai"
  | "done";

export interface FlowNode {
  kind: FlowNodeKind;
  label: string;
}

export interface SuggestionParam {
  name: string;
  example?: string;
}

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  count: number;
  preview: string;
  snippetText?: string;
  headline: string;
  detail: string;
  solution?: string;
  meta: string;
  videoUrl?: string;
  pauseBeforeSubmit?: boolean;
  runMode?: "run" | "save_only";
  params?: SuggestionParam[];
  primaryLabel?: string;
  pauseNotice?: string;
  flows: {
    user: FlowNode[];
    proposed: FlowNode[];
  };
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function collapsePreview(value: string, max = 64): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}...` : collapsed;
}

export interface DeciderProposalInput {
  name: string;
  solution: string;
  script: ActionScript;
  videoUrl?: string;
  pauseBeforeSubmit?: boolean;
  runMode?: "run" | "save_only";
  params?: SuggestionParam[];
  primaryLabel?: string;
  pauseNotice?: string;
}

function describeTarget(target: unknown): string | undefined {
  const first = Array.isArray(target) ? target[0] : target;
  if (!first || typeof first !== "object" || !("value" in first) || !("kind" in first)) return undefined;
  const val = typeof first.value === "string" ? first.value.trim() : "";
  if (!val) return undefined;
  if (first.kind === "text") return collapsePreview(val, 18);
  if (first.kind === "aria") {
    const m = /name\s*=\s*["']([^"']+)["']/i.exec(val);
    if (m?.[1]) return collapsePreview(m[1], 18);
  }
  if (first.kind === "testid") {
    return collapsePreview(val.replace(/[-_]+/g, " "), 18);
  }
  return undefined;
}

function stepToUserFlowNode(step: ActionScript["steps"][number]): FlowNode {
  const targetLabel = "target" in step ? describeTarget(step.target) : undefined;
  switch (step.action) {
    case "fill":
    case "insertText": {
      if (typeof step.value === "string" && step.value.trim().length > 0) {
        const tmpl = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(step.value.trim());
        if (tmpl) {
          return { kind: "input", label: `Fill ${collapsePreview(tmpl[1], 16)}` };
        }
        return { kind: "input", label: `Type "${collapsePreview(step.value, 18)}"` };
      }
      return { kind: "input", label: targetLabel ? `Fill ${targetLabel}` : "Type text" };
    }
    case "readText":
    case "readValue":
      return {
        kind: "paste",
        label: "bind" in step && typeof step.bind === "string"
          ? `Read ${collapsePreview(step.bind, 16)}`
          : "Read value",
      };
    case "extractList":
      return { kind: "paste", label: "Scan list" };
    case "select":
      return { kind: "click", label: targetLabel ? `Select ${targetLabel}` : "Select option" };
    case "pressKey":
      return { kind: "input", label: `Press ${"key" in step && step.key ? step.key : "Enter"}` };
    case "navigate":
      return { kind: "tab", label: "Open page" };
    case "switchTab":
      return { kind: "tab", label: "host" in step && step.host ? `Tab: ${collapsePreview(step.host, 14)}` : "Switch tab" };
    case "forEach":
      return { kind: "loop", label: "Repeat rows" };
    default:
      return { kind: "click", label: targetLabel ? `Click "${targetLabel}"` : "Click target" };
  }
}

function collectBoundAndLoopKeys(steps: ActionScript["steps"]): {
  boundKeys: Set<string>;
  loopItemKeys: Set<string>;
  hasForEach: boolean;
  forEachCount?: number;
  bodySteps: ActionScript["steps"];
} {
  const boundKeys = new Set<string>();
  const loopItemKeys = new Set<string>();
  let hasForEach = false;
  let forEachCount: number | undefined;
  const bodySteps: ActionScript["steps"] = [];

  const walk = (list: ActionScript["steps"], inLoop: boolean): void => {
    for (const step of list) {
      if (step.action === "forEach") {
        hasForEach = true;
        if (Array.isArray(step.items)) {
          forEachCount = step.items.length;
          const sample = step.items[0];
          if (sample && typeof sample === "object") {
            for (const key of Object.keys(sample)) {
              loopItemKeys.add(key);
            }
          }
        }
        walk(step.steps, true);
        continue;
      }
      if (
        (step.action === "readText" || step.action === "readValue" || step.action === "extractList") &&
        "bind" in step &&
        typeof step.bind === "string"
      ) {
        boundKeys.add(step.bind.trim());
      }
      if ("withinTextParam" in step && typeof (step as { withinTextParam?: unknown }).withinTextParam === "string") {
        loopItemKeys.add(((step as { withinTextParam: string }).withinTextParam).trim());
      }
      if (inLoop || !hasForEach) {
        bodySteps.push(step);
      }
    }
  };

  walk(steps, false);
  return { boundKeys, loopItemKeys, hasForEach, forEachCount, bodySteps };
}

function collectUnboundTemplateVars(steps: ActionScript["steps"], boundKeys: Set<string>, loopItemKeys: Set<string>): Set<string> {
  const vars = new Set<string>();
  const visitVal = (val: unknown): void => {
    if (typeof val === "string") {
      for (const m of val.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
        const key = m[1]?.trim();
        if (key && !boundKeys.has(key) && !loopItemKeys.has(key)) {
          vars.add(key);
        }
      }
    } else if (Array.isArray(val)) {
      val.forEach(visitVal);
    } else if (val && typeof val === "object") {
      for (const [k, v] of Object.entries(val)) {
        if (k === "bind" || k === "items") continue;
        visitVal(v);
      }
    }
  };
  visitVal(steps);
  return vars;
}

export function buildDeciderSuggestion(input: DeciderProposalInput): Suggestion {
  const name = input.name.trim() || (input.script.name ?? "").trim() || "Proposed automation";
  const solution = input.solution.trim();
  const steps = input.script.steps;
  const firstStep = steps[0];
  const isSingleInsert =
    steps.length === 1 &&
    firstStep?.action === "insertText" &&
    !firstStep.target &&
    typeof firstStep.value === "string";
  const isFlowTip = input.primaryLabel?.trim() === "Got it";

  const previewSource = isFlowTip
    ? (input.script.name?.trim() || name)
    : isSingleInsert && typeof firstStep.value === "string"
      ? firstStep.value
      : name;

  const { boundKeys, loopItemKeys, hasForEach, forEachCount, bodySteps } = collectBoundAndLoopKeys(steps);
  const meaningfulSteps = bodySteps.filter((s) => s.action !== "wait" && s.action !== "switchTab");
  const flowSourceSteps = meaningfulSteps.length > 0 ? meaningfulSteps : bodySteps;
  const userNodes: FlowNode[] = flowSourceSteps.slice(0, 3).map(stepToUserFlowNode);
  if (userNodes.length === 0) {
    userNodes.push({ kind: "click", label: "Run manually" });
  }
  userNodes.push({
    kind: "loop",
    label: forEachCount && forEachCount > 0 ? `×${forEachCount} remaining` : "Repeat",
  });

  const effectiveStepCount = hasForEach ? Math.max(1, bodySteps.length) : steps.length;
  const stepLabel = `${effectiveStepCount} ${effectiveStepCount === 1 ? "step" : "steps"}`;
  const runMode = input.runMode;
  const pauseBeforeSubmit = input.pauseBeforeSubmit;
  const pauseNotice =
    input.pauseNotice?.trim() ||
    (pauseBeforeSubmit ? "Pauses before submit — you click the final button." : undefined);
  const videoUrl =
    !isSingleInsert && !isFlowTip && typeof input.videoUrl === "string" && input.videoUrl.trim().length > 0
      ? input.videoUrl.trim()
      : undefined;
  const primaryLabel =
    input.primaryLabel?.trim() ||
    (runMode === "save_only" ? "Save skill" : undefined);

  const unboundVars = collectUnboundTemplateVars(steps, boundKeys, loopItemKeys);
  const params =
    Array.isArray(input.params) && input.params.length > 0
      ? input.params
          .filter((param) => {
            if (typeof param?.name !== "string") return false;
            const trimmed = param.name.trim();
            if (!trimmed) return false;
            if (boundKeys.has(trimmed) || loopItemKeys.has(trimmed)) return false;
            if (hasForEach && runMode !== "save_only" && !unboundVars.has(trimmed)) {
              return false;
            }
            return true;
          })
          .map((param) => ({
            name: param.name.trim(),
            ...(typeof param.example === "string" ? { example: param.example } : {}),
          }))
      : undefined;
  const metaSuffix =
    runMode === "save_only"
      ? "Ready to save"
      : forEachCount && forEachCount > 0
        ? `${forEachCount} remaining`
        : "Ready to run";

  return {
    id: `decider_${shortHash(`${name}:${solution}`)}`,
    kind: isSingleInsert ? "text" : "click",
    count: 1,
    preview: collapsePreview(previewSource, 64),
    ...(isSingleInsert && typeof firstStep.value === "string"
      ? { snippetText: firstStep.value }
      : {}),
    headline: collapsePreview(name, 56),
    detail: collapsePreview(solution, 140),
    ...(solution ? { solution } : {}),
    meta: isFlowTip ? "Flow tip" : `${stepLabel} · ${metaSuffix}`,
    ...(videoUrl ? { videoUrl } : {}),
    ...(pauseBeforeSubmit !== undefined ? { pauseBeforeSubmit } : {}),
    ...(runMode !== undefined ? { runMode } : {}),
    ...(params && params.length > 0 ? { params } : {}),
    ...(primaryLabel ? { primaryLabel } : {}),
    ...(pauseNotice ? { pauseNotice } : {}),
    flows: isFlowTip
      ? { user: [], proposed: [] }
      : {
          user: userNodes,
          proposed: [
            {
              kind: "ai",
              label:
                forEachCount && forEachCount > 0
                  ? `Auto-run ×${forEachCount}`
                  : isSingleInsert
                    ? "1-click insert"
                    : "1-click replay",
            },
            { kind: "done", label: "Done" },
          ],
        },
  };
}
