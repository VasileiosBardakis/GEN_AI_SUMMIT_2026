import { createHash } from "node:crypto";
import type { Finding, Step } from "@gen/shared";
import {
  detectSnippetsWithText,
  trigramJaccard,
  type SnippetFinding,
} from "./snippet.ts";

export interface SharedEdgeOptions {
  minLength?: number;
  minRepetitions?: number;
}

const FULL_SNIPPET_SIMILARITY_THRESHOLD = 0.8;

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function primaryTargetKey(step: Step): string {
  const first = step.target?.[0];
  return first ? `${first.kind}:${first.value}` : "";
}

function longestCommonPrefix(texts: string[]): string {
  if (texts.length === 0) return "";
  let prefix = texts[0];
  for (let i = 1; i < texts.length; i++) {
    const t = texts[i];
    const maxLen = Math.min(prefix.length, t.length);
    let j = 0;
    while (j < maxLen && prefix.charCodeAt(j) === t.charCodeAt(j)) {
      j += 1;
    }
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) return "";
  }
  return prefix;
}

function longestCommonSuffix(texts: string[]): string {
  if (texts.length === 0) return "";
  let suffix = texts[0];
  for (let i = 1; i < texts.length; i++) {
    const t = texts[i];
    const maxLen = Math.min(suffix.length, t.length);
    let j = 0;
    while (
      j < maxLen &&
      suffix.charCodeAt(suffix.length - 1 - j) ===
        t.charCodeAt(t.length - 1 - j)
    ) {
      j += 1;
    }
    suffix = suffix.slice(suffix.length - j);
    if (suffix.length === 0) return "";
  }
  return suffix;
}

function cleanPrefixEdge(rawPrefix: string, texts: string[]): string {
  if (!rawPrefix.includes("\n")) {
    return rawPrefix.trim();
  }
  const endsOnLineBoundary =
    rawPrefix.endsWith("\n") ||
    texts.every(
      (t) =>
        t.length === rawPrefix.length ||
        t[rawPrefix.length] === "\n" ||
        t[rawPrefix.length] === "\r",
    );
  const sliced = endsOnLineBoundary
    ? rawPrefix
    : rawPrefix.slice(0, rawPrefix.lastIndexOf("\n"));
  return sliced.trim();
}

function cleanSuffixEdge(rawSuffix: string, texts: string[]): string {
  if (!rawSuffix.includes("\n")) {
    return rawSuffix.trim();
  }
  const startsOnLineBoundary =
    rawSuffix.startsWith("\n") ||
    rawSuffix.startsWith("\r") ||
    texts.every((t) => {
      const startIdx = t.length - rawSuffix.length;
      return (
        startIdx === 0 || t[startIdx - 1] === "\n" || t[startIdx - 1] === "\r"
      );
    });
  const sliced = startsOnLineBoundary
    ? rawSuffix
    : rawSuffix.slice(rawSuffix.indexOf("\n") + 1);
  return sliced.trim();
}

function buildEdgeFinding(edgeText: string, repetitions: number): SnippetFinding {
  const norm = normalizeText(edgeText);
  const id =
    "snip_" + createHash("sha256").update(norm).digest("hex").slice(0, 8);
  const collapsed = edgeText.replace(/\s+/g, " ").trim();
  const preview =
    collapsed.length > 40 ? collapsed.slice(0, 40) + "..." : collapsed;
  const minutesPerWeek = Number(
    (repetitions * (edgeText.length / 200)).toFixed(2),
  );

  const finding: Finding = {
    id,
    verdict: "rung1",
    title: `Save a snippet for: "${preview}"`,
    why: `You typed this ${edgeText.length}-character text ${repetitions} times in this session.`,
    whyNotNext:
      "Text varies slightly between replies, so a reusable text snippet is safer and faster than a brittle UI script.",
    stats: {
      repetitions,
      minutesPerWeek,
      stability: 1,
    },
    artifact: {
      kind: "snippet",
      path: `snippets/${id}.txt`,
      verified: false,
    },
  };

  return {
    finding,
    text: edgeText,
  };
}

export function detectSharedEdgesWithText(
  steps: Step[],
  opts?: SharedEdgeOptions,
): SnippetFinding[] {
  const minLength = opts?.minLength ?? 20;
  const minRepetitions = opts?.minRepetitions ?? 3;

  const fullSnippets = detectSnippetsWithText(steps, {
    minLength,
    minRepetitions,
  });

  const emittedNorms = new Set<string>();
  const emittedIds = new Set<string>();
  for (const snippet of fullSnippets) {
    emittedNorms.add(normalizeText(snippet.text));
    emittedIds.add(snippet.finding.id);
  }

  const groups = new Map<string, string[]>();
  for (const step of steps) {
    if (step.action !== "fill" || typeof step.value !== "string") {
      continue;
    }
    if (step.value.includes("[REDACTED")) {
      continue;
    }
    const trimmed = step.value.trim();
    if (trimmed.length < minLength) {
      continue;
    }
    const inFullSnippetCluster = fullSnippets.some(
      (snippet) =>
        trigramJaccard(snippet.text, trimmed) >=
        FULL_SNIPPET_SIMILARITY_THRESHOLD,
    );
    if (inFullSnippetCluster) {
      continue;
    }

    const key = primaryTargetKey(step);
    const group = groups.get(key);
    if (group) {
      group.push(trimmed);
    } else {
      groups.set(key, [trimmed]);
    }
  }

  const results: SnippetFinding[] = [];
  for (const group of groups.values()) {
    if (group.length < minRepetitions) {
      continue;
    }

    const rawPrefix = longestCommonPrefix(group);
    const rawSuffix = longestCommonSuffix(group);
    const candidateEdges = [
      cleanPrefixEdge(rawPrefix, group),
      cleanSuffixEdge(rawSuffix, group),
    ];

    for (const edgeText of candidateEdges) {
      if (edgeText.length < minLength) {
        continue;
      }
      const norm = normalizeText(edgeText);
      if (norm.length < minLength || emittedNorms.has(norm)) {
        continue;
      }
      const item = buildEdgeFinding(edgeText, group.length);
      if (emittedIds.has(item.finding.id)) {
        continue;
      }
      emittedNorms.add(norm);
      emittedIds.add(item.finding.id);
      results.push(item);
    }
  }

  return results;
}

export function detectSharedEdges(
  steps: Step[],
  opts?: SharedEdgeOptions,
): Finding[] {
  return detectSharedEdgesWithText(steps, opts).map((item) => item.finding);
}
