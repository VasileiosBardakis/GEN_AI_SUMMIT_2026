import { createHash } from "node:crypto";
import type { Finding, Step } from "@gen/shared";

export interface SnippetOptions {
  minLength?: number;
  similarityThreshold?: number;
  minRepetitions?: number;
}

interface Candidate {
  raw: string;
  norm: string;
}

interface Cluster {
  repRaw: string;
  repNorm: string;
  members: Candidate[];
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildTrigrams(s: string): Set<string> {
  const trigrams = new Set<string>();
  for (let i = 0; i <= s.length - 3; i++) {
    trigrams.add(s.slice(i, i + 3));
  }
  return trigrams;
}

export function trigramJaccard(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  if (na.length < 3 || nb.length < 3) return 0;

  const trigramsA = buildTrigrams(na);
  const trigramsB = buildTrigrams(nb);

  let intersectionSize = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) {
      intersectionSize += 1;
    }
  }

  const unionSize = trigramsA.size + trigramsB.size - intersectionSize;
  return intersectionSize / unionSize;
}

function computeStability(members: Candidate[]): number {
  if (members.length < 2) return 1;

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      total += trigramJaccard(members[i].norm, members[j].norm);
      pairs += 1;
    }
  }

  return Number((total / pairs).toFixed(4));
}

export function detectSnippets(
  steps: Step[],
  opts?: SnippetOptions,
): Finding[] {
  const minLength = opts?.minLength ?? 20;
  const similarityThreshold = opts?.similarityThreshold ?? 0.8;
  const minRepetitions = opts?.minRepetitions ?? 3;

  const candidates: Candidate[] = [];
  for (const step of steps) {
    if (
      (step.action !== "fill" && step.action !== "paste") ||
      typeof step.value !== "string"
    ) {
      continue;
    }
    if (step.value.includes("[REDACTED")) {
      continue;
    }
    const norm = normalizeText(step.value);
    if (norm.length < minLength) {
      continue;
    }
    candidates.push({
      raw: step.value.trim(),
      norm,
    });
  }

  const clusters: Cluster[] = [];
  for (const candidate of candidates) {
    const existing = clusters.find(
      (cluster) =>
        trigramJaccard(cluster.repNorm, candidate.norm) >= similarityThreshold,
    );
    if (existing) {
      existing.members.push(candidate);
    } else {
      clusters.push({
        repRaw: candidate.raw,
        repNorm: candidate.norm,
        members: [candidate],
      });
    }
  }

  const findings: Finding[] = [];
  for (const cluster of clusters) {
    if (cluster.members.length < minRepetitions) {
      continue;
    }

    const id =
      "snip_" +
      createHash("sha256").update(cluster.repNorm).digest("hex").slice(0, 8);
    const collapsed = cluster.repRaw.replace(/\s+/g, " ").trim();
    const preview =
      collapsed.length > 40 ? collapsed.slice(0, 40) + "..." : collapsed;
    const repetitions = cluster.members.length;
    const avgChars =
      cluster.members.reduce((sum, m) => sum + m.raw.length, 0) / repetitions;
    const minutesPerWeek = Number((repetitions * (avgChars / 200)).toFixed(2));
    const stability = computeStability(cluster.members);

    findings.push({
      id,
      verdict: "rung1",
      title: `Save a snippet for: "${preview}"`,
      why: `You typed this ${Math.round(avgChars)}-character text ${repetitions} times in this session.`,
      whyNotNext:
        "Text varies slightly between replies, so a reusable text snippet is safer and faster than a brittle UI script.",
      stats: {
        repetitions,
        minutesPerWeek,
        stability,
      },
      artifact: {
        kind: "snippet",
        path: `snippets/${id}.txt`,
        verified: false,
      },
    });
  }

  return findings;
}
