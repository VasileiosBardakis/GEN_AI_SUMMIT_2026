import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, Report } from "@gen/shared";
import { ReportSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import { buildReport, pickPrimaryCandidate } from "../src/report.ts";
import { detectRepeatedCandidates, eventsToSteps } from "../src/v2/index.ts";

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

describe("buildReport (v2 repetition counting)", () => {
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

  function buildPortalToErpRowEvents(
    rows: number,
    opts?: { omitInitialTabSwitch?: boolean; omitSaveSubmit?: boolean },
  ): Event[] {
    const events: Event[] = [];
    let seq = 0;
    const baseTs = 1_745_100_000_000;
    const fields = ["invoice-id", "vendor", "amount", "date"];
    for (let r = 0; r < rows; r++) {
      let ts = baseTs + r * 20_000;
      const push = (
        type: Event["type"],
        app: string,
        extra: Partial<Event> = {},
      ) => {
        seq += 1;
        ts += 100;
        events.push({
          v: 1,
          id: `91000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
          ts,
          session: "sess_v2_portal_erp",
          source: "browser",
          app,
          type,
          ...extra,
        });
      };
      for (let f = 0; f < fields.length; f++) {
        if (!(opts?.omitInitialTabSwitch && r === 0 && f === 0)) {
          push("tab_switch", "portal.local");
        }
        push("click", "portal.local", {
          target: { locators: [{ kind: "testid", value: `copy-${fields[f]}-${r}` }] },
        });
        push("copy", "portal.local", {
          target: { locators: [{ kind: "testid", value: `portal-${fields[f]}-${r}` }] },
          clipboard: { text: `${fields[f]}-${r}` },
          value: `${fields[f]}-${r}`,
        });
        push("tab_switch", "erp.local");
        push("click", "erp.local", {
          target: { locators: [{ kind: "testid", value: `erp-${fields[f]}` }] },
        });
        push("paste", "erp.local", {
          target: { locators: [{ kind: "testid", value: `erp-${fields[f]}` }] },
          value: `${fields[f]}-${r}`,
        });
        push("input", "erp.local", {
          target: { locators: [{ kind: "testid", value: `erp-${fields[f]}` }] },
          value: `${fields[f]}-${r}`,
        });
      }
      if (!opts?.omitSaveSubmit) {
        push("click", "erp.local", {
          target: { locators: [{ kind: "testid", value: "save-btn" }] },
        });
        push("submit", "erp.local");
      }
    }
    return events;
  }

  it("reports 1 wf_* finding with repetitions === 3 for 3 tries of a 4-step task", async () => {
    const events = buildFourStepEvents(3);
    const report = await buildReport("sess_v2_4step", events, { llm: false });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].id).toMatch(/^wf_/);
    expect(report.findings[0].stats.repetitions).toBe(3);
  });

  it("reports repetitions === 3 (not 12) for 3 rows of a 4-field copy/switch/paste + save flow", async () => {
    const events = buildPortalToErpRowEvents(3);
    const report = await buildReport("sess_v2_portal_erp", events, { llm: false });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].id).toMatch(/^wf_/);
    expect(report.findings[0].stats.repetitions).toBe(3);

    const eventsNoInitSwitch = buildPortalToErpRowEvents(3, {
      omitInitialTabSwitch: true,
    });
    const reportNoInit = await buildReport(
      "sess_v2_portal_erp",
      eventsNoInitSwitch,
      { llm: false },
    );
    expect(reportNoInit.findings).toHaveLength(1);
    expect(reportNoInit.findings[0].stats.repetitions).toBe(3);

    const { steps } = eventsToSteps(events);
    const candidates = detectRepeatedCandidates(steps);
    const primary = pickPrimaryCandidate(candidates);
    expect(primary).toBeDefined();
    expect(primary?.count).toBe(3);
    expect(primary?.actions.length).toBeGreaterThan(20);
  });

  it("reports repetitions === 3 (not 12) when 3 rows x 4 fields is an exact multiple of the field cycle (no save/submit)", async () => {
    const events = buildPortalToErpRowEvents(3, { omitSaveSubmit: true });
    const report = await buildReport("sess_v2_portal_erp", events, { llm: false });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].stats.repetitions).toBe(3);

    const { steps } = eventsToSteps(events);
    const candidates = detectRepeatedCandidates(steps);
    const primary = pickPrimaryCandidate(candidates);
    expect(primary).toBeDefined();
    expect(primary?.count).toBe(3);
    expect(primary?.actions.length).toBe(28);

    const sixTries = buildFourStepEvents(6);
    const sixReport = await buildReport("sess_v2_4step", sixTries, { llm: false });
    expect(sixReport.findings).toHaveLength(1);
    expect(sixReport.findings[0].stats.repetitions).toBe(6);
  });

  it("returns findings: [] for 1 row of the 4-field portal-to-ERP flow", async () => {
    const events = buildPortalToErpRowEvents(1);
    const report = await buildReport("sess_v2_portal_erp", events, { llm: false });

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

  it("isolates signatures by step host and respects REPEAT_COUNT env override", async () => {
    const crossSiteEvents: Event[] = [
      ...buildFourStepEvents(2).map((e) => ({
        ...e,
        app: e.app === "portal.local" ? "portal-a.local" : "erp-a.local",
      })),
      ...buildFourStepEvents(1).map((e, idx) => ({
        ...e,
        id: `92000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        ts: e.ts + 50_000,
        app: e.app === "portal.local" ? "portal-b.local" : "erp-b.local",
      })),
    ];

    const crossReport = await buildReport("sess_v2_4step", crossSiteEvents, { llm: false });
    expect(crossReport.findings).toEqual([]);

    const prevRepeatEnv = process.env.REPEAT_COUNT;
    try {
      process.env.REPEAT_COUNT = "4";
      const threeRows = buildPortalToErpRowEvents(3);
      const reportAt4 = await buildReport("sess_v2_portal_erp", threeRows, { llm: false });
      expect(reportAt4.findings).toEqual([]);

      process.env.REPEAT_COUNT = "2";
      const twoRows = buildPortalToErpRowEvents(2);
      const reportAt2 = await buildReport("sess_v2_portal_erp", twoRows, { llm: false });
      expect(reportAt2.findings).toHaveLength(1);
      expect(reportAt2.findings[0].stats.repetitions).toBe(2);
    } finally {
      if (prevRepeatEnv === undefined) {
        delete process.env.REPEAT_COUNT;
      } else {
        process.env.REPEAT_COUNT = prevRepeatEnv;
      }
    }
  });
});
