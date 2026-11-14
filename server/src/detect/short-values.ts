import { createHash } from "node:crypto";
import type { Event, EventMeta, Finding, Locator, Step } from "@gen/shared";

export interface ShortValueOptions {
  minLength?: number;
  maxLength?: number;
  minRepetitions?: number;
  events?: Event[];
}

interface FieldMeta {
  autocompleteAttr?: string;
  inputTypeAttr?: string;
  inputName?: string;
}

interface SimulatedStepMeta {
  action: Step["action"];
  targetKey: string;
  locators: Set<string>;
  value?: string;
  meta: FieldMeta;
  used?: boolean;
}

interface ShortValueGroup {
  fieldType: string;
  fieldKey: string;
  norm: string;
  count: number;
  totalChars: number;
}

const IBAN_REDACTED_RE = /^\[REDACTED:IBAN[^\]]*\]$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{4}\b/g;
const REDACTED_RE = /\[REDACTED:[^\]]*\]/g;
const SHORTCUT_RE =
  /\s+(?:F(?:[1-9]|1[0-2])|(?:(?:Ctrl|Alt|Shift|Cmd|Meta)\+)+[A-Za-z0-9]+)$/i;

const DEFAULT_RANKS: Record<Locator["kind"], number> = {
  testid: 0,
  aria: 1,
  text: 2,
  css: 3,
  uia: 4,
};

const GRID_RANKS: Record<Locator["kind"], number> = {
  css: 0,
  testid: 1,
  aria: 2,
  text: 3,
  uia: 4,
};

const INCLUDED_TYPES = new Set<Event["type"]>([
  "click",
  "input",
  "change",
  "paste",
  "copy",
  "nav",
  "submit",
]);

function maskPii(raw: string): string {
  const redacted: string[] = [];
  const shielded = raw.replace(REDACTED_RE, (token) => {
    redacted.push(token);
    return `\uE000${redacted.length - 1}\uE000`;
  });

  const masked = shielded
    .replace(EMAIL_RE, "<email>")
    .replace(PHONE_RE, "<phone>");

  return masked.replace(
    /\uE000(\d+)\uE000/g,
    (_match: string, index: string) => redacted[Number(index)] ?? "",
  );
}

function formatTarget(target?: Event["target"]): Locator[] | undefined {
  if (!target || target.locators.length === 0) return undefined;

  const locators = target.locators.map((locator) => {
    if (locator.kind === "text" || locator.kind === "aria") {
      return { ...locator, value: locator.value.replace(SHORTCUT_RE, "") };
    }
    return { ...locator };
  });

  const isGrid =
    target.role === "gridcell" || target.tag?.toLowerCase() === "td";
  const ranks = isGrid ? GRID_RANKS : DEFAULT_RANKS;
  return locators.sort((a, b) => ranks[a.kind] - ranks[b.kind]);
}

function targetKey(target?: Event["target"]): string {
  const formatted = formatTarget(target);
  if (!formatted || formatted.length === 0) return "";
  return `${formatted[0].kind}:${formatted[0].value}`;
}

function targetLocatorSet(target?: Event["target"]): Set<string> {
  const formatted = formatTarget(target);
  if (!formatted) return new Set();
  return new Set(formatted.map((loc) => `${loc.kind}:${loc.value}`));
}

function stepTargetKey(step: Step): string {
  const first = step.target?.[0];
  return first ? `${first.kind}:${first.value}` : "";
}

function normalizeValueText(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function cleanAttr(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanAutocompleteAttr(val: unknown): string | undefined {
  const cleaned = cleanAttr(val);
  if (
    !cleaned ||
    cleaned.toLowerCase() === "off" ||
    cleaned.toLowerCase() === "on"
  ) {
    return undefined;
  }
  return cleaned;
}

function extractMeta(meta?: EventMeta): FieldMeta {
  if (!meta) return {};
  const typing = meta.typing;
  return {
    autocompleteAttr: cleanAutocompleteAttr(
      typing?.autocompleteAttr ?? meta.autocompleteAttr,
    ),
    inputTypeAttr: cleanAttr(typing?.inputTypeAttr ?? meta.inputTypeAttr),
    inputName: cleanAttr(typing?.inputName ?? meta.inputName),
  };
}

function mergeFieldMeta(base: FieldMeta, incoming: FieldMeta): FieldMeta {
  return {
    autocompleteAttr: base.autocompleteAttr ?? incoming.autocompleteAttr,
    inputTypeAttr: base.inputTypeAttr ?? incoming.inputTypeAttr,
    inputName: base.inputName ?? incoming.inputName,
  };
}

function pickFieldType(
  meta: FieldMeta | undefined,
  fallbackLocator: Locator,
): string {
  return (
    meta?.autocompleteAttr ??
    meta?.inputTypeAttr ??
    meta?.inputName ??
    fallbackLocator.value
  );
}

function buildEventFieldLookup(events?: Event[]): {
  simulatedSteps: SimulatedStepMeta[];
  fillPasteSteps: SimulatedStepMeta[];
} {
  const simulatedSteps: SimulatedStepMeta[] = [];

  if (!events || events.length === 0) {
    return { simulatedSteps, fillPasteSteps: [] };
  }

  let lastTargetKey = "";

  for (const ev of events) {
    const evMeta = extractMeta(ev.meta);

    if (ev.type === "blur") {
      const key = targetKey(ev.target);
      const prev = simulatedSteps[simulatedSteps.length - 1];
      if (
        prev &&
        (prev.action === "fill" || prev.action === "paste") &&
        lastTargetKey !== "" &&
        lastTargetKey === key
      ) {
        prev.meta = mergeFieldMeta(prev.meta, evMeta);
      }
      continue;
    }

    if (!INCLUDED_TYPES.has(ev.type)) continue;

    switch (ev.type) {
      case "input": {
        const masked = maskPii(ev.value ?? "");
        const key = targetKey(ev.target);
        const prev = simulatedSteps[simulatedSteps.length - 1];

        if (prev && prev.action === "fill" && lastTargetKey === key) {
          prev.value = masked;
          prev.meta = mergeFieldMeta(prev.meta, evMeta);
        } else {
          simulatedSteps.push({
            action: "fill",
            targetKey: key,
            locators: targetLocatorSet(ev.target),
            value: masked,
            meta: evMeta,
          });
        }
        lastTargetKey = key;
        break;
      }

      case "change": {
        const masked = maskPii(ev.value ?? "");
        const key = targetKey(ev.target);
        const prev = simulatedSteps[simulatedSteps.length - 1];

        if (
          prev &&
          prev.action === "fill" &&
          lastTargetKey === key &&
          prev.value === masked
        ) {
          prev.meta = mergeFieldMeta(prev.meta, evMeta);
          break;
        }

        simulatedSteps.push({
          action: "fill",
          targetKey: key,
          locators: targetLocatorSet(ev.target),
          value: masked,
          meta: evMeta,
        });
        lastTargetKey = key;
        break;
      }

      case "paste": {
        const rawVal = ev.value ?? ev.clipboard?.text;
        const key = targetKey(ev.target);
        simulatedSteps.push({
          action: "paste",
          targetKey: key,
          locators: targetLocatorSet(ev.target),
          ...(rawVal !== undefined ? { value: maskPii(rawVal) } : {}),
          meta: evMeta,
        });
        lastTargetKey = key;
        break;
      }

      case "copy": {
        const rawVal = ev.value ?? ev.clipboard?.text;
        const key = targetKey(ev.target);
        simulatedSteps.push({
          action: "copy",
          targetKey: key,
          locators: targetLocatorSet(ev.target),
          ...(rawVal !== undefined ? { value: maskPii(rawVal) } : {}),
          meta: evMeta,
        });
        lastTargetKey = key;
        break;
      }

      case "click":
      case "submit": {
        const key = targetKey(ev.target);
        simulatedSteps.push({
          action: ev.type,
          targetKey: key,
          locators: targetLocatorSet(ev.target),
          meta: evMeta,
        });
        lastTargetKey = key;
        break;
      }

      case "nav": {
        simulatedSteps.push({
          action: "nav",
          targetKey: "",
          locators: new Set(),
          ...(ev.url ? { value: maskPii(ev.url) } : {}),
          meta: evMeta,
        });
        lastTargetKey = "";
        break;
      }

      default:
        break;
    }
  }

  const fillPasteSteps = simulatedSteps.filter(
    (s) => s.action === "fill" || s.action === "paste",
  );

  return { simulatedSteps, fillPasteSteps };
}

function resolveStepMetas(steps: Step[], events?: Event[]): FieldMeta[] {
  const { simulatedSteps, fillPasteSteps } = buildEventFieldLookup(events);
  const alignedWithAllSteps = simulatedSteps.length === steps.length;
  const totalFillPaste = steps.filter(
    (s) => s.action === "fill" || s.action === "paste",
  ).length;
  const alignedWithFillPaste = fillPasteSteps.length === totalFillPaste;

  let fillPasteIndex = 0;
  return steps.map((step, i) => {
    const inlineStepMeta = extractMeta(
      (step as Step & { meta?: EventMeta }).meta,
    );
    const isFillOrPaste = step.action === "fill" || step.action === "paste";
    const currentFpIndex = isFillOrPaste ? fillPasteIndex++ : -1;

    let eventMeta: FieldMeta | undefined;
    if (alignedWithAllSteps) {
      eventMeta = simulatedSteps[i]?.meta;
    } else if (alignedWithFillPaste && isFillOrPaste) {
      eventMeta = fillPasteSteps[currentFpIndex]?.meta;
    } else if (isFillOrPaste) {
      const key = stepTargetKey(step);
      const stepNorm =
        typeof step.value === "string"
          ? normalizeValueText(step.value)
          : undefined;
      const matched = fillPasteSteps.find((entry) => {
        if (entry.used) return false;
        const targetMatches =
          (key !== "" && entry.targetKey === key) ||
          (step.target ?? []).some((loc) =>
            entry.locators.has(`${loc.kind}:${loc.value}`),
          );
        if (!targetMatches) return false;
        if (stepNorm !== undefined && typeof entry.value === "string") {
          return normalizeValueText(entry.value) === stepNorm;
        }
        return true;
      });
      if (matched) {
        matched.used = true;
        eventMeta = matched.meta;
      }
    }

    return mergeFieldMeta(inlineStepMeta, eventMeta ?? {});
  });
}

export function detectShortValues(
  steps: Step[],
  eventsOrOpts?: Event[] | ShortValueOptions,
  maybeOpts?: ShortValueOptions,
): Finding[] {
  const events = Array.isArray(eventsOrOpts)
    ? eventsOrOpts
    : eventsOrOpts?.events;
  const opts = Array.isArray(eventsOrOpts) ? maybeOpts : eventsOrOpts;

  const minLength = opts?.minLength ?? 5;
  const maxLength = opts?.maxLength ?? 19;
  const minRepetitions = opts?.minRepetitions ?? 2;

  const stepMetas = resolveStepMetas(steps, events);
  const groups = new Map<string, ShortValueGroup>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isFillOrPaste = step.action === "fill" || step.action === "paste";
    if (!isFillOrPaste) {
      continue;
    }

    let resolvedMeta = stepMetas[i] ?? {};

    // A browser paste emits a `paste` step followed by a `fill` step from the
    // accompanying `input`/`change` event on the same target. Collapse them
    // into one user action while preserving metadata from both steps.
    if (step.action === "paste" && i + 1 < steps.length) {
      const nextStep = steps[i + 1];
      const currentKey = stepTargetKey(step);
      if (
        nextStep.action === "fill" &&
        currentKey !== "" &&
        currentKey === stepTargetKey(nextStep)
      ) {
        if (
          typeof step.value === "string" &&
          typeof nextStep.value === "string" &&
          normalizeValueText(step.value) === normalizeValueText(nextStep.value)
        ) {
          resolvedMeta = mergeFieldMeta(resolvedMeta, stepMetas[i + 1] ?? {});
          i += 1;
        } else if (
          step.value === undefined &&
          typeof nextStep.value === "string"
        ) {
          stepMetas[i + 1] = mergeFieldMeta(
            resolvedMeta,
            stepMetas[i + 1] ?? {},
          );
          continue;
        }
      }
    }

    if (typeof step.value !== "string") {
      continue;
    }

    const firstLocator = step.target?.[0];
    if (!firstLocator) {
      continue;
    }

    const trimmed = step.value.trim();
    const norm = normalizeValueText(trimmed);

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

    const fieldType = pickFieldType(resolvedMeta, firstLocator);
    const fieldKey = fieldType.toLowerCase();
    const groupKey = `${fieldKey}::${norm}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.count += 1;
      existing.totalChars += trimmed.length;
    } else {
      groups.set(groupKey, {
        fieldType,
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
    // Time-saved formula comes after the MVP.
    const minutesPerWeek = 0;
    const id =
      "short_" +
      createHash("sha256")
        .update(`${group.fieldKey}::${group.norm}`)
        .digest("hex")
        .slice(0, 8);

    findings.push({
      id,
      verdict: "rung1",
      title: `Same ${group.fieldType} typed ${repetitions} times in ${group.fieldType} fields`,
      why: `You entered the same ${Math.round(avgChars)}-character value ${repetitions} times into ${group.fieldType} fields in this session.`,
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
