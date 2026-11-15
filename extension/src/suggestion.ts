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

function stepToUserFlowNode(step: ActionScript["steps"][number]): FlowNode {
  switch (step.action) {
    case "fill":
    case "insertText":
      return {
        kind: "input",
        label:
          typeof step.value === "string" && step.value.trim().length > 0
            ? `Type "${collapsePreview(step.value, 22)}"`
            : "Type text",
      };
    case "select":
      return { kind: "click", label: "Select option" };
    case "navigate":
      return { kind: "tab", label: "Open page" };
    case "forEach":
      return { kind: "loop", label: "Repeat rows" };
    default:
      return { kind: "click", label: "Click target" };
  }
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

  const userNodes: FlowNode[] = steps.slice(0, 3).map(stepToUserFlowNode);
  if (userNodes.length === 0) {
    userNodes.push({ kind: "click", label: "Run manually" });
  }
  userNodes.push({ kind: "loop", label: "Repeat" });

  const stepLabel = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
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
  const params =
    Array.isArray(input.params) && input.params.length > 0
      ? input.params
          .filter((param) => typeof param?.name === "string" && param.name.trim().length > 0)
          .map((param) => ({
            name: param.name.trim(),
            ...(typeof param.example === "string" ? { example: param.example } : {}),
          }))
      : undefined;
  const metaSuffix = runMode === "save_only" ? "Ready to save" : "Ready to run";

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
            { kind: "ai", label: collapsePreview(name, 26) },
            { kind: "done", label: "Done" },
          ],
        },
  };
}
