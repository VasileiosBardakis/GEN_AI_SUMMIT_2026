import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, Report } from "@gen/shared";
import { ReportSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import { buildReport } from "../src/report.ts";

describe("GET /report HTTP integration", () => {
  let tracesDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-report-test-"));
    server = createServer({ tracesDir, autoPropose: false });
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

  it("returns findings: [] for GET /report?session=missing_session", async () => {
    const res = await fetch(`${baseUrl}/report?session=missing_session`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as Report;
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("missing_session");
    expect(report.findings).toEqual([]);
  });
});

describe("buildReport (v2 meaningful window summary)", () => {
  function buildFourStepEvents(tries: number): Event[] {
    const events: Event[] = [];
    let seq = 0;
    const baseTs = 1_745_000_000_000;
    for (let r = 0; r < tries; r++) {
      const t = baseTs + r * 5_000;
      const push = (
        type: Event["type"],
        app: string,
        dt: number,
        extra: Partial<Event> = {},
      ) => {
        seq += 1;
        events.push({
          v: 1,
          id: `90000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
          ts: t + dt,
          session: "sess_v2_4step",
          source: "browser",
          app,
          type,
          ...extra,
        });
      };
      push("click", "portal.local", 100, {
        target: { locators: [{ kind: "testid", value: `copy-${r}` }] },
      });
      push("copy", "portal.local", 200, {
        clipboard: { text: `val-${r}` },
        value: `val-${r}`,
      });
      push("tab_switch", "erp.local", 300);
      push("paste", "erp.local", 400, {
        target: { locators: [{ kind: "testid", value: "erp-input" }] },
        value: `val-${r}`,
      });
    }
    return events;
  }

  it("reports 1 wf_* summary finding when llm === false and meaningfulCount >= 2", async () => {
    const events = buildFourStepEvents(1);
    const report = await buildReport("sess_v2_4step", events, { llm: false });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].id).toMatch(/^wf_/);
    expect(report.findings[0].verdict).toBe("rung0");
  });

  it("returns findings: [] when < 2 meaningful steps", async () => {
    const events = buildFourStepEvents(1).slice(0, 1);
    const report = await buildReport("sess_v2_4step", events, { llm: false });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toEqual([]);
  });

  it("ignores transition-only sequences such as nav->nav or tab_switch->tab_switch", async () => {
    const baseTs = 1_745_200_000_000;
    const navOnlyEvents: Event[] = [0, 1, 2, 3].map((i) => ({
      v: 1,
      id: `93000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      ts: baseTs + i * 500,
      session: "sess_v2_nav_only",
      source: "browser",
      app: i % 2 === 0 ? "127.0.0.1" : "localhost",
      url: `http://localhost:5173/${i % 2 === 0 ? "portal.html" : "erp.html"}`,
      type: i < 2 ? "nav" : "tab_switch",
    }));

    const report = await buildReport("sess_v2_nav_only", navOnlyEvents, { llm: false });
    expect(report.findings).toEqual([]);
  });
});
