import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, Finding, Report, Step } from "@gen/shared";
import { EventSchema, FindingSchema, ReportSchema } from "@gen/shared/schema.ts";
import { createServer } from "../src/app.ts";
import {
  isValidArtifactId,
  readSnippetArtifact,
  writeSnippetArtifact,
  type SnippetArtifact,
} from "../src/artifacts.ts";
import {
  detectSnippets,
  detectSnippetsWithText,
} from "../src/detect/snippet.ts";
import { buildReport } from "../src/report.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

function rawGet(
  port: number,
  requestPath: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: requestPath,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("detectSnippetsWithText & pickClusterText", () => {
  it("picks the most frequent raw text in a cluster and breaks ties by first seen", () => {
    const replyFriday =
      "Hi, thanks for your order. It ships Friday and tracking will follow shortly.";
    const replyMonday =
      "Hi, thanks for your order. It ships Monday and tracking will follow shortly.";

    // Monday appears twice, Friday once -> picks Monday
    const stepsMostFrequent: Step[] = [
      { action: "fill", value: replyFriday },
      { action: "fill", value: replyMonday },
      { action: "fill", value: replyMonday },
    ];
    const res1 = detectSnippetsWithText(stepsMostFrequent);
    expect(res1).toHaveLength(1);
    expect(res1[0].text).toBe(replyMonday);
    expect(res1[0].finding.artifact?.verified).toBe(false);

    // Tie (1 each of 3 variants) -> picks first seen (replyFriday)
    const replyFridayBang =
      "Hi, thanks for your order! It ships Friday and tracking will follow shortly.";
    const stepsTie: Step[] = [
      { action: "fill", value: replyFriday },
      { action: "fill", value: replyMonday },
      { action: "fill", value: replyFridayBang },
    ];
    const res2 = detectSnippetsWithText(stepsTie);
    expect(res2).toHaveLength(1);
    expect(res2[0].text).toBe(replyFriday);

    // detectSnippets returns only Finding[] with no extra properties
    const findings = detectSnippets(stepsTie);
    expect(findings).toHaveLength(1);
    expect(FindingSchema.parse(findings[0])).toEqual(findings[0]);
    expect("text" in findings[0]).toBe(false);
  });
});

describe("artifacts helpers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "gen-artifacts-unit-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("validates artifact IDs with isValidArtifactId", () => {
    expect(isValidArtifactId("snip_deadbeef")).toBe(true);
    expect(isValidArtifactId("snip-123_ABC")).toBe(true);
    expect(isValidArtifactId("")).toBe(false);
    expect(isValidArtifactId("..")).toBe(false);
    expect(isValidArtifactId("a..b")).toBe(false);
    expect(isValidArtifactId("foo/bar")).toBe(false);
    expect(isValidArtifactId("../secret")).toBe(false);
  });

  it("writes and reads a valid snippet artifact", async () => {
    const baseFinding: Finding = {
      id: "snip_12345678",
      verdict: "rung1",
      title: 'Save a snippet for: "Hi, thanks for your order. It ships Frid..."',
      why: "You typed this 76-character text 3 times in this session.",
      whyNotNext: "Text varies slightly between replies.",
      stats: { repetitions: 3, minutesPerWeek: 1.14, stability: 0.88 },
      artifact: {
        kind: "snippet",
        path: "snippets/snip_12345678.txt",
        verified: false,
      },
    };
    const fullText =
      "Hi, thanks for your order. It ships Friday and tracking will follow shortly.";

    const updated = writeSnippetArtifact(tempDir, baseFinding, fullText);
    expect(updated.artifact).toEqual({
      kind: "snippet",
      path: "snippets/snip_12345678.txt",
      verified: true,
    });

    const snippetPath = path.join(tempDir, "snippets", "snip_12345678.txt");
    expect(existsSync(snippetPath)).toBe(true);
    expect(await readFile(snippetPath, "utf8")).toBe(fullText);

    const readBack = await readSnippetArtifact(tempDir, "snip_12345678");
    expect(readBack).toEqual({
      id: "snip_12345678",
      kind: "snippet",
      text: fullText,
    });

    const missing = await readSnippetArtifact(tempDir, "snip_missing");
    expect(missing).toBeNull();
  });

  it("never writes snippet files when text contains [REDACTED: or id is invalid", async () => {
    const baseFinding: Finding = {
      id: "snip_redacted1",
      verdict: "rung1",
      title: 'Save a snippet for: "Redacted text..."',
      why: "Typed 3 times.",
      whyNotNext: "Snippet.",
      stats: { repetitions: 3, minutesPerWeek: 1, stability: 1 },
      artifact: {
        kind: "snippet",
        path: "snippets/snip_redacted1.txt",
        verified: false,
      },
    };

    const redactedResult = writeSnippetArtifact(
      tempDir,
      baseFinding,
      "Here is my token [REDACTED:SECRET_TOKEN#abc] in the reply.",
    );
    expect(redactedResult.artifact).toEqual({
      kind: "snippet",
      path: "snippets/snip_redacted1.txt",
      verified: false,
    });
    expect(
      existsSync(path.join(tempDir, "snippets", "snip_redacted1.txt")),
    ).toBe(false);
    expect(await readSnippetArtifact(tempDir, "snip_redacted1")).toBeNull();

    const badIdFinding: Finding = {
      ...baseFinding,
      id: "../escape",
    };
    const badIdResult = writeSnippetArtifact(
      tempDir,
      badIdFinding,
      "Safe text that should still be rejected due to invalid id.",
    );
    expect(badIdResult.artifact?.verified).toBe(false);
    expect(existsSync(path.join(tempDir, "escape.txt"))).toBe(false);
  });
});

describe("snippet persistence and GET /artifact/:id integration", () => {
  let rootDir: string;
  let tracesDir: string;
  let dataDir: string;
  let server: http.Server;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "gen-artifacts-http-"));
    tracesDir = path.join(rootDir, "traces");
    dataDir = path.join(rootDir, "data");
    server = createServer({ tracesDir, dataDir });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(rootDir, { recursive: true, force: true });
  });

  it("persists full snippet via buildReport on reply-x3.jsonl and serves it via GET /artifact/:id", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
    const report = buildReport("sess_reply_x3", replyX3Events, { dataDir });

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding.artifact).toEqual({
      kind: "snippet",
      path: `snippets/${finding.id}.txt`,
      verified: true,
    });

    const artifactRes = await fetch(`${baseUrl}/artifact/${finding.id}`);
    expect(artifactRes.status).toBe(200);
    const artifact = (await artifactRes.json()) as SnippetArtifact;
    expect(artifact.id).toBe(finding.id);
    expect(artifact.kind).toBe("snippet");
    expect(artifact.text.length).toBeGreaterThan(40);
    expect(artifact.text).toBe(
      "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
    );
  });

  it("persists full snippet via POST /events + GET /report?session=sess_reply_x3 and serves it via GET /artifact/:id", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");

    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replyX3Events),
    });
    expect(postRes.status).toBe(200);

    const reportRes = await fetch(`${baseUrl}/report?session=sess_reply_x3`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;
    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);

    const [finding] = report.findings;
    expect(finding.artifact).toEqual({
      kind: "snippet",
      path: `snippets/${finding.id}.txt`,
      verified: true,
    });

    const artifactRes = await fetch(`${baseUrl}/artifact/${finding.id}`);
    expect(artifactRes.status).toBe(200);
    const artifact = (await artifactRes.json()) as SnippetArtifact;
    expect(artifact).toEqual({
      id: finding.id,
      kind: "snippet",
      text: "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
    });
    expect(artifact.text.length).toBeGreaterThan(40);
  });

  it("returns 404 for unknown artifact IDs", async () => {
    const res = await fetch(`${baseUrl}/artifact/snip_unknown`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      error: "Artifact not found",
    });
  });

  it("returns 400 for artifact IDs containing / or .. or invalid characters", async () => {
    const rawPaths = [
      "/artifact/foo/bar",
      "/artifact/foo%2Fbar",
      "/artifact/..",
      "/artifact/a..b",
      "/artifact/..%2Fsecret",
      "/artifact/%2e%2e",
      "/artifact/",
      "/artifact/%E0%A4%A",
    ];

    for (const rawPath of rawPaths) {
      const res = await rawGet(port, rawPath);
      expect(res.status, `expected 400 for ${rawPath}`).toBe(400);
      expect(res.body).toEqual({
        ok: false,
        error: "Invalid artifact id",
      });
    }
  });

  it("never writes [REDACTED: text to disk, keeps artifact.verified false, and returns 404 on GET /artifact/:id", async () => {
    const finding: Finding = {
      id: "snip_redact99",
      verdict: "rung1",
      title: 'Save a snippet for: "Account token..."',
      why: "Typed 3 times.",
      whyNotNext: "Snippet.",
      stats: { repetitions: 3, minutesPerWeek: 1, stability: 1 },
      artifact: {
        kind: "snippet",
        path: "snippets/snip_redact99.txt",
        verified: false,
      },
    };

    const result = writeSnippetArtifact(
      dataDir,
      finding,
      "Your secret is [REDACTED:SECRET_TOKEN#99] and should not be persisted.",
    );
    expect(result.artifact?.verified).toBe(false);
    expect(
      existsSync(path.join(dataDir, "snippets", "snip_redact99.txt")),
    ).toBe(false);

    const res = await fetch(`${baseUrl}/artifact/snip_redact99`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      error: "Artifact not found",
    });
  });

  it("defaults dataDir to path.resolve(tracesDir, '..', 'data') when createServer({ tracesDir }) is called without dataDir and supports combined GET /report", async () => {
    const defaultWorkspaceDir = path.join(rootDir, "default-workspace");
    const defaultTracesDir = path.join(defaultWorkspaceDir, "traces");
    const defaultServer = createServer({ tracesDir: defaultTracesDir });
    await new Promise<void>((resolve) => {
      defaultServer.listen(0, "127.0.0.1", () => resolve());
    });
    const defaultPort = (defaultServer.address() as AddressInfo).port;
    const defaultBaseUrl = `http://127.0.0.1:${defaultPort}`;

    try {
      const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
      const postRes = await fetch(`${defaultBaseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(replyX3Events),
      });
      expect(postRes.status).toBe(200);

      const reportRes = await fetch(`${defaultBaseUrl}/report`);
      expect(reportRes.status).toBe(200);
      const report = (await reportRes.json()) as Report;
      expect(report.session).toBe("all");
      expect(report.findings).toHaveLength(1);
      const [finding] = report.findings;
      expect(finding.artifact?.verified).toBe(true);

      expect(
        existsSync(
          path.join(defaultWorkspaceDir, "data", "snippets", `${finding.id}.txt`),
        ),
      ).toBe(true);

      const artifactRes = await fetch(
        `${defaultBaseUrl}/artifact/${finding.id}`,
      );
      expect(artifactRes.status).toBe(200);
      const artifact = (await artifactRes.json()) as SnippetArtifact;
      expect(artifact.id).toBe(finding.id);
      expect(artifact.text.length).toBeGreaterThan(40);
    } finally {
      await new Promise<void>((resolve, reject) => {
        defaultServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
