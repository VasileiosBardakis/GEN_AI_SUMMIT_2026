import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { normalize } from "../src/detect/normalize.ts";

let seq = 0;

function makeEvent(
  type: Event["type"],
  extra: Partial<Omit<Event, "type">> = {},
): Event {
  seq += 1;
  return {
    v: 1,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    ts: 1740000000000 + seq * 1000,
    session: "sess_normalize",
    source: "browser",
    app: "mail.local",
    type,
    ...extra,
  };
}

type Target = NonNullable<Event["target"]>;

function threadRow(n: number): Target {
  return {
    tag: "tr",
    role: "row",
    label: `Order #${n}`,
    locators: [
      { kind: "testid", value: `thread-row-${n}` },
      { kind: "css", value: `tr[data-thread='${n}']` },
    ],
  };
}

const replyButton: Target = {
  tag: "button",
  role: "button",
  label: "Reply",
  locators: [
    { kind: "testid", value: "reply-btn" },
    { kind: "aria", value: 'button[name="Reply"]' },
    { kind: "text", value: "Reply" },
  ],
};

const replyBody: Target = {
  tag: "textarea",
  role: "textbox",
  label: "Reply body",
  locators: [
    { kind: "testid", value: "reply-body" },
    { kind: "aria", value: 'textbox[name="Reply body"]' },
    { kind: "css", value: "textarea.reply-editor" },
  ],
};

const sendButton: Target = {
  tag: "button",
  role: "button",
  label: "Send",
  locators: [{ kind: "testid", value: "send-btn" }],
};

const replyForm: Target = {
  tag: "form",
  role: "form",
  locators: [{ kind: "testid", value: "reply-form" }],
};

const header: Target = {
  tag: "header",
  role: "banner",
  locators: [{ kind: "css", value: "header.topbar" }],
};

describe("normalize", () => {
  it("collapses a 21-event, 3-cycle email reply trace into 17 steps", () => {
    const body1 = "Hi, thanks for your order. It ships Friday.";
    const body2 = "Thanks for the update, I will review it today.";
    const body3 = "Received, thank you!";

    const events: Event[] = [
      makeEvent("nav", { url: "http://mail.local/inbox" }),
      // Cycle 1
      makeEvent("click", { target: threadRow(1) }),
      makeEvent("scroll", {
        target: { tag: "html", locators: [{ kind: "css", value: "html" }] },
        meta: { scroll: { deltaX: 0, deltaY: 120 } },
      }),
      makeEvent("click", { target: replyButton }),
      makeEvent("input", { target: replyBody, value: body1 }),
      makeEvent("change", { target: replyBody, value: body1 }),
      makeEvent("click", { target: sendButton }),
      makeEvent("submit", { target: replyForm }),
      // Cycle 2 (includes a stray header click)
      makeEvent("click", { target: threadRow(2) }),
      makeEvent("click", { target: header }),
      makeEvent("click", { target: replyButton }),
      makeEvent("input", { target: replyBody, value: body2 }),
      makeEvent("change", { target: replyBody, value: body2 }),
      makeEvent("click", { target: sendButton }),
      makeEvent("submit", { target: replyForm }),
      // Cycle 3
      makeEvent("click", { target: threadRow(3) }),
      makeEvent("click", { target: replyButton }),
      makeEvent("input", { target: replyBody, value: body3 }),
      makeEvent("change", { target: replyBody, value: body3 }),
      makeEvent("click", { target: sendButton }),
      makeEvent("submit", { target: replyForm }),
    ];

    expect(events).toHaveLength(21);

    const steps = normalize(events);

    expect(steps).toHaveLength(17);
    expect(steps[0].action).toBe("nav");
    expect(steps.filter((step) => step.action === "fill")).toHaveLength(3);
    expect(steps.map((step) => step.action)).toEqual([
      "nav",
      "click",
      "click",
      "fill",
      "click",
      "submit",
      "click",
      "click",
      "click",
      "fill",
      "click",
      "submit",
      "click",
      "click",
      "fill",
      "click",
      "submit",
    ]);
    expect(
      steps
        .filter((step) => step.action === "fill")
        .map((step) => step.value),
    ).toEqual([body1, body2, body3]);
  });

  it("collapses a raw keystroke burst and its change event into one fill", () => {
    const field: Target = {
      tag: "input",
      role: "textbox",
      locators: [{ kind: "testid", value: "subject" }],
    };

    const events: Event[] = [
      makeEvent("input", { target: field, value: "H" }),
      makeEvent("keydown", { target: field, meta: { key: "H" } }),
      makeEvent("keyup", { target: field, meta: { key: "H" } }),
      makeEvent("input", { target: field, value: "Hi" }),
      makeEvent("keydown", { target: field, meta: { key: "i" } }),
      makeEvent("keyup", { target: field, meta: { key: "i" } }),
      makeEvent("input", { target: field, value: "Hi," }),
      makeEvent("input", { target: field, value: "Hi, " }),
      makeEvent("input", { target: field, value: "Hi, there" }),
      makeEvent("change", { target: field, value: "Hi, there" }),
    ];

    const steps = normalize(events);

    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      action: "fill",
      target: [{ kind: "testid", value: "subject" }],
      value: "Hi, there",
    });
  });

  it("orders gridcell locators css-first and strips shortcut hints", () => {
    const steps = normalize([
      makeEvent("click", {
        target: {
          tag: "td",
          role: "gridcell",
          locators: [
            { kind: "text", value: "A1 F2" },
            { kind: "aria", value: "gridcell A1 Ctrl+C" },
            { kind: "css", value: 'td[data-cell="A1"]' },
          ],
        },
      }),
    ]);

    expect(steps[0].target?.map((locator) => locator.kind)).toEqual([
      "css",
      "aria",
      "text",
    ]);
    expect(steps[0].target?.map((locator) => locator.value)).toEqual([
      'td[data-cell="A1"]',
      "gridcell A1",
      "A1",
    ]);
  });

  it("orders non-grid locators testid > aria > text > css > uia and strips shortcuts", () => {
    const steps = normalize([
      makeEvent("click", {
        target: {
          tag: "button",
          role: "button",
          locators: [
            { kind: "uia", value: "Button Save" },
            { kind: "text", value: "Save Ctrl+C" },
            { kind: "css", value: "button.save" },
            { kind: "aria", value: 'button[name="Save"] F2' },
            { kind: "testid", value: "save-btn" },
          ],
        },
      }),
    ]);

    expect(steps[0].target?.map((locator) => locator.kind)).toEqual([
      "testid",
      "aria",
      "text",
      "css",
      "uia",
    ]);
    expect(steps[0].target?.map((locator) => locator.value)).toEqual([
      "save-btn",
      'button[name="Save"]',
      "Save",
      "button.save",
      "Button Save",
    ]);
  });

  it("masks emails and phone numbers while preserving redacted tokens", () => {
    const fieldA: Target = {
      tag: "input",
      locators: [{ kind: "testid", value: "email-field" }],
    };
    const fieldB: Target = {
      tag: "input",
      locators: [{ kind: "testid", value: "phone-field" }],
    };
    const fieldC: Target = {
      tag: "input",
      locators: [{ kind: "testid", value: "notes-field" }],
    };

    const steps = normalize([
      makeEvent("input", { target: fieldA, value: "Contact alice@example.com" }),
      makeEvent("input", { target: fieldB, value: "Call +1 415-555-0199" }),
      makeEvent("input", {
        target: fieldC,
        value: "Keep [REDACTED:email] and [REDACTED:415-555-0199] intact",
      }),
    ]);

    expect(steps.map((step) => step.value)).toEqual([
      "Contact <email>",
      "Call <phone>",
      "Keep [REDACTED:email] and [REDACTED:415-555-0199] intact",
    ]);
  });
});
