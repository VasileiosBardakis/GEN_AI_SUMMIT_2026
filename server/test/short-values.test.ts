import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event, Step } from "@gen/shared";
import { EventSchema, FindingSchema, ReportSchema } from "@gen/shared/schema.ts";
import { detectShortValues } from "../src/detect/short-values.ts";
import { buildCombinedReport, buildReport } from "../src/report.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

describe("detectShortValues", () => {
  it("emits 1 rung1 finding when the same phone-like value is entered 4 times into one field without exposing the value", () => {
    const secretPhone = "+49-30-901820";
    const fieldTarget = [
      { kind: "aria" as const, value: "Contact Phone" },
      { kind: "css" as const, value: "input[name='phone']" },
    ];
    const steps: Step[] = [
      { action: "fill", target: fieldTarget, value: secretPhone },
      { action: "fill", target: fieldTarget, value: `  ${secretPhone}  ` },
      { action: "paste", target: fieldTarget, value: secretPhone },
      { action: "fill", target: fieldTarget, value: secretPhone },
    ];

    const findings = detectShortValues(steps);
    expect(findings).toHaveLength(1);

    const [finding] = findings;
    expect(FindingSchema.parse(finding)).toEqual(finding);
    expect(finding.id).toMatch(/^short_[0-9a-f]{8}$/);
    expect(finding.verdict).toBe("rung1");
    expect(finding.title).toBe("Short value typed 4 times in Contact Phone");
    expect(finding.why).toBe(
      "You entered the same 13-character value 4 times into Contact Phone in this session.",
    );
    expect(finding.whyNotNext).toBe(
      "A saved autofill entry or text snippet fills this field without exposing private text or building a UI script.",
    );
    expect(finding.stats).toEqual({
      repetitions: 4,
      minutesPerWeek: 0.26,
      stability: 1,
    });
    expect(finding.artifact).toBeUndefined();
    expect("artifact" in finding).toBe(false);
    expect(JSON.stringify(finding)).not.toContain(secretPhone);
    expect(JSON.stringify(finding)).not.toContain("901820");
  });

  it("accepts masked <email>, <phone>, and [REDACTED:IBAN#...] tokens repeated 4 times in one field without leaking the token", () => {
    const tokens = [
      { label: "Billing Email", value: "<email>" },
      { label: "Support Phone", value: "<phone>" },
      { label: "Vendor IBAN", value: "[REDACTED:IBAN#h_9f8e7d6c]" },
    ];

    for (const { label, value } of tokens) {
      const steps: Step[] = Array.from({ length: 4 }, () => ({
        action: "fill",
        target: [{ kind: "testid", value: label }],
        value,
      }));

      const findings = detectShortValues(steps);
      expect(findings).toHaveLength(1);

      const [finding] = findings;
      expect(FindingSchema.parse(finding)).toEqual(finding);
      expect(finding.verdict).toBe("rung1");
      expect(finding.title).toBe(`Short value typed 4 times in ${label}`);
      expect(finding.artifact).toBeUndefined();
      expect(JSON.stringify(finding)).not.toContain(value);
      expect(JSON.stringify(finding)).not.toContain(value.toLowerCase());
    }
  });

  it("returns [] for 3 repetitions in one field, 4 different short values in one field, and 4 equal values split across fields (2 + 2)", () => {
    const targetA = [{ kind: "testid" as const, value: "field-a" }];
    const targetB = [{ kind: "testid" as const, value: "field-b" }];

    // 3 repetitions in one field
    const threeReps: Step[] = [
      { action: "fill", target: targetA, value: "ACC-99102" },
      { action: "fill", target: targetA, value: "ACC-99102" },
      { action: "fill", target: targetA, value: "ACC-99102" },
    ];
    expect(detectShortValues(threeReps)).toEqual([]);

    // 4 different short values in one field
    const fourDifferent: Step[] = [
      { action: "fill", target: targetA, value: "ACC-99101" },
      { action: "fill", target: targetA, value: "ACC-99102" },
      { action: "fill", target: targetA, value: "ACC-99103" },
      { action: "fill", target: targetA, value: "ACC-99104" },
    ];
    expect(detectShortValues(fourDifferent)).toEqual([]);

    // 4 equal values split across different fields (2 + 2)
    const splitAcrossFields: Step[] = [
      { action: "fill", target: targetA, value: "ACC-99102" },
      { action: "fill", target: targetA, value: "ACC-99102" },
      { action: "fill", target: targetB, value: "ACC-99102" },
      { action: "fill", target: targetB, value: "ACC-99102" },
    ];
    expect(detectShortValues(splitAcrossFields)).toEqual([]);
  });

  it("ignores non-IBAN redacted tokens, out-of-range lengths, missing targets, and non-fill/paste actions", () => {
    const target = [{ kind: "testid" as const, value: "secret-input" }];
    const steps: Step[] = [
      // Non-IBAN redacted token repeated 4 times
      { action: "fill", target, value: "[REDACTED:PASSWORD#h_12345678]" },
      { action: "fill", target, value: "[REDACTED:PASSWORD#h_12345678]" },
      { action: "fill", target, value: "[REDACTED:PASSWORD#h_12345678]" },
      { action: "fill", target, value: "[REDACTED:PASSWORD#h_12345678]" },
      // Too short (< 5 chars)
      { action: "fill", target, value: "abcd" },
      { action: "fill", target, value: "abcd" },
      { action: "fill", target, value: "abcd" },
      { action: "fill", target, value: "abcd" },
      // Too long (> 19 chars)
      { action: "fill", target, value: "12345678901234567890" },
      { action: "fill", target, value: "12345678901234567890" },
      { action: "fill", target, value: "12345678901234567890" },
      { action: "fill", target, value: "12345678901234567890" },
      // Missing target
      { action: "fill", value: "valid-short" },
      { action: "fill", value: "valid-short" },
      { action: "fill", value: "valid-short" },
      { action: "fill", value: "valid-short" },
      // Non-fill/paste action (copy)
      { action: "copy", target, value: "copied-short" },
      { action: "copy", target, value: "copied-short" },
      { action: "copy", target, value: "copied-short" },
      { action: "copy", target, value: "copied-short" },
    ];

    expect(detectShortValues(steps)).toEqual([]);
  });
});

describe("buildReport & buildCombinedReport short-values integration", () => {
  it("produces 1 rung1 short-value finding from raw events without writing snippet files or leaking private text", async () => {
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "gen-short-values-report-"),
    );

    try {
      const rawPhone = "+1 (415) 555-0199";
      const events: Event[] = [1, 2, 3, 4].flatMap((idx) => [
        {
          v: 1 as const,
          id: `00000000-0000-4000-8000-00000000001${idx}`,
          ts: 1740000000000 + idx * 2000,
          session: "sess_phone_x4",
          source: "browser" as const,
          app: "127.0.0.1",
          url: "http://127.0.0.1:3000/crm",
          type: "input" as const,
          target: {
            tag: "input",
            role: "textbox",
            label: "Customer Phone",
            locators: [{ kind: "testid" as const, value: "customer-phone" }],
          },
          value: rawPhone,
        },
        {
          v: 1 as const,
          id: `00000000-0000-4000-8000-00000000002${idx}`,
          ts: 1740000001000 + idx * 2000,
          session: "sess_phone_x4",
          source: "browser" as const,
          app: "127.0.0.1",
          url: "http://127.0.0.1:3000/crm",
          type: "click" as const,
          target: {
            tag: "button",
            role: "button",
            label: "Next",
            locators: [{ kind: "testid" as const, value: "next-btn" }],
          },
        },
      ]);

      const report = buildReport("sess_phone_x4", events, { dataDir });
      expect(ReportSchema.parse(report)).toEqual(report);
      expect(report.findings).toHaveLength(1);

      const [finding] = report.findings;
      expect(FindingSchema.parse(finding)).toEqual(finding);
      expect(finding.verdict).toBe("rung1");
      expect(finding.title).toBe(
        "Short value typed 4 times in customer-phone",
      );
      expect(finding.artifact).toBeUndefined();
      expect(JSON.stringify(finding)).not.toContain(rawPhone);
      expect(JSON.stringify(finding)).not.toContain("<phone>");
      expect(JSON.stringify(report)).not.toContain(rawPhone);
      expect(JSON.stringify(report)).not.toContain("<phone>");
      expect(existsSync(path.join(dataDir, "snippets"))).toBe(false);

      const combined = buildCombinedReport([events, events], { dataDir });
      expect(ReportSchema.parse(combined)).toEqual(combined);
      expect(combined.findings).toHaveLength(1);
      expect(combined.findings[0]).toEqual(finding);
      expect(JSON.stringify(combined)).not.toContain(rawPhone);
      expect(JSON.stringify(combined)).not.toContain("<phone>");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("still produces 1 finding with repetitions === 3 on existing reply-x3.jsonl fixture", async () => {
    const replyX3Events = await loadFixtureEvents("reply-x3.jsonl");
    const report = buildReport("sess_reply_x3", replyX3Events);

    expect(ReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].stats.repetitions).toBe(3);
  });
});
