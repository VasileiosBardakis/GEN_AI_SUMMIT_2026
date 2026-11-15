import { describe, expect, it } from "vitest";
import {
  ActionScriptSchema,
  EventSchema,
  LibraryEntrySchema,
  ReportSchema,
  toLocatorList,
} from "../schema.ts";

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

  it("validates meta.pageSummary and catchall meta fields", () => {
    const withPageSummary = EventSchema.parse({
      ...validEvent,
      meta: {
        subType: "commit",
        pageSummary: {
          title: "Order Queue",
          items: [{ id: "row-1", status: "open" }],
        },
      },
    });
    expect(withPageSummary.meta?.pageSummary).toEqual({
      title: "Order Queue",
      items: [{ id: "row-1", status: "open" }],
    });

    expect(
      EventSchema.safeParse({
        ...validEvent,
        meta: { pageSummary: 123 },
      }).success,
    ).toBe(false);
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

  it("accepts readText -> switchTab -> fill and rejects switchTab without host", () => {
    const parsed = ActionScriptSchema.safeParse({
      steps: [
        { action: "readText", target: { kind: "css", value: ".order-id" }, bind: "orderId" },
        { action: "switchTab", host: "erp.local" },
        { action: "fill", target: { kind: "css", value: 'input[name="id"]' }, value: "{{orderId}}" },
      ],
    });
    expect(parsed.success).toBe(true);

    const withPort = ActionScriptSchema.safeParse({
      steps: [{ action: "switchTab", host: "127.0.0.1:5173" }],
    });
    expect(withPort.success).toBe(true);

    expect(ActionScriptSchema.safeParse({ steps: [{ action: "switchTab" }] }).success).toBe(false);
    expect(
      ActionScriptSchema.safeParse({ steps: [{ action: "switchTab", host: "   " }] }).success,
    ).toBe(false);
  });

  it("accepts single Locator and Locator[] targets, within, switchTab.url, pressKey, pauseBeforeSubmit, runMode, and forEach over pageSummary items", () => {
    const script = ActionScriptSchema.parse({
      name: "Batch order entry",
      pauseBeforeSubmit: true,
      runMode: "run_remaining",
      steps: [
        {
          action: "switchTab",
          host: "erp.local",
          url: "https://erp.local/orders/new",
        },
        {
          action: "forEach",
          items: [
            { orderId: "ORD-101", amount: 420 },
            { orderId: "ORD-102", amount: 850 },
          ],
          steps: [
            {
              action: "fill",
              target: [
                { kind: "testid", value: "order-id-input" },
                { kind: "css", value: 'input[name="orderId"]' },
              ],
              within: { kind: "css", value: "#order-form" },
              value: "{{orderId}}",
            },
            {
              action: "pressKey",
              key: "Enter",
              target: { kind: "css", value: 'input[name="orderId"]' },
              within: [{ kind: "testid", value: "order-panel" }, { kind: "css", value: "#order-form" }],
            },
          ],
        },
        {
          action: "click",
          target: { kind: "aria", value: "Submit all" },
        },
      ],
    });

    expect(script.pauseBeforeSubmit).toBe(true);
    expect(script.runMode).toBe("run_remaining");
    expect(script.steps[0]).toEqual({
      action: "switchTab",
      host: "erp.local",
      url: "https://erp.local/orders/new",
    });
    expect(script.steps[1]).toEqual({
      action: "forEach",
      items: [
        { orderId: "ORD-101", amount: "420" },
        { orderId: "ORD-102", amount: "850" },
      ],
      steps: [
        {
          action: "fill",
          target: [
            { kind: "testid", value: "order-id-input" },
            { kind: "css", value: 'input[name="orderId"]' },
          ],
          within: { kind: "css", value: "#order-form" },
          value: "{{orderId}}",
        },
        {
          action: "pressKey",
          key: "Enter",
          target: { kind: "css", value: 'input[name="orderId"]' },
          within: [{ kind: "testid", value: "order-panel" }, { kind: "css", value: "#order-form" }],
        },
      ],
    });

    const saveOnly = ActionScriptSchema.parse({
      runMode: "save_only",
      steps: [{ action: "pressKey", key: "Tab" }],
    });
    expect(saveOnly.runMode).toBe("save_only");

    expect(toLocatorList(undefined)).toEqual([]);
    expect(toLocatorList({ kind: "css", value: "#a" })).toEqual([{ kind: "css", value: "#a" }]);
    expect(
      toLocatorList([
        { kind: "testid", value: "a" },
        { kind: "css", value: "#a" },
      ]),
    ).toEqual([
      { kind: "testid", value: "a" },
      { kind: "css", value: "#a" },
    ]);

    expect(
      ActionScriptSchema.safeParse({
        steps: [{ action: "click", target: [] }],
      }).success,
    ).toBe(false);
  });

  it("rejects braces in bind names", () => {
    expect(
      ActionScriptSchema.safeParse({
        steps: [{ action: "readText", target: { kind: "css", value: ".id" }, bind: "{{orderId}}" }],
      }).success,
    ).toBe(false);
    expect(
      ActionScriptSchema.safeParse({
        steps: [{ action: "readValue", target: { kind: "css", value: ".id" }, bind: "{orderId}" }],
      }).success,
    ).toBe(false);
    expect(
      ActionScriptSchema.safeParse({
        steps: [{ action: "extractList", target: { kind: "css", value: "tr" }, bind: "{}" }],
      }).success,
    ).toBe(false);
  });
});

describe("LibraryEntrySchema", () => {
  it("validates a compiled library entry with Eyes detection metadata, stats, and startSignature", () => {
    const parsed = LibraryEntrySchema.parse({
      id: "lib_12345abc",
      name: "Shipping reply",
      description: "Insert shipping update into customer reply box.",
      kind: "snippet",
      status: "suggested",
      solution: "Insert 'Thanks, your order ships Friday.' into the reply box.",
      script: {
        name: "Shipping reply",
        pauseBeforeSubmit: false,
        runMode: "save_only",
        steps: [{ action: "insertText", value: "Thanks, your order ships Friday." }],
      },
      eyes: {
        intent: "shipping_reply",
        scope: {
          apps: ["mail.example.com"],
          urlPatterns: ["/tickets/*"],
          pageHints: ["order", "ticket"],
        },
        targetHints: {
          roles: ["textbox"],
          labelContains: ["reply", "customer"],
          locators: [],
        },
        textHints: {
          prefixHints: ["thanks, your order"],
          minCharsBeforeMatch: 6,
        },
        guards: {
          fieldEmptyOnly: true,
          requireClipboard: false,
          cooldownMs: 60000,
          minSignals: 2,
        },
      },
      stats: {
        repetitions: 3,
        stepCount: 4,
        manualSeconds: 18,
        replaySeconds: 2,
        timeSavedSeconds: 16,
      },
      startSignature: "mail.example.com|/tickets/*|focus:textbox:customer_reply",
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      runCount: 0,
    });
    expect(parsed.stats).toEqual({
      repetitions: 3,
      stepCount: 4,
      manualSeconds: 18,
      replaySeconds: 2,
      timeSavedSeconds: 16,
    });
    expect(parsed.startSignature).toBe(
      "mail.example.com|/tickets/*|focus:textbox:customer_reply",
    );

    expect(
      LibraryEntrySchema.safeParse({
        ...parsed,
        startSignature: "",
      }).success,
    ).toBe(false);
  });
});
