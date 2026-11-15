import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Report } from "@gen/shared";
import { EventSchema, ReportSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import type { ActionScript } from "../src/hands/types.ts";
import type { GeminiSdk } from "../src/llm/gemini.ts";
import { buildCombinedReport, buildReport, pickPrimaryCandidate } from "../src/report.ts";
import { detectRepeatedCandidates, eventsToSteps } from "../src/v2/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

describe("buildReport", () => {
  it("returns findings: [] when called with no events", async () => {
    const report = await buildReport("sess_empty");
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("sess_empty");
    expect(report.findings).toEqual([]);
  });

  it("returns 1 rung1 finding with repetitions === 3 for reply-x3.jsonl events", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
    const report = await buildReport("sess_reply_x3", replyX3Events);

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("sess_reply_x3");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].verdict).toBe("rung1");
    expect(report.findings[0].stats.repetitions).toBe(3);
  });
});

function groupBySession(events: Event[]): Event[][] {
  const bySession = new Map<string, Event[]>();
  for (const ev of events) {
    const list = bySession.get(ev.session);
    if (list) {
      list.push(ev);
    } else {
      bySession.set(ev.session, [ev]);
    }
  }
  return Array.from(bySession.values());
}

describe("buildCombinedReport", () => {
  it("combines findings across sessions and deduplicates by finding.id", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
    const navOnlyEvents: Event[] = [
      {
        v: 1,
        id: "10000000-0000-4000-8000-000000000001",
        ts: 1740000030000,
        session: "sess_browser",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:3000/inbox",
        type: "nav",
      },
    ];
    const duplicateSessionEvents = replyX3Events.map((e, i) => ({
      ...e,
      id: `20000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      session: "sess_reply_x3_dup",
    }));

    const report = await buildCombinedReport([
      replyX3Events,
      navOnlyEvents,
      duplicateSessionEvents,
    ]);

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("all");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].verdict).toBe("rung1");
    expect(report.findings[0].stats.repetitions).toBe(3);
  });

  it("joins crosstab-x3-split (3 sessions) into one rung2 finding for portal.local -> erp.local", async () => {
    const splitEvents = await loadFixtureEvents("crosstab-x3-split.jsonl");
    const sessions = groupBySession(splitEvents);
    expect(sessions).toHaveLength(3);

    const report = await buildCombinedReport(sessions, { llm: false });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("all");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].verdict).toBe("rung2");
    expect(report.findings[0].title).toContain(
      "Copy 4 fields from portal.local to erp.local",
    );
    expect(report.findings[0].stats.repetitions).toBe(3);
  });

  it("does not join two sessions 2 hours apart each with 1 reply (no finding)", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
    const oneReply = replyX3Events.slice(0, 8);
    const twoHoursMs = 2 * 60 * 60 * 1000;

    const session1 = oneReply.map((e, i) => ({
      ...e,
      id: `50000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      session: "sess_reply_1",
    }));
    const session2 = oneReply.map((e, i) => ({
      ...e,
      id: `60000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      ts: e.ts + twoHoursMs,
      session: "sess_reply_2",
    }));

    const report = await buildCombinedReport([session1, session2], { llm: false });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("all");
    expect(report.findings).toEqual([]);
  });

  it("deduplicates findings with the same id by keeping the one with more repetitions", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const oneReply = replyX3Events.slice(1, 8);
    const replyX5Events = [
      ...replyX3Events,
      ...oneReply.map((e, i) => ({
        ...e,
        id: `71000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        ts: e.ts + 30_000,
      })),
      ...oneReply.map((e, i) => ({
        ...e,
        id: `72000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        ts: e.ts + 60_000,
      })),
    ].map((e, i) => ({
      ...e,
      id: `70000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      ts: e.ts + twoHoursMs,
      session: "sess_reply_x5",
    }));

    const report = await buildCombinedReport([replyX3Events, replyX5Events], {
      llm: false,
    });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].verdict).toBe("rung1");
    expect(report.findings[0].stats.repetitions).toBe(5);
  });

  it("produces the same verdicts as before for reply-x3, invoice-x9, and dispute-x3", async () => {
    const cases: Array<{ fixture: string; expectedVerdict: string }> = [
      { fixture: "reply-x3.jsonl", expectedVerdict: "rung1" },
      { fixture: "invoice-x9.jsonl", expectedVerdict: "rung2" },
      { fixture: "dispute-x3.jsonl", expectedVerdict: "do_not_automate" },
    ];

    for (const { fixture, expectedVerdict } of cases) {
      const events = await loadFixtureEvents(fixture);
      const single = await buildReport(events[0].session, events, { llm: false });
      const combined = await buildCombinedReport([events], { llm: false });

      expect(ReportSchema.parse(combined)).toEqual(combined);
      expect(combined.session).toBe("all");
      expect(combined.findings.map((f) => f.verdict)).toEqual(
        single.findings.map((f) => f.verdict),
      );
      expect(combined.findings.some((f) => f.verdict === expectedVerdict)).toBe(
        true,
      );
    }
  });
});

describe("GET /report HTTP integration", () => {
  let tracesDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-report-test-"));
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

  it("returns 1 rung1 finding for GET /report?session=sess_reply_x3 after POSTing reply-x3.jsonl", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");

    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replyX3Events),
    });
    expect(postRes.status).toBe(200);

    const bySessionRes = await fetch(
      `${baseUrl}/report?session=sess_reply_x3`,
    );
    expect(bySessionRes.status).toBe(200);
    const bySessionReport = (await bySessionRes.json()) as Report;
    expect(ReportSchema.parse(bySessionReport)).toEqual(bySessionReport);
    expect(bySessionReport.session).toBe("sess_reply_x3");
    expect(bySessionReport.findings).toHaveLength(1);
    expect(bySessionReport.findings[0].verdict).toBe("rung1");
    expect(bySessionReport.findings[0].stats.repetitions).toBe(3);
  });

  it("returns combined session === 'all' for GET /report without ?session= after POSTing reply-x3.jsonl", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");

    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replyX3Events),
    });
    expect(postRes.status).toBe(200);

    const latestRes = await fetch(`${baseUrl}/report`);
    expect(latestRes.status).toBe(200);
    const latestReport = (await latestRes.json()) as Report;
    expect(ReportSchema.parse(latestReport)).toEqual(latestReport);
    expect(latestReport.session).toBe("all");
    expect(latestReport.findings).toHaveLength(1);
    expect(latestReport.findings[0].verdict).toBe("rung1");
    expect(latestReport.findings[0].stats.repetitions).toBe(3);
  });

  it("returns session: 'all' and rung1 finding when reply-x3.jsonl is followed by nav-only sess_browser events", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
    const browserNavEvents: Event[] = [
      {
        v: 1,
        id: "30000000-0000-4000-8000-000000000001",
        ts: 1740000050000,
        session: "sess_browser",
        source: "browser",
        app: "127.0.0.1",
        url: "http://127.0.0.1:3000/inbox",
        type: "nav",
      },
    ];

    const postReplyRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replyX3Events),
    });
    expect(postReplyRes.status).toBe(200);

    const postBrowserRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(browserNavEvents),
    });
    expect(postBrowserRes.status).toBe(200);

    const allRes = await fetch(`${baseUrl}/report`);
    expect(allRes.status).toBe(200);
    const allReport = (await allRes.json()) as Report;
    expect(ReportSchema.parse(allReport)).toEqual(allReport);
    expect(allReport.session).toBe("all");
    expect(allReport.findings).toHaveLength(1);
    expect(allReport.findings[0].verdict).toBe("rung1");

    const browserOnlyRes = await fetch(
      `${baseUrl}/report?session=sess_browser`,
    );
    expect(browserOnlyRes.status).toBe(200);
    const browserOnlyReport = (await browserOnlyRes.json()) as Report;
    expect(browserOnlyReport.session).toBe("sess_browser");
    expect(browserOnlyReport.findings).toEqual([]);
  });

  it("deduplicates identical finding ids across two sessions in GET /report", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
    const secondSessionEvents = replyX3Events.map((e, i) => ({
      ...e,
      id: `40000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      session: "sess_reply_x3_copy",
    }));

    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replyX3Events),
    });
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(secondSessionEvents),
    });

    const reportRes = await fetch(`${baseUrl}/report`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("all");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].verdict).toBe("rung1");
  });

  it("ignores session .jsonl files with mtime older than 30 minutes in GET /report without ?session=", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");

    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replyX3Events),
    });
    expect(postRes.status).toBe(200);

    const oldTime = new Date(Date.now() - 31 * 60 * 1000);
    const sessionFile = path.join(tracesDir, "sess_reply_x3.jsonl");
    await utimes(sessionFile, oldTime, oldTime);

    const reportRes = await fetch(`${baseUrl}/report`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("all");
    expect(report.findings).toEqual([]);
  });

  it("returns findings: [] for GET /report?session=sess_one_off after POSTing one-off.jsonl", async () => {
    const oneOffEvents = await loadFixtureEvents("one-off.jsonl");

    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(oneOffEvents),
    });
    expect(postRes.status).toBe(200);

    const reportRes = await fetch(`${baseUrl}/report?session=sess_one_off`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("sess_one_off");
    expect(report.findings).toEqual([]);
  });

  it("returns findings: [] for GET /report?session=missing_session", async () => {
    const reportRes = await fetch(`${baseUrl}/report?session=missing_session`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("missing_session");
    expect(report.findings).toEqual([]);
  });

  it("joins crosstab-x3-split on GET /report while keeping GET /report?session=X single-session", async () => {
    const splitEvents = await loadFixtureEvents("crosstab-x3-split.jsonl");

    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(splitEvents),
    });
    expect(postRes.status).toBe(200);

    const combinedRes = await fetch(`${baseUrl}/report?llm=0`);
    expect(combinedRes.status).toBe(200);
    const combinedReport = (await combinedRes.json()) as Report;
    expect(ReportSchema.parse(combinedReport)).toEqual(combinedReport);
    expect(combinedReport.session).toBe("all");
    expect(combinedReport.findings).toHaveLength(1);
    expect(combinedReport.findings[0].verdict).toBe("rung2");
    expect(combinedReport.findings[0].title).toContain(
      "Copy 4 fields from portal.local to erp.local",
    );

    const portalOnlyRes = await fetch(
      `${baseUrl}/report?session=sess_portal_tab&llm=0`,
    );
    expect(portalOnlyRes.status).toBe(200);
    const portalOnlyReport = (await portalOnlyRes.json()) as Report;
    expect(ReportSchema.parse(portalOnlyReport)).toEqual(portalOnlyReport);
    expect(portalOnlyReport.session).toBe("sess_portal_tab");
    expect(
      portalOnlyReport.findings.some((f) =>
        f.title.includes("Copy 4 fields from portal.local to erp.local"),
      ),
    ).toBe(false);
  });

  it("caches GET /report when no new events arrive and calls implement/gemini only once", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "gen-report-cache-"));
    const generateContent = vi.fn<GeminiSdk["models"]["generateContent"]>(
      async () => ({
        text: JSON.stringify({
          level: "rung1",
          risky: false,
          confidence: 0.9,
          name: "Cached reply",
        }),
      }),
    );
    const implement = vi.fn(
      async (_solution: string, opts?: { name?: string }): Promise<ActionScript> => ({
        name: opts?.name ?? "Cached script",
        steps: [{ action: "insertText", value: "cached" }],
      }),
    );
    const cachedServer = createServer({
      tracesDir: path.join(cacheRoot, "traces"),
      dataDir: path.join(cacheRoot, "data"),
      gemini: { sdk: { models: { generateContent } } },
      implement,
      autoPropose: false,
    });
    await new Promise<void>((resolve) => {
      cachedServer.listen(0, "127.0.0.1", () => resolve());
    });
    const cachedPort = (cachedServer.address() as AddressInfo).port;
    const cachedUrl = `http://127.0.0.1:${cachedPort}`;

    try {
      const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
      await fetch(`${cachedUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(replyX3Events),
      });

      const res1 = await fetch(`${cachedUrl}/report?session=sess_reply_x3`);
      expect(res1.status).toBe(200);
      const report1 = (await res1.json()) as Report;
      expect(report1.findings).toHaveLength(1);
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(implement).toHaveBeenCalledTimes(1);

      const res2 = await fetch(`${cachedUrl}/report?session=sess_reply_x3`);
      expect(res2.status).toBe(200);
      const report2 = (await res2.json()) as Report;
      expect(report2).toEqual(report1);
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(implement).toHaveBeenCalledTimes(1);

      const allRes1 = await fetch(`${cachedUrl}/report`);
      expect(allRes1.status).toBe(200);
      expect(generateContent).toHaveBeenCalledTimes(2);
      expect(implement).toHaveBeenCalledTimes(2);

      const allRes2 = await fetch(`${cachedUrl}/report`);
      expect(allRes2.status).toBe(200);
      expect(generateContent).toHaveBeenCalledTimes(2);
      expect(implement).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        cachedServer.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(cacheRoot, { recursive: true, force: true });
    }
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
    const report = await buildReport("sess_v2_4step", events, {
      pipeline: "v2",
      llm: false,
    });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].id).toMatch(/^wf_/);
    expect(report.findings[0].stats.repetitions).toBe(3);
  });

  it("reports repetitions === 3 (not 12) for 3 rows of a 4-field copy/switch/paste + save flow", async () => {
    const events = buildPortalToErpRowEvents(3);
    const report = await buildReport("sess_v2_portal_erp", events, {
      pipeline: "v2",
      llm: false,
    });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].id).toMatch(/^wf_/);
    expect(report.findings[0].stats.repetitions).toBe(3);

    // Also when row 1 starts on portal tab without an initial tab_switch
    const eventsNoInitSwitch = buildPortalToErpRowEvents(3, {
      omitInitialTabSwitch: true,
    });
    const reportNoInit = await buildReport(
      "sess_v2_portal_erp",
      eventsNoInitSwitch,
      { pipeline: "v2", llm: false },
    );
    expect(reportNoInit.findings).toHaveLength(1);
    expect(reportNoInit.findings[0].stats.repetitions).toBe(3);

    // Verify detectRepeatedCandidates + pickPrimaryCandidate directly
    const { steps } = eventsToSteps(events);
    const candidates = detectRepeatedCandidates(steps);
    const primary = pickPrimaryCandidate(candidates);
    expect(primary).toBeDefined();
    expect(primary?.count).toBe(3);
    expect(primary?.actions.length).toBeGreaterThan(20);
  });

  it("reports repetitions === 3 (not 12) when 3 rows x 4 fields is an exact multiple of the field cycle (no save/submit)", async () => {
    const events = buildPortalToErpRowEvents(3, { omitSaveSubmit: true });
    const report = await buildReport("sess_v2_portal_erp", events, {
      pipeline: "v2",
      llm: false,
    });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].stats.repetitions).toBe(3);

    const { steps } = eventsToSteps(events);
    const candidates = detectRepeatedCandidates(steps);
    const primary = pickPrimaryCandidate(candidates);
    expect(primary).toBeDefined();
    expect(primary?.count).toBe(3);
    expect(primary?.actions.length).toBe(28);

    // A genuine single 4-step task repeated 6 times still reports 6 (not grouped as 3x8)
    const sixTries = buildFourStepEvents(6);
    const sixReport = await buildReport("sess_v2_4step", sixTries, {
      pipeline: "v2",
      llm: false,
    });
    expect(sixReport.findings).toHaveLength(1);
    expect(sixReport.findings[0].stats.repetitions).toBe(6);
  });

  it("returns findings: [] for 1 row of the 4-field portal-to-ERP flow", async () => {
    const events = buildPortalToErpRowEvents(1);
    const report = await buildReport("sess_v2_portal_erp", events, {
      pipeline: "v2",
      llm: false,
    });

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

    const report = await buildReport("sess_v2_nav_only", navOnlyEvents, {
      pipeline: "v2",
      llm: false,
    });
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

    const crossReport = await buildReport("sess_v2_4step", crossSiteEvents, {
      pipeline: "v2",
      llm: false,
    });
    expect(crossReport.findings).toEqual([]);

    const prevRepeatEnv = process.env.REPEAT_COUNT;
    try {
      process.env.REPEAT_COUNT = "4";
      const threeRows = buildPortalToErpRowEvents(3);
      const reportAt4 = await buildReport("sess_v2_portal_erp", threeRows, {
        pipeline: "v2",
        llm: false,
      });
      expect(reportAt4.findings).toEqual([]);

      process.env.REPEAT_COUNT = "2";
      const twoRows = buildPortalToErpRowEvents(2);
      const reportAt2 = await buildReport("sess_v2_portal_erp", twoRows, {
        pipeline: "v2",
        llm: false,
      });
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
