import type { Event } from "@gen/shared";
import type { LibraryEntry } from "./types.ts";

const INTERACTIVE_EVENT_TYPES = new Set<Event["type"]>([
  "click",
  "dblclick",
  "focus",
  "input",
  "select",
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

const GENERIC_LABEL_STOPWORDS = new Set([
  "name",
  "names",
  "input",
  "field",
  "box",
  "textbox",
  "textarea",
  "button",
  "text",
  "value",
  "form",
]);

function extractTargetTextCorpus(evt: Event, roles: Set<string>): string[] {
  const parts: string[] = [];
  if (evt.target?.label) parts.push(evt.target.label.toLowerCase());
  if (evt.target?.locators) {
    for (const loc of evt.target.locators) {
      if (loc.kind === "testid" || loc.kind === "text") {
        parts.push(loc.value.toLowerCase());
        continue;
      }
      const attrMatches = loc.value.matchAll(
        /(?:name|aria-label|placeholder|data-testid)\s*[*^$~]?=\s*["']([^"']+)["']/gi,
      );
      for (const m of attrMatches) {
        if (m[1]) parts.push(m[1].toLowerCase());
      }
      const idMatch = /^#([A-Za-z][A-Za-z0-9_-]{2,})$/.exec(loc.value.trim());
      if (idMatch?.[1]) parts.push(idMatch[1].toLowerCase());
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

function containsHintPhrase(text: string, rawHint: string): boolean {
  const hint = rawHint.trim().toLowerCase();
  if (!hint || GENERIC_LABEL_STOPWORDS.has(hint)) return false;
  const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s_-]+");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(text);
}

function locatorsMatch(
  hintLoc: LibraryEntry["eyes"]["targetHints"]["locators"][number],
  evtLoc: NonNullable<Event["target"]>["locators"][number],
): boolean {
  const hv = hintLoc.value.trim().toLowerCase();
  const ev = evtLoc.value.trim().toLowerCase();
  if (!hv || !ev) return false;
  if (ev === hv) return true;
  if (hintLoc.kind !== evtLoc.kind) return false;
  if (hintLoc.kind === "css") {
    return hv
      .split(",")
      .map((s) => s.trim())
      .some((part) => part.length > 0 && part === ev);
  }
  return false;
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
    return 0;
  }

  const normalizedVal = (evt.value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

  if (evt.type === "input") {
    const inputType = evt.meta?.typing?.inputType ?? "";
    if (
      normalizedVal.length === 0 ||
      inputType.startsWith("delete") ||
      evt.meta?.subType === "blur_commit" ||
      inputType === "insertFromPaste"
    ) {
      return 0;
    }
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

  if (
    (entry.kind === "snippet" &&
      (eventRoles.has("button") || eventRoles.has("link") || eventRoles.has("combobox"))) ||
    (eyes.targetHints.roles.length > 0 && eventRoles.size > 0 && !roleMatched)
  ) {
    return 0;
  }

  const targetCorpus = extractTargetTextCorpus(evt, eventRoles);
  const labelMatched =
    eyes.targetHints.labelContains.length > 0 &&
    eyes.targetHints.labelContains.some((tok) =>
      targetCorpus.some((part) => containsHintPhrase(part, tok)),
    );

  const locatorMatched =
    eyes.targetHints.locators.length > 0 &&
    Boolean(evt.target?.locators?.length) &&
    eyes.targetHints.locators.some((hintLoc) =>
      evt.target!.locators.some((evtLoc) => locatorsMatch(hintLoc, evtLoc)),
    );

  const firstStep = entry.script.steps[0];
  const fullSnippetNorm =
    firstStep?.action === "insertText" && typeof firstStep.value === "string"
      ? firstStep.value.toLowerCase().replace(/\s+/g, " ").trim()
      : "";
  const alreadyHasSnippet =
    fullSnippetNorm.length > 0 &&
    (normalizedVal === fullSnippetNorm || normalizedVal.includes(fullSnippetNorm));

  const prefixMatched =
    evt.type === "input" &&
    hasPrefixHints &&
    !alreadyHasSnippet &&
    normalizedVal.length >= eyes.textHints.minCharsBeforeMatch &&
    eyes.textHints.prefixHints.some(
      (prefix) => normalizedVal.startsWith(prefix) || prefix.startsWith(normalizedVal),
    );

  if (eyes.guards.fieldEmptyOnly) {
    if (
      (evt.type === "focus" || evt.type === "click" || evt.type === "dblclick") &&
      normalizedVal.length > 0
    ) {
      return 0;
    }
    if (evt.type === "input" && !prefixMatched) {
      return 0;
    }
  }

  if (entry.kind === "snippet" && eyes.targetHints.locators.length > 0 && appMatched) {
    if (!locatorMatched && !prefixMatched) {
      return 0;
    }
  }

  const hasSpecificTargetHints =
    eyes.targetHints.locators.length > 0 || eyes.targetHints.labelContains.length > 0;
  if (hasSpecificTargetHints && !locatorMatched && !labelMatched && !prefixMatched) {
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

export interface LibraryRecallMatch {
  entry: LibraryEntry;
  event: Event;
  score: number;
}

export interface LibraryRecallMatcher {
  matchEvents(events: Event[], entries: LibraryEntry[], now?: number): LibraryEntry | null;
  matchEventsWithEvent(
    events: Event[],
    entries: LibraryEntry[],
    now?: number,
  ): LibraryRecallMatch | null;
  markTriggered(entryId: string, now?: number): void;
  suppressEntry(entryId: string, durationMs: number, now?: number): void;
  suppressOnTarget(
    entryId: string,
    targetKey: string | null,
    durationMs: number,
    now?: number,
  ): void;
  notifyTargetVisited(targetKey: string | null): void;
}

export function createLibraryRecallMatcher(): LibraryRecallMatcher {
  let lastClipboardAt: number | null = null;
  const lastTriggeredAt = new Map<string, number>();
  const suppressedUntil = new Map<string, number>();
  const suppressedTargetByEntry = new Map<string, string>();

  function markTriggered(entryId: string, now = Date.now()): void {
    lastTriggeredAt.set(entryId, now);
  }

  function suppressEntry(entryId: string, durationMs: number, now = Date.now()): void {
    suppressedTargetByEntry.delete(entryId);
    if (durationMs > 0) {
      suppressedUntil.set(entryId, now + durationMs);
    } else {
      suppressedUntil.delete(entryId);
    }
  }

  function suppressOnTarget(
    entryId: string,
    targetKey: string | null,
    durationMs: number,
    now = Date.now(),
  ): void {
    if (durationMs <= 0) return;
    suppressedUntil.set(entryId, now + durationMs);
    if (targetKey) {
      suppressedTargetByEntry.set(entryId, targetKey);
    } else {
      suppressedTargetByEntry.delete(entryId);
    }
  }

  function notifyTargetVisited(targetKey: string | null): void {
    if (!targetKey) return;
    for (const [entryId, dismissedTarget] of suppressedTargetByEntry.entries()) {
      if (dismissedTarget !== targetKey) {
        suppressedTargetByEntry.delete(entryId);
        suppressedUntil.delete(entryId);
      }
    }
  }

  function matchEventsWithEvent(
    events: Event[],
    entries: LibraryEntry[],
    now = Date.now(),
  ): LibraryRecallMatch | null {
    for (const evt of events) {
      if (evt.type === "copy" || evt.type === "cut") {
        const copyTs = evt.ts || now;
        lastClipboardAt = lastClipboardAt === null ? copyTs : Math.max(lastClipboardAt, copyTs);
      }
    }

    const candidates = entries.filter((entry) => {
      if (entry.status === "paused") return false;
      const until = suppressedUntil.get(entry.id);
      if (until !== undefined) {
        if (now < until) return false;
        suppressedUntil.delete(entry.id);
        suppressedTargetByEntry.delete(entry.id);
      }
      const last = lastTriggeredAt.get(entry.id);
      return last === undefined || now - last >= entry.eyes.guards.cooldownMs;
    });
    if (candidates.length === 0) return null;

    let best: LibraryRecallMatch | null = null;
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
          best = { entry, event: evt, score };
        }
      }
    }

    return best;
  }

  function matchEvents(
    events: Event[],
    entries: LibraryEntry[],
    now = Date.now(),
  ): LibraryEntry | null {
    return matchEventsWithEvent(events, entries, now)?.entry ?? null;
  }

  return {
    matchEvents,
    matchEventsWithEvent,
    markTriggered,
    suppressEntry,
    suppressOnTarget,
    notifyTargetVisited,
  };
}
