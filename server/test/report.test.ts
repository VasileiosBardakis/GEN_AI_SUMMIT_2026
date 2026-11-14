import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, Report } from "@gen/shared";
import { EventSchema, ReportSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import { buildCombinedReport, buildReport } from "../src/report.ts";

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
    expect(report.findings[0].title).toContain("portal.local -> erp.local");
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
      "portal.local -> erp.local",
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
        f.title.includes("portal.local -> erp.local"),
      ),
    ).toBe(false);
  });
});
