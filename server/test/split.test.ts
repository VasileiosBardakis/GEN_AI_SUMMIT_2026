import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { EventSchema, EventsSchema } from "@gen/shared/schema.ts";
import { normalize } from "../src/detect/normalize.ts";
import { detectSnippets } from "../src/detect/snippet.ts";
import {
  extractHost,
  extractTab,
  splitStreams,
} from "../src/detect/split.ts";

let seq = 0;

function makeEvent(
  type: Event["type"],
  extra: Partial<Omit<Event, "type">> = {},
): Event {
  seq += 1;
  return EventSchema.parse({
    v: 1,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    ts: 1740000000000 + seq * 1000,
    session: "sess_split_test",
    source: "browser",
    app: "app.example",
    type,
    ...extra,
  });
}

describe("extractHost", () => {
  it("extracts hostname from valid URLs and falls back to event.app when missing or malformed", () => {
    expect(
      extractHost(
        makeEvent("click", {
          app: "crm-desktop",
          url: "https://sub.crm.example:8443/leads?page=2",
        }),
      ),
    ).toBe("sub.crm.example");

    expect(
      extractHost(
        makeEvent("click", {
          app: "fallback.app",
          url: undefined,
        }),
      ),
    ).toBe("fallback.app");

    expect(
      extractHost(
        makeEvent("click", {
          app: "fallback.app",
          url: "not-a-valid-url",
        }),
      ),
    ).toBe("fallback.app");

    expect(
      extractHost(
        makeEvent("click", {
          app: "fallback.app",
          url: "about:blank",
        }),
      ),
    ).toBe("fallback.app");
  });
});

describe("extractTab", () => {
  it("prefers meta.tabId, then trimmed window title, then default", () => {
    expect(
      extractTab(
        makeEvent("click", {
          window: "Ignored Window",
          meta: { tabId: "tab-crm" },
        }),
      ),
    ).toBe("tab-crm");

    expect(
      extractTab(
        makeEvent("click", {
          meta: { tabId: 0 },
        }),
      ),
    ).toBe("0");

    expect(
      extractTab(
        makeEvent("click", {
          window: "  Inbox - Mail  ",
          meta: { tabId: "" },
        }),
      ),
    ).toBe("Inbox - Mail");

    expect(
      extractTab(
        makeEvent("click", {
          window: "   ",
        }),
      ),
    ).toBe("default");
  });
});

describe("splitStreams", () => {
  it("splits interleaved multi-site, multi-tab events and preserves step order for snippet detection", () => {
    const crmEvents: Event[] = [];
    const mailEvents: Event[] = [];

    const replyBodies = [
      "Hi, thanks for reaching out. Your request has been approved today.",
      "Hi, thanks for reaching out. Your request has been approved now.",
      "Hi, thanks for reaching out! Your request has been approved today.",
    ];

    for (let i = 0; i < 3; i++) {
      crmEvents.push(
        makeEvent("input", {
          app: "crm.example",
          url: "https://crm.example/leads",
          meta: { tabId: "tab-crm" },
          target: {
            tag: "input",
            locators: [{ kind: "testid", value: "lead-name" }],
          },
          value: `Lead ${i + 1}`,
        }),
        makeEvent("submit", {
          app: "crm.example",
          url: "https://crm.example/leads",
          meta: { tabId: "tab-crm" },
          target: {
            tag: "form",
            locators: [{ kind: "testid", value: "lead-form" }],
          },
        }),
      );

      mailEvents.push(
        makeEvent("click", {
          app: "mail.example",
          url: "https://mail.example/inbox",
          meta: { tabId: "tab-mail" },
          target: {
            tag: "button",
            locators: [{ kind: "testid", value: "reply-btn" }],
          },
        }),
        makeEvent("input", {
          app: "mail.example",
          url: "https://mail.example/inbox",
          meta: { tabId: "tab-mail" },
          target: {
            tag: "textarea",
            locators: [{ kind: "testid", value: "reply-body" }],
          },
          value: replyBodies[i],
        }),
        makeEvent("submit", {
          app: "mail.example",
          url: "https://mail.example/inbox",
          meta: { tabId: "tab-mail" },
          target: {
            tag: "form",
            locators: [{ kind: "testid", value: "send-reply" }],
          },
        }),
      );
    }

    const interleaved: Event[] = [];
    const maxLen = Math.max(crmEvents.length, mailEvents.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < crmEvents.length) interleaved.push(crmEvents[i]);
      if (i < mailEvents.length) interleaved.push(mailEvents[i]);
    }

    expect(EventsSchema.parse(interleaved)).toHaveLength(interleaved.length);

    const streams = splitStreams(interleaved);

    expect(streams).toHaveLength(2);
    expect(streams.map((s) => s.key)).toEqual([
      "tab-crm::crm.example",
      "tab-mail::mail.example",
    ]);

    const [crmStream, mailStream] = streams;

    expect(crmStream.tab).toBe("tab-crm");
    expect(crmStream.host).toBe("crm.example");
    expect(crmStream.events).toEqual(crmEvents);
    expect(
      crmStream.events.every(
        (ev) => ev.meta?.tabId === "tab-crm" && ev.app === "crm.example",
      ),
    ).toBe(true);
    expect(crmStream.steps).toEqual(normalize(crmEvents));

    expect(mailStream.tab).toBe("tab-mail");
    expect(mailStream.host).toBe("mail.example");
    expect(mailStream.events).toEqual(mailEvents);
    expect(
      mailStream.events.every(
        (ev) => ev.meta?.tabId === "tab-mail" && ev.app === "mail.example",
      ),
    ).toBe(true);
    expect(mailStream.steps).toEqual(normalize(mailEvents));

    const findings = detectSnippets(mailStream.steps);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("rung1");
    expect(findings[0].stats.repetitions).toBe(3);
  });

  it("splits same-host workflows across different numeric tabIds and window titles", () => {
    const tabEvents = EventsSchema.parse([
      makeEvent("click", {
        app: "docs.example",
        url: "https://docs.example/a",
        meta: { tabId: 1 },
        target: { locators: [{ kind: "testid", value: "edit-a" }] },
      }),
      makeEvent("click", {
        app: "docs.example",
        url: "https://docs.example/b",
        meta: { tabId: 2 },
        target: { locators: [{ kind: "testid", value: "edit-b" }] },
      }),
      makeEvent("input", {
        app: "docs.example",
        url: "https://docs.example/a",
        meta: { tabId: 1 },
        target: { locators: [{ kind: "testid", value: "title-a" }] },
        value: "Doc A",
      }),
      makeEvent("input", {
        app: "docs.example",
        url: "https://docs.example/b",
        meta: { tabId: 2 },
        target: { locators: [{ kind: "testid", value: "title-b" }] },
        value: "Doc B",
      }),
    ]);

    const tabStreams = splitStreams(tabEvents);
    expect(tabStreams).toHaveLength(2);
    expect(tabStreams.map((s) => s.key)).toEqual([
      "1::docs.example",
      "2::docs.example",
    ]);
    expect(tabStreams[0].steps.map((s) => s.action)).toEqual(["click", "fill"]);
    expect(tabStreams[1].steps.map((s) => s.action)).toEqual(["click", "fill"]);

    const windowEvents = EventsSchema.parse([
      makeEvent("click", {
        app: "docs.example",
        url: "https://docs.example/a",
        window: "  Spec A  ",
        target: { locators: [{ kind: "testid", value: "edit-a" }] },
      }),
      makeEvent("click", {
        app: "docs.example",
        url: "https://docs.example/b",
        window: "Spec B",
        target: { locators: [{ kind: "testid", value: "edit-b" }] },
      }),
    ]);

    const windowStreams = splitStreams(windowEvents);
    expect(windowStreams).toHaveLength(2);
    expect(windowStreams.map((s) => s.key)).toEqual([
      "Spec A::docs.example",
      "Spec B::docs.example",
    ]);
  });

  it("uses event.app as host when url is missing or malformed", () => {
    const events = EventsSchema.parse([
      makeEvent("click", {
        app: "notes-desktop",
        meta: { tabId: "win-1" },
        target: { locators: [{ kind: "uia", value: "New Note" }] },
      }),
      makeEvent("input", {
        app: "notes-desktop",
        url: "://malformed-url",
        meta: { tabId: "win-1" },
        target: { locators: [{ kind: "uia", value: "Editor" }] },
        value: "Meeting notes",
      }),
    ]);

    const streams = splitStreams(events);
    expect(streams).toHaveLength(1);
    expect(streams[0].key).toBe("win-1::notes-desktop");
    expect(streams[0].host).toBe("notes-desktop");
    expect(streams[0].events).toHaveLength(2);
    expect(streams[0].steps).toHaveLength(2);
  });

  it("excludes streams with zero normalized steps by default and includes them when includeEmptySteps is true", () => {
    const events = EventsSchema.parse([
      makeEvent("tab_switch", {
        app: "idle.example",
        url: "https://idle.example/home",
        meta: { tabId: "tab-idle" },
      }),
      makeEvent("scroll", {
        app: "idle.example",
        url: "https://idle.example/home",
        meta: { tabId: "tab-idle" },
      }),
      makeEvent("click", {
        app: "active.example",
        url: "https://active.example/dashboard",
        meta: { tabId: "tab-active" },
        target: { locators: [{ kind: "testid", value: "open-btn" }] },
      }),
    ]);

    const defaultStreams = splitStreams(events);
    expect(defaultStreams).toHaveLength(1);
    expect(defaultStreams[0].key).toBe("tab-active::active.example");
    expect(defaultStreams[0].steps).toHaveLength(1);

    const allStreams = splitStreams(events, { includeEmptySteps: true });
    expect(allStreams).toHaveLength(2);
    expect(allStreams.map((s) => s.key)).toEqual([
      "tab-idle::idle.example",
      "tab-active::active.example",
    ]);
    expect(allStreams[0].events).toHaveLength(2);
    expect(allStreams[0].steps).toEqual([]);
  });
});
