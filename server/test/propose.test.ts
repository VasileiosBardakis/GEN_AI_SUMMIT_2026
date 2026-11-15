import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { EventSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

describe("auto-propose config", () => {
  it("disables automatic proposals when BRAIN_AUTO_PROPOSE=0", async () => {
    const prev = process.env.BRAIN_AUTO_PROPOSE;
    process.env.BRAIN_AUTO_PROPOSE = "0";
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "gen-propose-env-"));
    const server = createServer({
      tracesDir: path.join(rootDir, "traces"),
      dataDir: path.join(rootDir, "data"),
      proposeDebounceMs: 0,
    });
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const replyEvents = await loadFixtureEvents("reply-x3.jsonl");
      const res = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(replyEvents),
      });
      expect(res.status).toBe(200);
      const nextRes = await fetch(`${baseUrl}/hands/next?waitMs=60`);
      expect(nextRes.status).toBe(204);
    } finally {
      if (prev === undefined) {
        delete process.env.BRAIN_AUTO_PROPOSE;
      } else {
        process.env.BRAIN_AUTO_PROPOSE = prev;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
