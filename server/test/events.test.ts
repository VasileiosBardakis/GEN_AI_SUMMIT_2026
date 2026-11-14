import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, Report } from "@gen/shared";
import { createServer } from "../src/app.ts";
import { readEvents } from "../src/trace.ts";

describe("server events & report routes", () => {
  let tracesDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-traces-"));
    server = createServer({ tracesDir });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tracesDir, { recursive: true, force: true });
  });

  it("handles POST /events, readEvents, invalid events, GET /report, and GET /health", async () => {
    const events: Event[] = [
      {
        v: 1,
        id: "00000000-0000-4000-8000-000000000001",
        ts: 1700000000001,
        session: "sess-test-1",
        source: "browser",
        app: "mail.local",
        type: "click",
        target: {
          locators: [{ kind: "testid", value: "reply-btn" }],
        },
      },
      {
        v: 1,
        id: "00000000-0000-4000-8000-000000000002",
        ts: 1700000000002,
        session: "sess-test-1",
        source: "browser",
        app: "mail.local",
        type: "input",
        value: "Thanks for the update",
      },
      {
        v: 1,
        id: "00000000-0000-4000-8000-000000000003",
        ts: 1700000000003,
        session: "sess-test-1",
        source: "browser",
        app: "mail.local",
        type: "submit",
      },
    ];

    const postValidRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    });
    expect(postValidRes.status).toBe(200);
    expect(postValidRes.headers.get("access-control-allow-origin")).toBe("*");
    expect(await postValidRes.json()).toEqual({ ok: true, n: 3, scrubbed: 0 });

    const stored = await readEvents(tracesDir, "sess-test-1");
    expect(stored).toEqual(events);

    const postInvalidRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ v: 2, id: "bad" }]),
    });
    expect(postInvalidRes.status).toBe(400);
    const invalidBody = (await postInvalidRes.json()) as { ok: boolean; error: string };
    expect(invalidBody.ok).toBe(false);
    expect(typeof invalidBody.error).toBe("string");

    const reportRes = await fetch(`${baseUrl}/report`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(report.session).toBe("all");
    expect(report.findings).toEqual([]);

    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ ok: true });
  });
});
