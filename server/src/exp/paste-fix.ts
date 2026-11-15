import type { Locator, Step } from "@gen/shared";

export type PasteFixSuggestion = {
  repeatIndex: number;
  stepIndex: number;
  actualTarget: Locator[];
  expectedTarget: Locator[];
};

type PasteOccurrence = {
  repeatIndex: number;
  stepIndex: number;
  target: Locator[];
  key: string;
};

function canonicalTargetKey(target: Locator[]): string {
  return target.map((l) => `${l.kind}:${l.value}`).join("\0");
}

export function detectPasteFixes(repeats: Step[][]): PasteFixSuggestion[] {
  if (repeats.length === 0) return [];

  const byOrdinal: PasteOccurrence[][] = [];

  for (let repeatIndex = 0; repeatIndex < repeats.length; repeatIndex += 1) {
    const steps = repeats[repeatIndex];
    let ordinal = 0;

    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      if (step.action !== "paste" || !step.target || step.target.length === 0) {
        continue;
      }

      const occurrence: PasteOccurrence = {
        repeatIndex,
        stepIndex,
        target: step.target,
        key: canonicalTargetKey(step.target),
      };

      if (!byOrdinal[ordinal]) {
        byOrdinal[ordinal] = [];
      }
      byOrdinal[ordinal].push(occurrence);
      ordinal += 1;
    }
  }

  const suggestions: PasteFixSuggestion[] = [];

  for (const occurrences of byOrdinal) {
    const total = occurrences.length;
    const groups = new Map<string, { count: number; target: Locator[] }>();

    for (const occ of occurrences) {
      const existing = groups.get(occ.key);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(occ.key, { count: 1, target: occ.target });
      }
    }

    let majorityKey: string | undefined;
    let majorityTarget: Locator[] | undefined;

    for (const [key, group] of groups) {
      if (group.count > total / 2 && group.count >= 2) {
        majorityKey = key;
        majorityTarget = group.target;
        break;
      }
    }

    if (majorityKey === undefined || majorityTarget === undefined) {
      continue;
    }

    for (const occ of occurrences) {
      if (occ.key !== majorityKey) {
        suggestions.push({
          repeatIndex: occ.repeatIndex,
          stepIndex: occ.stepIndex,
          actualTarget: occ.target,
          expectedTarget: majorityTarget,
        });
      }
    }
  }

  return suggestions;
}
