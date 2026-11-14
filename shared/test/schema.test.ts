import { describe, expect, it } from "vitest";
import { ActionScriptSchema, EventSchema, ReportSchema } from "../schema.ts";

describe("EventSchema", () => {
  const validEvent = {
    v: 1 as const,
    id: "00000000-0000-4000-8000-000000000001",
    ts: 1700000000000,
    session: "sess-1",
    source: "browser" as const,
    app: "localhost",
    type: "click" as const,
    target: {
      locators: [{ kind: "testid" as const, value: "submit-btn" }],
      tag: "button",
      label: "Submit",
    },
  };

  it("parses a valid event", () => {
    const parsed = EventSchema.safeParse(validEvent);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(validEvent);
    }
  });

  it("fails when v is 2", () => {
    const parsed = EventSchema.safeParse({ ...validEvent, v: 2 });
    expect(parsed.success).toBe(false);
  });

  it("fails when session is missing", () => {
    const withoutSession: Record<string, unknown> = { ...validEvent };
    delete withoutSession.session;
    const parsed = EventSchema.safeParse(withoutSession);
    expect(parsed.success).toBe(false);
  });
});

describe("ReportSchema", () => {
  const validFinding = {
    id: "finding-1",
    workflowId: "wf-1",
    verdict: "rung1" as const,
    title: "Automate repetitive reply",
    why: "Repeated across sessions.",
    whyNotNext: "Requires human check.",
    stats: {
      repetitions: 5,
      minutesPerWeek: 15,
      stability: 0.9,
    },
  };

  const validReport = {
    generatedAt: 1700000000000,
    session: "sess-1",
    findings: [validFinding],
  };

  it("parses a valid Report object with 1 finding", () => {
    const parsed = ReportSchema.safeParse(validReport);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(validReport);
    }
  });

  it("fails when finding verdict is rung9", () => {
    const parsed = ReportSchema.safeParse({
      ...validReport,
      findings: [{ ...validFinding, verdict: "rung9" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("fails when stats.stability is out of range (1.5 or -0.1)", () => {
    const tooHigh = ReportSchema.safeParse({
      ...validReport,
      findings: [
        {
          ...validFinding,
          stats: { ...validFinding.stats, stability: 1.5 },
        },
      ],
    });
    expect(tooHigh.success).toBe(false);

    const tooLow = ReportSchema.safeParse({
      ...validReport,
      findings: [
        {
          ...validFinding,
          stats: { ...validFinding.stats, stability: -0.1 },
        },
      ],
    });
    expect(tooLow.success).toBe(false);
  });
});

describe("ActionScriptSchema", () => {
  it("parses valid scripts and normalizes extractList fields array to record", () => {
    const parsed = ActionScriptSchema.safeParse({
      name: "Fill search",
      steps: [
        {
          action: "extractList",
          target: { kind: "css", value: "tr" },
          bind: "rows",
          fields: [{ name: "title", locator: { kind: "css", value: ".title" } }],
        },
        {
          action: "forEach",
          items: "rows",
          steps: [{ action: "fill", target: { kind: "css", value: "input" }, value: "{{title}}" }],
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.steps[0]).toEqual({
        action: "extractList",
        target: { kind: "css", value: "tr" },
        bind: "rows",
        fields: { title: { kind: "css", value: ".title" } },
      });
    }
  });

  it("rejects empty steps, unknown action, and relative navigate URL", () => {
    expect(ActionScriptSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(ActionScriptSchema.safeParse({ steps: [{ action: "bogus" }] }).success).toBe(false);
    expect(
      ActionScriptSchema.safeParse({ steps: [{ action: "navigate", url: "/local" }] }).success,
    ).toBe(false);
  });
});
