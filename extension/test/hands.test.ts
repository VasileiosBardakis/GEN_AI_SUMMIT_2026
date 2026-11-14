import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../../server/src/app.ts";
import { implementSolution } from "../../server/src/hands/implementor.ts";
import { fetchLatestScript, substitute } from "../src/background.ts";
import type { Step } from "../src/types.ts";

describe("Stage 5: extension hands helpers", () => {
  let tracesDir = "";
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    }
    if (tracesDir) {
      await rm(tracesDir, { recursive: true, force: true });
      tracesDir = "";
    }
  });

  it("preserves forEach nested step placeholders until each loop item runs", () => {
    const loopStep: Step = {
      action: "forEach",
      items: "{{targetBinding}}",
      steps: [
        {
          action: "fill",
          target: { kind: "css", value: "input[name='id']" },
          value: "{{id}}",
        },
      ],
    };

    const substituted = substitute(loopStep, { targetBinding: "orders" });
    expect(substituted).toEqual({
      action: "forEach",
      items: "orders",
      steps: [
        {
          action: "fill",
          target: { kind: "css", value: "input[name='id']" },
          value: "{{id}}",
        },
      ],
    });
  });

  it("fetchLatestScript returns null on 404/offline and returns the compiled ActionScript after POST /implement", async () => {
    tracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-ext-hands-"));
    server = createServer({
      tracesDir,
      implement: (solution, opts) =>
        implementSolution(solution, {
          ...opts,
          generate: async () => ({
            steps: [{ action: "insertText", value: "Hello from server" }],
          }),
        }),
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    await expect(fetchLatestScript(baseUrl)).resolves.toBeNull();

    const postRes = await fetch(`${baseUrl}/implement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Greeting", solution: "Insert Hello from server" }),
    });
    expect(postRes.status).toBe(200);

    const script = await fetchLatestScript(baseUrl);
    expect(script).toEqual({
      name: "Greeting",
      steps: [{ action: "insertText", value: "Hello from server" }],
    });
  });
});
