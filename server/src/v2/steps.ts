import type { Event, Locator, Step } from "@gen/shared";
import { normalizeHost, resolveEventHost } from "../common/host.ts";
import { formatTarget, targetKey, V2_STEP_EVENT_TYPES } from "../common/target.ts";

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

export function eventsToSteps(
  events: Event[],
  piiMap?: PiiMap,
): { steps: V2Step[]; piiMap: PiiMap } {
  const map: PiiMap = piiMap ?? new Map<string, string>();
  const scrubPii = (raw: string): string => raw;

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
    if (!V2_STEP_EVENT_TYPES.has(ev.type)) continue;

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
        const inputType = (ev.meta?.typing as { inputType?: string } | undefined)?.inputType;

        if (
          prev &&
          prev.action === "paste" &&
          prev.session === ev.session &&
          lastTargetKey !== "" &&
          lastTargetKey === key &&
          inputType === "insertFromPaste" &&
          prev.value === masked
        ) {
          if (url !== undefined && prev.url === undefined) prev.url = url;
          if (pageSummary !== undefined && prev.pageSummary === undefined) {
            prev.pageSummary = pageSummary;
          }
          if (key !== "") {
            getSessionFills(ev.session).set(key, masked);
          }
          lastTargetKey = key;
          break;
        }

        if (
          prev &&
          prev.action === "fill" &&
          prev.session === ev.session &&
          lastTargetKey !== "" &&
          lastTargetKey === key &&
          !(masked === "" && (prev.value ?? "") !== "")
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

export type MeaningfulWindowStep = {
  index: number;
  action: string;
  host: string;
  label?: string;
  value?: string;
  copiedFromStep?: number;
};

export type MeaningfulWindowGap = {
  afterIndex: number;
  marker: string;
};

export type MeaningfulWindow = {
  meaningfulCount: number;
  steps: MeaningfulWindowStep[];
  gaps: MeaningfulWindowGap[];
};

const MEANINGFUL_INTERACTION_ACTIONS = new Set<V2Action>([
  "copy",
  "paste",
  "fill",
  "submit",
  "click",
  "key",
]);

const TRANSITION_ACTIONS = new Set<V2Action>(["nav", "tab_switch"]);
const GAP_THRESHOLD_MS = 60_000;

function inferTargetLabel(target?: Locator[]): string | undefined {
  if (!target) return undefined;
  const aria = target.find((l) => l.kind === "aria");
  if (aria) return aria.value;
  const text = target.find((l) => l.kind === "text");
  if (text) return text.value;
  return undefined;
}

function matchStepLabels(
  steps: readonly V2Step[],
  events?: readonly Event[],
): (string | undefined)[] {
  if (!events || events.length === 0) {
    return steps.map((s) => inferTargetLabel(s.target));
  }

  const queues = new Map<string, Event[]>();
  for (const ev of events) {
    const mappedAction =
      ev.type === "input" || ev.type === "change"
        ? "fill"
        : ev.type === "keydown" || ev.type === "key"
          ? "key"
          : ev.type;
    const key = `${ev.session}::${mappedAction}`;
    const q = queues.get(key);
    if (q) q.push(ev);
    else queues.set(key, [ev]);
  }

  const cursors = new Map<string, number>();
  return steps.map((step) => {
    const key = `${step.session}::${step.action}`;
    const q = queues.get(key);
    let matched: Event | undefined;
    if (q) {
      let idx = cursors.get(key) ?? 0;
      while (idx < q.length && q[idx].ts < step.ts) {
        idx += 1;
      }
      if (idx < q.length) {
        matched = q[idx];
        cursors.set(key, idx + 1);
      }
    }
    return matched?.target?.label ?? inferTargetLabel(step.target);
  });
}

function resolveStepHost(step: Pick<V2Step, "app" | "url">): string {
  return (
    resolveEventHost(step, { preferUrl: true }) ??
    (step.app ? normalizeHost(step.app) : "")
  );
}

export function selectMeaningfulWindow(
  steps: V2Step[],
  events?: Event[],
  maxSteps = 40,
): { window: MeaningfulWindow; steps: V2Step[]; events: Event[] } {
  const labels = matchStepLabels(steps, events);
  const kept: Array<{
    step: V2Step;
    host: string;
    label?: string;
    rawIndex: number;
  }> = [];
  let prevHost: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const host = resolveStepHost(step);
    if (MEANINGFUL_INTERACTION_ACTIONS.has(step.action)) {
      kept.push({ step, host, label: labels[i], rawIndex: i });
      if (host) prevHost = host;
    } else if (TRANSITION_ACTIONS.has(step.action)) {
      if (prevHost !== undefined && host !== "" && host !== prevHost) {
        kept.push({ step, host, label: labels[i], rawIndex: i });
        prevHost = host;
      }
    }
  }

  const meaningfulCount = kept.length;
  const cap = Math.max(1, Math.trunc(maxSteps));
  const windowItems = kept.length > cap ? kept.slice(-cap) : kept;

  const windowSteps: MeaningfulWindowStep[] = [];
  const copyIndexByValue = new Map<string, number>();

  for (let idx = 0; idx < windowItems.length; idx++) {
    const { step, host, label } = windowItems[idx];
    const value =
      step.value !== undefined
        ? step.value
        : step.action === "key" && step.key !== undefined
          ? step.key
          : undefined;

    let copiedFromStep: number | undefined;
    if (step.action === "copy" && value !== undefined && value.length > 0) {
      copyIndexByValue.set(value, idx);
    } else if (step.action === "paste" && value !== undefined && value.length > 0) {
      copiedFromStep = copyIndexByValue.get(value);
    }

    windowSteps.push({
      index: idx,
      action: step.action,
      host,
      ...(label ? { label } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(copiedFromStep !== undefined ? { copiedFromStep } : {}),
    });
  }

  const gaps: MeaningfulWindowGap[] = [];
  for (let idx = 1; idx < windowItems.length; idx++) {
    const prev = windowItems[idx - 1];
    const curr = windowItems[idx];
    const deltaMs = curr.step.ts - prev.step.ts;
    if (deltaMs >= GAP_THRESHOLD_MS) {
      const mins = Math.max(1, Math.round(deltaMs / 60_000));
      let elsewhereHost = "";
      for (let s = prev.rawIndex + 1; s < curr.rawIndex; s++) {
        const h = resolveStepHost(steps[s]);
        if (h && h !== prev.host) {
          elsewhereHost = h;
          break;
        }
      }
      if (!elsewhereHost && events && events.length > 0) {
        for (const ev of events) {
          if (ev.ts > prev.step.ts && ev.ts < curr.step.ts) {
            const h =
              resolveEventHost(ev, { preferUrl: true }) ?? normalizeHost(ev.app);
            if (h && h !== prev.host) {
              elsewhereHost = h;
              break;
            }
          }
        }
      }
      if (!elsewhereHost) {
        elsewhereHost = curr.host || prev.host;
      }
      const marker = elsewhereHost
        ? `${mins} min elsewhere (${elsewhereHost})`
        : `${mins} min elsewhere`;
      gaps.push({ afterIndex: idx - 1, marker });
    }
  }

  let selectedSteps: V2Step[];
  if (kept.length <= cap) {
    selectedSteps = steps;
  } else {
    const startRawIndex = windowItems[0]?.rawIndex ?? 0;
    const prefixTransition =
      startRawIndex > 0 &&
      TRANSITION_ACTIONS.has(steps[startRawIndex - 1].action) &&
      resolveStepHost(steps[startRawIndex - 1]) === windowItems[0].host
        ? [steps[startRawIndex - 1]]
        : [];
    selectedSteps = [
      ...prefixTransition,
      ...windowItems.map((item) => item.step),
    ];
  }
  const minTs = selectedSteps[0]?.ts;
  const selectedEvents =
    events && minTs !== undefined
      ? events.filter(
          (ev) => V2_STEP_EVENT_TYPES.has(ev.type) && ev.ts >= minTs,
        )
      : [];

  return {
    window: {
      meaningfulCount,
      steps: windowSteps,
      gaps,
    },
    steps: selectedSteps,
    events: selectedEvents,
  };
}

export function buildMeaningfulWindow(
  steps: V2Step[],
  events?: Event[],
  maxSteps = 40,
): MeaningfulWindow {
  return selectMeaningfulWindow(steps, events, maxSteps).window;
}
