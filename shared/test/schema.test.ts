import { describe, expect, it } from "vitest";
import { EventSchema } from "../schema.ts";

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
