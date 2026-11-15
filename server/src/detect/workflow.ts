import { createHash } from "node:crypto";
import type { Event, Locator, Step, Workflow } from "@gen/shared";
import { trigramJaccard } from "./snippet.ts";

export type Candidate = {
  workflow: Workflow;
  repetitions: number;
  minutesPerWeek: number;
  stability: number;
};

export interface WorkflowOptions {
  minRepetitions?: number;
  minSteps?: number;
  maxEditDistance?: number;
  gapMs?: number;
  events?: Event[];
}

interface EnrichedStep {
  step: Step;
  startTs?: number;
  endTs?: number;
  app?: string;
}

const INCLUDED_EVENT_TYPES = new Set<Event["type"]>([
  "click",
  "input",
  "change",
  "paste",
  "copy",
  "nav",
  "submit",
  "key",
  "keydown",
]);

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

function eventTargetKey(target?: Event["target"]): string {
  if (!target || target.locators.length === 0) return "";
  const isGrid =
    target.role === "gridcell" || target.tag?.toLowerCase() === "td";
  const ranks = isGrid ? GRID_RANKS : DEFAULT_RANKS;
  const sorted = target.locators
    .map((loc) => {
      if (loc.kind === "text" || loc.kind === "aria") {
        return { ...loc, value: loc.value.replace(SHORTCUT_RE, "") };
      }
      return { ...loc };
    })
    .sort((a, b) => ranks[a.kind] - ranks[b.kind]);
  return `${sorted[0].kind}:${sorted[0].value}`;
}

const PLACEHOLDER_HOSTS = new Set(["", "browser", "unknown", "local-page"]);

function isPlaceholderHost(host?: string): boolean {
  if (!host) return true;
  const trimmed = host.trim().toLowerCase();
  const hostname = trimmed.split(":")[0] ?? "";
  return PLACEHOLDER_HOSTS.has(trimmed) || PLACEHOLDER_HOSTS.has(hostname);
}

function resolveEventHost(ev?: { app?: string; url?: string }): string | undefined {
  if (!ev) return undefined;
  if (ev.app && !isPlaceholderHost(ev.app)) {
    return ev.app.trim();
  }
  if (ev.url) {
    try {
      const parsed = new URL(ev.url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const host = parsed.hostname.trim().toLowerCase();
        if (!isPlaceholderHost(host)) return host;
      }
    } catch {
      // ignore invalid URL
    }
  }
  return undefined;
}

function mapEventsToStepMeta(
  steps: Step[],
  events?: Event[],
): { startTs?: number; endTs?: number; app?: string }[] {
  if (!events || events.length === 0) {
    return steps.map((s) => {
      const ts = (s as { ts?: number }).ts;
      return typeof ts === "number" ? { startTs: ts, endTs: ts } : {};
    });
  }

  const collapsed: {
    action: Step["action"];
    startTs: number;
    endTs: number;
    app: string;
    lastValue?: string;
  }[] = [];
  let lastKey = "";

  for (const ev of events) {
    if (!INCLUDED_EVENT_TYPES.has(ev.type)) continue;

    if (ev.type === "input") {
      const key = eventTargetKey(ev.target);
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.action === "fill" && lastKey === key) {
        prev.endTs = ev.ts;
        prev.lastValue = ev.value ?? "";
      } else {
        collapsed.push({
          action: "fill",
          startTs: ev.ts,
          endTs: ev.ts,
          app: resolveEventHost(ev) ?? ev.app,
          lastValue: ev.value ?? "",
        });
      }
      lastKey = key;
    } else if (ev.type === "change") {
      const key = eventTargetKey(ev.target);
      const prev = collapsed[collapsed.length - 1];
      if (
        prev &&
        prev.action === "fill" &&
        lastKey === key &&
        prev.lastValue === (ev.value ?? "")
      ) {
        prev.endTs = ev.ts;
      } else {
        collapsed.push({
          action: "fill",
          startTs: ev.ts,
          endTs: ev.ts,
          app: resolveEventHost(ev) ?? ev.app,
          lastValue: ev.value ?? "",
        });
      }
      lastKey = key;
    } else if (ev.type === "nav") {
      collapsed.push({
        action: "nav",
        startTs: ev.ts,
        endTs: ev.ts,
        app: resolveEventHost(ev) ?? ev.app,
      });
      lastKey = "";
    } else if (ev.type === "key" || ev.type === "keydown") {
      if (ev.meta?.key !== "Enter") continue;
      collapsed.push({
        action: "submit",
        startTs: ev.ts,
        endTs: ev.ts,
        app: ev.app,
        lastValue: "Enter",
      });
      lastKey = eventTargetKey(ev.target);
    } else if (ev.type === "submit") {
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.action === "submit" && prev.lastValue === "Enter") {
        prev.endTs = ev.ts;
        prev.lastValue = undefined;
      } else {
        collapsed.push({
          action: "submit",
          startTs: ev.ts,
          endTs: ev.ts,
          app: ev.app,
        });
      }
      lastKey = eventTargetKey(ev.target);
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
      });
      lastKey = eventTargetKey(ev.target);
    }
  }

  return steps.map((s, idx) => {
    const inlineTs = (s as { ts?: number }).ts;
    const fromCollapsed =
      collapsed.length === steps.length ? collapsed[idx] : undefined;
    const fromDirect =
      !fromCollapsed && events.length === steps.length ? events[idx] : undefined;

    const startTs =
      typeof inlineTs === "number"
        ? inlineTs
        : (fromCollapsed?.startTs ?? fromDirect?.ts);
    const endTs =
      typeof inlineTs === "number"
        ? inlineTs
        : (fromCollapsed?.endTs ?? fromDirect?.ts);
    const app =
      (fromCollapsed?.app && !isPlaceholderHost(fromCollapsed.app)
        ? fromCollapsed.app
        : undefined) ??
      resolveEventHost(fromDirect) ??
      fromCollapsed?.app ??
      fromDirect?.app;

    return { startTs, endTs, app };
  });
}

export function exactStepKey(step: Step): string {
  return `${step.action}:${step.target?.[0]?.kind ?? ""}:${step.target?.[0]?.value ?? ""}`;
}

function splitSequences(
  enriched: EnrichedStep[],
  gapMs: number,
  minRepetitions: number,
  minSteps: number,
): EnrichedStep[][] {
  const initialSeqs: EnrichedStep[][] = [];
  let current: EnrichedStep[] = [];

  const flush = () => {
    if (current.length > 0) {
      initialSeqs.push(current);
      current = [];
    }
  };

  for (const item of enriched) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const prevTs = prev.endTs ?? prev.startTs;
      const currTs = item.startTs ?? item.endTs;
      if (
        typeof prevTs === "number" &&
        typeof currTs === "number" &&
        currTs - prevTs >= gapMs
      ) {
        flush();
      }
    }

    if (item.step.action === "nav") {
      flush();
      continue;
    }

    if (item.step.action === "submit" && item.step.value !== "Enter") {
      current.push(item);
      flush();
      continue;
    }

    current.push(item);
  }
  flush();

  const afterLoopSplit: EnrichedStep[][] = [];
  for (const seq of initialSeqs) {
    if (seq.length === 0) continue;
    const hasSubmit = seq.some(
      (s) => s.step.action === "submit" && s.step.value !== "Enter",
    );
    if (!hasSubmit) {
      const firstKey = exactStepKey(seq[0].step);
      const splitIndices: number[] = [0];
      for (let i = 1; i < seq.length; i++) {
        if (
          exactStepKey(seq[i].step) === firstKey &&
          i - splitIndices[splitIndices.length - 1] >= 2
        ) {
          splitIndices.push(i);
        }
      }

      if (splitIndices.length >= minRepetitions) {
        for (let k = 0; k < splitIndices.length; k++) {
          const start = splitIndices[k];
          const end =
            k + 1 < splitIndices.length ? splitIndices[k + 1] : seq.length;
          afterLoopSplit.push(seq.slice(start, end));
        }
        continue;
      }
    }
    afterLoopSplit.push(seq);
  }

  return afterLoopSplit.filter((seq) => seq.length >= minSteps);
}

function normalizedEditDistance(a: string[], b: string[]): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;

  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n] / maxLen;
}

function isSingleTextSnippetCluster(members: EnrichedStep[][]): boolean {
  const valueTargets = new Set<string>();
  const values: string[] = [];

  for (const member of members) {
    for (const { step } of member) {
      if (
        (step.action === "fill" || step.action === "paste") &&
        typeof step.value === "string"
      ) {
        valueTargets.add(exactStepKey(step));
        values.push(step.value);
      }
    }
  }

  if (valueTargets.size > 1 || values.length < 2) {
    return false;
  }

  let totalSim = 0;
  let pairs = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      totalSim += trigramJaccard(values[i], values[j]);
      pairs += 1;
    }
  }

  const avgSim = pairs > 0 ? totalSim / pairs : 0;
  return avgSim >= 0.8;
}

function selectMedoid(
  members: EnrichedStep[][],
  memberKeys: string[][],
): EnrichedStep[] {
  let bestIdx = 0;
  let bestTotalDist = Number.POSITIVE_INFINITY;

  for (let i = 0; i < members.length; i++) {
    let totalDist = 0;
    for (let j = 0; j < members.length; j++) {
      if (i === j) continue;
      totalDist += normalizedEditDistance(memberKeys[i], memberKeys[j]);
    }

    if (totalDist < bestTotalDist - 1e-9) {
      bestTotalDist = totalDist;
      bestIdx = i;
    } else if (
      Math.abs(totalDist - bestTotalDist) <= 1e-9 &&
      members[i].length < members[bestIdx].length
    ) {
      bestIdx = i;
    }
  }

  return members[bestIdx];
}

function cloneStep(step: Step): Step {
  return {
    action: step.action,
    ...(step.target
      ? { target: step.target.map((loc) => ({ ...loc })) }
      : {}),
    ...(step.value !== undefined
      ? {
          value:
            typeof step.value === "string"
              ? step.value
              : { param: step.value.param },
        }
      : {}),
  };
}

function alignMemberToTemplate(
  member: EnrichedStep[],
  templateSteps: Step[],
): (Step | undefined)[] {
  const used = new Array<boolean>(member.length).fill(false);
  const aligned: (Step | undefined)[] = new Array(templateSteps.length).fill(
    undefined,
  );

  for (let t = 0; t < templateSteps.length; t++) {
    const tKey = exactStepKey(templateSteps[t]);
    for (let s = 0; s < member.length; s++) {
      if (!used[s] && exactStepKey(member[s].step) === tKey) {
        aligned[t] = member[s].step;
        used[s] = true;
        break;
      }
    }
  }

  if (member.length === templateSteps.length) {
    for (let t = 0; t < templateSteps.length; t++) {
      if (
        aligned[t] === undefined &&
        !used[t] &&
        member[t]?.step.action === templateSteps[t].action
      ) {
        aligned[t] = member[t].step;
        used[t] = true;
      }
    }
  }

  return aligned;
}

function deriveCleanParamName(step: Step, fallbackIdx: number): string {
  const raw = step.target?.[0]?.value ?? "";
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return snake.length > 0 ? snake : `param_${fallbackIdx}`;
}

function computeStability(members: EnrichedStep[][]): number {
  const allKeys = new Set<string>();
  for (const member of members) {
    for (const { step } of member) {
      allKeys.add(exactStepKey(step));
    }
  }

  if (allKeys.size === 0) return 1;

  let identicalCount = 0;
  for (const key of allKeys) {
    const appearsInAll = members.every((member) =>
      member.some(({ step }) => exactStepKey(step) === key),
    );
    if (appearsInAll) {
      identicalCount += 1;
    }
  }

  return Number((identicalCount / allKeys.size).toFixed(4));
}

function resolveApps(
  members: EnrichedStep[][],
  events?: Event[],
): { sourceApp: string; destApp: string } {
  const firstMember = members[0] ?? [];
  const memberRealApps = firstMember
    .map((m) => m.app)
    .filter((app): app is string => Boolean(app) && !isPlaceholderHost(app));

  const nonNavEvents = events?.filter((e) => e.type !== "nav") ?? [];
  const fallbackEvents =
    nonNavEvents.length > 0 ? nonNavEvents : (events ?? []);
  const eventRealApps = fallbackEvents
    .map((ev) => resolveEventHost(ev))
    .filter((app): app is string => Boolean(app));
  const allEventRealApps = (events ?? [])
    .map((ev) => resolveEventHost(ev))
    .filter((app): app is string => Boolean(app));

  const fromMemberStart = memberRealApps[0];
  const fromMemberEnd = memberRealApps[memberRealApps.length - 1];
  const fromEventsStart = eventRealApps[0] ?? allEventRealApps[0];
  const fromEventsEnd =
    eventRealApps[eventRealApps.length - 1] ??
    allEventRealApps[allEventRealApps.length - 1];

  const sourceApp =
    fromMemberStart ??
    fromEventsStart ??
    firstMember[0]?.app ??
    fallbackEvents[0]?.app ??
    "browser";
  const destApp =
    fromMemberEnd ??
    fromEventsEnd ??
    firstMember[firstMember.length - 1]?.app ??
    fallbackEvents[fallbackEvents.length - 1]?.app ??
    sourceApp;

  return { sourceApp, destApp };
}

export function detectWorkflows(
  steps: Step[],
  opts?: WorkflowOptions,
): Candidate[] {
  const minRepetitions = opts?.minRepetitions ?? 3;
  const minSteps = opts?.minSteps ?? 3;
  const maxEditDistance = opts?.maxEditDistance ?? 0.2;
  const gapMs = opts?.gapMs ?? 30_000;

  if (steps.length === 0) return [];

  const meta = mapEventsToStepMeta(steps, opts?.events);
  const enriched: EnrichedStep[] = steps.map((step, i) => ({
    step,
    startTs: meta[i]?.startTs,
    endTs: meta[i]?.endTs,
    app: meta[i]?.app,
  }));

  const sequences = splitSequences(enriched, gapMs, minRepetitions, minSteps);
  if (sequences.length < minRepetitions) return [];

  interface SeqCluster {
    repKeys: string[];
    members: EnrichedStep[][];
    memberKeys: string[][];
  }

  const clusters: SeqCluster[] = [];
  for (const seq of sequences) {
    const keys = seq.map((item) => exactStepKey(item.step));
    const existing = clusters.find(
      (cluster) =>
        normalizedEditDistance(cluster.repKeys, keys) <= maxEditDistance,
    );
    if (existing) {
      existing.members.push(seq);
      existing.memberKeys.push(keys);
    } else {
      clusters.push({
        repKeys: keys,
        members: [seq],
        memberKeys: [keys],
      });
    }
  }

  const candidates: Candidate[] = [];

  for (const cluster of clusters) {
    if (cluster.members.length < minRepetitions) continue;
    if (isSingleTextSnippetCluster(cluster.members)) continue;

    const medoid = selectMedoid(cluster.members, cluster.memberKeys);
    const templateSteps = medoid.map((item) => cloneStep(item.step));

    const alignedMembers = cluster.members.map((member) =>
      alignMemberToTemplate(member, templateSteps),
    );

    const params: { name: string; example: string }[] = [];
    const usedParamNames = new Set<string>();
    const vectorToParamName = new Map<string, string>();

    const instances: Workflow["instances"] = cluster.members.map((member) => ({
      startTs: member[0]?.startTs ?? 0,
      endTs: member[member.length - 1]?.endTs ?? member[member.length - 1]?.startTs ?? 0,
      bindings: {},
    }));

    for (let t = 0; t < templateSteps.length; t++) {
      const memberVals = alignedMembers.map((aligned) => {
        const s = aligned[t];
        return typeof s?.value === "string" ? s.value : undefined;
      });

      const stringVals = memberVals.filter(
        (v): v is string => typeof v === "string",
      );
      const distinctVals = new Set(stringVals);
      if (distinctVals.size <= 1) continue;

      const vecKey = JSON.stringify(memberVals.map((v) => v ?? ""));
      let paramName = vectorToParamName.get(vecKey);

      if (!paramName) {
        const baseName = deriveCleanParamName(
          templateSteps[t],
          params.length + 1,
        );
        paramName = baseName;
        let suffix = 2;
        while (usedParamNames.has(paramName)) {
          paramName = `${baseName}_${suffix}`;
          suffix += 1;
        }
        usedParamNames.add(paramName);
        vectorToParamName.set(vecKey, paramName);
        params.push({
          name: paramName,
          example: stringVals[0] ?? "",
        });
      }

      templateSteps[t].value = { param: paramName };

      for (let m = 0; m < cluster.members.length; m++) {
        const val = memberVals[m];
        if (val !== undefined) {
          instances[m].bindings[paramName] = val;
        }
      }
    }

    const stability = computeStability(cluster.members);
    const id =
      "wf_" +
      createHash("sha256")
        .update(templateSteps.map(exactStepKey).join("|"))
        .digest("hex")
        .slice(0, 8);
    const { sourceApp, destApp } = resolveApps(cluster.members, opts?.events);
    const repetitions = cluster.members.length;
    const minutesPerWeek = Number(
      ((repetitions * templateSteps.length * 2) / 60).toFixed(2),
    );
    const name =
      sourceApp !== destApp
        ? `${sourceApp} -> ${destApp} (${templateSteps.length} steps)`
        : `${sourceApp} workflow (${templateSteps.length} steps)`;

    candidates.push({
      workflow: {
        id,
        name,
        sourceApp,
        destApp,
        steps: templateSteps,
        params,
        instances,
      },
      repetitions,
      minutesPerWeek,
      stability,
    });
  }

  return candidates;
}
