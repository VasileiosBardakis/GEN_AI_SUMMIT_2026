import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/app.ts";
import { implementSolution } from "../../src/hands/implementor.ts";

describe("POST /implement, GET /script/latest, and /hands/* bridge", () => {
  let tracesDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-implement-test-"));
    server = createServer({
      tracesDir,
      implement: (solution, opts) =>
        implementSolution(solution, {
          ...opts,
          generate: async () => ({
            steps: [{ action: "insertText", value: "Thanks, shipping Friday." }],
          }),
        }),
    });
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

  it("compiles a solution with POST /implement and serves it on GET /script/latest", async () => {
    const emptyRes = await fetch(`${baseUrl}/script/latest`);
    expect(emptyRes.status).toBe(404);

    const postRes = await fetch(`${baseUrl}/implement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Supplier reply",
        solution: "Insert Thanks, shipping Friday.",
      }),
    });
    expect(postRes.status).toBe(200);
    const postJson = (await postRes.json()) as {
      ok: boolean;
      script: { name?: string; steps: unknown[] };
    };
    expect(postJson).toEqual({
      ok: true,
      script: {
        name: "Supplier reply",
        steps: [{ action: "insertText", value: "Thanks, shipping Friday." }],
      },
    });

    const latestRes = await fetch(`${baseUrl}/script/latest`);
    expect(latestRes.status).toBe(200);
    expect(await latestRes.json()).toEqual(postJson);
  });

  it("rejects invalid /implement payloads with 400", async () => {
    const badJsonRes = await fetch(`${baseUrl}/implement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(badJsonRes.status).toBe(400);

    const emptySolRes = await fetch(`${baseUrl}/implement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ solution: "   " }),
    });
    expect(emptySolRes.status).toBe(400);
  });

  it("routes POST /hands/run -> GET /hands/next -> POST /hands/result", async () => {
    const emptyPoll = await fetch(`${baseUrl}/hands/next?waitMs=20`);
    expect(emptyPoll.status).toBe(204);

    const script = {
      name: "Search",
      steps: [{ action: "fill", target: { kind: "css", value: "input[type='search']" }, value: "q" }],
    };

    const runPromise = fetch(`${baseUrl}/hands/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script }),
    });

    const nextRes = await fetch(`${baseUrl}/hands/next?waitMs=1000`);
    expect(nextRes.status).toBe(200);
    const cmd = (await nextRes.json()) as { id: string; script: typeof script };
    expect(cmd.script).toEqual(script);

    const resultRes = await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cmd.id, ok: true, results: [{ ok: true, url: "http://x", value: "q" }] }),
    });
    expect(resultRes.status).toBe(200);

    const runRes = await runPromise;
    expect(runRes.status).toBe(200);
    expect(await runRes.json()).toEqual({
      id: cmd.id,
      ok: true,
      results: [{ ok: true, url: "http://x", value: "q" }],
    });
  });
});
