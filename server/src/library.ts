import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Workflow } from "@gen/shared";
import type { ActionScript } from "./hands/types.ts";

export type LibraryConfig = {
  matchMaxDistance: number;
  borderlineMaxDistance: number;
  filename: string;
};

export const DEFAULT_LIBRARY_CONFIG: LibraryConfig = {
  matchMaxDistance: 0.15,
  borderlineMaxDistance: 0.35,
  filename: "library.json",
};

export type WorkflowSignature = {
  host: string;
  steps: string[];
};

export type LibraryEntry = {
  id: string;
  signature: WorkflowSignature;
  name: string;
  solution: string;
  script?: ActionScript;
};

export type LibraryMatch = {
  kind: "match" | "borderline" | "none";
  entry?: LibraryEntry;
  distance: number;
};

export type LibraryOptions = {
  dataDir?: string;
  config?: Partial<LibraryConfig>;
};

const DEFAULT_DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data",
);

function resolveOptions(opts?: LibraryOptions): {
  dataDir: string;
  config: LibraryConfig;
} {
  return {
    dataDir: opts?.dataDir ?? DEFAULT_DATA_DIR,
    config: {
      matchMaxDistance:
        opts?.config?.matchMaxDistance ?? DEFAULT_LIBRARY_CONFIG.matchMaxDistance,
      borderlineMaxDistance:
        opts?.config?.borderlineMaxDistance ??
        DEFAULT_LIBRARY_CONFIG.borderlineMaxDistance,
      filename: opts?.config?.filename ?? DEFAULT_LIBRARY_CONFIG.filename,
    },
  };
}

export function signature(workflow: Workflow): WorkflowSignature {
  const host =
    workflow.destApp && workflow.destApp !== workflow.sourceApp
      ? `${workflow.sourceApp}->${workflow.destApp}`
      : workflow.destApp || workflow.sourceApp;

  const steps = workflow.steps.map(
    (s) => `${s.action}:${s.target?.[0]?.kind ?? "none"}`,
  );

  return { host, steps };
}

function levenshtein(a: readonly string[], b: readonly string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

export function normalizedEditDistance(
  a: WorkflowSignature,
  b: WorkflowSignature,
): number {
  if (a.host !== b.host) {
    return 1;
  }
  if (a.steps.length === 0 && b.steps.length === 0) {
    return 0;
  }
  const distance = levenshtein(a.steps, b.steps);
  return distance / Math.max(a.steps.length, b.steps.length);
}

export async function loadLibrary(
  opts?: LibraryOptions,
): Promise<LibraryEntry[]> {
  const { dataDir, config } = resolveOptions(opts);
  const filePath = path.join(dataDir, config.filename);

  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as LibraryEntry[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function matchLibrary(
  workflow: Workflow,
  opts?: LibraryOptions,
): Promise<LibraryMatch> {
  const { config } = resolveOptions(opts);
  const sig = signature(workflow);
  const entries = await loadLibrary(opts);

  if (entries.length === 0) {
    return { kind: "none", distance: 1 };
  }

  let bestEntry = entries[0];
  let bestDistance = normalizedEditDistance(sig, entries[0].signature);

  for (let i = 1; i < entries.length; i++) {
    const d = normalizedEditDistance(sig, entries[i].signature);
    if (d < bestDistance) {
      bestDistance = d;
      bestEntry = entries[i];
    }
  }

  if (bestDistance <= config.matchMaxDistance) {
    return { kind: "match", entry: bestEntry, distance: bestDistance };
  }
  if (bestDistance <= config.borderlineMaxDistance) {
    return { kind: "borderline", entry: bestEntry, distance: bestDistance };
  }
  return { kind: "none", distance: bestDistance };
}
