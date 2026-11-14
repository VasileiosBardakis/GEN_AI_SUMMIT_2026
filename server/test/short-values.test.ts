import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event, Step } from "@gen/shared";
import { EventSchema, FindingSchema, ReportSchema } from "@gen/shared/schema.ts";
import { normalize } from "../src/detect/normalize.ts";
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
  it("emits 1 rung1 finding with default minRepetitions=2 and minutesPerWeek=0 without exposing the value", () => {
    const secretPhone = "+49-30-901820";
    const fieldTarget = [
      { kind: "aria" as const, value: "Contact Phone" },
      { kind: "css" as const, value: "input[name='phone']" },
    ];
    const steps: Step[] = [
      { action: "fill", target: fieldTarget, value: secretPhone },
      { action: "paste", target: fieldTarget, value: `  ${secretPhone}  ` },
    ];

    const findings = detectShortValues(steps);
    expect(findings).toHaveLength(1);

    const [finding] = findings;
    expect(FindingSchema.parse(finding)).toEqual(finding);
    expect(finding.id).toMatch(/^short_[0-9a-f]{8}$/);
    expect(finding.verdict).toBe("rung1");
    expect(finding.title).toBe(
      "Same Contact Phone typed 2 times in Contact Phone fields",
    );
    expect(finding.why).toBe(
      "You entered the same 13-character value 2 times into Contact Phone fields in this session.",
    );
    expect(finding.whyNotNext).toBe(
      "A saved autofill entry or text snippet fills this field without exposing private text or building a UI script.",
    );
    expect(finding.stats).toEqual({
      repetitions: 2,
      minutesPerWeek: 0,
      stability: 1,
    });
    expect(finding.artifact).toBeUndefined();
    expect("artifact" in finding).toBe(false);
    expect(JSON.stringify(finding)).not.toContain(secretPhone);
    expect(JSON.stringify(finding)).not.toContain("901820");
  });

  it("groups repeats by field type across different locators using EventMeta (autocompleteAttr > inputTypeAttr > inputName > locator)", () => {
    const rawEmail = "founder@acme.io";
    const events: Event[] = [
      {
        v: 1,
        id: "00000000-0000-4000-8000-000000000101",
        ts: 1740000001000,
        session: "sess_email_x3",
        source: "browser",
        app: "crm.example.com",
        url: "https://crm.example.com/signup",
        type: "input",
        target: {
          tag: "input",
          locators: [{ kind: "testid", value: "crm-signup-email" }],
        },
        value: rawEmail,
        meta: {
          typing: {
            autocompleteAttr: "email",
            inputTypeAttr: "text",
            inputName: "crm_user_field",
          },
        },
      },
      {
        v: 1,
        id: "00000000-0000-4000-8000-000000000102",
        ts: 1740000002000,
        session: "sess_email_x3",
        source: "browser",
        app: "billing.example.org",
        url: "https://billing.example.org/checkout",
        type: "input",
        target: {
          tag: "input",
          locators: [{ kind: "css", value: "#billing-address-contact" }],
        },
        value: rawEmail,
        meta: {
          typing: {
            inputTypeAttr: "email",
            inputName: "billing_contact_input",
          },
        },
      },
      {
        v: 1,
        id: "00000000-0000-4000-8000-000000000103",
        ts: 1740000003000,
        session: "sess_email_x3",
        source: "browser",
        app: "portal.example.net",
        url: "https://portal.example.net/profile",
        type: "paste",
        target: {
          tag: "input",
          locators: [{ kind: "aria", value: "Primary contact" }],
        },
        value: rawEmail,
        meta: {
          typing: {
            inputName: "email",
          },
        },
      },
    ];

    const steps = normalize(events);
    const findings = detectShortValues(steps, events);
    expect(findings).toHaveLength(1);

    const [finding] = findings;
    expect(FindingSchema.parse(finding)).toEqual(finding);
    expect(finding.verdict).toBe("rung1");
    expect(finding.title).toBe("Same email typed 3 times in email fields");
    expect(finding.why).toBe(
      "You entered the same 7-character value 3 times into email fields in this session.",
    );
    expect(finding.stats).toEqual({
      repetitions: 3,
      minutesPerWeek: 0,
      stability: 1,
    });
    expect(JSON.stringify(finding)).not.toContain(rawEmail);
    expect(JSON.stringify(finding)).not.toContain("<email>");
  });

  it("resolves field type in strict priority order: autocompleteAttr, inputTypeAttr, inputName, then locator", () => {
    const val = "ACC-99102";

    const makePair = (
      typingMeta?: NonNullable<Event["meta"]>["typing"],
    ): { steps: Step[]; events: Event[] } => {
      const events: Event[] = [1, 2].flatMap((idx) => [
        {
          v: 1 as const,
          id: `00000000-0000-4000-8000-00000000020${idx}`,
          ts: 1740000000000 + idx * 2000,
          session: "sess_priority",
          source: "browser" as const,
          app: "app.local",
          type: "input" as const,
          target: {
            tag: "input",
            locators: [{ kind: "testid" as const, value: "locator-fallback" }],
          },
          value: val,
          ...(typingMeta ? { meta: { typing: typingMeta } } : {}),
        },
        {
          v: 1 as const,
          id: `00000000-0000-4000-8000-00000000021${idx}`,
          ts: 1740000001000 + idx * 2000,
          session: "sess_priority",
          source: "browser" as const,
          app: "app.local",
          type: "click" as const,
          target: {
            tag: "button",
            locators: [{ kind: "testid" as const, value: "next-btn" }],
          },
        },
      ]);
      return { steps: normalize(events), events };
    };

    // 1. autocompleteAttr wins over inputTypeAttr, inputName, and locator
    const case1 = makePair({
      autocompleteAttr: "organization",
      inputTypeAttr: "text",
      inputName: "company_name",
    });
    expect(detectShortValues(case1.steps, case1.events)[0].title).toBe(
      "Same organization typed 2 times in organization fields",
    );

    // 2. inputTypeAttr wins over inputName and locator when autocompleteAttr is absent
    const case2 = makePair({
      inputTypeAttr: "tel",
      inputName: "company_phone",
    });
    expect(detectShortValues(case2.steps, case2.events)[0].title).toBe(
      "Same tel typed 2 times in tel fields",
    );

    // 3. inputName wins over locator when autocompleteAttr and inputTypeAttr are absent
    const case3 = makePair({
      inputName: "company_code",
    });
    expect(detectShortValues(case3.steps, case3.events)[0].title).toBe(
      "Same company_code typed 2 times in company_code fields",
    );

    // 4. locator is used when EventMeta has none of the three
    const case4 = makePair();
    expect(detectShortValues(case4.steps, case4.events)[0].title).toBe(
      "Same locator-fallback typed 2 times in locator-fallback fields",
    );
  });

  it("accepts masked <email>, <phone>, and [REDACTED:IBAN#...] tokens repeated 2 times without leaking the token", () => {
    const tokens = [
      { label: "email", value: "<email>" },
      { label: "phone", value: "<phone>" },
      { label: "iban", value: "[REDACTED:IBAN#h_9f8e7d6c]" },
    ];

    for (const { label, value } of tokens) {
      const steps: Step[] = Array.from({ length: 2 }, () => ({
        action: "fill",
        target: [{ kind: "testid", value: label }],
        value,
      }));

      const findings = detectShortValues(steps);
      expect(findings).toHaveLength(1);

      const [finding] = findings;
      expect(FindingSchema.parse(finding)).toEqual(finding);
      expect(finding.verdict).toBe("rung1");
      expect(finding.title).toBe(`Same ${label} typed 2 times in ${label} fields`);
      expect(finding.stats.minutesPerWeek).toBe(0);
      expect(finding.artifact).toBeUndefined();
      expect(JSON.stringify(finding)).not.toContain(value);
      expect(JSON.stringify(finding)).not.toContain(value.toLowerCase());
    }
  });

  it("returns [] for 1 repetition, 2 different short values in one field type, and 2 equal values split across different field types (1 + 1)", () => {
    const targetA = [{ kind: "testid" as const, value: "field-a" }];
    const targetB = [{ kind: "testid" as const, value: "field-b" }];

    // 1 repetition in one field type
    const oneRep: Step[] = [
      { action: "fill", target: targetA, value: "ACC-99102" },
    ];
    expect(detectShortValues(oneRep)).toEqual([]);

    // 2 different short values in one field type
    const twoDifferent: Step[] = [
      { action: "fill", target: targetA, value: "ACC-99101" },
      { action: "fill", target: targetA, value: "ACC-99102" },
    ];
    expect(detectShortValues(twoDifferent)).toEqual([]);

    // 2 equal values split across different field types (1 + 1)
    const splitAcrossFieldTypes: Step[] = [
      { action: "fill", target: targetA, value: "ACC-99102" },
      { action: "fill", target: targetB, value: "ACC-99102" },
    ];
    expect(detectShortValues(splitAcrossFieldTypes)).toEqual([]);
  });

  it("ignores non-IBAN redacted tokens, out-of-range lengths, missing targets, and non-fill/paste actions", () => {
    const target = [{ kind: "testid" as const, value: "secret-input" }];
    const steps: Step[] = [
      // Non-IBAN redacted token repeated 2 times
      { action: "fill", target, value: "[REDACTED:PASSWORD#h_12345678]" },
      { action: "fill", target, value: "[REDACTED:PASSWORD#h_12345678]" },
      // Too short (< 5 chars)
      { action: "fill", target, value: "abcd" },
      { action: "fill", target, value: "abcd" },
      // Too long (> 19 chars)
      { action: "fill", target, value: "12345678901234567890" },
      { action: "fill", target, value: "12345678901234567890" },
      // Missing target
      { action: "fill", value: "valid-short" },
      { action: "fill", value: "valid-short" },
      // Non-fill/paste action (copy)
      { action: "copy", target, value: "copied-short" },
      { action: "copy", target, value: "copied-short" },
    ];

    expect(detectShortValues(steps)).toEqual([]);
  });
});

describe("buildReport & buildCombinedReport short-values integration", () => {
  it("produces 1 rung1 short-value finding across different email fields on two sites without writing snippet files or leaking private text", async () => {
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "gen-short-values-report-"),
    );

    try {
      const rawEmail = "ops@company.example.com";
      const sites = [
        {
          app: "vendor-a.local",
          url: "http://vendor-a.local/login",
          locator: { kind: "testid" as const, value: "vendor-a-email" },
          typing: { autocompleteAttr: "email", inputTypeAttr: "email" },
        },
        {
          app: "vendor-b.local",
          url: "http://vendor-b.local/account",
          locator: { kind: "css" as const, value: "input#contact-email" },
          typing: { inputTypeAttr: "email", inputName: "contact_email" },
        },
        {
          app: "vendor-c.local",
          url: "http://vendor-c.local/checkout",
          locator: { kind: "aria" as const, value: "Work Email" },
          typing: { autocompleteAttr: "email" },
        },
      ];

      const events: Event[] = sites.flatMap((site, idx) => [
        {
          v: 1 as const,
          id: `00000000-0000-4000-8000-00000000001${idx + 1}`,
          ts: 1740000000000 + (idx + 1) * 2000,
          session: "sess_email_sites",
          source: "browser" as const,
          app: site.app,
          url: site.url,
          type: "input" as const,
          target: {
            tag: "input",
            role: "textbox",
            label: "Email",
            locators: [site.locator],
          },
          value: rawEmail,
          meta: {
            typing: site.typing,
          },
        },
        {
          v: 1 as const,
          id: `00000000-0000-4000-8000-00000000002${idx + 1}`,
          ts: 1740000001000 + (idx + 1) * 2000,
          session: "sess_email_sites",
          source: "browser" as const,
          app: site.app,
          url: site.url,
          type: "click" as const,
          target: {
            tag: "button",
            role: "button",
            label: "Next",
            locators: [{ kind: "testid" as const, value: "next-btn" }],
          },
        },
      ]);

      const report = buildReport("sess_email_sites", events, { dataDir });
      expect(ReportSchema.parse(report)).toEqual(report);
      expect(report.findings).toHaveLength(1);

      const [finding] = report.findings;
      expect(FindingSchema.parse(finding)).toEqual(finding);
      expect(finding.verdict).toBe("rung1");
      expect(finding.title).toBe("Same email typed 3 times in email fields");
      expect(finding.stats).toEqual({
        repetitions: 3,
        minutesPerWeek: 0,
        stability: 1,
      });
      expect(finding.artifact).toBeUndefined();
      expect(JSON.stringify(finding)).not.toContain(rawEmail);
      expect(JSON.stringify(finding)).not.toContain("<email>");
      expect(JSON.stringify(report)).not.toContain(rawEmail);
      expect(JSON.stringify(report)).not.toContain("<email>");
      expect(existsSync(path.join(dataDir, "snippets"))).toBe(false);

      const combined = buildCombinedReport([events, events], { dataDir });
      expect(ReportSchema.parse(combined)).toEqual(combined);
      expect(combined.findings).toHaveLength(1);
      expect(combined.findings[0]).toEqual(finding);
      expect(JSON.stringify(combined)).not.toContain(rawEmail);
      expect(JSON.stringify(combined)).not.toContain("<email>");
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
