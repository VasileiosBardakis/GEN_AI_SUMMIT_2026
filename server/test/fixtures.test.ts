import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventSchema } from "@gen/shared/schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string) {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line));
}

describe("email reply JSONL fixtures", () => {
  it("validates reply-x3.jsonl events against EventSchema and workflow expectations", async () => {
    const rawEvents = await loadFixtureEvents("reply-x3.jsonl");

    expect(rawEvents).toHaveLength(21);

    const parsedEvents = rawEvents.map((event) => EventSchema.parse(event));

    const sessions = new Set(parsedEvents.map((e) => e.session));
    expect(sessions.size).toBe(1);
    expect(sessions.has("sess_reply_x3")).toBe(true);

    const blurCommitInputEvents = parsedEvents.filter(
      (e) => e.type === "input" && e.meta?.subType === "blur_commit",
    );
    expect(blurCommitInputEvents).toHaveLength(3);

    for (let i = 1; i < parsedEvents.length; i++) {
      expect(parsedEvents[i].ts).toBeGreaterThan(parsedEvents[i - 1].ts);
    }
  });

  it("validates one-off.jsonl events against EventSchema and workflow expectations", async () => {
    const rawEvents = await loadFixtureEvents("one-off.jsonl");

    expect(rawEvents).toHaveLength(7);

    const parsedEvents = rawEvents.map((event) => EventSchema.parse(event));

    const sessions = new Set(parsedEvents.map((e) => e.session));
    expect(sessions.size).toBe(1);
    expect(sessions.has("sess_one_off")).toBe(true);

    const inputEvents = parsedEvents.filter((e) => e.type === "input");
    expect(inputEvents).toHaveLength(1);

    for (let i = 1; i < parsedEvents.length; i++) {
      expect(parsedEvents[i].ts).toBeGreaterThan(parsedEvents[i - 1].ts);
    }
  });
});
