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
});
