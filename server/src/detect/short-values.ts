import { createHash } from "node:crypto";
import type { Finding, Locator, Step } from "@gen/shared";

export interface ShortValueOptions {
  minLength?: number;
  maxLength?: number;
  minRepetitions?: number;
}

interface ShortValueGroup {
  firstLocator: Locator;
  fieldKey: string;
  norm: string;
  count: number;
  totalChars: number;
}

const IBAN_REDACTED_RE = /^\[REDACTED:IBAN[^\]]*\]$/i;

export function detectShortValues(
  steps: Step[],
  opts?: ShortValueOptions,
): Finding[] {
  const minLength = opts?.minLength ?? 5;
  const maxLength = opts?.maxLength ?? 19;
  const minRepetitions = opts?.minRepetitions ?? 4;

  const groups = new Map<string, ShortValueGroup>();

  for (const step of steps) {
    if (
      (step.action !== "fill" && step.action !== "paste") ||
      typeof step.value !== "string"
    ) {
      continue;
    }

    const firstLocator = step.target?.[0];
    if (!firstLocator) {
      continue;
    }

    const trimmed = step.value.trim();
    const norm = trimmed.toLowerCase().replace(/\s+/g, " ");

    const isMaskedToken =
      trimmed === "<email>" ||
      trimmed === "<phone>" ||
      IBAN_REDACTED_RE.test(trimmed);
    const isShortString =
      !trimmed.includes("[REDACTED") &&
      norm.length >= minLength &&
      norm.length <= maxLength;

    if (!isMaskedToken && !isShortString) {
      continue;
    }

    const fieldKey = `${firstLocator.kind}:${firstLocator.value}`;
    const groupKey = `${fieldKey}::${norm}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.count += 1;
      existing.totalChars += trimmed.length;
    } else {
      groups.set(groupKey, {
        firstLocator,
        fieldKey,
        norm,
        count: 1,
        totalChars: trimmed.length,
      });
    }
  }

  const findings: Finding[] = [];
  for (const group of groups.values()) {
    if (group.count < minRepetitions) {
      continue;
    }

    const repetitions = group.count;
    const avgChars = group.totalChars / repetitions;
    const minutesPerWeek = Number((repetitions * (avgChars / 200)).toFixed(2));
    const id =
      "short_" +
      createHash("sha256")
        .update(`${group.fieldKey}::${group.norm}`)
        .digest("hex")
        .slice(0, 8);

    findings.push({
      id,
      verdict: "rung1",
      title: `Short value typed ${repetitions} times in ${group.firstLocator.value}`,
      why: `You entered the same ${Math.round(avgChars)}-character value ${repetitions} times into ${group.firstLocator.value} in this session.`,
      whyNotNext:
        "A saved autofill entry or text snippet fills this field without exposing private text or building a UI script.",
      stats: {
        repetitions,
        minutesPerWeek,
        stability: 1,
      },
    });
  }

  return findings;
}
