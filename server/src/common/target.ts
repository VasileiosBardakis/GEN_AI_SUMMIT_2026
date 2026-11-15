import type { Event, Locator, Step } from "@gen/shared";
import { resolveEventHost } from "./host.ts";

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const PHONE_RE =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{4}\b/g;
export const REDACTED_RE = /\[REDACTED(?::[^\]]*)?\]/g;
export const SHORTCUT_RE =
  /\s+(?:F(?:[1-9]|1[0-2])|(?:(?:Ctrl|Alt|Shift|Cmd|Meta)\+)+[A-Za-z0-9]+)$/i;
export const ROW_SUFFIX_RE = /(?:-\d+|_\d+)(?=(?:["']\])?$)/;

export type LocatorRanks = Record<Locator["kind"], number>;

export const CSS_FIRST_RANKS: LocatorRanks = {
  testid: 0,
  css: 1,
  aria: 2,
  text: 3,
  uia: 4,
};

export const ARIA_FIRST_RANKS: LocatorRanks = {
  testid: 0,
  aria: 1,
  text: 2,
  css: 3,
  uia: 4,
};

export const GRID_RANKS: LocatorRanks = {
  css: 0,
  testid: 1,
  aria: 2,
  text: 3,
  uia: 4,
};

export function maskPii(raw: string): string {
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

const NAMED_CONTROL_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "option",
  "treeitem",
  "checkbox",
  "radio",
  "switch",
]);

export function rankLocators(
  target: NonNullable<Event["target"]>,
  locators: Locator[],
  defaultRanks: LocatorRanks = CSS_FIRST_RANKS,
): Locator[] {
  const isGrid =
    target.role === "gridcell" || target.tag?.toLowerCase() === "td";
  const isNamedControl =
    !isGrid &&
    defaultRanks === CSS_FIRST_RANKS &&
    Boolean(target.role && NAMED_CONTROL_ROLES.has(target.role.toLowerCase()));
  const ranks = isGrid ? GRID_RANKS : isNamedControl ? ARIA_FIRST_RANKS : defaultRanks;
  return locators.sort((a, b) => ranks[a.kind] - ranks[b.kind]);
}

export function formatTarget(
  target?: Event["target"],
  defaultRanks: LocatorRanks = CSS_FIRST_RANKS,
): Locator[] | undefined {
  if (!target || target.locators.length === 0) return undefined;

  const locators = target.locators.map((locator) => {
    if (locator.kind === "text" || locator.kind === "aria") {
      return { ...locator, value: locator.value.replace(SHORTCUT_RE, "") };
    }
    return { ...locator };
  });

  return rankLocators(target, locators, defaultRanks);
}

export function targetKey(
  target?: Event["target"],
  defaultRanks: LocatorRanks = CSS_FIRST_RANKS,
): string {
  const formatted = formatTarget(target, defaultRanks);
  if (!formatted || formatted.length === 0) return "";
  return `${formatted[0].kind}:${formatted[0].value}`;
}

export function dedupeLocators(locators: readonly Locator[]): Locator[] {
  const seen = new Set<string>();
  const out: Locator[] = [];
  for (const loc of locators) {
    const key = `${loc.kind}::${loc.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ ...loc });
    }
  }
  return out;
}

export function primaryTargetKey(
  step: { target?: readonly { kind: string; value: string }[] } | undefined,
): string | undefined {
  const loc = step?.target?.[0];
  return loc ? `${loc.kind}:${loc.value}` : undefined;
}

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function stripRowSuffix(value: string): string {
  return value.replace(ROW_SUFFIX_RE, "");
}

export function exactStepKey(step: Step): string {
  return `${step.action}:${step.target?.[0]?.kind ?? ""}:${step.target?.[0]?.value ?? ""}`;
}

const CORE_STEP_EVENT_TYPES: readonly Event["type"][] = [
  "click",
  "input",
  "change",
  "paste",
  "copy",
  "nav",
  "submit",
];

export const STEP_TRIGGER_TYPES = new Set<Event["type"]>([
  ...CORE_STEP_EVENT_TYPES,
  "tab_switch",
]);

const STEP_META_EVENT_TYPES = new Set<Event["type"]>([
  ...CORE_STEP_EVENT_TYPES,
  "key",
  "keydown",
]);

export const V2_STEP_EVENT_TYPES = new Set<Event["type"]>([
  ...STEP_TRIGGER_TYPES,
  "key",
  "keydown",
]);

export type CollapsedStepMeta = {
  action: Step["action"];
  startTs: number;
  endTs: number;
  app: string;
  label?: string;
  lastValue?: string;
};

export function collapseEventsToStepMeta(events: Event[]): {
  collapsed: CollapsedStepMeta[];
  stepIndexByEvent: Map<number, number>;
} {
  const collapsed: CollapsedStepMeta[] = [];
  const stepIndexByEvent = new Map<number, number>();
  let lastKey = "";

  for (let evIdx = 0; evIdx < events.length; evIdx++) {
    const ev = events[evIdx];
    if (!STEP_META_EVENT_TYPES.has(ev.type)) continue;

    if (ev.type === "input") {
      const key = targetKey(ev.target, ARIA_FIRST_RANKS);
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.action === "fill" && lastKey === key) {
        prev.endTs = ev.ts;
        prev.lastValue = ev.value ?? "";
        stepIndexByEvent.set(evIdx, collapsed.length - 1);
      } else {
        collapsed.push({
          action: "fill",
          startTs: ev.ts,
          endTs: ev.ts,
          app: resolveEventHost(ev) ?? ev.app,
          label: ev.target?.label,
          lastValue: ev.value ?? "",
        });
        stepIndexByEvent.set(evIdx, collapsed.length - 1);
      }
      lastKey = key;
    } else if (ev.type === "change") {
      const key = targetKey(ev.target, ARIA_FIRST_RANKS);
      const prev = collapsed[collapsed.length - 1];
      if (
        prev &&
        prev.action === "fill" &&
        lastKey === key &&
        prev.lastValue === (ev.value ?? "")
      ) {
        prev.endTs = ev.ts;
        stepIndexByEvent.set(evIdx, collapsed.length - 1);
      } else {
        collapsed.push({
          action: "fill",
          startTs: ev.ts,
          endTs: ev.ts,
          app: resolveEventHost(ev) ?? ev.app,
          label: ev.target?.label,
          lastValue: ev.value ?? "",
        });
        stepIndexByEvent.set(evIdx, collapsed.length - 1);
      }
      lastKey = key;
    } else if (ev.type === "nav") {
      collapsed.push({
        action: "nav",
        startTs: ev.ts,
        endTs: ev.ts,
        app: resolveEventHost(ev) ?? ev.app,
      });
      stepIndexByEvent.set(evIdx, collapsed.length - 1);
      lastKey = "";
    } else if (ev.type === "key" || ev.type === "keydown") {
      if (ev.meta?.key !== "Enter") continue;
      collapsed.push({
        action: "submit",
        startTs: ev.ts,
        endTs: ev.ts,
        app: ev.app,
        label: ev.target?.label,
        lastValue: "Enter",
      });
      stepIndexByEvent.set(evIdx, collapsed.length - 1);
      lastKey = targetKey(ev.target, ARIA_FIRST_RANKS);
    } else if (ev.type === "submit") {
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.action === "submit" && prev.lastValue === "Enter") {
        prev.endTs = ev.ts;
        prev.lastValue = undefined;
        if (!prev.label && ev.target?.label) {
          prev.label = ev.target.label;
        }
        stepIndexByEvent.set(evIdx, collapsed.length - 1);
      } else {
        collapsed.push({
          action: "submit",
          startTs: ev.ts,
          endTs: ev.ts,
          app: ev.app,
          label: ev.target?.label,
        });
        stepIndexByEvent.set(evIdx, collapsed.length - 1);
      }
      lastKey = targetKey(ev.target, ARIA_FIRST_RANKS);
    } else if (
      ev.type === "click" ||
      ev.type === "paste" ||
      ev.type === "copy"
    ) {
      collapsed.push({
        action: ev.type,
        startTs: ev.ts,
        endTs: ev.ts,
        app: resolveEventHost(ev) ?? ev.app,
        label: ev.target?.label,
      });
      stepIndexByEvent.set(evIdx, collapsed.length - 1);
      lastKey = targetKey(ev.target, ARIA_FIRST_RANKS);
    }
  }

  return { collapsed, stepIndexByEvent };
}
