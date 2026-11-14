import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../server/src/app.ts";
import { implementSolution } from "../../server/src/hands/implementor.ts";
import { fetchLatestScript, runActionScript, substitute } from "../src/background.ts";
import type { ActionScript, Step } from "../src/types.ts";

describe("Stage 5: extension hands helpers", () => {
  let tracesDir = "";
  let server: http.Server | null = null;
  const originalChrome = (globalThis as Record<string, unknown>).chrome;

  afterEach(async () => {
    if (originalChrome === undefined) {
      delete (globalThis as Record<string, unknown>).chrome;
    } else {
      (globalThis as Record<string, unknown>).chrome = originalChrome;
    }
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

  it("switchTab switches currentTabId from tab 101 (portal.local) to tab 202 (erp.local) and fills with read value", async () => {
    const query = vi.fn(async () => [
      { id: 101, url: "https://portal.local/orders/1", windowId: 1, active: true, lastAccessed: 900 },
      { id: 201, url: "https://erp.local/old", windowId: 2, active: false, lastAccessed: 100 },
      { id: 202, url: "https://erp.local/entry", windowId: 2, active: false, lastAccessed: 500 },
    ]);
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const updateWindow = vi.fn(async () => ({}));
    const executeScript = vi.fn(
      async ({ target, args }: { target: { tabId: number }; args: [Step] }) => {
        const step = args[0];
        if (step.action === "readText") {
          return [{ frameId: 0, result: { ok: true, url: "https://portal.local/orders/1", value: "ORD-42" } }];
        }
        return [{ frameId: 0, result: { ok: true, url: `tab:${target.tabId}` } }];
      },
    );

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query, update: updateTab },
      windows: { update: updateWindow },
      scripting: { executeScript },
    };

    const script: ActionScript = {
      steps: [
        { action: "readText", target: { kind: "css", value: ".order-id" }, bind: "orderId" },
        { action: "switchTab", host: "erp.local" },
        { action: "fill", target: { kind: "css", value: 'input[name="id"]' }, value: "{{orderId}}" },
        {
          action: "forEach",
          items: [{ note: "priority" }],
          steps: [{ action: "fill", target: { kind: "css", value: 'input[name="note"]' }, value: "{{note}}" }],
        },
      ],
    };

    const results = await runActionScript(101, script);

    expect(query).toHaveBeenCalledWith({});
    expect(updateTab).toHaveBeenCalledWith(202, { active: true });
    expect(updateWindow).toHaveBeenCalledWith(2, { focused: true });
    expect(executeScript).toHaveBeenCalledTimes(3);
    expect(executeScript.mock.calls[0]?.[0].target.tabId).toBe(101);
    expect(executeScript.mock.calls[1]?.[0].target.tabId).toBe(202);
    expect(executeScript.mock.calls[1]?.[0].args[0]).toMatchObject({
      action: "fill",
      value: "ORD-42",
    });
    expect(executeScript.mock.calls[2]?.[0].target.tabId).toBe(202);
    expect(executeScript.mock.calls[2]?.[0].args[0]).toMatchObject({
      action: "fill",
      value: "priority",
    });
    expect(results[1]).toEqual({ ok: true, tab: "erp.local" });
  });

  it("switchTab throws when no open tab matches host and does not run later fill", async () => {
    const query = vi.fn(async () => [
      { id: 101, url: "https://portal.local/orders/1", windowId: 1, active: true },
    ]);
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const executeScript = vi.fn(async () => [
      { frameId: 0, result: { ok: true, url: "https://portal.local/orders/1", value: "ORD-42" } },
    ]);

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query, update: updateTab },
      scripting: { executeScript },
    };

    const script: ActionScript = {
      steps: [
        { action: "readText", target: { kind: "css", value: ".order-id" }, bind: "orderId" },
        { action: "switchTab", host: "erp.local" },
        { action: "fill", target: { kind: "css", value: 'input[name="id"]' }, value: "{{orderId}}" },
      ],
    };

    await expect(runActionScript(101, script)).rejects.toThrow("No open tab for erp.local");
    expect(updateTab).not.toHaveBeenCalled();
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("switchTab matches host:port when port is specified in step.host", async () => {
    const query = vi.fn(async () => [
      { id: 301, url: "http://127.0.0.1:4173/other", active: true },
      { id: 302, url: "http://127.0.0.1:5173/target", active: false },
    ]);
    const updateTab = vi.fn(async (tabId: number) => ({ id: tabId }));
    const executeScript = vi.fn(async ({ target }: { target: { tabId: number } }) => [
      { frameId: 0, result: { ok: true, url: `tab:${target.tabId}` } },
    ]);

    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query, update: updateTab },
      scripting: { executeScript },
    };

    const results = await runActionScript(301, {
      steps: [
        { action: "switchTab", host: "127.0.0.1:5173" },
        { action: "click", target: { kind: "css", value: "#go" } },
      ],
    });

    expect(updateTab).toHaveBeenCalledWith(302, { active: true });
    expect(executeScript.mock.calls[0]?.[0].target.tabId).toBe(302);
    expect(results[0]).toEqual({ ok: true, tab: "127.0.0.1:5173" });
  });
});
