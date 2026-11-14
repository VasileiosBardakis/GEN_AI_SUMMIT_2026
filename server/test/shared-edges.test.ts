import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event, Step } from "@gen/shared";
import { EventSchema, FindingSchema, ReportSchema } from "@gen/shared/schema.ts";
import { readSnippetArtifact } from "../src/artifacts.ts";
import { normalize } from "../src/detect/normalize.ts";
import {
  detectSharedEdges,
  detectSharedEdgesWithText,
} from "../src/detect/shared-edges.ts";
import {
  detectSnippets,
  detectSnippetsWithText,
  trigramJaccard,
} from "../src/detect/snippet.ts";
import { buildCombinedReport, buildReport } from "../src/report.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXPECTED_SIGNOFF = "Best regards,\nAlex Rivera\nCustomer Support Team";

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

describe("signoff-x4.jsonl fixture & detectSharedEdges", () => {
  it("validates signoff-x4.jsonl against EventSchema and trace constraints", async () => {
    const events = await loadFixtureEvents("signoff-x4.jsonl");

    const sessions = new Set(events.map((e) => e.session));
    expect(sessions.size).toBe(1);
    expect(sessions.has("sess_signoff_x4")).toBe(true);

    for (let i = 1; i < events.length; i++) {
      expect(events[i].ts).toBeGreaterThan(events[i - 1].ts);
    }

    const blurCommits = events.filter(
      (e) => e.type === "input" && e.meta?.subType === "blur_commit",
    );
    expect(blurCommits).toHaveLength(4);

    const bodies = blurCommits.map((e) => {
      const val = e.value ?? "";
      expect(val.endsWith(`\n\n${EXPECTED_SIGNOFF}`)).toBe(true);
      return val.slice(0, val.length - `\n\n${EXPECTED_SIGNOFF}`.length);
    });

    expect(new Set(bodies).size).toBe(4);
    expect(new Set(bodies.map((b) => b[0])).size).toBe(4);
    expect(new Set(bodies.map((b) => b[b.length - 1])).size).toBe(4);

    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        expect(trigramJaccard(bodies[i], bodies[j])).toBeLessThan(0.3);
      }
    }
  });

  it("detects 1 rung1 sign-off snippet finding with repetitions === 4 on signoff-x4.jsonl", async () => {
    const events = await loadFixtureEvents("signoff-x4.jsonl");
    const steps = normalize(events);

    expect(detectSnippets(steps)).toEqual([]);

    const withText = detectSharedEdgesWithText(steps);
    expect(withText).toHaveLength(1);
    expect(withText[0].text).toBe(EXPECTED_SIGNOFF);

    const findings = detectSharedEdges(steps);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(FindingSchema.parse(finding)).toEqual(finding);
    expect(finding).toEqual(withText[0].finding);
    expect(finding.verdict).toBe("rung1");
    expect(finding.id).toMatch(/^snip_[0-9a-f]{8}$/);
    expect(finding.stats.repetitions).toBe(4);
    expect(finding.stats.stability).toBe(1);
    expect(finding.stats.minutesPerWeek).toBe(
      Number((4 * (EXPECTED_SIGNOFF.length / 200)).toFixed(2)),
    );
    expect(finding.title).toBe(
      'Save a snippet for: "Best regards, Alex Rivera Customer Suppo..."',
    );
    expect(finding.why).toBe(
      `You typed this ${EXPECTED_SIGNOFF.length}-character text 4 times in this session.`,
    );
    expect(finding.artifact).toEqual({
      kind: "snippet",
      path: `snippets/${finding.id}.txt`,
      verified: false,
    });
  });

  it("emits 1 rung1 finding in buildReport and persists artifact when dataDir is provided", async () => {
    const events = await loadFixtureEvents("signoff-x4.jsonl");
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "gen-shared-edges-report-"),
    );

    try {
      const report = await buildReport("sess_signoff_x4", events, {
        dataDir: tempDir,
      });
      expect(ReportSchema.parse(report)).toEqual(report);
      expect(report.session).toBe("sess_signoff_x4");
      const rung1Findings = report.findings.filter((f) => f.verdict === "rung1");
      expect(rung1Findings).toHaveLength(1);
      expect(
        report.findings.every(
          (f) => f.verdict === "rung1" || f.verdict === "do_not_automate",
        ),
      ).toBe(true);
      const [rung1] = rung1Findings;
      expect(rung1.stats.repetitions).toBe(4);
      expect(rung1.artifact?.verified).toBe(true);

      const artifact = await readSnippetArtifact(
        tempDir,
        rung1.id,
      );
      expect(artifact).toEqual({
        id: rung1.id,
        kind: "snippet",
        text: EXPECTED_SIGNOFF,
      });

      const combined = await buildCombinedReport([events], { dataDir: tempDir });
      expect(ReportSchema.parse(combined)).toEqual(combined);
      const combinedRung1 = combined.findings.filter((f) => f.verdict === "rung1");
      expect(combinedRung1).toHaveLength(1);
      expect(combinedRung1[0].id).toBe(rung1.id);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves reply-x3.jsonl (1 finding) and one-off.jsonl (0 findings) without duplicates", async () => {
    const replyEvents = await loadFixtureEvents("reply-x3.jsonl");
    const replySteps = normalize(replyEvents);

    expect(detectSharedEdges(replySteps)).toEqual([]);
    const combinedReplyFindings = [
      ...detectSnippets(replySteps),
      ...detectSharedEdges(replySteps),
    ];
    expect(combinedReplyFindings).toHaveLength(1);

    const replyReport = await buildReport("sess_reply_x3", replyEvents);
    expect(replyReport.findings).toHaveLength(1);
    expect(replyReport.findings[0].stats.repetitions).toBe(3);

    const oneOffEvents = await loadFixtureEvents("one-off.jsonl");
    const oneOffSteps = normalize(oneOffEvents);
    expect([
      ...detectSnippets(oneOffSteps),
      ...detectSharedEdges(oneOffSteps),
    ]).toEqual([]);
    expect((await buildReport("sess_one_off", oneOffEvents)).findings).toEqual([]);
  });

  it("detects shared prefix greetings (>= 20 chars across >= 3 fills on the same target locator)", () => {
    const greeting =
      "Hello valued customer, thank you for reaching out to Acme Support!";
    const target = [{ kind: "testid" as const, value: "reply-body" }];

    const steps: Step[] = [
      {
        action: "fill",
        target,
        value: `${greeting}\n\nYour package #8841 is out for delivery via courier today.`,
      },
      {
        action: "fill",
        target,
        value: `${greeting}\n\nBilling credit #902 has been applied to your statement.`,
      },
      {
        action: "fill",
        target,
        value: `${greeting}\n\nEngineering resolved the webhook latency incident in us-east.`,
      },
    ];

    expect(detectSnippetsWithText(steps)).toEqual([]);

    const detected = detectSharedEdgesWithText(steps);
    expect(detected).toHaveLength(1);
    expect(detected[0].text).toBe(greeting);
    expect(detected[0].finding.verdict).toBe("rung1");
    expect(detected[0].finding.stats.repetitions).toBe(3);
    expect(FindingSchema.parse(detected[0].finding)).toEqual(
      detected[0].finding,
    );
  });

  it("strips partial leading/trailing lines at the nearest newline when bodies share an initial word or trailing period", () => {
    const greeting = "Dear Customer,\nThank you for contacting support.";
    const signoff = "Warm regards,\nSupport Desk Team";
    const target = [{ kind: "testid" as const, value: "reply-body" }];

    const steps: Step[] = [
      {
        action: "fill",
        target,
        value: `${greeting}\n\nYour replacement shipment departed Memphis this morning.\n\n${signoff}`,
      },
      {
        action: "fill",
        target,
        value: `${greeting}\n\nYour quarterly invoice adjustment was approved by finance.\n\n${signoff}`,
      },
      {
        action: "fill",
        target,
        value: `${greeting}\n\nYour sandbox API credentials have been rotated by security.\n\n${signoff}`,
      },
    ];

    const detected = detectSharedEdgesWithText(steps);
    expect(detected).toHaveLength(2);
    expect(detected.map((d) => d.text)).toEqual([greeting, signoff]);
  });

  it("groups fills by primary target locator and does not mix different targets", () => {
    const greeting =
      "Hello valued customer, thank you for contacting Acme Support!";
    const replyTarget = [{ kind: "testid" as const, value: "reply-body" }];
    const notesTarget = [{ kind: "testid" as const, value: "internal-notes" }];

    // 2 fills on reply-body and 2 fills on internal-notes -> neither reaches minRepetitions=3
    const splitSteps: Step[] = [
      {
        action: "fill",
        target: replyTarget,
        value: `${greeting}\n\nPackage #101 shipped via FedEx Ground.`,
      },
      {
        action: "fill",
        target: replyTarget,
        value: `${greeting}\n\nRefund #202 was credited back to your card.`,
      },
      {
        action: "fill",
        target: notesTarget,
        value: `${greeting}\n\nEscalated database outage ticket to tier-3 on-call.`,
      },
      {
        action: "fill",
        target: notesTarget,
        value: `${greeting}\n\nUpdated enterprise SSO metadata certificate in portal.`,
      },
    ];

    expect(detectSharedEdges(splitSteps)).toEqual([]);

    // Adding a 3rd fill to reply-body triggers detection only for reply-body (repetitions: 3)
    const stepsWithThirdReply: Step[] = [
      ...splitSteps,
      {
        action: "fill",
        target: replyTarget,
        value: `${greeting}\n\nHardware token replacement was approved by security.`,
      },
    ];

    const findings = detectSharedEdges(stepsWithThirdReply);
    expect(findings).toHaveLength(1);
    expect(findings[0].stats.repetitions).toBe(3);
  });

  it("never emits duplicate findings when detectSnippets already detected the same text", () => {
    const targetA = [{ kind: "testid" as const, value: "quick-reply" }];
    const targetB = [{ kind: "testid" as const, value: "full-reply" }];

    // 3 standalone fills of the sign-off on targetA (caught by detectSnippets)
    // plus 3 long distinct replies ending with the exact same sign-off on targetB
    const steps: Step[] = [
      { action: "fill", target: targetA, value: EXPECTED_SIGNOFF },
      { action: "fill", target: targetA, value: EXPECTED_SIGNOFF },
      { action: "fill", target: targetA, value: EXPECTED_SIGNOFF },
      {
        action: "fill",
        target: targetB,
        value: `Your freight shipment cleared customs in Rotterdam this morning.\n\n${EXPECTED_SIGNOFF}`,
      },
      {
        action: "fill",
        target: targetB,
        value: `Billing credit for the overage charge has been posted to your ledger!\n\n${EXPECTED_SIGNOFF}`,
      },
      {
        action: "fill",
        target: targetB,
        value: `Could your network administrator whitelist our new webhook IP range?\n\n${EXPECTED_SIGNOFF}`,
      },
    ];

    const fullFindings = detectSnippets(steps);
    expect(fullFindings).toHaveLength(1);

    const edgeFindings = detectSharedEdges(steps);
    expect(edgeFindings).toEqual([]);
  });
});
