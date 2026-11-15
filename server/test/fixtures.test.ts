import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventSchema, EventsSchema } from "@gen/shared/schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixtureEvents(filename: string) {
  const filePath = path.join(__dirname, "fixtures", filename);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line));
}

describe("email reply JSONL fixtures", () => {
  it("validates reply-x3.jsonl events against EventSchema and workflow expectations", async () => {
    const rawEvents = await loadFixtureEvents("reply-x3.jsonl");

    expect(rawEvents).toHaveLength(21);

    const parsedEvents = rawEvents.map((event) => EventSchema.parse(event));

    const sessions = new Set(parsedEvents.map((e) => e.session));
    expect(sessions.size).toBe(1);
    expect(sessions.has("sess_reply_x3")).toBe(true);

    const blurCommitInputEvents = parsedEvents.filter(
      (e) => e.type === "input" && e.meta?.subType === "blur_commit",
    );
    expect(blurCommitInputEvents).toHaveLength(3);

    for (let i = 1; i < parsedEvents.length; i++) {
      expect(parsedEvents[i].ts).toBeGreaterThan(parsedEvents[i - 1].ts);
    }
  });

  it("validates one-off.jsonl events against EventSchema and workflow expectations", async () => {
    const rawEvents = await loadFixtureEvents("one-off.jsonl");

    expect(rawEvents).toHaveLength(7);

    const parsedEvents = rawEvents.map((event) => EventSchema.parse(event));

    const sessions = new Set(parsedEvents.map((e) => e.session));
    expect(sessions.size).toBe(1);
    expect(sessions.has("sess_one_off")).toBe(true);

    const inputEvents = parsedEvents.filter((e) => e.type === "input");
    expect(inputEvents).toHaveLength(1);

    for (let i = 1; i < parsedEvents.length; i++) {
      expect(parsedEvents[i].ts).toBeGreaterThan(parsedEvents[i - 1].ts);
    }
  });

  it("validates invoice-x9.jsonl events against EventSchema and workflow expectations", async () => {
    const rawEvents = await loadFixtureEvents("invoice-x9.jsonl");
    const parsedEvents = rawEvents.map((event) => EventSchema.parse(event));

    const sessions = new Set(parsedEvents.map((e) => e.session));
    expect(sessions.size).toBe(1);
    expect(sessions.has("sess_invoice_x9")).toBe(true);

    for (let i = 1; i < parsedEvents.length; i++) {
      expect(parsedEvents[i].ts).toBeGreaterThan(parsedEvents[i - 1].ts);
    }

    const saveClicks = parsedEvents.filter(
      (e) => e.type === "click" && e.target?.label === "Save",
    );
    expect(saveClicks).toHaveLength(9);

    const strayClicks = parsedEvents.filter(
      (e) => e.type === "click" && e.target?.label === "Portal banner",
    );
    expect(strayClicks).toHaveLength(3);

    const copiedInvoiceIds = parsedEvents
      .filter(
        (e) =>
          e.type === "copy" &&
          e.target?.locators.some(
            (l) => l.kind === "testid" && l.value === "portal-invoice-id",
          ),
      )
      .map((e) => e.value ?? e.clipboard?.text);
    const pastedInvoiceIds = parsedEvents
      .filter(
        (e) =>
          e.type === "paste" &&
          e.target?.locators.some(
            (l) => l.kind === "testid" && l.value === "erp-invoice-id",
          ),
      )
      .map((e) => e.value ?? e.clipboard?.text);

    expect(copiedInvoiceIds).toHaveLength(9);
    expect(pastedInvoiceIds).toHaveLength(9);
    expect(new Set(copiedInvoiceIds).size).toBe(9);
    expect(pastedInvoiceIds).toEqual(copiedInvoiceIds);
  });

  it("validates routine-20-noisy.jsonl events against EventSchema and workflow expectations", async () => {
    const rawEvents = await loadFixtureEvents("routine-20-noisy.jsonl");
    const parsedEvents = rawEvents.map((event) => EventSchema.parse(event));

    const sessions = new Set(parsedEvents.map((e) => e.session));
    expect(sessions.size).toBe(1);
    expect(sessions.has("sess_routine_20_noisy")).toBe(true);

    for (let i = 1; i < parsedEvents.length; i++) {
      expect(parsedEvents[i].ts).toBeGreaterThan(parsedEvents[i - 1].ts);
    }

    const routineClicks = parsedEvents.filter(
      (e) =>
        e.type === "click" &&
        e.target?.role === "gridcell" &&
        e.target.locators.some(
          (l) => l.kind === "testid" && l.value.startsWith("routine-cell-"),
        ),
    );
    expect(routineClicks).toHaveLength(80);

    const step20Clicks = routineClicks.filter((e) =>
      e.target?.locators.some(
        (l) => l.kind === "testid" && l.value === "routine-cell-20",
      ),
    );
    expect(step20Clicks).toHaveLength(4);

    let repStartIdx = 0;
    for (const step20Click of step20Clicks) {
      const repEndIdx = parsedEvents.indexOf(step20Click);
      const repEvents = parsedEvents.slice(repStartIdx, repEndIdx + 1);
      const strayEvents = repEvents.filter(
        (e) =>
          e.type === "scroll" ||
          (e.type === "click" &&
            e.target?.locators.some(
              (l) => l.kind === "testid" && l.value === "stray-toolbar",
            )),
      );
      expect(strayEvents.length).toBeGreaterThanOrEqual(1);
      expect(strayEvents.length).toBeLessThanOrEqual(3);
      repStartIdx = repEndIdx + 1;
    }
  });

  it("validates dispute-x3.jsonl events against EventSchema and workflow expectations", async () => {
    const rawEvents = await loadFixtureEvents("dispute-x3.jsonl");
    const parsedEvents = rawEvents.map((event) => EventSchema.parse(event));

    const sessions = new Set(parsedEvents.map((e) => e.session));
    expect(sessions.size).toBe(1);
    expect(sessions.has("sess_dispute_x3")).toBe(true);

    for (let i = 1; i < parsedEvents.length; i++) {
      expect(parsedEvents[i].ts).toBeGreaterThan(parsedEvents[i - 1].ts);
    }

    const sendClicks = parsedEvents.filter(
      (e) => e.type === "click" && e.target?.label === "Send",
    );
    expect(sendClicks).toHaveLength(3);

    const inputEvents = parsedEvents.filter((e) => e.type === "input");
    expect(inputEvents).toHaveLength(3);

    const inputValues = inputEvents.map((e) => e.value ?? "");
    expect(new Set(inputValues).size).toBe(3);

    for (const ev of inputEvents) {
      expect((ev.value ?? "").length).toBeGreaterThanOrEqual(120);
      const typing = ev.meta?.typing as
        | { backspaceCount?: number; typingDurationMs?: number }
        | undefined;
      const backspaceCount =
        (ev.meta?.backspaceCount as number | undefined) ??
        typing?.backspaceCount ??
        0;
      const typingDurationMs =
        (ev.meta?.typingDurationMs as number | undefined) ??
        typing?.typingDurationMs ??
        0;
      expect(backspaceCount).toBeGreaterThanOrEqual(15);
      expect(typingDurationMs).toBeGreaterThan(0);
    }
  });

  it("validates crosstab-x3.jsonl and crosstab-x3-split.jsonl against EventSchema", async () => {
    const singleEvents = await loadFixtureEvents("crosstab-x3.jsonl");
    const splitEvents = await loadFixtureEvents("crosstab-x3-split.jsonl");

    expect(singleEvents).toHaveLength(32);
    expect(splitEvents).toHaveLength(32);

    const parsedSingle = singleEvents.map((e) => EventSchema.parse(e));
    const parsedSplit = splitEvents.map((e) => EventSchema.parse(e));

    expect(new Set(parsedSingle.map((e) => e.session))).toEqual(
      new Set(["sess_crosstab_x3"]),
    );
    expect(new Set(parsedSplit.map((e) => e.session))).toEqual(
      new Set(["sess_portal_tab", "sess_erp_tab", "sess_browser"]),
    );

    for (let i = 1; i < parsedSplit.length; i++) {
      expect(parsedSplit[i].ts).toBeGreaterThan(parsedSplit[i - 1].ts);
    }
  });
});

describe("unseen-sheet-loop fixture and sheet.html demo", () => {
  it("validates unseen-sheet-loop.jsonl against EventsSchema with >= 3 cycles and compact pageSummary", async () => {
    const rawEvents = await loadFixtureEvents("unseen-sheet-loop.jsonl");
    const parsedEvents = EventsSchema.parse(rawEvents);

    expect(parsedEvents.length).toBeGreaterThan(0);

    const sessions = new Set(parsedEvents.map((e) => e.session));
    expect(sessions.size).toBe(1);

    for (const ev of parsedEvents) {
      expect(ev.v).toBe(1);
      expect(ev.source).toBe("browser");
      if (ev.meta && "pageSummary" in ev.meta && ev.meta.pageSummary !== undefined) {
        const bytes = Buffer.byteLength(JSON.stringify(ev.meta.pageSummary), "utf8");
        expect(bytes).toBeLessThanOrEqual(4096);
      }
    }

    for (let i = 1; i < parsedEvents.length; i++) {
      expect(parsedEvents[i].ts).toBeGreaterThan(parsedEvents[i - 1].ts);
    }

    const withPageSummary = parsedEvents.filter(
      (e) => e.meta && "pageSummary" in e.meta && e.meta.pageSummary !== undefined,
    );
    expect(withPageSummary.length).toBeGreaterThan(0);

    const copyEvents = parsedEvents.filter((e) => e.type === "copy");
    const pasteEvents = parsedEvents.filter(
      (e) =>
        e.type === "paste" &&
        e.target?.locators.some(
          (l) => l.kind === "testid" && l.value === "client-value-input",
        ),
    );
    const saveClicks = parsedEvents.filter(
      (e) =>
        e.type === "click" &&
        e.target?.locators.some(
          (l) => l.kind === "testid" && l.value === "save-client-btn",
        ),
    );
    const backClicks = parsedEvents.filter(
      (e) =>
        e.type === "click" &&
        e.target?.locators.some(
          (l) => l.kind === "testid" && l.value === "back-to-list-btn",
        ),
    );

    expect(copyEvents.length).toBeGreaterThanOrEqual(3);
    expect(pasteEvents.length).toBeGreaterThanOrEqual(3);
    expect(saveClicks.length).toBeGreaterThanOrEqual(3);
    expect(backClicks.length).toBeGreaterThanOrEqual(3);

    const copiedValues = copyEvents.map((e) => e.value ?? e.clipboard?.text);
    const pastedValues = pasteEvents.map((e) => e.value ?? e.clipboard?.text);
    expect(new Set(copiedValues).size).toBeGreaterThanOrEqual(3);
    expect(pastedValues).toEqual(copiedValues);
  });

  it("serves GET /sheet.html from apps/demo with client list, detail view, and sheet table testids", async () => {
    const staticServerUrl = new URL("../../scripts/lib/static-server.mjs", import.meta.url).href;
    const { startDemoServer } = (await import(staticServerUrl)) as {
      startDemoServer: (opts: { dir: string; port: number }) => Promise<{
        port: number;
        url: string;
        close: () => Promise<void>;
      }>;
    };

    const demoServer = await startDemoServer({ dir: "apps/demo", port: 0 });
    try {
      const response = await fetch(`${demoServer.url}sheet.html`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");

      const html = await response.text();
      for (const testid of [
        "tab-clients",
        "tab-sheet",
        "client-list",
        "client-detail",
        "client-value-input",
        "save-client-btn",
        "back-to-list-btn",
        "sheet-table",
      ]) {
        expect(html).toContain(`data-testid="${testid}"`);
      }
    } finally {
      await demoServer.close();
    }
  });
});
