import { describe, expect, it } from "vitest";
import type { Event, Report } from "../contract.ts";

describe("shared contract", () => {
  it("validates Event and Report types", () => {
    const event: Event = {
      v: 1,
      id: "00000000-0000-4000-8000-000000000001",
      ts: 1700000000000,
      session: "sess-1",
      source: "browser",
      app: "localhost",
      type: "click",
      target: {
        locators: [{ kind: "testid", value: "submit-btn" }],
        tag: "button",
        label: "Submit",
      },
    };

    const report: Report = {
      generatedAt: 1700000001000,
      session: "sess-1",
      findings: [
        {
          id: "finding-1",
          workflowId: "wf-1",
          verdict: "rung1",
          title: "Automate form copy",
          why: "High repetition and deterministic locators",
          whyNotNext: "Cross-app clipboard not needed for rung2",
          stats: {
            repetitions: 12,
            minutesPerWeek: 30,
            stability: 0.95,
          },
        },
      ],
    };

    expect(event.v).toBe(1);
    expect(report.findings.length).toBe(1);
  });
});
