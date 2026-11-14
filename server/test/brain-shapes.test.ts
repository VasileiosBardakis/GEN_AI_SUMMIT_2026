import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_EVENT_TYPES,
  type Event,
  type Finding,
  type Locator,
  type Report,
  type Step,
  type Verdict,
} from "@gen/shared";
import {
  EventSchema,
  FindingSchema,
  LocatorSchema,
  ReportSchema,
  VerdictSchema,
} from "@gen/shared/schema.ts";
import { normalize } from "../src/detect/normalize.ts";
import {
  detectSnippets,
  trigramJaccard,
  type SnippetOptions,
} from "../src/detect/snippet.ts";
import { buildReport } from "../src/report.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

let eventSeq = 0;

function makeEvent(
  type: Event["type"],
  overrides: Partial<Omit<Event, "type">> = {},
): Event {
  eventSeq += 1;
  const event: Event = {
    v: 1,
    id: `00000000-0000-4000-8000-${String(eventSeq).padStart(12, "0")}`,
    ts: 1740000000000 + eventSeq * 100,
    session: "sess_brain_shapes",
    source: "browser",
    app: "crm.local",
    type,
    ...overrides,
  };
  return EventSchema.parse(event);
}

const VALID_STEP_ACTIONS = new Set<Step["action"]>([
  "click",
  "fill",
  "nav",
  "paste",
  "copy",
  "submit",
]);

function assertValidStepShape(step: Step): void {
  expect(VALID_STEP_ACTIONS.has(step.action)).toBe(true);
  if (step.target !== undefined) {
    expect(Array.isArray(step.target)).toBe(true);
    for (const locator of step.target) {
      expect(LocatorSchema.parse(locator)).toEqual(locator);
    }
  }
  if (step.value !== undefined) {
    expect(
      typeof step.value === "string" ||
        (typeof step.value === "object" &&
          step.value !== null &&
          typeof step.value.param === "string"),
    ).toBe(true);
  }
}

function assertValidFindingShape(finding: Finding): void {
  const parsed: Finding = FindingSchema.parse(finding);
  expect(parsed).toEqual(finding);
  const verdict: Verdict = VerdictSchema.parse(finding.verdict);
  expect(verdict).toBe(finding.verdict);
}

function assertValidReportShape(report: Report): void {
  const parsed: Report = ReportSchema.parse(report);
  expect(parsed).toEqual(report);
  for (const finding of report.findings) {
    assertValidFindingShape(finding);
  }
}

describe("Brain shapes: normalize(events)", () => {
  it.each<{
    label: string;
    event: Event;
    expected: Step;
  }>([
    {
      label: "input -> fill",
      event: makeEvent("input", {
        target: {
          tag: "input",
          locators: [{ kind: "testid", value: "customer-name" }],
        },
        value: "Ada Lovelace",
      }),
      expected: {
        action: "fill",
        target: [{ kind: "testid", value: "customer-name" }],
        value: "Ada Lovelace",
      },
    },
    {
      label: "change -> fill",
      event: makeEvent("change", {
        target: {
          tag: "select",
          locators: [{ kind: "aria", value: "Priority" }],
        },
        value: "high",
      }),
      expected: {
        action: "fill",
        target: [{ kind: "aria", value: "Priority" }],
        value: "high",
      },
    },
    {
      label: "click -> click",
      event: makeEvent("click", {
        target: {
          tag: "button",
          locators: [{ kind: "testid", value: "reply-btn" }],
        },
      }),
      expected: {
        action: "click",
        target: [{ kind: "testid", value: "reply-btn" }],
      },
    },
    {
      label: "submit -> submit",
      event: makeEvent("submit", {
        target: {
          tag: "form",
          locators: [{ kind: "css", value: "form#reply" }],
        },
      }),
      expected: {
        action: "submit",
        target: [{ kind: "css", value: "form#reply" }],
      },
    },
    {
      label: "paste (with value) -> paste",
      event: makeEvent("paste", {
        target: {
          tag: "textarea",
          locators: [{ kind: "testid", value: "reply-box" }],
        },
        value: "Pasted body text",
      }),
      expected: {
        action: "paste",
        target: [{ kind: "testid", value: "reply-box" }],
        value: "Pasted body text",
      },
    },
    {
      label: "paste (with clipboard.text fallback) -> paste",
      event: makeEvent("paste", {
        target: {
          tag: "textarea",
          locators: [{ kind: "testid", value: "reply-box" }],
        },
        clipboard: { text: "Clipboard fallback text" },
      }),
      expected: {
        action: "paste",
        target: [{ kind: "testid", value: "reply-box" }],
        value: "Clipboard fallback text",
      },
    },
    {
      label: "copy (with clipboard.text) -> copy",
      event: makeEvent("copy", {
        target: {
          tag: "span",
          locators: [{ kind: "text", value: "Order #1024" }],
        },
        clipboard: { text: "Order #1024" },
      }),
      expected: {
        action: "copy",
        target: [{ kind: "text", value: "Order #1024" }],
        value: "Order #1024",
      },
    },
    {
      label: "nav -> nav",
      event: makeEvent("nav", {
        url: "https://crm.local/tickets/1024",
      }),
      expected: {
        action: "nav",
        value: "https://crm.local/tickets/1024",
      },
    },
  ])("maps action event ($label) to canonical Step", ({ event, expected }) => {
    const steps = normalize([event]);
    expect(steps).toHaveLength(1);
    assertValidStepShape(steps[0]);
    expect(steps[0]).toEqual(expected);
  });

  it.each<Event["type"]>([
    "scroll",
    "keydown",
    "keyup",
    "mousemove",
    "focus",
    "blur",
  ])("drops non-action event %s", (nonActionType) => {
    const steps = normalize([
      makeEvent(nonActionType, {
        target: {
          tag: "div",
          locators: [{ kind: "testid", value: "panel" }],
        },
        value: "ignored",
      }),
    ]);
    expect(steps).toEqual([]);
  });

  it("drops every non-action event type in ALL_EVENT_TYPES", () => {
    const actionTypes = new Set<Event["type"]>([
      "click",
      "input",
      "change",
      "paste",
      "copy",
      "nav",
      "submit",
    ]);
    const nonActionEvents = ALL_EVENT_TYPES.filter(
      (t) => !actionTypes.has(t),
    ).map((t) => makeEvent(t));

    expect(normalize(nonActionEvents)).toEqual([]);
  });

  it.each<{
    label: string;
    target: NonNullable<Event["target"]>;
    expectedOrder: Locator["kind"][];
  }>([
    {
      label: "standard element ranks testid > aria > text > css > uia",
      target: {
        tag: "button",
        role: "button",
        locators: [
          { kind: "uia", value: "UIA_Save" },
          { kind: "css", value: "button.save" },
          { kind: "text", value: "Save" },
          { kind: "aria", value: 'button[name="Save"]' },
          { kind: "testid", value: "save-btn" },
        ],
      },
      expectedOrder: ["testid", "aria", "text", "css", "uia"],
    },
    {
      label: "td tag ranks css > testid > aria > text > uia",
      target: {
        tag: "td",
        locators: [
          { kind: "uia", value: "UIA_Cell_B2" },
          { kind: "text", value: "B2" },
          { kind: "aria", value: "Cell B2" },
          { kind: "testid", value: "cell-b2" },
          { kind: "css", value: 'td[data-cell="B2"]' },
        ],
      },
      expectedOrder: ["css", "testid", "aria", "text", "uia"],
    },
    {
      label: "gridcell role ranks css > testid > aria > text > uia",
      target: {
        tag: "div",
        role: "gridcell",
        locators: [
          { kind: "text", value: "C4" },
          { kind: "uia", value: "UIA_Cell_C4" },
          { kind: "testid", value: "cell-c4" },
          { kind: "aria", value: "Gridcell C4" },
          { kind: "css", value: 'div[role="gridcell"][data-col="C"]' },
        ],
      },
      expectedOrder: ["css", "testid", "aria", "text", "uia"],
    },
  ])("ranks locators correctly: $label", ({ target, expectedOrder }) => {
    const steps = normalize([makeEvent("click", { target })]);
    expect(steps).toHaveLength(1);
    assertValidStepShape(steps[0]);
    expect(steps[0].target?.map((l) => l.kind)).toEqual(expectedOrder);
  });

  it.each<{
    rawText: string;
    rawAria: string;
    expectedText: string;
    expectedAria: string;
  }>([
    {
      rawText: "Rename F2",
      rawAria: "Rename cell F2",
      expectedText: "Rename",
      expectedAria: "Rename cell",
    },
    {
      rawText: "Copy Ctrl+C",
      rawAria: "Copy selection Ctrl+C",
      expectedText: "Copy",
      expectedAria: "Copy selection",
    },
    {
      rawText: "Paste Special Ctrl+Shift+V",
      rawAria: "Paste Special Alt+F12",
      expectedText: "Paste Special",
      expectedAria: "Paste Special",
    },
  ])(
    "strips trailing shortcut suffixes from text/aria locators ($rawText)",
    ({ rawText, rawAria, expectedText, expectedAria }) => {
      const steps = normalize([
        makeEvent("click", {
          target: {
            tag: "menuitem",
            locators: [
              { kind: "testid", value: "menu-item F2" },
              { kind: "aria", value: rawAria },
              { kind: "text", value: rawText },
              { kind: "css", value: ".item" },
            ],
          },
        }),
      ]);

      expect(steps).toHaveLength(1);
      assertValidStepShape(steps[0]);
      expect(steps[0].target).toEqual([
        { kind: "testid", value: "menu-item F2" },
        { kind: "aria", value: expectedAria },
        { kind: "text", value: expectedText },
        { kind: "css", value: ".item" },
      ]);
    },
  );

  it.each<{
    label: string;
    raw: string;
    expected: string;
  }>([
    {
      label: "masks email addresses",
      raw: "Send invoice to billing.team+eu@example.co.uk today",
      expected: "Send invoice to <email> today",
    },
    {
      label: "masks US and international phone numbers",
      raw: "Reach support at +1 (415) 555-0199 or 212-555-0144",
      expected: "Reach support at <phone> or <phone>",
    },
    {
      label: "preserves [REDACTED:...] tokens while masking surrounding PII",
      raw: "Token [REDACTED:email#a1] and [REDACTED:415-555-0199] but raw bob@acme.io and 415-555-0123",
      expected:
        "Token [REDACTED:email#a1] and [REDACTED:415-555-0199] but raw <email> and <phone>",
    },
  ])("masks PII in step values: $label", ({ raw, expected }) => {
    const steps = normalize([
      makeEvent("input", {
        target: {
          tag: "textarea",
          locators: [{ kind: "testid", value: "notes" }],
        },
        value: raw,
      }),
    ]);

    expect(steps).toHaveLength(1);
    assertValidStepShape(steps[0]);
    expect(steps[0].value).toBe(expected);
  });
});

describe("Brain shapes: trigramJaccard(a, b) and detectSnippets(steps, opts)", () => {
  it.each<{
    a: string;
    b: string;
    min: number;
    max: number;
  }>([
    { a: "Identical text", b: "  identical   TEXT ", min: 1, max: 1 },
    { a: "ab", b: "ab", min: 1, max: 1 },
    { a: "ab", b: "cd", min: 0, max: 0 },
    { a: "ab", b: "longer string", min: 0, max: 0 },
    { a: "", b: "non-empty", min: 0, max: 0 },
    {
      a: "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
      b: "Hi, thanks for your order. It ships Monday and tracking will follow shortly.",
      min: 0.8,
      max: 0.99,
    },
    {
      a: "Quarterly financial summary for Q1",
      b: "Database index migration rollback script",
      min: 0,
      max: 0.25,
    },
  ])(
    "trigramJaccard($a, $b) stays within [0, 1] and expected bounds [$min, $max]",
    ({ a, b, min, max }) => {
      const score = trigramJaccard(a, b);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(score).toBeGreaterThanOrEqual(min);
      expect(score).toBeLessThanOrEqual(max);
      expect(trigramJaccard(b, a)).toBeCloseTo(score, 10);
    },
  );

  it.each<{
    label: string;
    opts: SnippetOptions;
    expectedCount: number;
  }>([
    {
      label: "default options (minLength=20, threshold=0.8, minRepetitions=3)",
      opts: {},
      expectedCount: 1,
    },
    {
      label: "high minLength=60 filters out shorter candidates",
      opts: { minLength: 60 },
      expectedCount: 0,
    },
    {
      label: "lower minRepetitions=2 includes 2-member cluster",
      opts: { minRepetitions: 2 },
      expectedCount: 2,
    },
    {
      label: "higher minRepetitions=4 excludes 3-member cluster",
      opts: { minRepetitions: 4 },
      expectedCount: 0,
    },
    {
      label: "strict similarityThreshold=1.0 splits slightly varying replies",
      opts: { similarityThreshold: 1.0 },
      expectedCount: 0,
    },
  ])("detectSnippets honors SnippetOptions: $label", ({ opts, expectedCount }) => {
    const steps: Step[] = [
      { action: "fill", value: "Order #101 confirmed and queued for dispatch." },
      { action: "fill", value: "Order #102 confirmed and queued for dispatch." },
      { action: "fill", value: "Order #103 confirmed and queued for dispatch." },
      {
        action: "paste",
        value: "Refund #1 processed to your original payment method today.",
      },
      {
        action: "paste",
        value: "Refund #2 processed to your original payment method today.",
      },
    ];

    const findings = detectSnippets(steps, opts);
    expect(findings).toHaveLength(expectedCount);
    for (const finding of findings) {
      assertValidFindingShape(finding);
    }
  });

  it("ignores short, redacted, non-string, and non-fill/paste steps", () => {
    const validText =
      "Your subscription renewal has been processed and receipt sent.";
    const steps: Step[] = [
      { action: "fill", value: "too short" },
      { action: "paste", value: "   also short   " },
      {
        action: "fill",
        value: "Contains [REDACTED:SECRET_TOKEN] which must never become a snippet.",
      },
      {
        action: "paste",
        value: "Contains [REDACTED:PASSWORD] which must also be ignored completely.",
      },
      { action: "fill", value: { param: "boundTemplateParam" } },
      { action: "fill" },
      { action: "click", target: [{ kind: "testid", value: "btn" }] },
      { action: "submit" },
      { action: "copy", value: validText },
      { action: "copy", value: validText },
      { action: "copy", value: validText },
      { action: "nav", value: "https://crm.local/very-long-navigation-url-path-12345" },
      { action: "nav", value: "https://crm.local/very-long-navigation-url-path-12345" },
      { action: "nav", value: "https://crm.local/very-long-navigation-url-path-12345" },
    ];

    expect(detectSnippets(steps)).toEqual([]);
  });

  it("truncates >40-char titles with ... and produces deterministic snip_<8hex> IDs and artifact paths", () => {
    const longText =
      "Thank you for contacting support. Your ticket is assigned to engineering.";
    const shortText = "Thanks for confirming your address!";

    expect(longText.length).toBeGreaterThan(40);
    expect(shortText.length).toBeGreaterThanOrEqual(20);
    expect(shortText.length).toBeLessThanOrEqual(40);

    const steps: Step[] = [
      { action: "fill", value: longText },
      { action: "fill", value: longText },
      { action: "paste", value: longText },
      { action: "fill", value: shortText },
      { action: "paste", value: shortText },
      { action: "fill", value: shortText },
    ];

    const firstRun = detectSnippets(steps);
    const secondRun = detectSnippets(steps);

    expect(firstRun).toHaveLength(2);
    expect(secondRun).toEqual(firstRun);

    for (const finding of firstRun) {
      assertValidFindingShape(finding);
      expect(finding.id).toMatch(/^snip_[0-9a-f]{8}$/);
      expect(finding.verdict).toBe("rung1");
      expect(finding.artifact).toEqual({
        kind: "snippet",
        path: `snippets/${finding.id}.txt`,
        verified: false,
      });
    }

    expect(firstRun[0].title).toBe(
      `Save a snippet for: "${longText.slice(0, 40)}..."`,
    );
    expect(firstRun[1].title).toBe(`Save a snippet for: "${shortText}"`);
  });
});

describe("Brain shapes: buildReport(session, events)", () => {
  it.each<{
    label: string;
    session: string;
    events: Event[] | undefined;
    expectedFindings: number;
  }>([
    {
      label: "undefined events defaults to empty findings",
      session: "sess_undef",
      events: undefined,
      expectedFindings: 0,
    },
    {
      label: "empty events array returns empty findings",
      session: "sess_empty",
      events: [],
      expectedFindings: 0,
    },
    {
      label: "below-threshold trace (only 2 repetitions) returns empty findings",
      session: "sess_below_threshold",
      events: [
        makeEvent("input", {
          target: {
            tag: "textarea",
            locators: [{ kind: "testid", value: "reply-1" }],
          },
          value: "Hi there, your request has been approved by finance.",
        }),
        makeEvent("click", {
          target: {
            tag: "button",
            locators: [{ kind: "testid", value: "send-1" }],
          },
        }),
        makeEvent("input", {
          target: {
            tag: "textarea",
            locators: [{ kind: "testid", value: "reply-2" }],
          },
          value: "Hi there, your request has been approved by legal.",
        }),
      ],
      expectedFindings: 0,
    },
    {
      label: "single-cluster trace returns 1 validated finding",
      session: "sess_single_cluster",
      events: [
        makeEvent("input", {
          target: {
            tag: "textarea",
            locators: [{ kind: "testid", value: "box-1" }],
          },
          value:
            "Hi, thanks for your order. It ships Friday and tracking will follow shortly.",
        }),
        makeEvent("submit"),
        makeEvent("input", {
          target: {
            tag: "textarea",
            locators: [{ kind: "testid", value: "box-2" }],
          },
          value:
            "Hi, thanks for your order. It ships Monday and tracking will follow shortly.",
        }),
        makeEvent("submit"),
        makeEvent("paste", {
          target: {
            tag: "textarea",
            locators: [{ kind: "testid", value: "box-3" }],
          },
          value:
            "Hi, thanks for your order! It ships Friday and tracking will follow shortly.",
        }),
      ],
      expectedFindings: 1,
    },
    {
      label: "multi-cluster trace returns 2 validated findings",
      session: "sess_multi_cluster",
      events: [
        makeEvent("input", {
          target: { tag: "textarea", locators: [{ kind: "testid", value: "a1" }] },
          value:
            "Please find attached the quarterly revenue breakdown for your review.",
        }),
        makeEvent("paste", {
          target: { tag: "textarea", locators: [{ kind: "testid", value: "b1" }] },
          value:
            "Your support ticket has been escalated to the engineering on-call rotation.",
        }),
        makeEvent("input", {
          target: { tag: "textarea", locators: [{ kind: "testid", value: "a2" }] },
          value:
            "Please find attached the quarterly revenue breakdown for your team.",
        }),
        makeEvent("paste", {
          target: { tag: "textarea", locators: [{ kind: "testid", value: "b2" }] },
          value:
            "Your support ticket has been escalated to the engineering on-call team.",
        }),
        makeEvent("input", {
          target: { tag: "textarea", locators: [{ kind: "testid", value: "a3" }] },
          value:
            "Please find attached the quarterly revenue breakdown for your review!",
        }),
        makeEvent("paste", {
          target: { tag: "textarea", locators: [{ kind: "testid", value: "b3" }] },
          value:
            "Your support ticket has been escalated to the engineering on-call rotation!",
        }),
      ],
      expectedFindings: 2,
    },
  ])(
    "produces schema-valid Report for $label",
    async ({ session, events, expectedFindings }) => {
      const before = Date.now();
      const report =
        events === undefined
          ? await buildReport(session)
          : await buildReport(session, events);
      const after = Date.now();

      assertValidReportShape(report);
      expect(report.session).toBe(session);
      expect(report.generatedAt).toBeGreaterThanOrEqual(before);
      expect(report.generatedAt).toBeLessThanOrEqual(after);
      expect(report.findings).toHaveLength(expectedFindings);
    },
  );

  it.each<{
    fixture: string;
    session: string;
    expectedFindings: number;
  }>([
    {
      fixture: "reply-x3.jsonl",
      session: "sess_reply_x3",
      expectedFindings: 1,
    },
    {
      fixture: "one-off.jsonl",
      session: "sess_one_off",
      expectedFindings: 0,
    },
  ])(
    "produces schema-valid Report from fixture $fixture",
    async ({ fixture, session, expectedFindings }) => {
      const events = await loadFixtureEvents(fixture);
      const report = await buildReport(session, events);

      assertValidReportShape(report);
      expect(report.session).toBe(session);
      expect(report.findings).toHaveLength(expectedFindings);

      if (expectedFindings > 0) {
        expect(report.findings[0].verdict).toBe("rung1");
        expect(report.findings[0].stats.repetitions).toBe(3);
        expect(report.findings[0].id).toMatch(/^snip_[0-9a-f]{8}$/);
      }
    },
  );
});
