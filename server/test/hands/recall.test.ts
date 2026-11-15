import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

    // Clicking a button sharing label words ("Clear reply") must NOT trigger a textbox snippet
    expect(
      matcher.matchEvents(
        [
          makeEvent({
            app: "localhost",
            url: "http://localhost:5173/",
            window: "Automation Ladder — Local Demo",
            type: "click",
            target: {
              locators: [{ kind: "css", value: "#clear-reply" }],
              tag: "button",
              label: "Clear reply",
              role: "button",
            },
          }),
        ],
        [replyEntry],
        2_520,
      ),
    ).toBeNull();

    // Focusing/clicking while field ALREADY contains the snippet must NOT trigger
    expect(
      matcher.matchEvents([baseReplyEvent({ type: "focus", value: snippet })], [replyEntry], 2_540),
    ).toBeNull();
    expect(
      matcher.matchEvents([baseReplyEvent({ type: "click", value: snippet })], [replyEntry], 2_550),
    ).toBeNull();

    // Deleting to empty (Backspace -> input value="") must NOT trigger mid-delete
    expect(
      matcher.matchEvents(
        [baseReplyEvent({ type: "input", value: "", meta: { typing: { inputType: "deleteContentBackward" } } })],
        [replyEntry],
        2_560,
      ),
    ).toBeNull();

    // A "Company name" snippet must NEVER match other [name="..."] selectors via the word "name"
    const companyEntry = buildLibraryEntryFromScript({
      name: "Insert Nikolaidis logistics",
      solution: "Insert 'Nikolaidis logistics' into the currently focused field.",
      script: {
        name: "Insert Nikolaidis logistics",
        steps: [{ action: "insertText", value: "Nikolaidis logistics" }],
      },
      context: {
        app: "localhost",
        url: "http://localhost:5173/",
        title: "Automation Ladder — Local Demo",
        targetLabel: "Company name",
        targetRole: "textbox",
        locators: [
          { kind: "aria", value: 'textbox[name="Company name"]' },
          { kind: "css", value: 'input[name="company_name"]' },
        ],
      },
      status: "active",
      now: 1_000,
    });
    expect(
      matcher.matchEvents([baseReplyEvent({ type: "focus", value: "" })], [companyEntry], 2_580),
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

  it("matches snippets on combobox and searchbox text inputs across sites while rejecting select dropdowns", () => {
    const matcher = createLibraryRecallMatcher();
    const query = "asjgskgnsadjgnasdjgasdgbn";
    const searchEntry = buildLibraryEntryFromScript({
      name: `Insert "${query}"`,
      solution: `Insert '${query}' into the currently focused field.`,
      script: {
        name: `Insert "${query}"`,
        steps: [{ action: "insertText", value: query }],
      },
      context: {
        app: "www.youtube.com",
        url: "https://www.youtube.com/",
        title: "YouTube",
        targetLabel: "Search",
        targetRole: "combobox",
        locators: [
          { kind: "css", value: 'input[name="search_query"]' },
          { kind: "aria", value: 'combobox[name="Search"]' },
        ],
      },
      status: "active",
      now: 1_000,
    });

    // Focusing or clicking an empty <input role="combobox"> or <input role="searchbox"> triggers recall
    expect(
      matcher.matchEvents(
        [
          makeEvent({
            app: "www.youtube.com",
            url: "https://www.youtube.com/",
            window: "YouTube",
            type: "focus",
            value: "",
            target: {
              locators: [
                { kind: "aria", value: 'combobox[name="Search"]' },
                { kind: "css", value: 'input[name="search_query"]' },
              ],
              tag: "input",
              label: "Search",
              role: "combobox",
            },
          }),
        ],
        [searchEntry],
        2_000,
      )?.id,
    ).toBe(searchEntry.id);

    // Native <select> combobox must still be rejected for text snippets
    expect(
      matcher.matchEvents(
        [
          makeEvent({
            app: "www.youtube.com",
            url: "https://www.youtube.com/",
            window: "YouTube",
            type: "focus",
            value: "",
            target: {
              locators: [{ kind: "css", value: 'select[name="search_query"]' }],
              tag: "select",
              label: "Search",
              role: "combobox",
            },
          }),
        ],
        [searchEntry],
        2_500,
      ),
    ).toBeNull();
  });

  it("fires a saved Portal->ERP workflow immediately on move 1 (copy event on portal.html)", async () => {
    const matcher = createLibraryRecallMatcher();
    const portalToErp = buildLibraryEntryFromScript({
      name: "Portal order to ERP",
      solution: "Read order ID on portal.html, switch to erp.html, and fill order ID.",
      script: {
        name: "Portal order to ERP",
        steps: [
          {
            action: "readText",
            target: { kind: "css", value: ".order-id" },
            bind: "orderId",
          },
          { action: "switchTab", host: "erp.local" },
          {
            action: "fill",
            target: { kind: "css", value: 'input[name="order_id"]' },
            value: "{{orderId}}",
          },
        ],
      },
      context: {
        app: "localhost",
        url: "http://localhost:5173/portal.html",
        title: "Customer Portal",
      },
      status: "active",
      now: 1_000,
    });

    expect(portalToErp.eyes.guards.fieldEmptyOnly).toBe(false);
    expect(portalToErp.eyes.targetHints.locators).toEqual([{ kind: "css", value: ".order-id" }]);

    const copyEvt = makeEvent({
      id: "evt_portal_copy",
      app: "localhost",
      url: "http://localhost:5173/portal.html",
      window: "Customer Portal",
      type: "copy",
      value: "ORD-1042",
      target: {
        locators: [{ kind: "css", value: ".order-id" }],
        tag: "span",
      },
    });

    const match = matcher.matchEventsWithEvent([copyEvt], [portalToErp], 15_000);
    expect(match?.entry.id).toBe(portalToErp.id);
    expect(match?.borderline).toBe(false);

    // Non-borderline Locator[] match does not need Iris
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const irisMatch = await matcher.matchEventsWithIris([copyEvt], [portalToErp], {
      now: 15_000,
      irisOpts: { apiKey: "test-key", projectId: "test-proj", fetch: fetchMock },
    });
    expect(irisMatch?.entry.id).toBe(portalToErp.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recalls a copy -> switchTab -> paste Portal->ERP skill on move 1 even when requireClipboard is true", () => {
    const matcher = createLibraryRecallMatcher();
    const baseEntry = buildLibraryEntryFromScript({
      name: "Portal invoice to ERP",
      solution: "Copy Invoice ID from portal, switch tab to ERP, and paste into Invoice ID.",
      script: {
        name: "Portal invoice to ERP",
        steps: [
          {
            action: "readText",
            target: { kind: "testid", value: "portal-invoice-id" },
            bind: "invoiceId",
          },
          { action: "switchTab", host: "erp.local" },
          {
            action: "fill",
            target: { kind: "testid", value: "erp-invoice-id" },
            value: "{{invoiceId}}",
          },
        ],
      },
      context: {
        app: "portal.local",
        url: "http://portal.local:5173/portal",
        title: "Supplier Portal",
        targetLabel: "Invoice ID",
      },
      status: "active",
      now: 1_000,
    });

    const portalToErpWithClipboardGuard: LibraryEntry = {
      ...baseEntry,
      eyes: {
        ...baseEntry.eyes,
        guards: {
          ...baseEntry.eyes.guards,
          requireClipboard: true,
        },
      },
    };

    const copyEvt = makeEvent({
      id: "evt_portal_copy_clip_guard",
      ts: 5_000,
      app: "portal.local",
      url: "http://portal.local:5173/portal",
      window: "Supplier Portal",
      type: "copy",
      value: "INV-2026-001",
      target: {
        locators: [
          { kind: "testid", value: "portal-invoice-id" },
          { kind: "css", value: 'span[data-testid="portal-invoice-id"]' },
        ],
        tag: "span",
        label: "Invoice ID",
      },
    });

    // Even with requireClipboard: true and a timestamp older than CLIPBOARD_WINDOW_MS,
    // a move-1 copy event must still recall the copy -> switchTab -> paste workflow.
    const match = matcher.matchEventsWithEvent(
      [copyEvt],
      [portalToErpWithClipboardGuard],
      200_000,
    );
    expect(match?.entry.id).toBe(portalToErpWithClipboardGuard.id);
    expect(match?.event.id).toBe("evt_portal_copy_clip_guard");
    expect(match?.borderline).toBe(false);
  });

  it("falls back to semantic role/label/text matching when primary Locator[] drift and ranks Locator[] matches first", () => {
    const matcher = createLibraryRecallMatcher();
    const driftedEntry = buildLibraryEntryFromScript({
      name: "Fill CRM email",
      solution: "Fill Customer Email on CRM.",
      script: {
        name: "Fill CRM email",
        steps: [
          {
            action: "fill",
            target: { kind: "css", value: "#legacy-email-v1" },
            value: "ops@acme.example",
          },
        ],
      },
      context: {
        app: "crm.local",
        url: "https://crm.local/customers/new",
        title: "New Customer",
        targetLabel: "Customer Email",
        targetRole: "textbox",
      },
      status: "active",
      now: 1_000,
    });

    const driftedEvt = makeEvent({
      app: "crm.local",
      url: "https://crm.local/customers/new",
      window: "New Customer",
      type: "click",
      value: "",
      target: {
        locators: [{ kind: "css", value: "#email-v2" }],
        tag: "input",
        role: "textbox",
        label: "Customer Email",
      },
    });

    const fallbackMatch = matcher.matchEventsWithEvent([driftedEvt], [driftedEntry], 20_000);
    expect(fallbackMatch?.entry.id).toBe(driftedEntry.id);
    expect(fallbackMatch?.borderline).toBe(true);

    // Exact/CSS-list Locator[] match beats semantic-only fallback
    const exactEntry = buildLibraryEntryFromScript({
      name: "Fill CRM email v2",
      solution: "Fill Customer Email v2 on CRM.",
      script: {
        name: "Fill CRM email v2",
        steps: [
          {
            action: "fill",
            target: { kind: "css", value: "input.primary, #email-v2" },
            value: "v2@acme.example",
          },
        ],
      },
      context: {
        app: "crm.local",
        url: "https://crm.local/customers/new",
        title: "New Customer",
        targetLabel: "Customer Email",
        targetRole: "textbox",
      },
      status: "active",
      now: 900,
    });

    const rankedMatch = matcher.matchEventsWithEvent(
      [driftedEvt],
      [driftedEntry, exactEntry],
      20_000,
    );
    expect(rankedMatch?.entry.id).toBe(exactEntry.id);
    expect(rankedMatch?.borderline).toBe(false);
    expect(rankedMatch?.score).toBeGreaterThan(fallbackMatch!.score);
  });

  it("resolves 1-signal and semantic borderline matches via judgeRecallIris and ignores timeouts without throwing", async () => {
    const matcher = createLibraryRecallMatcher();

    // 1-signal match (unscoped entry with minSignals: 1, single label match)
    const oneSignalBase = buildLibraryEntryFromScript({
      name: "Fill invoice code",
      solution: "Fill Invoice Code.",
      script: {
        name: "Fill invoice code",
        steps: [
          {
            action: "fill",
            target: { kind: "aria", value: "Invoice Code" },
            value: "INV-900",
          },
        ],
      },
      status: "active",
      now: 1_000,
    });
    const oneSignalEntry: LibraryEntry = {
      ...oneSignalBase,
      eyes: {
        ...oneSignalBase.eyes,
        targetHints: {
          roles: [],
          labelContains: ["invoice code"],
          locators: [],
        },
        guards: {
          ...oneSignalBase.eyes.guards,
          minSignals: 1,
        },
      },
    };

    const evt = makeEvent({
      app: "unseen.local",
      url: "https://unseen.local/form",
      window: "Form",
      type: "focus",
      value: "",
      target: {
        locators: [{ kind: "css", value: "#inv-code" }],
        tag: "input",
        label: "Invoice Code",
      },
    });

    const syncMatch = matcher.matchEventsWithEvent([evt], [oneSignalEntry], 30_000);
    expect(syncMatch?.score).toBe(1);
    expect(syncMatch?.borderline).toBe(true);

    // Iris approves borderline match
    const approveFetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          model: "projects/test-proj/models/iris-latest",
          answers: { match: { noul: 0.92 } },
          usage: { inputTokens: 12, outputTokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const approved = await matcher.matchEventsWithIris([evt], [oneSignalEntry], {
      now: 30_000,
      irisOpts: { apiKey: "test-key", projectId: "test-proj", fetch: approveFetch },
    });
    expect(approveFetch).toHaveBeenCalledTimes(1);
    expect(approved?.entry.id).toBe(oneSignalEntry.id);

    // Iris rejects borderline match
    const rejectFetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          model: "projects/test-proj/models/iris-latest",
          answers: { match: { noul: 0.15 } },
          usage: { inputTokens: 12, outputTokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const rejected = await matcher.matchEventsWithIris([evt], [oneSignalEntry], {
      now: 30_000,
      irisOpts: { apiKey: "test-key", projectId: "test-proj", fetch: rejectFetch },
    });
    expect(rejectFetch).toHaveBeenCalledTimes(1);
    expect(rejected).toBeNull();

    // Timeout / null from Iris falls back cleanly to accepting the semantic match without throwing
    const hungTimers: ReturnType<typeof setTimeout>[] = [];
    const timeoutFetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("late")), 5_000);
          hungTimers.push(timer);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );

    const timedOutFallback = await matcher.matchEventsWithIris([evt], [oneSignalEntry], {
      now: 30_000,
      irisOpts: {
        apiKey: "test-key",
        projectId: "test-proj",
        timeoutMs: 25,
        fetch: timeoutFetch,
      },
    });
    for (const t of hungTimers) clearTimeout(t);
    expect(timeoutFetch).toHaveBeenCalledTimes(1);
    expect(timedOutFallback?.entry.id).toBe(oneSignalEntry.id);
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

    // Approving targets the concrete CSS locator (skipping aria) and does not lock out for 60s
    const pollRunPromise = fetch(`${baseUrl}/hands/next?waitMs=2000`);
    await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: decideCmd.id, ok: true, decision: "approved" }),
    });
    const runCmd = (await (await pollRunPromise).json()) as {
      id: string;
      script: LibraryEntry["script"];
    };
    expect(runCmd.script.steps).toEqual([
      {
        action: "insertText",
        value: snippet,
        target: { kind: "css", value: 'textarea[name="customer_reply"]' },
      },
    ]);
    await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: runCmd.id, ok: true, results: [{ ok: true }] }),
    });
  });
});
