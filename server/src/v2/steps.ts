import type { Event, Locator, Step } from "@gen/shared";
import {
  EMAIL_RE,
  formatTarget,
  PHONE_RE,
  REDACTED_RE,
  targetKey,
} from "../common/target.ts";

export type V2Action = Step["action"] | "tab_switch" | "key";

export type V2Step = {
  action: V2Action;
  ts: number;
  session: string;
  app: string;
  target?: Locator[];
  value?: string;
  url?: string;
  key?: string;
  pageSummary?: string;
};

export type PiiMap = Map<string, string>;

const INCLUDED_TYPES = new Set<Event["type"]>([
  "click",
  "input",
  "change",
  "paste",
  "copy",
  "nav",
  "submit",
  "tab_switch",
  "keydown",
  "key",
]);

function createScrubber(map: PiiMap): (raw: string) => string {
  const rawToEmailToken = new Map<string, string>();
  const rawToPhoneToken = new Map<string, string>();
  let maxEmailIndex = 0;
  let maxPhoneIndex = 0;

  for (const [token, raw] of map.entries()) {
    const emailMatch = /^__PII_EMAIL_(\d+)__$/.exec(token);
    if (emailMatch) {
      maxEmailIndex = Math.max(maxEmailIndex, Number(emailMatch[1]));
      if (!rawToEmailToken.has(raw)) {
        rawToEmailToken.set(raw, token);
      }
      continue;
    }
    const phoneMatch = /^__PII_PHONE_(\d+)__$/.exec(token);
    if (phoneMatch) {
      maxPhoneIndex = Math.max(maxPhoneIndex, Number(phoneMatch[1]));
      if (!rawToPhoneToken.has(raw)) {
        rawToPhoneToken.set(raw, token);
      }
    }
  }

  return (raw: string): string => {
    const redacted: string[] = [];
    const shielded = raw.replace(REDACTED_RE, (token) => {
      redacted.push(token);
      return `\uE000${redacted.length - 1}\uE000`;
    });

    const withEmails = shielded.replace(EMAIL_RE, (email) => {
      const existing = rawToEmailToken.get(email);
      if (existing) return existing;
      maxEmailIndex += 1;
      const token = `__PII_EMAIL_${maxEmailIndex}__`;
      rawToEmailToken.set(email, token);
      map.set(token, email);
      return token;
    });

    const withPhones = withEmails.replace(PHONE_RE, (phone) => {
      const existing = rawToPhoneToken.get(phone);
      if (existing) return existing;
      maxPhoneIndex += 1;
      const token = `__PII_PHONE_${maxPhoneIndex}__`;
      rawToPhoneToken.set(phone, token);
      map.set(token, phone);
      return token;
    });

    return withPhones.replace(
      /\uE000(\d+)\uE000/g,
      (_match: string, index: string) => redacted[Number(index)] ?? "",
    );
  };
}

export function eventsToSteps(
  events: Event[],
  piiMap?: PiiMap,
): { steps: V2Step[]; piiMap: PiiMap } {
  const map: PiiMap = piiMap ?? new Map<string, string>();
  const scrubPii = createScrubber(map);

  const steps: V2Step[] = [];
  let lastTargetKey = "";
  const lastFillBySession = new Map<string, Map<string, string>>();

  function getSessionFills(session: string): Map<string, string> {
    let fills = lastFillBySession.get(session);
    if (!fills) {
      fills = new Map<string, string>();
      lastFillBySession.set(session, fills);
    }
    return fills;
  }

  for (const ev of events) {
    if (!INCLUDED_TYPES.has(ev.type)) continue;

    const url = typeof ev.url === "string" ? scrubPii(ev.url) : undefined;
    const pageSummary =
      typeof ev.meta?.pageSummary === "string"
        ? scrubPii(ev.meta.pageSummary)
        : undefined;

    switch (ev.type) {
      case "input": {
        const masked = scrubPii(ev.value ?? "");
        const target = formatTarget(ev.target);
        const key = targetKey(ev.target);
        const prev = steps[steps.length - 1];

        if (
          prev &&
          prev.action === "fill" &&
          prev.session === ev.session &&
          lastTargetKey !== "" &&
          lastTargetKey === key
        ) {
          prev.value = masked;
          if (url !== undefined) prev.url = url;
          if (pageSummary !== undefined) prev.pageSummary = pageSummary;
        } else {
          steps.push({
            action: "fill",
            ts: ev.ts,
            session: ev.session,
            app: ev.app,
            ...(target ? { target } : {}),
            value: masked,
            ...(url !== undefined ? { url } : {}),
            ...(pageSummary !== undefined ? { pageSummary } : {}),
          });
        }
        if (key !== "") {
          getSessionFills(ev.session).set(key, masked);
        }
        lastTargetKey = key;
        break;
      }

      case "change": {
        const masked = scrubPii(ev.value ?? "");
        const target = formatTarget(ev.target);
        const key = targetKey(ev.target);
        const prev = steps[steps.length - 1];
        const sessionFills = getSessionFills(ev.session);

        if (
          prev &&
          prev.action === "fill" &&
          prev.session === ev.session &&
          lastTargetKey !== "" &&
          lastTargetKey === key &&
          prev.value === masked
        ) {
          if (pageSummary !== undefined && prev.pageSummary === undefined) {
            prev.pageSummary = pageSummary;
          }
          break;
        }

        if (key !== "" && sessionFills.get(key) === masked) {
          break;
        }

        steps.push({
          action: "fill",
          ts: ev.ts,
          session: ev.session,
          app: ev.app,
          ...(target ? { target } : {}),
          value: masked,
          ...(url !== undefined ? { url } : {}),
          ...(pageSummary !== undefined ? { pageSummary } : {}),
        });
        if (key !== "") {
          sessionFills.set(key, masked);
        }
        lastTargetKey = key;
        break;
      }

      case "click":
      case "submit": {
        const target = formatTarget(ev.target);
        steps.push({
          action: ev.type,
          ts: ev.ts,
          session: ev.session,
          app: ev.app,
          ...(target ? { target } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(pageSummary !== undefined ? { pageSummary } : {}),
        });
        lastTargetKey = targetKey(ev.target);
        if (ev.type === "submit") {
          lastFillBySession.delete(ev.session);
        }
        break;
      }

      case "paste":
      case "copy": {
        const target = formatTarget(ev.target);
        const rawVal = ev.value ?? ev.clipboard?.text;
        steps.push({
          action: ev.type,
          ts: ev.ts,
          session: ev.session,
          app: ev.app,
          ...(target ? { target } : {}),
          ...(rawVal !== undefined ? { value: scrubPii(rawVal) } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(pageSummary !== undefined ? { pageSummary } : {}),
        });
        lastTargetKey = targetKey(ev.target);
        break;
      }

      case "nav": {
        steps.push({
          action: "nav",
          ts: ev.ts,
          session: ev.session,
          app: ev.app,
          ...(ev.value !== undefined ? { value: scrubPii(ev.value) } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(pageSummary !== undefined ? { pageSummary } : {}),
        });
        lastTargetKey = "";
        lastFillBySession.delete(ev.session);
        break;
      }

      case "tab_switch": {
        const target = formatTarget(ev.target);
        steps.push({
          action: "tab_switch",
          ts: ev.ts,
          session: ev.session,
          app: ev.app,
          ...(target ? { target } : {}),
          ...(ev.value !== undefined ? { value: scrubPii(ev.value) } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(pageSummary !== undefined ? { pageSummary } : {}),
        });
        lastTargetKey = "";
        break;
      }

      case "keydown":
      case "key": {
        if (ev.meta?.key !== "Enter") break;
        const target = formatTarget(ev.target);
        steps.push({
          action: "key",
          ts: ev.ts,
          session: ev.session,
          app: ev.app,
          ...(target ? { target } : {}),
          key: "Enter",
          ...(url !== undefined ? { url } : {}),
          ...(pageSummary !== undefined ? { pageSummary } : {}),
        });
        lastTargetKey = targetKey(ev.target);
        break;
      }

      default:
        break;
    }
  }

  return { steps, piiMap: map };
}
