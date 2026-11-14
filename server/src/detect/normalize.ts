import type { Event, Locator, Step } from "@gen/shared";

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

/**
 * Replace PII (emails and phone numbers) in a raw string with stable tokens.
 * Existing layer-1 `[REDACTED:...]` tokens are left untouched.
 */
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

function rankLocators(
  target: NonNullable<Event["target"]>,
  locators: Locator[],
): Locator[] {
  const isGrid =
    target.role === "gridcell" || target.tag?.toLowerCase() === "td";
  const ranks = isGrid ? GRID_RANKS : DEFAULT_RANKS;
  return locators.sort((a, b) => ranks[a.kind] - ranks[b.kind]);
}

/**
 * Turn a raw captured target into a clean, ranked locator list.
 * Trailing keyboard shortcut hints (" F2", " Ctrl+C") are stripped from
 * text/aria locators so the canonical selector stays stable.
 */
function formatTarget(target?: Event["target"]): Locator[] | undefined {
  if (!target || target.locators.length === 0) return undefined;

  const locators = target.locators.map((locator) => {
    if (locator.kind === "text" || locator.kind === "aria") {
      return { ...locator, value: locator.value.replace(SHORTCUT_RE, "") };
    }
    return { ...locator };
  });

  return rankLocators(target, locators);
}

function targetKey(target?: Event["target"]): string {
  const formatted = formatTarget(target);
  if (!formatted || formatted.length === 0) return "";
  return `${formatted[0].kind}:${formatted[0].value}`;
}

/**
 * Collapse a noisy browser event trace into a canonical sequence of steps.
 * Raw keystroke bursts collapse into a single `fill`, duplicate `change`
 * events are dropped, and PII is masked before the step is emitted.
 */
export function normalize(events: Event[]): Step[] {
  const steps: Step[] = [];
  let lastTargetKey = "";

  for (const ev of events) {
    if (!INCLUDED_TYPES.has(ev.type)) continue;

    switch (ev.type) {
      case "input": {
        const masked = maskPii(ev.value ?? "");
        const target = formatTarget(ev.target);
        const key = targetKey(ev.target);
        const prev = steps[steps.length - 1];

        if (prev && prev.action === "fill" && lastTargetKey === key) {
          prev.value = masked;
        } else {
          steps.push({
            action: "fill",
            ...(target ? { target } : {}),
            value: masked,
          });
        }
        lastTargetKey = key;
        break;
      }

      case "change": {
        const masked = maskPii(ev.value ?? "");
        const target = formatTarget(ev.target);
        const key = targetKey(ev.target);
        const prev = steps[steps.length - 1];

        if (
          prev &&
          prev.action === "fill" &&
          lastTargetKey === key &&
          prev.value === masked
        ) {
          break;
        }

        steps.push({
          action: "fill",
          ...(target ? { target } : {}),
          value: masked,
        });
        lastTargetKey = key;
        break;
      }

      case "click":
      case "submit": {
        const target = formatTarget(ev.target);
        steps.push({
          action: ev.type,
          ...(target ? { target } : {}),
        });
        lastTargetKey = targetKey(ev.target);
        break;
      }

      case "paste":
      case "copy": {
        const target = formatTarget(ev.target);
        const rawVal = ev.value ?? ev.clipboard?.text;
        steps.push({
          action: ev.type,
          ...(target ? { target } : {}),
          ...(rawVal !== undefined ? { value: maskPii(rawVal) } : {}),
        });
        lastTargetKey = targetKey(ev.target);
        break;
      }

      case "nav": {
        steps.push({
          action: "nav",
          ...(ev.url ? { value: maskPii(ev.url) } : {}),
        });
        lastTargetKey = "";
        break;
      }

      default:
        break;
    }
  }

  return steps;
}
