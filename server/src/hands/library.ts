import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LibraryEntrySchema, type LibraryEntry, type Locator } from "./types.ts";

const LIBRARY_FILENAME = "library.json";

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

function normalizeSnippetText(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

function getSnippetInsertText(entry: LibraryEntry): string | null {
  if (entry.kind !== "snippet") return null;
  const insertStep = entry.script.steps.find(
    (s): s is Extract<LibraryEntry["script"]["steps"][number], { action: "insertText" }> =>
      s.action === "insertText",
  );
  if (!insertStep || typeof insertStep.value !== "string") return null;
  const normalized = normalizeSnippetText(insertStep.value);
  return normalized.length > 0 ? normalized : null;
}

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const val of values) {
    const clean = val.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function dedupeLocators(locators: readonly Locator[]): Locator[] {
  const out: Locator[] = [];
  const seen = new Set<string>();
  for (const loc of locators) {
    const value = loc.value.trim();
    if (!value) continue;
    const key = `${loc.kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: loc.kind, value });
  }
  return out;
}

export async function upsertLibraryEntry(
  dataDir: string,
  incoming: LibraryEntry,
): Promise<{ entry: LibraryEntry; items: LibraryEntry[] }> {
  const validIncoming = LibraryEntrySchema.parse(incoming);
  const existingItems = await readLibrary(dataDir);
  let idx = existingItems.findIndex((item) => item.id === validIncoming.id);

  if (idx === -1 && validIncoming.kind === "snippet") {
    const incomingText = getSnippetInsertText(validIncoming);
    if (incomingText !== null) {
      idx = existingItems.findIndex(
        (item) => getSnippetInsertText(item) === incomingText,
      );
    }
  }

  if (idx === -1) {
    const next = [validIncoming, ...existingItems];
    await writeLibrary(dataDir, next);
    return { entry: validIncoming, items: next };
  }

  const existing = existingItems[idx];
  const merged: LibraryEntry = {
    ...validIncoming,
    id: existing.id,
    status:
      existing.status === "suggested" && validIncoming.status === "active"
        ? "active"
        : existing.status,
    eyes: {
      ...validIncoming.eyes,
      scope: {
        apps: dedupeStrings([
          ...existing.eyes.scope.apps,
          ...validIncoming.eyes.scope.apps,
        ]),
        urlPatterns: dedupeStrings([
          ...existing.eyes.scope.urlPatterns,
          ...validIncoming.eyes.scope.urlPatterns,
        ]),
        pageHints: dedupeStrings([
          ...existing.eyes.scope.pageHints,
          ...validIncoming.eyes.scope.pageHints,
        ]),
      },
      targetHints: {
        roles: dedupeStrings([
          ...existing.eyes.targetHints.roles,
          ...validIncoming.eyes.targetHints.roles,
        ]),
        labelContains: dedupeStrings([
          ...existing.eyes.targetHints.labelContains,
          ...validIncoming.eyes.targetHints.labelContains,
        ]),
        locators: dedupeLocators([
          ...existing.eyes.targetHints.locators,
          ...validIncoming.eyes.targetHints.locators,
        ]),
      },
      textHints: {
        ...validIncoming.eyes.textHints,
        prefixHints: dedupeStrings([
          ...existing.eyes.textHints.prefixHints,
          ...validIncoming.eyes.textHints.prefixHints,
        ]),
      },
    },
    createdAt: existing.createdAt,
    updatedAt: validIncoming.updatedAt,
    runCount: existing.runCount,
  };
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
