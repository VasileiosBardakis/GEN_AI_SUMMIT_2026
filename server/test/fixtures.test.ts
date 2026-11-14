import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventSchema } from "@gen/shared/schema.ts";

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
});
