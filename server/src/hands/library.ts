import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LibraryEntrySchema, type LibraryEntry } from "./types.ts";

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

export async function upsertLibraryEntry(
  dataDir: string,
  incoming: LibraryEntry,
): Promise<{ entry: LibraryEntry; items: LibraryEntry[] }> {
  const validIncoming = LibraryEntrySchema.parse(incoming);
  const existingItems = await readLibrary(dataDir);
  const idx = existingItems.findIndex((item) => item.id === validIncoming.id);

  if (idx === -1) {
    const next = [validIncoming, ...existingItems];
    await writeLibrary(dataDir, next);
    return { entry: validIncoming, items: next };
  }

  const existing = existingItems[idx];
  const merged: LibraryEntry = {
    ...validIncoming,
    status: existing.status,
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
