import type { Event } from "@gen/shared";
import type { LibraryEntry } from "./types.ts";

const INTERACTIVE_EVENT_TYPES = new Set<Event["type"]>([
  "click",
  "dblclick",
  "focus",
  "input",
  "change",
  "paste",
  "select",
  "submit",
]);

const CLIPBOARD_WINDOW_MS = 120_000;

function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";
  let host = trimmed;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    host = trimmed.replace(/^https?:\/\//, "").split(/[/?#]/)[0] ?? "";
  }
  return host === "127.0.0.1" || host === "::1" || host === "[::1]" ? "localhost" : host;
}

function extractEventHost(evt: Event): string {
  if (evt.url) {
    const fromUrl = normalizeHost(evt.url);
    if (fromUrl) return fromUrl;
  }
  return normalizeHost(evt.app);
}

function normalizeUrlForPattern(rawUrl: string): string {
  try {
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const u = new URL(withScheme);
    return `${normalizeHost(u.hostname)}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    const cleaned = rawUrl.trim().toLowerCase().replace(/^https?:\/\//, "").split(/[?#]/)[0] ?? "";
    return cleaned.replace(/^(127\.0\.0\.1|\[::1\]|::1)(:\d+)?/, "localhost");
  }
}

function hostMatches(eventHost: string, patternHost: string): boolean {
  const h = normalizeHost(eventHost);
  const p = normalizeHost(patternHost);
  if (!h || !p) return false;
  return h === p || h.endsWith(`.${p}`);
}

function urlMatchesPattern(eventUrl: string | undefined, pattern: string): boolean {
  if (!eventUrl) return false;
  const cleanUrl = normalizeUrlForPattern(eventUrl);
  const cleanPattern = normalizeUrlForPattern(pattern);
  if (!cleanUrl || !cleanPattern) return false;

  const escaped = cleanPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}`).test(cleanUrl) || cleanUrl.includes(cleanPattern.replace(/\*/g, ""));
}

function extractImplicitRoles(evt: Event): Set<string> {
  const roles = new Set<string>();
  if (evt.target?.role) {
    roles.add(evt.target.role.trim().toLowerCase());
  }
  const tag = evt.target?.tag?.trim().toLowerCase();
  if (tag === "button") roles.add("button");
  if (tag === "a") roles.add("link");
  if (tag === "input" || tag === "textarea") roles.add("textbox");
  if (tag === "select") roles.add("combobox");
  if (tag === "td" || tag === "th") roles.add("gridcell");
  const nonGridTags = new Set(["input", "textarea", "select", "button", "a", "body", "html", "main", "section", "header", "p", "label"]);
  const hasGridLocator = Boolean(
    evt.target?.locators?.some((l) => /grid|cell|waffle|sheet|canvas/i.test(l.value)),
  );
  if (
    !evt.target?.role &&
    (!tag || !nonGridTags.has(tag)) &&
    (tag === "canvas" || hasGridLocator) &&
    evt.meta &&
    typeof evt.meta === "object" &&
    "grid" in evt.meta &&
    evt.meta.grid
  ) {
    roles.add("gridcell");
    roles.add("cell");
  }
  return roles;
}

function extractTargetTextCorpus(evt: Event, roles: Set<string>): string[] {
  const parts: string[] = [];
  if (evt.target?.label) parts.push(evt.target.label.toLowerCase());
  if (evt.target?.locators) {
    for (const loc of evt.target.locators) {
      parts.push(loc.value.toLowerCase());
    }
  }
  if (roles.has("gridcell")) {
    const grid =
      evt.meta && typeof evt.meta === "object"
        ? (evt.meta as { grid?: { cellRef?: unknown } }).grid
        : undefined;
    if (grid && typeof grid.cellRef === "string") {
      parts.push(grid.cellRef.toLowerCase(), "cell");
    }
  }
  return parts;
}

function matchEntryToEvent(
  entry: LibraryEntry,
  evt: Event,
  lastClipboardAt: number | null,
  now: number,
): number {
  const { eyes } = entry;
  const hasTargetHints =
    eyes.targetHints.roles.length > 0 ||
    eyes.targetHints.labelContains.length > 0 ||
    eyes.targetHints.locators.length > 0;
  const hasPrefixHints = eyes.textHints.prefixHints.length > 0;

  if (!INTERACTIVE_EVENT_TYPES.has(evt.type)) {
    if (evt.type !== "nav" && evt.type !== "tab_switch") return 0;
    if (hasTargetHints || hasPrefixHints || eyes.guards.fieldEmptyOnly) return 0;
  }

  if (eyes.guards.requireClipboard) {
    const hasEventClipboard = Boolean(
      evt.clipboard?.text || evt.clipboard?.textHash || evt.clipboard?.fromApp,
    );
    if (
      !hasEventClipboard &&
      (lastClipboardAt === null || now - lastClipboardAt > CLIPBOARD_WINDOW_MS)
    ) {
      return 0;
    }
  }

  const eventHost = extractEventHost(evt);
  const appMatched =
    eyes.scope.apps.length > 0 &&
    eyes.scope.apps.some((app) => hostMatches(eventHost, app));

  const urlMatched =
    eyes.scope.urlPatterns.length > 0 &&
    eyes.scope.urlPatterns.some((pat) => urlMatchesPattern(evt.url, pat));

  const hasScopeConstraint = eyes.scope.apps.length > 0 || eyes.scope.urlPatterns.length > 0;
  if (hasScopeConstraint && !appMatched && !urlMatched) {
    return 0;
  }

  const pageText = `${evt.window ?? ""} ${evt.url ?? ""}`.toLowerCase();
  const pageHintMatched =
    eyes.scope.pageHints.length > 0 &&
    eyes.scope.pageHints.some((hint) => pageText.includes(hint.toLowerCase()));

  const eventRoles = extractImplicitRoles(evt);
  const roleMatched =
    eyes.targetHints.roles.length > 0 &&
    eyes.targetHints.roles.some((role) => eventRoles.has(role.trim().toLowerCase()));

  const targetCorpus = extractTargetTextCorpus(evt, eventRoles);
  const labelMatched =
    eyes.targetHints.labelContains.length > 0 &&
    eyes.targetHints.labelContains.some((tok) => {
      const needle = tok.toLowerCase();
      return targetCorpus.some((part) => part.includes(needle));
    });

  const locatorMatched =
    eyes.targetHints.locators.length > 0 &&
    Boolean(evt.target?.locators?.length) &&
    eyes.targetHints.locators.some((hintLoc) =>
      evt.target!.locators.some((evtLoc) => {
        const hv = hintLoc.value.toLowerCase();
        const ev = evtLoc.value.toLowerCase();
        return ev === hv || (hintLoc.kind === evtLoc.kind && (ev.includes(hv) || hv.includes(ev)));
      }),
    );

  const normalizedVal = (evt.value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const prefixMatched =
    hasPrefixHints &&
    normalizedVal.length >= eyes.textHints.minCharsBeforeMatch &&
    eyes.textHints.prefixHints.some(
      (prefix) => normalizedVal.startsWith(prefix) || normalizedVal.includes(prefix),
    );

  if (
    eyes.guards.fieldEmptyOnly &&
    normalizedVal.length > 0 &&
    !prefixMatched &&
    (evt.type === "input" || evt.type === "change" || evt.type === "focus")
  ) {
    return 0;
  }

  const targetOrTextSignals =
    (roleMatched ? 1 : 0) +
    (labelMatched ? 1 : 0) +
    (locatorMatched ? 1 : 0) +
    (prefixMatched ? 1 : 0);

  if ((hasTargetHints || hasPrefixHints) && targetOrTextSignals === 0) {
    return 0;
  }

  const totalSignals =
    (appMatched ? 1 : 0) +
    (urlMatched ? 1 : 0) +
    (pageHintMatched ? 1 : 0) +
    targetOrTextSignals;

  return totalSignals >= eyes.guards.minSignals ? totalSignals : 0;
}

export interface LibraryRecallMatcher {
  matchEvents(events: Event[], entries: LibraryEntry[], now?: number): LibraryEntry | null;
  markTriggered(entryId: string, now?: number): void;
}

export function createLibraryRecallMatcher(): LibraryRecallMatcher {
  let lastClipboardAt: number | null = null;
  const lastTriggeredAt = new Map<string, number>();

  function markTriggered(entryId: string, now = Date.now()): void {
    lastTriggeredAt.set(entryId, now);
  }

  function matchEvents(
    events: Event[],
    entries: LibraryEntry[],
    now = Date.now(),
  ): LibraryEntry | null {
    for (const evt of events) {
      if (evt.type === "copy" || evt.type === "cut") {
        const copyTs = evt.ts || now;
        lastClipboardAt = lastClipboardAt === null ? copyTs : Math.max(lastClipboardAt, copyTs);
      }
    }

    const candidates = entries.filter((entry) => {
      if (entry.status === "paused") return false;
      const last = lastTriggeredAt.get(entry.id);
      return last === undefined || now - last >= entry.eyes.guards.cooldownMs;
    });
    if (candidates.length === 0) return null;

    let best: { entry: LibraryEntry; score: number } | null = null;
    for (const evt of events) {
      for (const entry of candidates) {
        const score = matchEntryToEvent(entry, evt, lastClipboardAt, now);
        if (score === 0) continue;
        if (
          !best ||
          score > best.score ||
          (score === best.score &&
            ((entry.status === "active" && best.entry.status !== "active") ||
              (entry.status === best.entry.status && entry.updatedAt > best.entry.updatedAt)))
        ) {
          best = { entry, score };
        }
      }
    }

    return best?.entry ?? null;
  }

  return { matchEvents, markTriggered };
}
