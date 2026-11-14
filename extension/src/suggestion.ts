export type SuggestionKind = "text" | "click";

export interface SuggestionOptions {
  minTextLength?: number;
  similarityThreshold?: number;
  minRepetitions?: number;
  clickWindowMs?: number;
  clickReplayUrl?: string;
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
  recordText(value: string): Suggestion | null;
  recordClick(key: string, label: string | undefined, ts?: number): Suggestion | null;
}

interface TextCluster {
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

  const textClusters: TextCluster[] = [];
  const clickClusters: ClickCluster[] = [];

  function recordText(value: string): Suggestion | null {
    const raw = value.trim();
    const norm = normalizeText(raw);
    if (norm.length < minTextLength || norm.includes("[redacted")) return null;

    let cluster = textClusters.find(
      (candidate) => trigramJaccard(candidate.repNorm, norm) >= similarityThreshold
    );
    if (!cluster) {
      cluster = { repRaw: raw, repNorm: norm, members: [], notified: false };
      textClusters.push(cluster);
    }

    cluster.members.push(raw);
    if (cluster.members.length < minRepetitions || cluster.notified) return null;

    cluster.notified = true;
    const count = cluster.members.length;
    const avgChars =
      cluster.members.reduce((sum, member) => sum + member.length, 0) / count;
    const minutesPerWeek = Number((count * (avgChars / 200)).toFixed(1));

    return {
      id: `text_${shortHash(cluster.repNorm)}`,
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
