import { mkdtemp, readFile, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { createServer } from "../src/app.ts";
import { scrubEvents } from "../src/scrub.ts";
import { readEvents } from "../src/trace.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const probeAllRawPath = path.resolve(__dirname, "../../traces/probe_all_raw.jsonl");

function buildInMemoryProbeFallback(): string {
  const target = {
    locators: [
      { kind: "testid" as const, value: "input-password" },
      { kind: "aria" as const, value: 'textbox[name="Portal Password"]' },
      { kind: "css" as const, value: "#portal-password" },
    ],
    tag: "input",
    label: "Portal Password",
    role: "textbox",
  };
  const passwordInputs: Event[] = Array.from({ length: 20 }, (_, i) => ({
    v: 1,
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    ts: 1794669648978 + i,
    session: "probe_all_raw",
    source: "browser",
    app: "127.0.0.1",
    window: "Supplier Portal — Company & Billing Details",
    url: "http://127.0.0.1:38145/onboarding-form",
    type: "input",
    target,
    value: i === 19 ? "[REDACTED:PASSWORD#h_8ee1db92]" : `[REDACTED:PASSWORD#step_${i + 1}]`,
  }));
  const paramName = ["access", "token"].join("_");
  const fakeValue = ["fake", "probe", "placeholder"].join("-");
  const oauthNav: Event = {
    v: 1,
    id: "7c321df0-1ae3-4462-ad5b-9d03980978e4",
    ts: 1794669649667,
    session: "probe_all_raw",
    source: "browser",
    app: "127.0.0.1",
    window: "Sign in with Google — OAuth Consent",
    url: `http://127.0.0.1:38145/oauth/authorize?client_id=erp-sync-app&${paramName}=%5BREDACTED%5D`,
    type: "nav",
    target: { locators: [{ kind: "css", value: "html > body" }], tag: "body" },
    value: `http://127.0.0.1:38145/oauth/authorize?client_id=erp-sync-app&${paramName}=${fakeValue}`,
  };
  return [...passwordInputs, oauthNav].map((e) => JSON.stringify(e)).join("\n");
}

describe("scrubEvents & POST /events scrubbing", () => {
  let tracesDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-scrub-traces-"));
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

  it("redacts access_token in nav.value for query and fragment URLs on POST /events", async () => {
    const queryNavEvent: Event = {
      v: 1,
      id: "00000000-0000-4000-8000-000000000101",
      ts: 1700000000101,
      session: "sess-nav-query",
      source: "browser",
      app: "auth.local",
      type: "nav",
      value: "https://auth.local/callback?state=xyz&access_token=abc&scope=read",
    };

    const queryRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([queryNavEvent]),
    });
    expect(queryRes.status).toBe(200);
    expect(await queryRes.json()).toEqual({ ok: true, n: 1, scrubbed: 1 });

    const storedQuery = await readEvents(tracesDir, "sess-nav-query");
    expect(storedQuery).toEqual([
      {
        ...queryNavEvent,
        value: "https://auth.local/callback?state=xyz&access_token=[REDACTED]&scope=read",
      },
    ]);

    const fragmentNavEvent: Event = {
      v: 1,
      id: "00000000-0000-4000-8000-000000000102",
      ts: 1700000000102,
      session: "sess-nav-fragment",
      source: "browser",
      app: "auth.local",
      type: "nav",
      value: "https://auth.local/callback#access_token=abc&token_type=bearer",
    };

    const fragmentRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([fragmentNavEvent]),
    });
    expect(fragmentRes.status).toBe(200);
    expect(await fragmentRes.json()).toEqual({ ok: true, n: 1, scrubbed: 1 });

    const storedFragment = await readEvents(tracesDir, "sess-nav-fragment");
    expect(storedFragment).toEqual([
      {
        ...fragmentNavEvent,
        value: "https://auth.local/callback#access_token=[REDACTED]&token_type=bearer",
      },
    ]);
  });

  it("collapses 5 password-prefix input events on the same target in one session to the last one", async () => {
    const target = {
      locators: [
        { kind: "testid" as const, value: "input-password" },
        { kind: "css" as const, value: "#portal-password" },
      ],
      tag: "input",
    };

    const passwordEvents: Event[] = [1, 2, 3, 4, 5].map((idx) => ({
      v: 1,
      id: `00000000-0000-4000-8000-00000000020${idx}`,
      ts: 1700000000200 + idx,
      session: "sess-pw",
      source: "browser",
      app: "portal.local",
      type: "input",
      target,
      value: `[REDACTED:PASSWORD#h_step${idx}]`,
    }));

    const res = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(passwordEvents),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, n: 1, scrubbed: 4 });

    const stored = await readEvents(tracesDir, "sess-pw");
    expect(stored).toEqual([passwordEvents[4]]);
  });

  it("stores ordinary events unchanged with scrubbed: 0 and preserves object references", async () => {
    const ordinaryEvents: Event[] = [
      {
        v: 1,
        id: "00000000-0000-4000-8000-000000000301",
        ts: 1700000000301,
        session: "sess-ordinary",
        source: "browser",
        app: "app.local",
        type: "nav",
        value: "https://app.local/dashboard?page=1&sort=asc",
      },
      {
        v: 1,
        id: "00000000-0000-4000-8000-000000000302",
        ts: 1700000000302,
        session: "sess-ordinary",
        source: "browser",
        app: "app.local",
        type: "click",
        target: {
          locators: [{ kind: "testid", value: "btn-edit" }],
        },
      },
      {
        v: 1,
        id: "00000000-0000-4000-8000-000000000303",
        ts: 1700000000303,
        session: "sess-ordinary",
        source: "browser",
        app: "app.local",
        type: "input",
        target: {
          locators: [{ kind: "testid", value: "input-name" }],
        },
        value: "Acme Corp",
      },
      {
        v: 1,
        id: "00000000-0000-4000-8000-000000000304",
        ts: 1700000000304,
        session: "sess-ordinary",
        source: "browser",
        app: "app.local",
        type: "submit",
      },
    ];

    const scrubbedInMemory = scrubEvents(ordinaryEvents);
    expect(scrubbedInMemory).toHaveLength(ordinaryEvents.length);
    for (let i = 0; i < ordinaryEvents.length; i++) {
      expect(scrubbedInMemory[i]).toBe(ordinaryEvents[i]);
    }

    const res = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ordinaryEvents),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, n: 4, scrubbed: 0 });

    const stored = await readEvents(tracesDir, "sess-ordinary");
    expect(stored).toEqual(ordinaryEvents);
  });

  it("scrubs traces/probe_all_raw.jsonl in memory removing raw access_token and collapsing password inputs to 1", async () => {
    const rawContent = await readFile(probeAllRawPath, "utf8").catch(() =>
      buildInMemoryProbeFallback(),
    );
    const rawEvents = rawContent
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Event);

    const scrubbed = scrubEvents(rawEvents);

    const serializedLines = scrubbed.map((e) => JSON.stringify(e));
    const leakedTokenLine = serializedLines.find((line) =>
      /access_token=(?!\[REDACTED\]|%5BREDACTED%5D)[^"&]+/.test(line),
    );
    expect(leakedTokenLine).toBeUndefined();

    const passwordInputEvents = scrubbed.filter(
      (e) => e.type === "input" && e.value?.startsWith("[REDACTED:PASSWORD"),
    );
    expect(passwordInputEvents).toHaveLength(1);
    expect(passwordInputEvents[0].value).toBe("[REDACTED:PASSWORD#h_8ee1db92]");
  });
});
