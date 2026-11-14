import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Event } from "@gen/shared";

function sanitizeSession(session: string): string {
  const sanitized = session.replace(/[^A-Za-z0-9_-]/g, "");
  return sanitized || "default";
}

export async function appendEvents(dir: string, events: Event[]): Promise<void> {
  if (events.length === 0) return;
  await mkdir(dir, { recursive: true });

  const grouped = new Map<string, Event[]>();
  for (const event of events) {
    const key = sanitizeSession(event.session);
    const list = grouped.get(key);
    if (list) {
      list.push(event);
    } else {
      grouped.set(key, [event]);
    }
  }

  for (const [sessionKey, sessionEvents] of grouped.entries()) {
    const filePath = path.join(dir, `${sessionKey}.jsonl`);
    const lines = sessionEvents.map((e) => `${JSON.stringify(e)}\n`).join("");
    await appendFile(filePath, lines, "utf8");
  }
}

export async function readEvents(dir: string, session: string): Promise<Event[]> {
  const sessionKey = sanitizeSession(session);
  const filePath = path.join(dir, `${sessionKey}.jsonl`);
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Event);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}
