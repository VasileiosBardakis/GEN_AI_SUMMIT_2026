import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Finding, Report, Step, Workflow } from "@gen/shared";
import { EventSchema } from "@gen/shared/schema.ts";
import { extractTarget } from "../../extension/src/locators.ts";
import { createServer } from "../src/app.ts";
import type { ActionScript } from "../src/hands/types.ts";
import type { GeminiSdk } from "../src/llm/gemini.ts";
import { buildSolutionText, filterNoisySteps } from "../src/pipeline.ts";
import { createProposer } from "../src/propose.ts";

function buildCrossTabRowIndexedEvents(): Event[] {
  const rows = [
    {
      idx: 1,
      invoiceId: "INV-2026-001",
      vendor: "Acme Industrial",
      amount: "1250.00",
      date: "2026-02-01",
    },
    {
      idx: 2,
      invoiceId: "INV-2026-002",
      vendor: "Acme Industrial",
      amount: "3480.50",
      date: "2026-02-03",
    },
    {
      idx: 3,
      invoiceId: "INV-2026-003",
      vendor: "Initech LLC",
      amount: "920.75",
      date: "2026-02-05",
    },
  ];

  const events: Event[] = [];
  let ts = 1_740_000_200_000;
  let seq = 1;
  const nextId = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;

  for (const row of rows) {
    const portalFields = [
      { testid: `portal-invoice-id-${row.idx}`, label: "Invoice ID", value: row.invoiceId },
      { testid: `portal-vendor-${row.idx}`, label: "Vendor", value: row.vendor },
      { testid: `portal-amount-${row.idx}`, label: "Amount", value: row.amount },
      { testid: `portal-date-${row.idx}`, label: "Date", value: row.date },
    ];

    for (const f of portalFields) {
      events.push(
        EventSchema.parse({
          v: 1,
          id: nextId(),
          ts: (ts += 1000),
          session: "sess_portal_rows",
          source: "browser",
          app: "portal.local",
          window: "Supplier Portal",
          url: "http://portal.local:5173/portal",
          type: "copy",
          target: {
            tag: "span",
            label: f.label,
            locators: [
              { kind: "testid", value: f.testid },
              { kind: "css", value: `span[data-testid="${f.testid}"]` },
            ],
          },
          value: f.value,
          clipboard: {
            fromApp: "portal.local",
            fromUrl: "http://portal.local:5173/portal",
            text: f.value,
          },
          meta: { tabId: 101 },
        }),
      );
    }

    events.push(
      EventSchema.parse({
        v: 1,
        id: nextId(),
        ts: (ts += 1000),
        session: "sess_browser_rows",
        source: "browser",
        app: "erp.local",
        window: "ERP System",
        url: "http://erp.local:5173/erp",
        type: "tab_switch",
        meta: {
          tabId: 202,
          subType: "cross_app_switch",
          fromApp: "portal.local",
          toApp: "erp.local",
        },
      }),
    );

    const erpFields = [
      { testid: "erp-invoice-id", label: "Invoice ID", value: row.invoiceId },
      { testid: "erp-vendor", label: "Vendor", value: row.vendor },
      { testid: "erp-amount", label: "Amount", value: row.amount },
      { testid: "erp-date", label: "Date", value: row.date },
    ];

    for (const f of erpFields) {
      events.push(
        EventSchema.parse({
          v: 1,
          id: nextId(),
          ts: (ts += 1000),
          session: "sess_erp_rows",
          source: "browser",
          app: "erp.local",
          window: "ERP System",
          url: "http://erp.local:5173/erp",
          type: "paste",
          target: {
            tag: "input",
            role: "textbox",
            label: f.label,
            locators: [
              { kind: "testid", value: f.testid },
              { kind: "css", value: `input[data-testid="${f.testid}"]` },
            ],
          },
          value: f.value,
          clipboard: {
            fromApp: "portal.local",
            toApp: "erp.local",
            fromUrl: "http://portal.local:5173/portal",
            text: f.value,
          },
          meta: { tabId: 202 },
        }),
      );
    }

    events.push(
      EventSchema.parse({
        v: 1,
        id: nextId(),
        ts: (ts += 1000),
        session: "sess_erp_rows",
        source: "browser",
        app: "erp.local",
        window: "ERP System",
        url: "http://erp.local:5173/erp",
        type: "click",
        target: {
          tag: "button",
          role: "button",
          label: "Save",
          locators: [
            { kind: "testid", value: "save-btn" },
            { kind: "text", value: "Save" },
          ],
        },
        meta: { tabId: 202 },
      }),
    );

    if (row.idx < rows.length) {
      events.push(
        EventSchema.parse({
          v: 1,
          id: nextId(),
          ts: (ts += 1000),
          session: "sess_browser_rows",
          source: "browser",
          app: "portal.local",
          window: "Supplier Portal",
          url: "http://portal.local:5173/portal",
          type: "tab_switch",
          meta: {
            tabId: 101,
            subType: "cross_app_switch",
            fromApp: "erp.local",
            toApp: "portal.local",
          },
        }),
      );
    }
  }

  return events;
}

describe("GEN-61 cross-tab row-indexed workflow detection, prioritization, switchTab, and Text target capture", () => {
  let rootDir: string;
  let server: http.Server;
  let baseUrl: string;
  let capturedSolutions: string[];
  let fakeImplement: ReturnType<
    typeof vi.fn<(solution: string, opts?: { name?: string }) => Promise<ActionScript>>
  >;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "gen-crosstab-rowids-"));
    capturedSolutions = [];
    fakeImplement = vi.fn(async (solution: string, opts?: { name?: string }) => {
      capturedSolutions.push(solution);
      if (solution.includes("readText")) {
        return {
          name: opts?.name ?? "Copy 4 fields from portal.local to erp.local",
          steps: [
            { action: "switchTab", host: "portal.local" },
            {
              action: "readText",
              target: { kind: "testid", value: "portal-invoice-id-1" },
              bind: "portal_invoice_id",
            },
            {
              action: "readText",
              target: { kind: "testid", value: "portal-vendor-1" },
              bind: "portal_vendor",
            },
            { action: "switchTab", host: "erp.local" },
            {
              action: "fill",
              target: { kind: "testid", value: "erp-invoice-id" },
              value: "{{portal_invoice_id}}",
            },
            {
              action: "fill",
              target: { kind: "testid", value: "erp-vendor" },
              value: "{{portal_vendor}}",
            },
            {
              action: "click",
              target: { kind: "testid", value: "save-btn" },
            },
          ],
        };
      }
      return {
        name: opts?.name ?? "Short value fill",
        steps: [
          {
            action: "fill",
            target: { kind: "testid", value: "erp-vendor" },
            value: "Acme Industrial",
          },
        ],
      };
    });

    const fakeGemini: GeminiSdk = {
      models: {
        generateContent: vi.fn(async () => ({
          text: JSON.stringify({
            verdict: "rung2",
            confidence: 0.9,
            risky: false,
          }),
        })),
      },
    };

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    server = createServer({
      tracesDir: path.join(rootDir, "traces"),
      dataDir: path.join(rootDir, "data"),
      gemini: { sdk: fakeGemini },
      implement: fakeImplement,
      autoPropose: true,
      proposeDebounceMs: 0,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(rootDir, { recursive: true, force: true });
  });

  it("posts 3-repeat row-indexed portal-to-ERP trace, produces one wf_* finding queued before any short_*, and emits leading switchTab", async () => {
    const events = buildCrossTabRowIndexedEvents();

    const postRes = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    });
    expect(postRes.status).toBe(200);

    const nextDecide = await fetch(`${baseUrl}/hands/next?waitMs=2000`);
    expect(nextDecide.status).toBe(200);
    const decideCmd = (await nextDecide.json()) as {
      ok: boolean;
      id: string;
      kind: string;
      name: string;
      solution: string;
      script: ActionScript;
    };
    expect(decideCmd.ok).toBe(true);
    expect(decideCmd.kind).toBe("decide");
    expect(decideCmd.name).toBe("Copy 4 fields from portal.local to erp.local");
    expect(decideCmd.script.steps.some((s) => s.action === "readText")).toBe(true);
    expect(
      decideCmd.script.steps.some((s) => s.action === "fill" || s.action === "insertText"),
    ).toBe(true);

    // Dismiss the wf_* proposal and confirm the covered short_* (erp-vendor) is NOT queued
    const dismissRes = await fetch(`${baseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: decideCmd.id, ok: true, decision: "dismissed" }),
    });
    expect(dismissRes.status).toBe(200);

    const noCoveredShort = await fetch(`${baseUrl}/hands/next?waitMs=80`);
    expect(noCoveredShort.status).toBe(204);

    // Check report findings and generated solution text
    const reportRes = await fetch(`${baseUrl}/report`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as Report;

    const wfFindings = report.findings.filter((f) => f.id.startsWith("wf_"));
    expect(wfFindings).toHaveLength(1);
    expect(wfFindings[0].verdict).toBe("rung2");
    expect(wfFindings[0].title).toBe("Copy 4 fields from portal.local to erp.local");
    expect(report.findings.some((f) => f.id.startsWith("short_"))).toBe(true);

    expect(capturedSolutions.length).toBeGreaterThanOrEqual(1);
    const wfSolution = capturedSolutions.find((s) => s.includes("readText"));
    expect(wfSolution).toBeDefined();
    const lines = wfSolution!.split("\n");
    const firstStepIdx = lines.findIndex((l) => l.startsWith('1. switchTab host="portal.local"'));
    const firstReadIdx = lines.findIndex((l) => /^\d+\.\s+readText\s/.test(l));
    const secondSwitchIdx = lines.findIndex((l) => l.includes('switchTab host="erp.local"'));
    const firstFillIdx = lines.findIndex((l) => /^\d+\.\s+fill\s/.test(l));
    expect(firstStepIdx).toBeGreaterThan(0);
    expect(firstReadIdx).toBeGreaterThan(firstStepIdx);
    expect(secondSwitchIdx).toBeGreaterThan(firstReadIdx);
    expect(firstFillIdx).toBeGreaterThan(secondSwitchIdx);
  });

  it("buildSolutionText starts with switchTab host=<sourceApp> before the first readText", () => {
    const wf: Workflow = {
      id: "wf_row_test",
      name: "portal.local -> erp.local (3 steps)",
      sourceApp: "portal.local",
      destApp: "erp.local",
      steps: [
        {
          action: "copy",
          target: [{ kind: "testid", value: "portal-invoice-id-1" }],
          value: { param: "portal_invoice_id" },
        },
        {
          action: "paste",
          target: [{ kind: "testid", value: "erp-invoice-id" }],
          value: { param: "portal_invoice_id" },
        },
        {
          action: "click",
          target: [{ kind: "testid", value: "save-btn" }],
        },
      ],
      params: [{ name: "portal_invoice_id", example: "INV-2026-001" }],
      instances: [],
    };

    const solution = buildSolutionText("rung2", wf);
    expect(solution).not.toBeNull();
    const lines = solution!.split("\n");
    expect(lines[1]).toBe('1. switchTab host="portal.local"');
    expect(lines[2]).toBe(
      '2. readText from testid="portal-invoice-id-1" into "{{portal_invoice_id}}"',
    );
    expect(lines[3]).toBe('3. switchTab host="erp.local"');
    expect(lines[4]).toBe('4. fill testid="erp-invoice-id" with "{{portal_invoice_id}}"');
  });

  it("filterNoisySteps never drops copy/paste steps and normalizes trailing numeric row suffixes", () => {
    const steps: Step[] = [1, 2, 3].flatMap((row) => [
      ...(row === 2
        ? [{ action: "click" as const, target: [{ kind: "testid" as const, value: "stray-btn" }] }]
        : []),
      {
        action: "copy" as const,
        target: [{ kind: "testid" as const, value: `portal-invoice-id-${row}` }],
        value: `INV-${row}`,
      },
      {
        action: "copy" as const,
        target: [{ kind: "testid" as const, value: `portal_vendor_${row}` }],
        value: `Vendor ${row}`,
      },
      {
        action: "paste" as const,
        target: [{ kind: "testid" as const, value: "erp-invoice-id" }],
        value: `INV-${row}`,
      },
      {
        action: "submit" as const,
        target: [{ kind: "testid" as const, value: "erp-form" }],
      },
    ]);

    const { filteredSteps } = filterNoisySteps(steps);
    expect(
      filteredSteps.some((s) => s.target?.some((loc) => loc.value === "stray-btn")),
    ).toBe(false);
    expect(filteredSteps.filter((s) => s.action === "copy")).toHaveLength(3 * 2);
    expect(filteredSteps.filter((s) => s.action === "paste")).toHaveLength(3);
  });

  it("createProposer proposes wf_* before short_* and skips short_* covered by copy/paste wf_*", async () => {
    const proposedOrder: string[] = [];
    const coveredShort: Finding = {
      id: "short_vendor",
      verdict: "rung1",
      title: "Same erp-vendor typed 2 times in erp-vendor fields",
      why: "Repeated value.",
      whyNotNext: "Snippet.",
      stats: { repetitions: 2, minutesPerWeek: 0, stability: 1 },
    };
    const unrelatedShort: Finding = {
      id: "short_notes",
      verdict: "rung1",
      title: "Same notes-box typed 2 times in notes-box fields",
      why: "Repeated notes.",
      whyNotNext: "Snippet.",
      stats: { repetitions: 2, minutesPerWeek: 0, stability: 1 },
    };
    const wfFinding: Finding = {
      id: "wf_crosstab",
      workflowId: "wf_crosstab",
      verdict: "rung2",
      title: "Copy 2 fields from portal.local to erp.local",
      why: "Observed 3 repetitions.",
      whyNotNext: "Script.",
      stats: { repetitions: 3, minutesPerWeek: 1, stability: 1 },
    };

    const scripts = new Map<string, ActionScript>([
      [
        "short_vendor",
        {
          name: "Covered short",
          steps: [
            {
              action: "fill",
              target: { kind: "testid", value: "erp-vendor" },
              value: "Acme Industrial",
            },
          ],
        },
      ],
      [
        "short_notes",
        {
          name: "Unrelated short",
          steps: [
            {
              action: "fill",
              target: { kind: "testid", value: "notes-box" },
              value: "Approved",
            },
          ],
        },
      ],
      [
        "wf_crosstab",
        {
          name: "Copy 2 fields from portal.local to erp.local",
          steps: [
            { action: "switchTab", host: "portal.local" },
            {
              action: "readText",
              target: { kind: "testid", value: "portal-vendor-1" },
              bind: "portal_vendor",
            },
            { action: "switchTab", host: "erp.local" },
            {
              action: "fill",
              target: { kind: "testid", value: "erp-vendor" },
              value: "{{portal_vendor}}",
            },
          ],
        },
      ],
    ]);

    const proposer = createProposer({
      runReport: async () => ({
        findings: [coveredShort, unrelatedShort, wfFinding],
        scripts,
      }),
      requestDecision: async (name) => {
        proposedOrder.push(name);
        return { ok: true, decision: "dismissed" };
      },
      runScript: async () => ({ ok: true }),
      debounceMs: 0,
      log: () => {},
    });

    proposer.onEvents("sess-order");
    await vi.waitFor(() => {
      expect(proposedOrder).toEqual([
        "Copy 2 fields from portal.local to erp.local",
        "Same notes-box typed 2 times in notes-box fields",
      ]);
    });
    proposer.close();
  });

  it("extractTarget on a Text node returns its parentElement locators", () => {
    const prevNode = (globalThis as Record<string, unknown>).Node;
    const prevHtmlEl = (globalThis as Record<string, unknown>).HTMLElement;

    class MockNode {
      parentElement: MockHTMLElement | null = null;
    }
    class MockHTMLElement extends MockNode {
      nodeType = 1;
      tagName: string;
      id = "";
      classList: string[] = [];
      innerText: string;
      textContent: string;
      isContentEditable = false;
      private attrs: Record<string, string>;

      constructor(tagName: string, attrs: Record<string, string>, text: string) {
        super();
        this.tagName = tagName.toUpperCase();
        this.attrs = attrs;
        this.id = attrs.id ?? "";
        this.innerText = text;
        this.textContent = text;
      }

      getAttribute(name: string): string | null {
        return this.attrs[name] ?? null;
      }

      closest(selector: string): MockHTMLElement | null {
        if (selector.includes("[data-testid]") && this.attrs["data-testid"]) {
          return this;
        }
        return null;
      }
    }

    (globalThis as Record<string, unknown>).Node = MockNode;
    (globalThis as Record<string, unknown>).HTMLElement = MockHTMLElement;

    try {
      const span = new MockHTMLElement(
        "span",
        { id: "portal-invoice-id-1", "data-testid": "portal-invoice-id-1" },
        "INV-2026-001",
      );
      const textNode = new MockNode();
      textNode.parentElement = span;

      const result = extractTarget(textNode as unknown as EventTarget);
      expect(result.element).toBe(span);
      expect(result.target).toBeDefined();
      expect(result.target?.tag).toBe("span");
      expect(result.target?.locators).toEqual([
        { kind: "testid", value: "portal-invoice-id-1" },
        { kind: "css", value: "#portal-invoice-id-1" },
      ]);
    } finally {
      if (prevNode === undefined) {
        delete (globalThis as Record<string, unknown>).Node;
      } else {
        (globalThis as Record<string, unknown>).Node = prevNode;
      }
      if (prevHtmlEl === undefined) {
        delete (globalThis as Record<string, unknown>).HTMLElement;
      } else {
        (globalThis as Record<string, unknown>).HTMLElement = prevHtmlEl;
      }
    }
  });
});
