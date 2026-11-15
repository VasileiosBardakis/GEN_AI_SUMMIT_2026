import { describe, expect, it } from "vitest";
import type { Locator, Step } from "@gen/shared";
import { detectPasteFixes } from "../src/exp/paste-fix.ts";

function loc(kind: Locator["kind"], value: string): Locator {
  return { kind, value };
}

function pasteStep(target?: Locator[], value = "copied"): Step {
  return target ? { action: "paste", target, value } : { action: "paste", value };
}

function clickStep(target: Locator[]): Step {
  return { action: "click", target };
}

describe("detectPasteFixes", () => {
  it("returns [] when repeats are consistent and all paste steps target the same Locator[]", () => {
    const cellB2 = [loc("css", "td[data-cell='B2']"), loc("aria", "Row 2 Col B")];
    const repeats: Step[][] = [
      [clickStep([loc("testid", "row-1")]), pasteStep(cellB2, "alpha")],
      [clickStep([loc("testid", "row-2")]), pasteStep(cellB2, "beta")],
      [clickStep([loc("testid", "row-3")]), pasteStep(cellB2, "gamma")],
    ];

    expect(detectPasteFixes(repeats)).toEqual([]);
  });

  it("flags a single outlier paste with repeatIndex, stepIndex, actualTarget, and expectedTarget", () => {
    const expectedCell = [loc("css", "td[data-cell='C4']"), loc("aria", "Total")];
    const wrongCell = [loc("css", "td[data-cell='D4']"), loc("aria", "Notes")];

    const repeats: Step[][] = [
      [
        { action: "nav", value: "https://sheet.local" },
        clickStep([loc("testid", "copy-btn")]),
        pasteStep(expectedCell, "100"),
      ],
      [
        { action: "nav", value: "https://sheet.local" },
        clickStep([loc("testid", "copy-btn")]),
        pasteStep(wrongCell, "200"),
        { action: "submit" },
      ],
      [
        { action: "nav", value: "https://sheet.local" },
        clickStep([loc("testid", "copy-btn")]),
        pasteStep(expectedCell, "300"),
      ],
    ];

    expect(detectPasteFixes(repeats)).toEqual([
      {
        repeatIndex: 1,
        stepIndex: 2,
        actualTarget: wrongCell,
        expectedTarget: expectedCell,
      },
    ]);
  });

  it("flags only the outlier paste in multi-paste repeats", () => {
    const firstField = [loc("testid", "first-name")];
    const secondField = [loc("testid", "email")];
    const wrongSecondField = [loc("testid", "phone")];

    const repeats: Step[][] = [
      [pasteStep(firstField, "Ada"), clickStep([loc("testid", "next")]), pasteStep(secondField, "ada@example.com")],
      [pasteStep(firstField, "Grace"), clickStep([loc("testid", "next")]), pasteStep(secondField, "grace@example.com")],
      [pasteStep(firstField, "Alan"), clickStep([loc("testid", "next")]), pasteStep(wrongSecondField, "alan@example.com")],
    ];

    expect(detectPasteFixes(repeats)).toEqual([
      {
        repeatIndex: 2,
        stepIndex: 2,
        actualTarget: wrongSecondField,
        expectedTarget: secondField,
      },
    ]);
  });

  it("returns [] when there are fewer than 3 repeats with no strict majority or empty input", () => {
    const cellA = [loc("css", "td[data-cell='A1']")];
    const cellB = [loc("css", "td[data-cell='B1']")];
    const cellC = [loc("css", "td[data-cell='C1']")];

    expect(detectPasteFixes([])).toEqual([]);
    expect(detectPasteFixes([[pasteStep(cellA)]])).toEqual([]);
    expect(detectPasteFixes([[pasteStep(cellA)], [pasteStep(cellB)]])).toEqual([]);
    expect(detectPasteFixes([[pasteStep(cellA)], [pasteStep(cellB)], [pasteStep(cellC)]])).toEqual([]);
    expect(
      detectPasteFixes([
        [pasteStep(cellA)],
        [pasteStep(cellA)],
        [pasteStep(cellB)],
        [pasteStep(cellB)],
      ]),
    ).toEqual([]);
  });

  it("ignores paste steps with missing or empty targets when computing ordinals", () => {
    const target1 = [loc("testid", "field-1")];
    const target2 = [loc("testid", "field-2")];
    const wrongTarget2 = [loc("testid", "field-3")];

    const repeats: Step[][] = [
      [pasteStep(undefined), pasteStep(target1), pasteStep([]), pasteStep(target2)],
      [pasteStep(target1), pasteStep(wrongTarget2)],
      [pasteStep(target1), pasteStep(target2)],
    ];

    expect(detectPasteFixes(repeats)).toEqual([
      {
        repeatIndex: 1,
        stepIndex: 1,
        actualTarget: wrongTarget2,
        expectedTarget: target2,
      },
    ]);
  });
});
