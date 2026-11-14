import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { EventSchema } from "@gen/shared/schema.ts";
import { normalize } from "../src/detect/normalize.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string): Promise<Event[]> {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => EventSchema.parse(JSON.parse(line)));
}

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

describe("normalize", () => {
  it("collapses the 21-event, 3-cycle email reply fixture into 17 steps", async () => {
    const body1 =
      "Hi, thanks for your order. It ships Friday and tracking will follow shortly.";
    const body2 =
      "Hi, thanks for your order. It ships Monday and tracking will follow shortly.";
    const body3 =
      "Hi, thanks for your order! It ships Friday and tracking will follow shortly.";

    const events = await loadFixtureEvents("reply-x3.jsonl");

    expect(events).toHaveLength(21);
    expect(events.filter((event) => event.type === "scroll")).toHaveLength(1);

    const steps = normalize(events);

    expect(steps).toHaveLength(17);
    expect(steps.map((step) => step.action as string)).not.toContain("scroll");
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
