import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import { createServer } from "../../src/app.ts";
import { buildLibraryEntryFromScript } from "../../src/hands/implementor.ts";
import { createLibraryRecallMatcher } from "../../src/hands/recall.ts";
import type { LibraryEntry } from "../../src/hands/types.ts";

function makeSheetEntry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  const base = buildLibraryEntryFromScript({
    name: "Sheets status fill",
    solution: "Fill the selected Google Sheets cell with Approved and click Save.",
    script: {
      name: "Sheets status fill",
      steps: [
        { action: "insertText", value: "Approved" },
        { action: "click", target: { kind: "text", value: "Save" } },
      ],
    },
    now: 1_000,
  });
  return {
    ...base,
    eyes: {
      intent: "sheets_status_fill",
      scope: {
        apps: ["docs.google.com"],
        urlPatterns: ["docs.google.com/spreadsheets*"],
        pageHints: ["Q4 Budget"],
      },
      targetHints: {
        roles: ["gridcell"],
        labelContains: [],
        locators: [],
      },
      textHints: { prefixHints: [], minCharsBeforeMatch: 0 },
      guards: {
        fieldEmptyOnly: false,
        requireClipboard: false,
        cooldownMs: 60_000,
        minSignals: 2,
      },
    },
    ...overrides,
  };
}

function makeEvent(partial: Partial<Event>): Event {
  return {
    v: 1,
    id: partial.id ?? "evt_1",
    ts: partial.ts ?? 10_000,
    session: "sess_1",
    source: "browser",
    app: "docs.google.com",
    url: "https://docs.google.com/spreadsheets/d/123/edit",
    window: "Q4 Budget - Google Sheets",
    type: "click",
    ...partial,
  };
}

describe("createLibraryRecallMatcher", () => {
  it("waits until half-detected interaction (e.g. clicking a sheet cell) and ignores nav or unrelated buttons", () => {
    const matcher = createLibraryRecallMatcher();
    const entry = makeSheetEntry();

    // Navigating to Google Sheets alone must not trigger
    const navMatch = matcher.matchEvents(
      [makeEvent({ type: "nav", target: undefined })],
      [entry],
      10_000,
    );
    expect(navMatch).toBeNull();

    // Clicking an unrelated toolbar button must not trigger
    const buttonMatch = matcher.matchEvents(
      [
        makeEvent({
          type: "click",
          target: { locators: [{ kind: "text", value: "Share" }], role: "button", label: "Share" },
        }),
      ],
      [entry],
      10_500,
    );
    expect(buttonMatch).toBeNull();

    // Clicking a cell (role=gridcell or meta.grid) half-detects the loop
    const cellMatch = matcher.matchEvents(
      [
        makeEvent({
          type: "click",
          target: { locators: [{ kind: "css", value: "div.cell" }], role: "gridcell" },
          meta: { grid: { cellRef: "B4" } },
        }),
      ],
      [entry],
      11_000,
    );
    expect(cellMatch?.id).toBe(entry.id);
  });

  it("matches Google Sheets canvas cell click via meta.grid even without explicit DOM role", () => {
    const matcher = createLibraryRecallMatcher();
    const entry = makeSheetEntry();

    const match = matcher.matchEvents(
      [
        makeEvent({
          type: "click",
          target: { locators: [{ kind: "css", value: "canvas" }], tag: "canvas" },
          meta: { grid: { cellRef: "C12" } },
        }),
      ],
      [entry],
      20_000,
    );
    expect(match?.id).toBe(entry.id);
  });

  it("treats 127.0.0.1 and localhost as equivalent loopback hosts", () => {
    const matcher = createLibraryRecallMatcher();
    const entry = makeSheetEntry({
      eyes: {
        ...makeSheetEntry().eyes,
        scope: { apps: ["localhost"], urlPatterns: ["localhost*"], pageHints: [] },
      },
    });

    const match = matcher.matchEvents(
      [
        makeEvent({
          app: "127.0.0.1",
          url: "http://127.0.0.1:5173/",
          window: "Automation Ladder — Local Demo",
          target: { locators: [{ kind: "css", value: "td" }], role: "gridcell" },
        }),
      ],
      [entry],
      25_000,
    );
    expect(match?.id).toBe(entry.id);
  });

  it("does not infer gridcell for form inputs/buttons just because page-level meta.grid is present", () => {
    const matcher = createLibraryRecallMatcher();
    const entry = makeSheetEntry();

    const inputClick = makeEvent({
      app: "127.0.0.1",
      url: "http://127.0.0.1:5173/",
      target: {
        locators: [{ kind: "css", value: 'input[name="company_name"]' }],
        tag: "input",
        label: "Company name",
        role: "textbox",
      },
      meta: { grid: { cellRef: "A1" } },
    });
    expect(matcher.matchEvents([inputClick], [entry], 26_000)).toBeNull();

    const untaggedInputClick = makeEvent({
      app: "127.0.0.1",
      url: "http://127.0.0.1:5173/",
      target: {
        locators: [{ kind: "css", value: 'input[name="company_name"]' }],
        tag: "input",
      },
      meta: { grid: { cellRef: "A1" } },
    });
    expect(matcher.matchEvents([untaggedInputClick], [entry], 26_500)).toBeNull();
  });

  it("enforces paused status, cooldownMs, and requireClipboard guards", () => {
    const matcher = createLibraryRecallMatcher();
    const paused = makeSheetEntry({ status: "paused" });
    const clickEvt = makeEvent({
      type: "click",
      target: { locators: [{ kind: "css", value: "td" }], role: "gridcell" },
    });

    expect(matcher.matchEvents([clickEvt], [paused], 10_000)).toBeNull();

    const clipEntry = makeSheetEntry({
      eyes: {
        ...makeSheetEntry().eyes,
        guards: {
          fieldEmptyOnly: false,
          requireClipboard: true,
          cooldownMs: 30_000,
          minSignals: 2,
        },
      },
    });

    // No clipboard yet
    expect(matcher.matchEvents([clickEvt], [clipEntry], 10_000)).toBeNull();

    // Copy event in preceding batch satisfies requireClipboard
    expect(
      matcher.matchEvents(
        [makeEvent({ id: "evt_copy", ts: 11_000, type: "copy" })],
        [clipEntry],
        11_000,
      ),
    ).toBeNull();
    expect(matcher.matchEvents([clickEvt], [clipEntry], 12_000)?.id).toBe(clipEntry.id);

    // Cooldown suppresses immediate re-trigger until cooldownMs passes
    matcher.markTriggered(clipEntry.id, 12_000);
    expect(matcher.matchEvents([clickEvt], [clipEntry], 25_000)).toBeNull();
    expect(matcher.matchEvents([clickEvt], [clipEntry], 43_000)?.id).toBe(clipEntry.id);
  });

  it("ignores paste, change, blur_commit, insertFromPaste, filled clicks, and unrelated textboxes on the same page", () => {
    const matcher = createLibraryRecallMatcher();
    const snippet = "Hi, thanks for your order. It ships Friday and tracking will follow shortly.";
    const replyEntry = buildLibraryEntryFromScript({
      name: "Insert shipping reply",
      solution: `Insert '${snippet}' into the currently focused field.`,
      script: {
        name: "Insert shipping reply",
        steps: [{ action: "insertText", value: snippet }],
      },
      context: {
        app: "localhost",
        url: "http://localhost:5173/",
        title: "Automation Ladder — Local Demo",
        targetLabel: "Reply to customer",
        targetRole: "textbox",
        locators: [{ kind: "css", value: 'textarea[name="customer_reply"]' }],
      },
      status: "active",
      now: 1_000,
    });

    const baseReplyEvent = (overrides: Partial<Event>): Event =>
      makeEvent({
        app: "localhost",
        url: "http://localhost:5173/",
        window: "Automation Ladder — Local Demo",
        target: {
          locators: [{ kind: "css", value: 'textarea[name="customer_reply"]' }],
          tag: "textarea",
          label: "Reply to customer",
          role: "textbox",
        },
        ...overrides,
      });

    // nav / paste / change / blur_commit / insertFromPaste must never trigger
    expect(matcher.matchEvents([baseReplyEvent({ type: "nav", target: undefined })], [replyEntry], 2_000)).toBeNull();
    expect(matcher.matchEvents([baseReplyEvent({ type: "paste", value: snippet })], [replyEntry], 2_100)).toBeNull();
    expect(matcher.matchEvents([baseReplyEvent({ type: "change", value: snippet })], [replyEntry], 2_200)).toBeNull();
    expect(
      matcher.matchEvents(
        [baseReplyEvent({ type: "input", value: snippet, meta: { subType: "blur_commit" } })],
        [replyEntry],
        2_300,
      ),
    ).toBeNull();
    expect(
      matcher.matchEvents(
        [baseReplyEvent({ type: "input", value: snippet, meta: { typing: { inputType: "insertFromPaste" } } })],
        [replyEntry],
        2_400,
      ),
    ).toBeNull();

    // Clicking an unrelated empty input on the same page must NOT trigger
    expect(
      matcher.matchEvents(
        [
          makeEvent({
            app: "localhost",
            url: "http://localhost:5173/",
            window: "Automation Ladder — Local Demo",
            type: "click",
            value: "",
            target: {
              locators: [{ kind: "css", value: 'input[name="company_name"]' }],
              tag: "input",
              label: "Company name",
              role: "textbox",
            },
          }),
        ],
        [replyEntry],
        2_500,
      ),
    ).toBeNull();

    // Clicking the target field while already filled with unrelated text must NOT trigger
    expect(
      matcher.matchEvents([baseReplyEvent({ type: "click", value: "Already wrote something else" })], [replyEntry], 2_600),
    ).toBeNull();

    // Clicking the empty target field triggers immediately
    expect(
      matcher.matchEvents([baseReplyEvent({ type: "click", value: "" })], [replyEntry], 2_700)?.id,
    ).toBe(replyEntry.id);
  });
});

describe("POST /events -> library half-detection -> /decide bridge", () => {
  let tracesDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tracesDir = await mkdtemp(path.join(os.tmpdir(), "gen-recall-test-"));
    server = createServer({
      tracesDir,
      dataDir: path.join(tracesDir, "data"),
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tracesDir, { recursive: true, force: true });
  });

  it("recalls a saved library entry with /decide when half-detected and runs it on approval", async () => {
    const entry = makeSheetEntry();
    const saveRes = await fetch(`${baseUrl}/library`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    expect(saveRes.status).toBe(200);

    // Start long-poll before sending the half-detected event
    const pollDecidePromise = fetch(`${baseUrl}/hands/next?waitMs=2000`);

    const eventsRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        makeEvent({
          type: "click",
          target: { locators: [{ kind: "css", value: "td.cell" }], role: "gridcell" },
          meta: { grid: { cellRef: "B2" } },
        }),
      ]),
    });
    expect(eventsRes.status).toBe(200);
    expect(await eventsRes.json()).toEqual({ ok: true, n: 1, scrubbed: 0 });

    const decidePollRes = await pollDecidePromise;
    expect(decidePollRes.status).toBe(200);
    const decideCmd = (await decidePollRes.json()) as {
      id: string;
      kind: string;
      name: string;
      solution: string;
      script: LibraryEntry["script"];
    };
    expect(decideCmd.kind).toBe("decide");
    expect(decideCmd.name).toBe(entry.name);
    expect(decideCmd.solution).toBe(entry.solution);
    expect(decideCmd.script).toEqual(entry.script);

    // Approve in extension -> should update library runCount/status and enqueue script execution
    const pollRunPromise = fetch(`${baseUrl}/hands/next?waitMs=2000`);
    const resultRes = await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: decideCmd.id, ok: true, decision: "approved" }),
    });
    expect(resultRes.status).toBe(200);

    const runPollRes = await pollRunPromise;
    expect(runPollRes.status).toBe(200);
    const runCmd = (await runPollRes.json()) as { id: string; script: LibraryEntry["script"] };
    expect(runCmd.script).toEqual(entry.script);

    await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: runCmd.id, ok: true, results: [{ ok: true }] }),
    });

    const libRes = await fetch(`${baseUrl}/library`);
    const libJson = (await libRes.json()) as { ok: boolean; items: LibraryEntry[] };
    expect(libJson.items[0]?.status).toBe("active");
    expect(libJson.items[0]?.runCount).toBe(1);
  });

  it("does not enqueue script execution when the recalled /decide card is dismissed", async () => {
    const entry = makeSheetEntry();
    await fetch(`${baseUrl}/library`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });

    const pollDecidePromise = fetch(`${baseUrl}/hands/next?waitMs=2000`);
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        makeEvent({
          type: "click",
          target: { locators: [{ kind: "css", value: "td.cell" }], role: "gridcell" },
        }),
      ]),
    });

    const decideCmd = (await (await pollDecidePromise).json()) as { id: string; kind: string };
    expect(decideCmd.kind).toBe("decide");

    await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: decideCmd.id, ok: true, decision: "dismissed" }),
    });

    const nextPoll = await fetch(`${baseUrl}/hands/next?waitMs=60`);
    expect(nextPoll.status).toBe(204);
  });

  it("auto-saves an active snippet via POST /library/auto without delaying subsequent empty focus", async () => {
    const snippet = "Hi, thanks for your order. It ships Friday and tracking will follow shortly.";
    const autoRes = await fetch(`${baseUrl}/library/auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Insert shipping reply",
        solution: `Insert '${snippet}' into the currently focused field.`,
        script: {
          name: "Insert shipping reply",
          steps: [{ action: "insertText", value: snippet }],
        },
        context: {
          app: "localhost",
          url: "http://localhost:5173/",
          title: "Automation Ladder — Local Demo",
          targetLabel: "Reply to customer",
          targetRole: "textbox",
          locators: [{ kind: "css", value: 'textarea[name="customer_reply"]' }],
        },
      }),
    });
    expect(autoRes.status).toBe(200);
    const autoJson = (await autoRes.json()) as { ok: boolean; entry: LibraryEntry };
    expect(autoJson.ok).toBe(true);
    expect(autoJson.entry.status).toBe("active");

    // Trailing change/paste events right after auto-save do NOT trigger recall
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        makeEvent({
          app: "localhost",
          url: "http://localhost:5173/",
          window: "Automation Ladder — Local Demo",
          type: "change",
          value: snippet,
          target: {
            locators: [{ kind: "css", value: 'textarea[name="customer_reply"]' }],
            tag: "textarea",
            label: "Reply to customer",
            role: "textbox",
          },
        }),
      ]),
    });
    const suppressedPoll = await fetch(`${baseUrl}/hands/next?waitMs=50`);
    expect(suppressedPoll.status).toBe(204);

    // Focusing the empty field immediately afterwards triggers /decide to insert it
    const pollDecidePromise = fetch(`${baseUrl}/hands/next?waitMs=2000`);
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        makeEvent({
          app: "localhost",
          url: "http://localhost:5173/",
          window: "Automation Ladder — Local Demo",
          type: "focus",
          value: "",
          target: {
            locators: [{ kind: "css", value: 'textarea[name="customer_reply"]' }],
            tag: "textarea",
            label: "Reply to customer",
            role: "textbox",
          },
        }),
      ]),
    });

    const decidePollRes = await pollDecidePromise;
    expect(decidePollRes.status).toBe(200);
    const decideCmd = (await decidePollRes.json()) as {
      id: string;
      kind: string;
      name: string;
      script: LibraryEntry["script"];
    };
    expect(decideCmd.kind).toBe("decide");
    expect(decideCmd.name).toBe("Insert shipping reply");
    expect(decideCmd.script.steps).toEqual([{ action: "insertText", value: snippet }]);
  });
});
