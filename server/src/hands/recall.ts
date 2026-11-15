import type { Event } from "@gen/shared";
import {
  hostnameFromUrl,
  normalizeHost as normalizeHostBase,
  resolveEventHost,
} from "../common/host.ts";
import { judgeRecallIris, type IrisJudgeOptions } from "../llm/iris.ts";
import { buildStartSignature } from "./implementor.ts";
import { toLocatorList, type LibraryEntry, type Locator, type Step } from "./types.ts";

const INTERACTIVE_EVENT_TYPES = new Set<Event["type"]>([
  "click",
  "dblclick",
  "focus",
  "input",
  "select",
  "copy",
  "paste",
  "change",
]);

const CLIPBOARD_WINDOW_MS = 120_000;
const IMPLICIT_TAG_ROLES: Record<string, string> = {
  button: "button",
  a: "link",
  input: "textbox",
  textarea: "textbox",
  select: "combobox",
  td: "gridcell",
  th: "gridcell",
};

function normalizeHost(raw: string): string {
  return normalizeHostBase(raw, { collapseLoopback: true });
}

function extractEventHost(evt: Event): string {
  return resolveEventHost(evt, { preferUrl: true, collapseLoopback: true }) ?? "";
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
  const trimmedPattern = pattern.trim().toLowerCase();
  if (!trimmedPattern) return false;

  let targetToMatch: string;
  let cleanPattern: string;
  if (trimmedPattern.startsWith("/")) {
    try {
      const withScheme = /^https?:\/\//i.test(eventUrl) ? eventUrl : `https://${eventUrl}`;
      targetToMatch = new URL(withScheme).pathname.replace(/\/+$/, "").toLowerCase() || "/";
    } catch {
      targetToMatch = eventUrl.trim().toLowerCase();
    }
    cleanPattern = trimmedPattern.replace(/\/+$/, "") || "/";
  } else {
    targetToMatch = normalizeUrlForPattern(eventUrl);
    cleanPattern = normalizeUrlForPattern(trimmedPattern);
  }
  if (!targetToMatch || !cleanPattern) return false;

  const escaped = cleanPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return (
    new RegExp(`^${escaped}`).test(targetToMatch) ||
    targetToMatch.includes(cleanPattern.replace(/\*/g, ""))
  );
}

function extractImplicitRoles(evt: Event): Set<string> {
  const roles = new Set<string>();
  const explicitRole = evt.target?.role?.trim().toLowerCase();
  if (explicitRole) {
    roles.add(explicitRole);
  }
  const tag = evt.target?.tag?.trim().toLowerCase();
  const implicitRole = tag ? IMPLICIT_TAG_ROLES[tag] : undefined;
  if (implicitRole) roles.add(implicitRole);
  if (explicitRole === "searchbox" || (explicitRole === "combobox" && tag !== "select")) {
    roles.add("textbox");
  }
  const nonGridTags = new Set([
    "input",
    "textarea",
    "select",
    "button",
    "a",
    "body",
    "html",
    "main",
    "section",
    "header",
    "p",
    "label",
  ]);
  if (
    !evt.target?.role &&
    (!tag || !nonGridTags.has(tag)) &&
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
      if (
        loc.kind === "testid" ||
        loc.kind === "text" ||
        (loc.kind === "aria" &&
          !loc.value.startsWith("[") &&
          !/^[a-z]+\[\s*name\s*=/i.test(loc.value))
      ) {
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
  if (!hint) return false;
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
    const hintParts = hv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const evtParts = ev
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return hintParts.some((hp) => evtParts.includes(hp));
  }
  return false;
}

type MatchScoreResult = {
  score: number;
  borderline: boolean;
};

const NO_MATCH: MatchScoreResult = { score: 0, borderline: false };

function matchEntryToEvent(
  entry: LibraryEntry,
  evt: Event,
  lastClipboardAt: number | null,
  now: number,
): MatchScoreResult {
  const { eyes } = entry;
  const hasTargetHints =
    eyes.targetHints.roles.length > 0 ||
    eyes.targetHints.labelContains.length > 0 ||
    eyes.targetHints.locators.length > 0;
  const hasPrefixHints = eyes.textHints.prefixHints.length > 0;

  if (!INTERACTIVE_EVENT_TYPES.has(evt.type)) {
    return NO_MATCH;
  }

  const startAction = buildStartSignature(entry.script).action;
  if (
    evt.type === "copy" &&
    (eyes.guards.fieldEmptyOnly || startAction !== "copy")
  ) {
    return NO_MATCH;
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
      return NO_MATCH;
    }
  }

  if (eyes.guards.requireClipboard && evt.type !== "copy") {
    const hasEventClipboard = Boolean(
      evt.clipboard?.text || evt.clipboard?.textHash || evt.clipboard?.fromApp,
    );
    if (
      !hasEventClipboard &&
      (lastClipboardAt === null || now - lastClipboardAt > CLIPBOARD_WINDOW_MS)
    ) {
      return NO_MATCH;
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
    return NO_MATCH;
  }

  const pageText = `${evt.window ?? ""} ${evt.url ?? ""}`.toLowerCase();
  const pageHintMatched =
    eyes.scope.pageHints.length > 0 &&
    eyes.scope.pageHints.some((hint) => pageText.includes(hint.toLowerCase()));

  // 1. Locator[]-first matching (exact or CSS-list match)
  const locatorMatched =
    eyes.targetHints.locators.length > 0 &&
    Boolean(evt.target?.locators?.length) &&
    eyes.targetHints.locators.some((hintLoc) =>
      evt.target!.locators.some((evtLoc) => locatorsMatch(hintLoc, evtLoc)),
    );

  // 2. Semantic role/label/text matching
  const eventRoles = extractImplicitRoles(evt);
  const roleMatched =
    eyes.targetHints.roles.length > 0 &&
    eyes.targetHints.roles.some((role) => eventRoles.has(role.trim().toLowerCase()));

  const isNonTextControl =
    eventRoles.has("button") ||
    eventRoles.has("link") ||
    evt.target?.tag?.trim().toLowerCase() === "select" ||
    (eventRoles.has("combobox") && !eventRoles.has("textbox"));

  if (
    (entry.kind === "snippet" && isNonTextControl) ||
    (eyes.targetHints.roles.length > 0 && eventRoles.size > 0 && !roleMatched)
  ) {
    return NO_MATCH;
  }

  const targetCorpus = extractTargetTextCorpus(evt, eventRoles);
  const labelMatched =
    eyes.targetHints.labelContains.length > 0 &&
    eyes.targetHints.labelContains.some((tok) =>
      targetCorpus.some((part) => containsHintPhrase(part, tok)),
    );

  const snippetStep = entry.script.steps.find(
    (s): s is Extract<Step, { action: "insertText" }> =>
      s.action === "insertText" && typeof s.value === "string",
  );
  const fullSnippetNorm = snippetStep
    ? snippetStep.value.toLowerCase().replace(/\s+/g, " ").trim()
    : "";
  const alreadyHasSnippet =
    fullSnippetNorm.length > 0 &&
    (normalizedVal === fullSnippetNorm || normalizedVal.includes(fullSnippetNorm));

  if (alreadyHasSnippet) {
    return NO_MATCH;
  }

  const prefixMatched =
    evt.type === "input" &&
    hasPrefixHints &&
    normalizedVal.length >= eyes.textHints.minCharsBeforeMatch &&
    eyes.textHints.prefixHints.some(
      (prefix) => normalizedVal.startsWith(prefix) || prefix.startsWith(normalizedVal),
    );

  if (eyes.guards.fieldEmptyOnly) {
    if (
      (evt.type === "focus" || evt.type === "click" || evt.type === "dblclick") &&
      normalizedVal.length > 0
    ) {
      return NO_MATCH;
    }
    if (evt.type === "paste" || evt.type === "change") {
      return NO_MATCH;
    }
    if (evt.type === "input" && !prefixMatched) {
      return NO_MATCH;
    }
  }

  const hasSpecificTargetHints =
    eyes.targetHints.locators.length > 0 || eyes.targetHints.labelContains.length > 0;
  if (hasSpecificTargetHints && !locatorMatched && !labelMatched && !prefixMatched) {
    return NO_MATCH;
  }

  const targetOrTextSignals =
    (roleMatched ? 1 : 0) +
    (labelMatched ? 1 : 0) +
    (locatorMatched ? 1 : 0) +
    (prefixMatched ? 1 : 0);

  if ((hasTargetHints || hasPrefixHints) && targetOrTextSignals === 0) {
    return NO_MATCH;
  }

  const totalSignals =
    (appMatched ? 1 : 0) +
    (urlMatched ? 1 : 0) +
    (pageHintMatched ? 1 : 0) +
    targetOrTextSignals;

  if (totalSignals < eyes.guards.minSignals) {
    return NO_MATCH;
  }

  const score = totalSignals + (locatorMatched ? 2 : 0);
  const borderline = totalSignals <= 1 || !locatorMatched;
  return { score, borderline };
}

export interface LibraryRecallMatch {
  entry: LibraryEntry;
  event: Event;
  score: number;
  borderline: boolean;
}

export interface LibraryRecallMatcher {
  matchEvents(events: Event[], entries: LibraryEntry[], now?: number): LibraryEntry | null;
  matchEventsWithEvent(
    events: Event[],
    entries: LibraryEntry[],
    now?: number,
  ): LibraryRecallMatch | null;
  matchEventsWithIris(
    events: Event[],
    entries: LibraryEntry[],
    opts?: { now?: number; irisOpts?: IrisJudgeOptions },
  ): Promise<LibraryRecallMatch | null>;
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
        const result = matchEntryToEvent(entry, evt, lastClipboardAt, now);
        if (result.score === 0) continue;
        if (
          !best ||
          result.score > best.score ||
          (result.score === best.score &&
            ((entry.status === "active" && best.entry.status !== "active") ||
              (entry.status === best.entry.status && entry.updatedAt > best.entry.updatedAt)))
        ) {
          best = { entry, event: evt, score: result.score, borderline: result.borderline };
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

  async function matchEventsWithIris(
    events: Event[],
    entries: LibraryEntry[],
    opts?: { now?: number; irisOpts?: IrisJudgeOptions },
  ): Promise<LibraryRecallMatch | null> {
    const matched = matchEventsWithEvent(events, entries, opts?.now);
    if (!matched) return null;
    if (!matched.borderline) return matched;

    try {
      const judgment = await judgeRecallIris(
        {
          currentEvent: {
            type: matched.event.type,
            app: matched.event.app,
            url: matched.event.url,
            window: matched.event.window,
            target: matched.event.target
              ? {
                  tag: matched.event.target.tag,
                  role: matched.event.target.role,
                  label: matched.event.target.label,
                  locators: matched.event.target.locators,
                }
              : undefined,
          },
          candidateEntry: {
            id: matched.entry.id,
            name: matched.entry.name,
            description: matched.entry.description,
            kind: matched.entry.kind,
            intent: matched.entry.eyes.intent,
            targetHints: matched.entry.eyes.targetHints,
          },
          score: matched.score,
          borderline: matched.borderline,
        },
        { timeoutMs: 1500, ...opts?.irisOpts },
      );
      if (judgment === null) {
        return matched;
      }
      return judgment.match ? matched : null;
    } catch {
      return matched;
    }
  }

  return {
    matchEvents,
    matchEventsWithEvent,
    matchEventsWithIris,
    markTriggered,
    suppressEntry,
    suppressOnTarget,
    notifyTargetVisited,
  };
}

const PREFIX_SKIPPED_ACTIONS = new Set<Step["action"]>([
  "navigate",
  "wait",
  "switchTab",
  "extractList",
  "waitFor",
]);

const PREFIX_INTERACTIVE_EVENT_TYPES = new Set<Event["type"]>([
  "click",
  "dblclick",
  "input",
  "change",
  "paste",
  "copy",
  "select",
  "submit",
  "keydown",
  "key",
]);

function locatorsMatchForPrefix(
  stepLoc: Locator,
  evtLoc: NonNullable<Event["target"]>["locators"][number],
): boolean {
  const sv = stepLoc.value.trim().toLowerCase();
  const ev = evtLoc.value.trim().toLowerCase();
  if (!sv || !ev) return false;
  if (ev === sv) return true;
  if (stepLoc.kind !== evtLoc.kind) return false;
  if (stepLoc.kind === "css") {
    const stepParts = sv.split(",").map((s) => s.trim()).filter(Boolean);
    const evtParts = ev.split(",").map((s) => s.trim()).filter(Boolean);
    for (const sp of stepParts) {
      if (evtParts.includes(sp)) return true;
      if (
        evtParts.some(
          (ep) =>
            ep.endsWith(` ${sp}`) ||
            ep.endsWith(`>${sp}`) ||
            ep.endsWith(`> ${sp}`),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function extractAriaName(raw: string): string | null {
  const trimmed = raw.trim();
  const m = /^[a-z]+\[\s*name\s*=\s*["']([\s\S]*?)["']\s*\]$/i.exec(trimmed);
  if (m?.[1]) return m[1].toLowerCase().trim();
  if (!trimmed.startsWith("[")) return trimmed.toLowerCase();
  return null;
}

function stepLocatorsMatchEvent(stepLocators: Locator[], evt: Event): boolean {
  const concrete = stepLocators.filter((loc) => !loc.value.includes("{{"));
  if (concrete.length === 0) {
    return Boolean(evt.target);
  }
  const evtLocators = evt.target?.locators ?? [];
  for (const sl of concrete) {
    if (evtLocators.some((el) => locatorsMatchForPrefix(sl, el))) {
      return true;
    }
  }
  const evtLabel = evt.target?.label?.trim().toLowerCase();
  if (evtLabel) {
    for (const sl of concrete) {
      if (sl.kind === "text" && sl.value.trim().toLowerCase() === evtLabel) {
        return true;
      }
      if (sl.kind === "aria") {
        const ariaName = extractAriaName(sl.value);
        if (ariaName && ariaName === evtLabel) {
          return true;
        }
      }
    }
  }
  return false;
}

function advancePastSkippedSteps(
  steps: readonly Step[],
  startIdx: number,
  initialHost: string | undefined,
): { idx: number; host: string | undefined } {
  let idx = startIdx;
  let host = initialHost;
  while (idx < steps.length && PREFIX_SKIPPED_ACTIONS.has(steps[idx].action)) {
    const step = steps[idx];
    if (step.action === "switchTab" && step.host) {
      host = normalizeHost(step.host);
    } else if (step.action === "navigate") {
      host = hostnameFromUrl(step.url) ?? host;
    }
    idx += 1;
  }
  return { idx, host };
}

function isFocusingClickForStep(evt: Event, step: Step): boolean {
  if (evt.type !== "click" && evt.type !== "dblclick") return false;
  if (step.action !== "fill" && step.action !== "insertText" && step.action !== "select") {
    return false;
  }
  if (!("target" in step) || !step.target) return false;
  return stepLocatorsMatchEvent(toLocatorList(step.target), evt);
}

function matchStepToEvent(
  step: Step,
  evt: Event,
  expectedHost: string | undefined,
  entry: LibraryEntry,
): { matched: boolean; value?: string; fillLocators?: Locator[]; bindName?: string } {
  const evtHost = extractEventHost(evt);
  if (expectedHost && evtHost && !hostMatches(evtHost, expectedHost)) {
    return { matched: false };
  }

  switch (step.action) {
    case "readText":
    case "readValue": {
      if (evt.type !== "copy") return { matched: false };
      if (!stepLocatorsMatchEvent(toLocatorList(step.target), evt)) {
        return { matched: false };
      }
      const val = (evt.value ?? evt.clipboard?.text ?? "").trim();
      return {
        matched: true,
        ...(val ? { value: val } : {}),
        bindName: step.bind,
      };
    }
    case "fill":
    case "insertText": {
      if (evt.type !== "input" && evt.type !== "change" && evt.type !== "paste") {
        return { matched: false };
      }
      const rawVal = evt.value ?? evt.clipboard?.text ?? "";
      if (
        evt.type === "input" &&
        evt.meta?.typing?.inputType?.startsWith("delete") &&
        rawVal.trim().length === 0
      ) {
        return { matched: false };
      }
      const stepLocs =
        "target" in step && step.target
          ? toLocatorList(step.target)
          : entry.eyes.targetHints.locators;
      if (stepLocs.length > 0) {
        if (!stepLocatorsMatchEvent(stepLocs, evt)) {
          return { matched: false };
        }
      } else if (rawVal.trim().length === 0) {
        return { matched: false };
      }
      const val = rawVal.trim();
      const eventScriptLocs: Locator[] | undefined = evt.target?.locators?.flatMap(
        (l): Locator[] =>
          l.kind === "testid" ||
          l.kind === "aria" ||
          l.kind === "css" ||
          l.kind === "text"
            ? [{ kind: l.kind, value: l.value }]
            : [],
      );
      return {
        matched: true,
        ...(val ? { value: val } : {}),
        fillLocators: stepLocs.length > 0 ? stepLocs : eventScriptLocs,
      };
    }
    case "select": {
      if (evt.type !== "select" && evt.type !== "change") {
        return { matched: false };
      }
      if (!stepLocatorsMatchEvent(toLocatorList(step.target), evt)) {
        return { matched: false };
      }
      const val = (evt.value ?? "").trim();
      return {
        matched: true,
        ...(val ? { value: val } : {}),
        fillLocators: toLocatorList(step.target),
      };
    }
    case "click": {
      if (evt.type !== "click" && evt.type !== "dblclick" && evt.type !== "submit") {
        return { matched: false };
      }
      if (!stepLocatorsMatchEvent(toLocatorList(step.target), evt)) {
        return { matched: false };
      }
      return { matched: true };
    }
    case "pressKey": {
      const keyHit =
        ((evt.type === "keydown" || evt.type === "key") && evt.meta?.key === step.key) ||
        (evt.type === "submit" && step.key === "Enter");
      if (!keyHit) return { matched: false };
      if (step.target && !stepLocatorsMatchEvent(toLocatorList(step.target), evt)) {
        return { matched: false };
      }
      return { matched: true };
    }
    default:
      return { matched: false };
  }
}

function filterPrefixInteractiveEvents(events: readonly Event[]): Event[] {
  return events.filter((evt) => {
    if (!PREFIX_INTERACTIVE_EVENT_TYPES.has(evt.type)) return false;
    if (evt.type === "keydown" || evt.type === "key") {
      const key = evt.meta?.key;
      return key === "Enter" || key === "Tab" || key === "Escape";
    }
    return true;
  });
}

function computeMatchedPrefixInternal(
  sessionEvents: Event[],
  entry: LibraryEntry,
): {
  startStepIndex: number;
  completedValues: string[];
  boundValues: Record<string, string>;
} {
  const steps = entry.script.steps;
  if (entry.kind === "snippet" || steps.length === 0 || sessionEvents.length === 0) {
    return { startStepIndex: 0, completedValues: [], boundValues: {} };
  }

  const interactiveEvents = filterPrefixInteractiveEvents(sessionEvents);
  if (interactiveEvents.length === 0) {
    return { startStepIndex: 0, completedValues: [], boundValues: {} };
  }

  const completedValues: string[] = [];
  const boundValues: Record<string, string> = {};
  const addCompletedValue = (val: string | undefined): number => {
    if (!val) return -1;
    const existingIdx = completedValues.indexOf(val);
    if (existingIdx !== -1) return existingIdx;
    completedValues.push(val);
    return completedValues.length - 1;
  };

  let startStepIndex = 0;
  let currentHost: string | undefined = entry.eyes.scope.apps[0]
    ? normalizeHost(entry.eyes.scope.apps[0])
    : undefined;
  let lastFillLocs: Locator[] | undefined;
  let lastFillValIdx = -1;
  let lastFillBindName: string | undefined;

  let evtCursor = 0;
  while (evtCursor < interactiveEvents.length) {
    const { idx: candidateIdx, host: nextHost } = advancePastSkippedSteps(
      steps,
      startStepIndex,
      currentHost,
    );
    if (candidateIdx >= steps.length) break;

    const candidateStep = steps[candidateIdx];

    if (candidateStep.action === "forEach") {
      const body = candidateStep.steps;
      if (body.length === 0) break;

      let loopIdx = 0;
      let loopHost = nextHost;
      let iterValues: string[] = [];
      let iterLastFillLocs: Locator[] | undefined;
      let iterLastFillValIdx = -1;
      let matchedAnyInLoop = false;

      while (evtCursor < interactiveEvents.length) {
        const evt = interactiveEvents[evtCursor];
        const adv = advancePastSkippedSteps(body, loopIdx, loopHost);
        if (adv.idx >= body.length) {
          for (const v of iterValues) addCompletedValue(v);
          iterValues = [];
          loopIdx = 0;
          loopHost = nextHost;
          iterLastFillLocs = undefined;
          iterLastFillValIdx = -1;
          continue;
        }
        loopIdx = adv.idx;
        loopHost = adv.host;
        const loopStep = body[loopIdx];

        if (
          iterLastFillLocs &&
          (evt.type === "input" || evt.type === "change" || evt.type === "paste") &&
          stepLocatorsMatchEvent(iterLastFillLocs, evt)
        ) {
          const val = (evt.value ?? evt.clipboard?.text ?? "").trim();
          if (val && iterLastFillValIdx >= 0) {
            iterValues[iterLastFillValIdx] = val;
          }
          evtCursor += 1;
          continue;
        }

        if (isFocusingClickForStep(evt, loopStep)) {
          evtCursor += 1;
          continue;
        }

        if (
          (evt.type === "keydown" || evt.type === "key") &&
          evt.meta?.key === "Tab" &&
          !(loopStep.action === "pressKey" && loopStep.key === "Tab")
        ) {
          evtCursor += 1;
          continue;
        }

        const res = matchStepToEvent(loopStep, evt, loopHost, entry);
        if (!res.matched) {
          break;
        }

        matchedAnyInLoop = true;
        if (res.value) {
          const existing = iterValues.indexOf(res.value);
          if (existing === -1) {
            iterValues.push(res.value);
            iterLastFillValIdx = iterValues.length - 1;
          } else {
            iterLastFillValIdx = existing;
          }
        } else {
          iterLastFillValIdx = -1;
        }
        iterLastFillLocs = res.fillLocators;
        loopIdx += 1;
        evtCursor += 1;

        const afterAdv = advancePastSkippedSteps(body, loopIdx, loopHost);
        if (afterAdv.idx >= body.length) {
          for (const v of iterValues) addCompletedValue(v);
          iterValues = [];
          loopIdx = 0;
          loopHost = nextHost;
          iterLastFillLocs = undefined;
          iterLastFillValIdx = -1;
        } else {
          loopIdx = afterAdv.idx;
          loopHost = afterAdv.host;
        }
      }

      if (matchedAnyInLoop) {
        startStepIndex = candidateIdx;
      }
      break;
    }

    const evt = interactiveEvents[evtCursor];

    if (
      lastFillLocs &&
      (evt.type === "input" || evt.type === "change" || evt.type === "paste") &&
      stepLocatorsMatchEvent(lastFillLocs, evt)
    ) {
      const val = (evt.value ?? evt.clipboard?.text ?? "").trim();
      if (val) {
        if (lastFillValIdx >= 0) {
          completedValues[lastFillValIdx] = val;
        } else {
          lastFillValIdx = addCompletedValue(val);
        }
        if (lastFillBindName) {
          boundValues[lastFillBindName] = val;
        }
      }
      evtCursor += 1;
      continue;
    }

    if (isFocusingClickForStep(evt, candidateStep)) {
      evtCursor += 1;
      continue;
    }

    if (
      (evt.type === "keydown" || evt.type === "key") &&
      evt.meta?.key === "Tab" &&
      !(candidateStep.action === "pressKey" && candidateStep.key === "Tab")
    ) {
      evtCursor += 1;
      continue;
    }

    const res = matchStepToEvent(candidateStep, evt, nextHost, entry);
    if (!res.matched) {
      break;
    }

    if (res.value) {
      lastFillValIdx = addCompletedValue(res.value);
      if (res.bindName) {
        boundValues[res.bindName] = res.value;
      }
    } else {
      lastFillValIdx = -1;
    }
    lastFillLocs = res.fillLocators;
    lastFillBindName = res.bindName;
    currentHost = nextHost;
    startStepIndex = candidateIdx + 1;
    evtCursor += 1;
  }

  return { startStepIndex, completedValues, boundValues };
}

export function computeMatchedPrefix(
  sessionEvents: Event[],
  entry: LibraryEntry,
): { startStepIndex: number; completedValues: string[] } {
  const { startStepIndex, completedValues } = computeMatchedPrefixInternal(
    sessionEvents,
    entry,
  );
  return { startStepIndex, completedValues };
}

export function extractMatchedPrefixBindings(
  sessionEvents: Event[],
  entry: LibraryEntry,
): Record<string, string> {
  return computeMatchedPrefixInternal(sessionEvents, entry).boundValues;
}
