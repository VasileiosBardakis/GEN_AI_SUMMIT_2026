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

function signatureFromStoredEntry(raw: unknown): WorkflowSignature | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const sig = obj.signature as Partial<WorkflowSignature> | undefined;
  if (sig && typeof sig.host === "string" && Array.isArray(sig.steps)) {
    return { host: sig.host, steps: sig.steps };
  }
  const eyes = obj.eyes as { scope?: { apps?: unknown } } | undefined;
  const script = obj.script as ActionScript | undefined;
  if (!script || !Array.isArray(script.steps)) return null;

  const apps = Array.isArray(eyes?.scope?.apps)
    ? eyes.scope.apps.filter((a): a is string => typeof a === "string" && a.length > 0)
    : [];
  const switchHosts = script.steps
    .filter((s): s is Extract<ActionScript["steps"][number], { action: "switchTab" }> => s.action === "switchTab")
    .map((s) => s.host);
  const host =
    apps.length >= 2
      ? `${apps[0]}->${apps[apps.length - 1]}`
      : apps.length === 1 && switchHosts.length > 0 && switchHosts[0] !== apps[0]
        ? `${apps[0]}->${switchHosts[0]}`
        : apps[0] || switchHosts[0] || "browser";

  const steps: string[] = [];
  for (const s of script.steps) {
    if (s.action === "switchTab" || s.action === "wait" || s.action === "waitFor") continue;
    if (s.action === "forEach") {
      for (const nested of s.steps) {
        const mapped = nested.action === "insertText" ? "fill" : nested.action === "navigate" ? "nav" : nested.action;
        const kind = "target" in nested && nested.target ? nested.target.kind : "none";
        steps.push(`${mapped}:${kind}`);
      }
      continue;
    }
    const mapped =
      s.action === "insertText"
        ? "fill"
        : s.action === "readText" || s.action === "readValue"
          ? "copy"
          : s.action === "navigate"
            ? "nav"
            : s.action;
    const kind = "target" in s && s.target ? s.target.kind : "none";
    steps.push(`${mapped}:${kind}`);
  }
  return { host, steps };
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

  let bestEntry: LibraryEntry | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entrySig = signatureFromStoredEntry(entry);
    if (!entrySig) {
      continue;
    }
    const d = normalizedEditDistance(sig, entrySig);
    if (d < bestDistance) {
      bestDistance = d;
      bestEntry = entry;
    }
  }

  if (!bestEntry) {
    return { kind: "none", distance: 1 };
  }

  if (bestDistance <= config.matchMaxDistance) {
    return { kind: "match", entry: bestEntry, distance: bestDistance };
  }
  if (bestDistance <= config.borderlineMaxDistance) {
    return { kind: "borderline", entry: bestEntry, distance: bestDistance };
  }
  return { kind: "none", distance: bestDistance };
}
