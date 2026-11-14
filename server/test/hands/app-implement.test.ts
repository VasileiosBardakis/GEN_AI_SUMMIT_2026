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
      dataDir: path.join(tracesDir, "data"),
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

  it("routes POST /decide -> GET /hands/next -> POST /hands/result for approved and dismissed", async () => {
    const script = {
      name: "Search",
      steps: [{ action: "fill", target: { kind: "css", value: "input[type='search']" }, value: "q" }],
    };

    const approvePromise = fetch(`${baseUrl}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Search", solution: "Fill search box", script }),
    });

    const nextApprove = await fetch(`${baseUrl}/hands/next?waitMs=1000`);
    expect(nextApprove.status).toBe(200);
    const approveCmd = (await nextApprove.json()) as {
      id: string;
      kind: string;
      name: string;
      solution: string;
      script: typeof script;
    };
    expect(approveCmd.kind).toBe("decide");
    expect(approveCmd.name).toBe("Search");
    expect(approveCmd.solution).toBe("Fill search box");
    expect(approveCmd.script).toEqual(script);

    await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: approveCmd.id, ok: true, decision: "approved" }),
    });

    const approveRes = await approvePromise;
    expect(approveRes.status).toBe(200);
    expect(await approveRes.json()).toEqual({ id: approveCmd.id, ok: true, decision: "approved" });

    const dismissPromise = fetch(`${baseUrl}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Search", solution: "Fill search box", script }),
    });
    const nextDismiss = await fetch(`${baseUrl}/hands/next?waitMs=1000`);
    const dismissCmd = (await nextDismiss.json()) as { id: string };
    await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: dismissCmd.id, ok: true, decision: "dismissed" }),
    });
    const dismissRes = await dismissPromise;
    expect(dismissRes.status).toBe(200);
    expect(await dismissRes.json()).toEqual({ id: dismissCmd.id, ok: true, decision: "dismissed" });
  });

  it("saves compiled automations to the library on /implement and exposes GET/POST/DELETE /library", async () => {
    const emptyLibRes = await fetch(`${baseUrl}/library`);
    expect(emptyLibRes.status).toBe(200);
    expect(await emptyLibRes.json()).toEqual({ ok: true, items: [] });

    const implRes = await fetch(`${baseUrl}/implement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Supplier reply",
        solution: "Insert Thanks, shipping Friday. into the reply box.",
        context: {
          app: "mail.example.com",
          url: "https://mail.example.com/tickets/42",
          title: "Ticket #42",
          targetLabel: "Customer Reply",
        },
      }),
    });
    expect(implRes.status).toBe(200);
    expect(await implRes.json()).toEqual({
      ok: true,
      script: {
        name: "Supplier reply",
        steps: [{ action: "insertText", value: "Thanks, shipping Friday." }],
      },
    });

    const listRes = await fetch(`${baseUrl}/library`);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      ok: boolean;
      items: Array<{
        id: string;
        name: string;
        kind: string;
        eyes: {
          triggerEvent: string;
          scope: { apps: string[]; urlPatterns: string[]; pageHints: string[] };
          targetHints: { labelContains: string[] };
          textHints: { prefixHints: string[] };
        };
      }>;
    };
    expect(listJson.ok).toBe(true);
    expect(listJson.items).toHaveLength(1);
    const saved = listJson.items[0];
    expect(saved.name).toBe("Supplier reply");
    expect(saved.kind).toBe("snippet");
    expect(saved.eyes.scope.apps).toEqual(["mail.example.com"]);
    expect(saved.eyes.scope.urlPatterns).toEqual(["/tickets/*"]);
    expect(saved.eyes.targetHints.labelContains).toContain("customer reply");
    expect(saved.eyes.textHints.prefixHints).toEqual(["thanks, shipping friday."]);

    const libImplRes = await fetch(`${baseUrl}/library/implement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Second entry",
        solution: "Insert Thanks, shipping Friday.",
      }),
    });
    expect(libImplRes.status).toBe(200);
    const libImplJson = (await libImplRes.json()) as {
      ok: boolean;
      entry: { id: string; name: string };
    };
    expect(libImplJson.ok).toBe(true);
    expect(libImplJson.entry.name).toBe("Second entry");

    const delRes = await fetch(`${baseUrl}/library/${libImplJson.entry.id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    const delJson = (await delRes.json()) as { ok: boolean; items: unknown[] };
    expect(delJson.items).toHaveLength(1);
  });
});
