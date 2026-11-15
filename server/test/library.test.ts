import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Step, Workflow } from "@gen/shared";
import {
  DEFAULT_LIBRARY_CONFIG,
  loadLibrary,
  matchLibrary,
  normalizedEditDistance,
  signature,
  type LibraryEntry,
} from "../src/library.ts";
import {
  buildLibraryEntryFromScript,
  buildStartSignature,
  formatStartSignature,
} from "../src/hands/implementor.ts";
import {
  dedupeLibraryEntries,
  readLibrary,
  upsertLibraryEntry,
} from "../src/hands/library.ts";

function makeSteps(count: number, overrides?: Partial<Record<number, Step>>): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < count; i++) {
    if (overrides?.[i]) {
      steps.push(overrides[i]!);
    } else {
      steps.push({
        action: i % 2 === 0 ? "fill" : "click",
        target: [{ kind: "testid", value: `field-${i}` }],
        value: i % 2 === 0 ? `literal-value-${i}` : undefined,
      });
    }
  }
  return steps;
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    name: "Test Workflow",
    sourceApp: "crm.example.com",
    destApp: "crm.example.com",
    steps: makeSteps(10),
    params: [{ name: "customer", example: "Acme Secret Corp" }],
    instances: [
      {
        startTs: 1000,
        endTs: 2000,
        bindings: { customer: "Secret Binding Value" },
      },
    ],
    ...overrides,
  };
}

describe("signature & normalizedEditDistance", () => {
  it("emits action:locatorKind entries and host, and excludes literal step.value, params[].example, and instances[].bindings", () => {
    const wfSameApp = makeWorkflow({
      sourceApp: "crm.example.com",
      destApp: "crm.example.com",
      steps: [
        { action: "nav" },
        {
          action: "fill",
          target: [{ kind: "aria", value: "Email" }],
          value: "sensitive-user@example.com",
        },
        {
          action: "click",
          target: [{ kind: "testid", value: "save-btn" }, { kind: "css", value: ".btn" }],
        },
        {
          action: "paste",
          target: [],
          value: { param: "customer" },
        },
        {
          action: "submit",
          target: [{ kind: "css", value: "form" }],
        },
      ],
      params: [{ name: "customer", example: "TOP_SECRET_EXAMPLE" }],
      instances: [
        {
          startTs: 10,
          endTs: 20,
          bindings: { customer: "TOP_SECRET_BINDING" },
        },
      ],
    });

    const sigSame = signature(wfSameApp);
    expect(sigSame).toEqual({
      host: "crm.example.com",
      steps: [
        "nav:none",
        "fill:aria",
        "click:testid",
        "paste:none",
        "submit:css",
      ],
    });

    const serialized = JSON.stringify(sigSame);
    expect(serialized).not.toContain("sensitive-user@example.com");
    expect(serialized).not.toContain("TOP_SECRET_EXAMPLE");
    expect(serialized).not.toContain("TOP_SECRET_BINDING");
    expect(serialized).not.toContain("save-btn");

    const wfCrossApp = makeWorkflow({
      sourceApp: "sheets.example.com",
      destApp: "erp.example.com",
    });
    expect(signature(wfCrossApp).host).toBe("sheets.example.com->erp.example.com");

    const wfNoDest = makeWorkflow({
      sourceApp: "sheets.example.com",
      destApp: "",
    });
    expect(signature(wfNoDest).host).toBe("sheets.example.com");
  });

  it("computes normalizedEditDistance for host mismatches, empty steps, and edits", () => {
    expect(
      normalizedEditDistance(
        { host: "a.com", steps: ["click:css"] },
        { host: "b.com", steps: ["click:css"] },
      ),
    ).toBe(1);

    expect(
      normalizedEditDistance(
        { host: "a.com", steps: [] },
        { host: "a.com", steps: [] },
      ),
    ).toBe(0);

    expect(
      normalizedEditDistance(
        { host: "a.com", steps: ["click:css", "fill:aria"] },
        { host: "a.com", steps: ["click:css", "submit:css"] },
      ),
    ).toBe(0.5);
  });
});

describe("loadLibrary & matchLibrary", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gen-library-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("loadLibrary returns [] when library.json is missing, and returns parsed LibraryEntry[] when present", async () => {
    const dataDir = await makeTempDir();

    const missing = await loadLibrary({ dataDir });
    expect(missing).toEqual([]);

    const entries: LibraryEntry[] = [
      {
        id: "entry-1",
        signature: signature(makeWorkflow()),
        name: "Sync CRM Contact",
        solution: "Fill contact fields and click save.",
        script: {
          name: "Sync CRM Contact",
          steps: [{ action: "click", target: { kind: "testid", value: "save" } }],
        },
      },
    ];
    await writeFile(
      path.join(dataDir, DEFAULT_LIBRARY_CONFIG.filename),
      JSON.stringify(entries),
      "utf8",
    );

    const loaded = await loadLibrary({ dataDir });
    expect(loaded).toEqual(entries);
  });

  it("matchLibrary returns { kind: 'none', distance: 1 } on empty or missing store", async () => {
    const dataDir = await makeTempDir();
    const wf = makeWorkflow();

    const missingResult = await matchLibrary(wf, { dataDir });
    expect(missingResult).toEqual({ kind: "none", distance: 1 });
    expect("entry" in missingResult).toBe(false);

    await writeFile(path.join(dataDir, "library.json"), "[]", "utf8");
    const emptyResult = await matchLibrary(wf, { dataDir });
    expect(emptyResult).toEqual({ kind: "none", distance: 1 });
    expect("entry" in emptyResult).toBe(false);
  });

  it("matchLibrary classifies exact, 1-of-10 match, 2-of-10 borderline, 5-of-10 none, and host mismatch", async () => {
    const dataDir = await makeTempDir();
    const baseWf = makeWorkflow({ steps: makeSteps(10) });
    const entry: LibraryEntry = {
      id: "lib-base",
      signature: signature(baseWf),
      name: "Base Workflow",
      solution: "Run base workflow steps",
    };
    await writeFile(
      path.join(dataDir, "library.json"),
      JSON.stringify([entry]),
      "utf8",
    );

    // Exact match: distance === 0 -> match
    const exactRes = await matchLibrary(baseWf, { dataDir });
    expect(exactRes).toEqual({ kind: "match", entry, distance: 0 });

    // 1-of-10 edit: distance === 0.1 <= 0.15 -> match
    const oneEditWf = makeWorkflow({
      steps: makeSteps(10, {
        0: { action: "nav" },
      }),
    });
    const oneEditRes = await matchLibrary(oneEditWf, { dataDir });
    expect(oneEditRes.kind).toBe("match");
    expect(oneEditRes.entry).toEqual(entry);
    expect(oneEditRes.distance).toBeCloseTo(0.1);

    // 2-of-10 edits: distance === 0.2 (between 0.15 and 0.35) -> borderline
    const twoEditsWf = makeWorkflow({
      steps: makeSteps(10, {
        0: { action: "nav" },
        1: { action: "submit" },
      }),
    });
    const twoEditsRes = await matchLibrary(twoEditsWf, { dataDir });
    expect(twoEditsRes.kind).toBe("borderline");
    expect(twoEditsRes.entry).toEqual(entry);
    expect(twoEditsRes.distance).toBeCloseTo(0.2);

    // 5-of-10 edits: distance === 0.5 > 0.35 -> none (omitting entry)
    const fiveEditsWf = makeWorkflow({
      steps: makeSteps(10, {
        0: { action: "nav" },
        1: { action: "submit" },
        2: { action: "copy" },
        3: { action: "paste" },
        4: { action: "submit" },
      }),
    });
    const fiveEditsRes = await matchLibrary(fiveEditsWf, { dataDir });
    expect(fiveEditsRes).toEqual({ kind: "none", distance: 0.5 });
    expect("entry" in fiveEditsRes).toBe(false);

    // Host mismatch: distance === 1 -> none (omitting entry)
    const otherHostWf = makeWorkflow({
      sourceApp: "other.example.com",
      destApp: "other.example.com",
      steps: makeSteps(10),
    });
    const hostMismatchRes = await matchLibrary(otherHostWf, { dataDir });
    expect(hostMismatchRes).toEqual({ kind: "none", distance: 1 });
    expect("entry" in hostMismatchRes).toBe(false);
  });

  it("allows opts.config to override matchMaxDistance and borderlineMaxDistance", async () => {
    const dataDir = await makeTempDir();
    const baseWf = makeWorkflow({ steps: makeSteps(10) });
    const entry: LibraryEntry = {
      id: "lib-base",
      signature: signature(baseWf),
      name: "Base Workflow",
      solution: "Run base workflow steps",
    };
    await writeFile(
      path.join(dataDir, "library.json"),
      JSON.stringify([entry]),
      "utf8",
    );

    // 2-of-10 edits => distance 0.2
    const twoEditsWf = makeWorkflow({
      steps: makeSteps(10, {
        0: { action: "nav" },
        1: { action: "submit" },
      }),
    });

    // Raise matchMaxDistance to 0.25 -> promoted to "match"
    const promoted = await matchLibrary(twoEditsWf, {
      dataDir,
      config: { matchMaxDistance: 0.25, borderlineMaxDistance: 0.5 },
    });
    expect(promoted).toEqual({ kind: "match", entry, distance: 0.2 });

    // Lower thresholds -> demoted to "none"
    const demoted = await matchLibrary(twoEditsWf, {
      dataDir,
      config: { matchMaxDistance: 0.05, borderlineMaxDistance: 0.15 },
    });
    expect(demoted).toEqual({ kind: "none", distance: 0.2 });
    expect("entry" in demoted).toBe(false);
  });

  it("matches Hands LibraryEntry objects stored with eyes + script and no signature field", async () => {
    const dataDir = await makeTempDir();
    const handsEntry = {
      id: "lib_hands_wf",
      name: "Fill supplier form",
      kind: "workflow",
      status: "active",
      solution: "Fill company and click save",
      script: {
        name: "Fill supplier form",
        steps: [
          { action: "fill", target: { kind: "testid", value: "company" }, value: "Acme" },
          { action: "click", target: { kind: "testid", value: "save" } },
        ],
      },
      eyes: {
        scope: { apps: ["crm.example.com"], urlPatterns: [], pageHints: [] },
        targetHints: { roles: [], labelContains: [], locators: [] },
        textHints: { prefixHints: [], minCharsBeforeMatch: 2 },
        guards: { requireClipboard: false, fieldEmptyOnly: false, minSignals: 1, cooldownMs: 5000 },
      },
      runCount: 1,
      createdAt: 1000,
      updatedAt: 1000,
    };
    await writeFile(path.join(dataDir, "library.json"), JSON.stringify([handsEntry]), "utf8");

    const wf = makeWorkflow({
      sourceApp: "crm.example.com",
      destApp: "crm.example.com",
      steps: [
        { action: "fill", target: [{ kind: "testid", value: "company" }], value: "Globex" },
        { action: "click", target: [{ kind: "testid", value: "save" }] },
      ],
    });
    const res = await matchLibrary(wf, { dataDir });
    expect(res.kind).toBe("match");
    expect(res.distance).toBe(0);
    expect(res.entry?.id).toBe("lib_hands_wf");
  });

  it("upsertLibraryEntry deduplicates snippets by normalized insertText and preserves/merges field locators and labels", async () => {
    const dataDir = await makeTempDir();

    const firstSnippet = buildLibraryEntryFromScript({
      name: "Shipping reply v1",
      solution: "Insert shipping reply into customer reply box.",
      kind: "snippet",
      script: {
        name: "Shipping reply v1",
        steps: [
          {
            action: "insertText",
            value: "Hi,   thanks for your order.  It ships Friday.",
          },
        ],
      },
      context: {
        app: "support.local",
        url: "http://support.local/tickets/12",
        targetLabel: "Reply to customer",
        targetRole: "textbox",
        locators: [{ kind: "css", value: 'textarea[name="customer_reply"]' }],
      },
      status: "active",
      now: 1_000,
    });

    const savedFirst = await upsertLibraryEntry(dataDir, firstSnippet);
    expect(savedFirst.items).toHaveLength(1);

    const secondSnippet = buildLibraryEntryFromScript({
      name: "Shipping reply v2",
      solution: "Insert the same reply into backup notes field.",
      kind: "snippet",
      script: {
        name: "Shipping reply v2",
        steps: [
          {
            action: "insertText",
            value: "  hi, thanks for your order. it ships friday. ",
          },
        ],
      },
      context: {
        app: "crm.local",
        url: "http://crm.local/cases/99",
        targetLabel: "Agent Notes",
        targetRole: "textbox",
        locators: [{ kind: "testid", value: "agent-notes-input" }],
      },
      status: "active",
      now: 2_000,
    });

    expect(secondSnippet.id).not.toBe(firstSnippet.id);

    const savedSecond = await upsertLibraryEntry(dataDir, secondSnippet);
    expect(savedSecond.items).toHaveLength(1);
    expect(savedSecond.entry.id).toBe(firstSnippet.id);
    expect(savedSecond.entry.createdAt).toBe(1_000);
    expect(savedSecond.entry.updatedAt).toBe(2_000);
    expect(savedSecond.entry.eyes.scope.apps).toEqual(["support.local", "crm.local"]);
    expect(savedSecond.entry.eyes.scope.urlPatterns).toEqual(["/tickets/*", "/cases/*"]);
    expect(savedSecond.entry.eyes.targetHints.locators).toEqual([
      { kind: "css", value: 'textarea[name="customer_reply"]' },
      { kind: "testid", value: "agent-notes-input" },
    ]);
    expect(savedSecond.entry.eyes.targetHints.labelContains).toContain("reply to customer");
    expect(savedSecond.entry.eyes.targetHints.labelContains).toContain("agent notes");

    const reloaded = await readLibrary(dataDir);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe(firstSnippet.id);
  });

  it("upsertLibraryEntry reuses existing entry across rephrased solution, omitted pre-fill click, and added trailing save step", async () => {
    const dataDir = await makeTempDir();

    const first = buildLibraryEntryFromScript({
      name: "Fill Company Name and Owner Email",
      solution: "Automates entering company details into the form.",
      status: "active",
      context: { app: "127.0.0.1", url: "http://127.0.0.1:5173/" },
      script: {
        name: "Fill Company Name and Owner Email",
        steps: [
          { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:5173/" },
          { action: "click", target: { kind: "css", value: 'input[name="company_name"]' } },
          { action: "fill", target: { kind: "css", value: 'input[name="company_name"]' }, value: "{{companyName}}" },
          { action: "fill", target: { kind: "css", value: 'input[name="owner_email"]' }, value: "{{ownerEmail}}" },
        ],
      },
      now: 1000,
    });
    const firstSaved = await upsertLibraryEntry(dataDir, {
      ...first,
      startSignature: formatStartSignature(buildStartSignature(first.script, { app: "127.0.0.1" })),
      runCount: 2,
      stats: { repetitions: 2, stepCount: 4, manualSeconds: 8.37, replaySeconds: 0, timeSavedSeconds: 8.37 },
    });

    // Variation without initial click and slightly different name/solution
    const noClickVariant = buildLibraryEntryFromScript({
      name: "Fill Company and Owner Details",
      solution: "Automate entering company name and owner email details into the form.",
      status: "active",
      context: { app: "127.0.0.1", url: "http://127.0.0.1:5173/" },
      script: {
        name: "Fill Company and Owner Details",
        steps: [
          { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:5173/" },
          { action: "fill", target: { kind: "css", value: 'input[name="company_name"]' }, value: "{{companyName}}" },
          { action: "fill", target: { kind: "css", value: 'input[name="owner_email"]' }, value: "{{ownerEmail}}" },
        ],
      },
      now: 2000,
    });
    const secondSaved = await upsertLibraryEntry(dataDir, {
      ...noClickVariant,
      startSignature: formatStartSignature(buildStartSignature(noClickVariant.script, { app: "127.0.0.1" })),
    });
    expect(secondSaved.items).toHaveLength(1);
    expect(secondSaved.entry.id).toBe(firstSaved.entry.id);
    expect(secondSaved.entry.runCount).toBe(2);

    // Richer variant adding trailing Save button click + rephrased solution
    const withSave = buildLibraryEntryFromScript({
      name: "Fill Company Name and Owner Email",
      solution: "Automate entering company details and owner email into the form.",
      status: "active",
      context: { app: "127.0.0.1", url: "http://127.0.0.1:5173/" },
      script: {
        name: "Fill Company Name and Owner Email",
        steps: [
          { action: "switchTab", host: "127.0.0.1", url: "http://127.0.0.1:5173/" },
          { action: "click", target: { kind: "css", value: 'input[name="company_name"]' } },
          { action: "fill", target: { kind: "css", value: 'input[name="company_name"]' }, value: "{{companyName}}" },
          { action: "fill", target: { kind: "css", value: 'input[name="owner_email"]' }, value: "{{ownerEmail}}" },
          { action: "click", target: { kind: "aria", value: 'button[name="Save profile"]' } },
        ],
      },
      now: 3000,
    });
    const thirdSaved = await upsertLibraryEntry(dataDir, {
      ...withSave,
      startSignature: formatStartSignature(buildStartSignature(withSave.script, { app: "127.0.0.1" })),
      stats: { repetitions: 3, stepCount: 5, manualSeconds: 58.38, replaySeconds: 0, timeSavedSeconds: 58.38 },
    });
    expect(thirdSaved.items).toHaveLength(1);
    expect(thirdSaved.entry.id).toBe(firstSaved.entry.id);
    expect(thirdSaved.entry.runCount).toBe(2);
    expect(thirdSaved.entry.script.steps).toHaveLength(5);

    const disk = await readLibrary(dataDir);
    expect(disk).toHaveLength(1);
    expect(dedupeLibraryEntries(disk)).toHaveLength(1);
  });
});
