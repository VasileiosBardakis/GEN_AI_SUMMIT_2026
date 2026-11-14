import type { ActionScript } from "./types.ts";

export type SuggestionKind = "text" | "click";

export interface SuggestionOptions {
  minTextLength?: number;
  similarityThreshold?: number;
  minRepetitions?: number;
  clickWindowMs?: number;
  clickReplayUrl?: string;
  initialTextClusters?: TextCluster[];
  onTextClustersChange?: (clusters: TextCluster[]) => void;
}

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

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  count: number;
  preview: string;
  snippetText?: string;
  headline: string;
  detail: string;
  meta: string;
  videoUrl?: string;
  flows: {
    user: FlowNode[];
    proposed: FlowNode[];
  };
}

export interface SuggestionEngine {
  recordText(value: string, scopeKey?: string): Suggestion | null;
  recordClick(key: string, label: string | undefined, ts?: number): Suggestion | null;
}

export interface TextCluster {
  scopeKey: string;
  repRaw: string;
  repNorm: string;
  members: string[];
  notified: boolean;
}

interface ClickCluster {
  key: string;
  label: string;
  timestamps: number[];
  notified: boolean;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildTrigrams(value: string): Set<string> {
  const trigrams = new Set<string>();
  for (let i = 0; i <= value.length - 3; i++) {
    trigrams.add(value.slice(i, i + 3));
  }
  return trigrams;
}

export function trigramJaccard(a: string, b: string): number {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (left === right) return 1;
  if (left.length < 3 || right.length < 3) return 0;

  const leftTrigrams = buildTrigrams(left);
  const rightTrigrams = buildTrigrams(right);

  let intersection = 0;
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) intersection += 1;
  }

  return intersection / (leftTrigrams.size + rightTrigrams.size - intersection);
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

export function createSuggestionEngine(options: SuggestionOptions = {}): SuggestionEngine {
  const minTextLength = options.minTextLength ?? 20;
  const similarityThreshold = options.similarityThreshold ?? 0.8;
  const minRepetitions = options.minRepetitions ?? 3;
  const clickWindowMs = options.clickWindowMs ?? 60_000;
  const clickReplayUrl = options.clickReplayUrl;

  const textClusters: TextCluster[] = (options.initialTextClusters ?? []).map((c) => ({
    scopeKey: c.scopeKey,
    repRaw: c.repRaw,
    repNorm: c.repNorm,
    members: [...c.members],
    notified: Boolean(c.notified),
  }));
  const clickClusters: ClickCluster[] = [];

  function notifyTextClusters(): void {
    if (!options.onTextClustersChange) return;
    const recent = textClusters.slice(-200).map((c) => ({
      scopeKey: c.scopeKey,
      repRaw: c.repRaw,
      repNorm: c.repNorm,
      members: [...c.members],
      notified: c.notified,
    }));
    options.onTextClustersChange(recent);
  }

  function recordText(value: string, scopeKey = ""): Suggestion | null {
    const raw = value.trim();
    const norm = normalizeText(raw);
    if (norm.length < minTextLength || norm.includes("[redacted")) return null;

    let cluster = textClusters.find(
      (candidate) =>
        candidate.scopeKey === scopeKey &&
        trigramJaccard(candidate.repNorm, norm) >= similarityThreshold
    );
    if (!cluster) {
      cluster = { scopeKey, repRaw: raw, repNorm: norm, members: [], notified: false };
      textClusters.push(cluster);
    }

    cluster.members.push(raw);
    if (cluster.members.length < minRepetitions || cluster.notified) {
      notifyTextClusters();
      return null;
    }

    cluster.notified = true;
    notifyTextClusters();
    const count = cluster.members.length;
    const avgChars =
      cluster.members.reduce((sum, member) => sum + member.length, 0) / count;
    const minutesPerWeek = Number((count * (avgChars / 200)).toFixed(1));
    const hashInput = scopeKey ? `${scopeKey}::${cluster.repNorm}` : cluster.repNorm;

    return {
      id: `text_${shortHash(hashInput)}`,
      kind: "text",
      count,
      preview: collapsePreview(cluster.repRaw),
      snippetText: cluster.repRaw,
      headline: "Save this text as a snippet",
      detail: `Repeated ${count} similar times. Save once to insert with a shortcut.`,
      meta: `${count} repeats · ~${minutesPerWeek} min/week saved`,
      flows: {
        user: [
          { kind: "click", label: "Open customer reply" },
          { kind: "input", label: "Type the same message" },
          { kind: "click", label: "Send" },
          { kind: "loop", label: `Repeat ×${count}` },
        ],
        proposed: [
          { kind: "click", label: "Open customer reply" },
          { kind: "ai", label: "Insert saved snippet" },
          { kind: "click", label: "Send" },
          { kind: "done", label: "Done" },
        ],
      },
    };
  }

  function recordClick(key: string, label: string | undefined, ts = Date.now()): Suggestion | null {
    const name = (label ?? "").trim();
    if (!key || !name) return null;

    let cluster = clickClusters.find((candidate) => candidate.key === key);
    if (!cluster) {
      cluster = { key, label: name, timestamps: [], notified: false };
      clickClusters.push(cluster);
    }

    cluster.label = name;
    cluster.timestamps = cluster.timestamps.filter((stamp) => ts - stamp < clickWindowMs);
    cluster.timestamps.push(ts);

    const count = cluster.timestamps.length;
    if (count < minRepetitions || cluster.notified) return null;

    cluster.notified = true;
    const shortName = collapsePreview(name, 40);
    return {
      id: `click_${shortHash(key)}`,
      kind: "click",
      count,
      preview: shortName,
      headline: `Automate "${shortName}"?`,
      detail: `Clicked ${count} times in the last minute. Run as a one-click shortcut.`,
      meta: `${count} repeats · ~${count * 15}s saved per run`,
      ...(clickReplayUrl ? { videoUrl: clickReplayUrl } : {}),
      flows: {
        user: [
          { kind: "click", label: `Click "${shortName}"` },
          { kind: "tab", label: "Switch to ERP tab" },
          { kind: "paste", label: "Paste reference" },
          { kind: "loop", label: `Repeat ×${count}` },
        ],
        proposed: [
          { kind: "click", label: `Click "${shortName}"` },
          { kind: "ai", label: "Switch tab + paste" },
          { kind: "done", label: "Done" },
        ],
      },
    };
  }

  return { recordText, recordClick };
}

export interface DeciderProposalInput {
  name: string;
  solution: string;
  script: ActionScript;
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

  const previewSource =
    isSingleInsert && typeof firstStep.value === "string"
      ? firstStep.value
      : name;

  const userNodes: FlowNode[] = steps.slice(0, 3).map(stepToUserFlowNode);
  if (userNodes.length === 0) {
    userNodes.push({ kind: "click", label: "Run manually" });
  }
  userNodes.push({ kind: "loop", label: "Repeat" });

  const stepLabel = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;

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
    meta: `${stepLabel} · Ready to run`,
    flows: {
      user: userNodes,
      proposed: [
        { kind: "ai", label: collapsePreview(name, 26) },
        { kind: "done", label: "Done" },
      ],
    },
  };
}
