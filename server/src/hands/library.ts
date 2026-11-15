import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeHost } from "../common/host.ts";
import { LibraryEntrySchema, toLocatorList, type ActionScript, type LibraryEntry, type Step } from "./types.ts";

const LIBRARY_FILENAME = "library.json";

type CanonicalStep = {
  action: string;
  locators: string[];
  text?: string;
};

const IGNORED_MATCH_ACTIONS = new Set(["switchTab", "navigate", "wait", "waitFor"]);
const VALUE_ENTRY_ACTIONS = new Set(["fill", "select", "insertText"]);
const TRAILING_CONFIRM_ACTIONS = new Set(["click", "pressKey", "submit"]);

function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeHostList(apps: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const app of apps) {
    const norm = normalizeHost(app, { collapseLoopback: true });
    if (norm) out.add(norm);
  }
  return out;
}

function appsCompatible(a: LibraryEntry, b: LibraryEntry): boolean {
  const hostsA = normalizeHostList(a.eyes.scope.apps);
  const hostsB = normalizeHostList(b.eyes.scope.apps);
  if (hostsA.size === 0 || hostsB.size === 0) return true;
  for (const h of hostsA) {
    if (hostsB.has(h)) return true;
  }
  return false;
}

function stepLocators(step: Step): string[] {
  if (!("target" in step) || !step.target) return [];
  return toLocatorList(step.target)
    .map((loc) => `${loc.kind}:${loc.value.trim().toLowerCase()}`)
    .filter(Boolean);
}

function locatorsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const bSet = new Set(b);
  return a.some((loc) => bSet.has(loc));
}

export function extractCanonicalSteps(steps: readonly Step[]): CanonicalStep[] {
  const raw: CanonicalStep[] = [];
  const visit = (list: readonly Step[]): void => {
    for (const step of list) {
      if (step.action === "forEach") {
        visit(step.steps);
        continue;
      }
      if (IGNORED_MATCH_ACTIONS.has(step.action)) continue;
      const locators = stepLocators(step);
      const text =
        step.action === "insertText" && locators.length === 0
          ? step.value.trim().replace(/\s+/g, " ")
          : undefined;
      raw.push({
        action: step.action,
        locators,
        ...(text !== undefined ? { text } : {}),
      });
    }
  };
  visit(steps);

  // Collapse a click immediately preceding a fill/select/insertText on the same target.
  const collapsed: CanonicalStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const curr = raw[i];
    const next = raw[i + 1];
    if (
      curr.action === "click" &&
      next &&
      VALUE_ENTRY_ACTIONS.has(next.action) &&
      locatorsOverlap(curr.locators, next.locators)
    ) {
      continue;
    }
    collapsed.push(curr);
  }
  return collapsed;
}

export function canonicalStepCount(script: ActionScript): number {
  return extractCanonicalSteps(script.steps).length;
}

function canonicalStepsMatch(a: CanonicalStep, b: CanonicalStep): boolean {
  if (a.action !== b.action) return false;
  if (a.locators.length > 0 && b.locators.length > 0) {
    return locatorsOverlap(a.locators, b.locators);
  }
  if (a.locators.length === 0 && b.locators.length === 0) {
    return (a.text ?? "") === (b.text ?? "");
  }
  return false;
}

export function isEquivalentLibraryEntry(a: LibraryEntry, b: LibraryEntry): boolean {
  if (a.id === b.id) return true;
  if (a.kind !== b.kind) return false;
  if (!appsCompatible(a, b)) return false;

  const sameStartSig =
    Boolean(a.startSignature) &&
    Boolean(b.startSignature) &&
    a.startSignature === b.startSignature;
  const sameName = normalizeName(a.name) === normalizeName(b.name);
  if (sameStartSig && sameName) return true;

  const stepsA = extractCanonicalSteps(a.script.steps);
  const stepsB = extractCanonicalSteps(b.script.steps);
  if (stepsA.length === 0 || stepsB.length === 0) return false;

  const hasTargetedSteps =
    stepsA.some((s) => s.locators.length > 0) &&
    stepsB.some((s) => s.locators.length > 0);
  if (!hasTargetedSteps) {
    const hostsA = normalizeHostList(a.eyes.scope.apps);
    const hostsB = normalizeHostList(b.eyes.scope.apps);
    const sameAppScope =
      (hostsA.size === 0 && hostsB.size === 0) ||
      (hostsA.size > 0 && hostsB.size > 0 && appsCompatible(a, b));
    if (!sameAppScope || !sameName) return false;
  }

  const minLen = Math.min(stepsA.length, stepsB.length);
  for (let i = 0; i < minLen; i++) {
    if (!canonicalStepsMatch(stepsA[i], stepsB[i])) return false;
  }

  if (stepsA.length === stepsB.length) return true;

  const longer = stepsA.length > stepsB.length ? stepsA : stepsB;
  const extraSteps = longer.slice(minLen);
  const onlyTrailingConfirmations = extraSteps.every((s) =>
    TRAILING_CONFIRM_ACTIONS.has(s.action),
  );
  if (!onlyTrailingConfirmations) return false;
  return minLen >= 2 || sameName || sameStartSig;
}

export function findMatchingLibraryEntry(
  entries: readonly LibraryEntry[],
  candidate: LibraryEntry,
): LibraryEntry | undefined {
  const byId = entries.find((item) => item.id === candidate.id);
  if (byId) return byId;
  return entries.find((item) => isEquivalentLibraryEntry(item, candidate));
}

function mergeDuplicateEntries(
  existing: LibraryEntry,
  incoming: LibraryEntry,
  opts: { sumRunCounts?: boolean } = {},
): LibraryEntry {
  const exactIdMatch = existing.id === incoming.id;
  const existingSteps = canonicalStepCount(existing.script);
  const incomingSteps = canonicalStepCount(incoming.script);
  const preferIncomingContent =
    exactIdMatch ||
    incomingSteps > existingSteps ||
    (incomingSteps === existingSteps && !existing.stats && Boolean(incoming.stats));

  const runCount = opts.sumRunCounts
    ? existing.runCount + incoming.runCount
    : Math.max(existing.runCount, incoming.runCount);

  const bestStats = preferIncomingContent
    ? (incoming.stats ?? existing.stats)
    : incoming.stats &&
        (!existing.stats || incoming.stats.repetitions > existing.stats.repetitions)
      ? incoming.stats
      : existing.stats;

  const status =
    existing.status === "active" || existing.status === "paused"
      ? existing.status
      : incoming.status;

  return {
    ...(preferIncomingContent ? incoming : existing),
    id: existing.id,
    status,
    createdAt: Math.min(existing.createdAt, incoming.createdAt),
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
    runCount,
    ...(bestStats ? { stats: bestStats } : {}),
  };
}

export function dedupeLibraryEntries(entries: readonly LibraryEntry[]): LibraryEntry[] {
  const result: LibraryEntry[] = [];
  for (const entry of entries) {
    const matchIdx = result.findIndex((item) => isEquivalentLibraryEntry(item, entry));
    if (matchIdx === -1) {
      result.push(entry);
    } else {
      result[matchIdx] = mergeDuplicateEntries(result[matchIdx], entry, {
        sumRunCounts: result[matchIdx].id !== entry.id,
      });
    }
  }
  return result;
}

export function libraryFilePath(dataDir: string): string {
  return path.join(dataDir, LIBRARY_FILENAME);
}

export async function readLibrary(dataDir: string): Promise<LibraryEntry[]> {
  const filePath = libraryFilePath(dataDir);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsedJson)) return [];

  const valid: LibraryEntry[] = [];
  for (const item of parsedJson) {
    const parsed = LibraryEntrySchema.safeParse(item);
    if (parsed.success) {
      valid.push(parsed.data);
    }
  }
  return valid;
}

export async function writeLibrary(
  dataDir: string,
  entries: LibraryEntry[],
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    libraryFilePath(dataDir),
    JSON.stringify(entries, null, 2) + "\n",
    "utf8",
  );
}

export async function upsertLibraryEntry(
  dataDir: string,
  incoming: LibraryEntry,
): Promise<{ entry: LibraryEntry; items: LibraryEntry[] }> {
  const validIncoming = LibraryEntrySchema.parse(incoming);
  const existingItems = dedupeLibraryEntries(await readLibrary(dataDir));
  const exactIdx = existingItems.findIndex((item) => item.id === validIncoming.id);
  const idx =
    exactIdx !== -1
      ? exactIdx
      : existingItems.findIndex((item) => isEquivalentLibraryEntry(item, validIncoming));

  if (idx === -1) {
    const next = [validIncoming, ...existingItems];
    await writeLibrary(dataDir, next);
    return { entry: validIncoming, items: next };
  }

  const existing = existingItems[idx];
  const merged = mergeDuplicateEntries(existing, validIncoming);
  merged.status = existing.status;
  merged.updatedAt = validIncoming.updatedAt;
  const next = existingItems.slice();
  next[idx] = merged;
  await writeLibrary(dataDir, next);
  return { entry: merged, items: next };
}

export async function recordLibraryRun(
  dataDir: string,
  id: string,
  now = Date.now(),
): Promise<LibraryEntry | null> {
  const existingItems = await readLibrary(dataDir);
  const idx = existingItems.findIndex((item) => item.id === id);
  if (idx === -1) return null;

  const existing = existingItems[idx];
  const updated: LibraryEntry = {
    ...existing,
    status: "active",
    runCount: existing.runCount + 1,
    updatedAt: now,
  };
  const next = existingItems.slice();
  next[idx] = updated;
  await writeLibrary(dataDir, next);
  return updated;
}

export async function deleteLibraryEntry(
  dataDir: string,
  id: string,
): Promise<{ deleted: boolean; items: LibraryEntry[] }> {
  const existingItems = await readLibrary(dataDir);
  const next = existingItems.filter((item) => item.id !== id);
  if (next.length === existingItems.length) {
    return { deleted: false, items: existingItems };
  }
  await writeLibrary(dataDir, next);
  return { deleted: true, items: next };
}
