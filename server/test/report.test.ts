import { mkdtemp, readFile, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, Report } from "@gen/shared";
import { EventSchema, ReportSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import { buildReport } from "../src/report.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

describe("buildReport", () => {
  it("returns findings: [] when called with no events", () => {
    const report = buildReport("sess_empty");
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("sess_empty");
    expect(report.findings).toEqual([]);
  });

  it("returns 1 rung1 finding with repetitions === 3 for reply-x3.jsonl events", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
    const report = buildReport("sess_reply_x3", replyX3Events);

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.session).toBe("sess_reply_x3");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].verdict).toBe("rung1");
    expect(report.findings[0].stats.repetitions).toBe(3);
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

  it("returns 1 rung1 finding for GET /report?session=sess_reply_x3 and GET /report (latestSession fallback)", async () => {
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

    const latestRes = await fetch(`${baseUrl}/report`);
    expect(latestRes.status).toBe(200);
    const latestReport = (await latestRes.json()) as Report;
    expect(ReportSchema.parse(latestReport)).toEqual(latestReport);
    expect(latestReport.session).toBe("sess_reply_x3");
    expect(latestReport.findings).toEqual(bySessionReport.findings);
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
});
