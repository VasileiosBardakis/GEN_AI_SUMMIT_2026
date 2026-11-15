import type { V2Action, V2Step } from "./steps.ts";
import { normalizeHost } from "./validate.ts";

export const DEFAULT_REPEAT_COUNT = 3;

export function resolveRepeatCount(): number {
  const n = Number(process.env.REPEAT_COUNT);
  return Number.isInteger(n) && n >= 2 ? n : DEFAULT_REPEAT_COUNT;
}

function stepSignaturePart(step: V2Step): string {
  const host = step.app ? normalizeHost(step.app) : "";
  return host ? `${step.action}@${host}` : step.action;
}

export type Episode = {
  session: string;
  steps: V2Step[];
  startTs: number;
  endTs: number;
};

export type RepeatedPattern = {
  signature: string;
  actions: V2Action[];
  count: number;
};

export type PatternInstance = {
  startTs: number;
  endTs: number;
  steps: V2Step[];
  bindings: Record<string, string>;
};

export type PatternCandidate = {
  signature: string;
  actions: V2Action[];
  count: number;
  apps: string[];
  instances: PatternInstance[];
};

function buildBindings(matchedSteps: V2Step[]): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (let idx = 0; idx < matchedSteps.length; idx++) {
    const value = matchedSteps[idx].value;
    if (typeof value === "string" && value.length > 0) {
      bindings[`step_${idx}`] = value;
    }
  }
  return bindings;
}

function collectApps(instances: PatternInstance[]): string[] {
  const apps: string[] = [];
  const seen = new Set<string>();
  for (const instance of instances) {
    for (const step of instance.steps) {
      if (step.app.length > 0 && !seen.has(step.app)) {
        seen.add(step.app);
        apps.push(step.app);
      }
    }
  }
  return apps;
}

export function splitEpisodes(
  steps: V2Step[],
  idleGapMs = 30_000,
): Episode[] {
  if (steps.length === 0) return [];

  const episodes: Episode[] = [];
  let current: V2Step[] = [steps[0]];

  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    const curr = steps[i];
    if (curr.session !== prev.session || curr.ts - prev.ts >= idleGapMs) {
      episodes.push({
        session: current[0].session,
        steps: current,
        startTs: current[0].ts,
        endTs: current[current.length - 1].ts,
      });
      current = [curr];
    } else {
      current.push(curr);
    }
  }

  episodes.push({
    session: current[0].session,
    steps: current,
    startTs: current[0].ts,
    endTs: current[current.length - 1].ts,
  });

  return episodes;
}

const TRANSITION_ONLY_ACTIONS = new Set<V2Action>(["nav", "tab_switch"]);

function maxSharedPrimaryTargetCount(
  instances: readonly PatternInstance[],
): number {
  if (instances.length === 0) return 0;
  const stepCount = instances[0].steps.length;
  let hasAnyTarget = false;
  let maxShared = 0;

  for (let j = 0; j < stepCount; j++) {
    const counts = new Map<string, number>();
    for (const inst of instances) {
      const primary = inst.steps[j]?.target?.[0];
      if (!primary) continue;
      hasAnyTarget = true;
      const key = `${primary.kind}:${primary.value}`;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next > maxShared) {
        maxShared = next;
      }
    }
  }

  return hasAnyTarget ? maxShared : instances.length;
}

export function detectRepeatedCandidates(
  steps: V2Step[],
  opts?: {
    minRepeats?: number;
    minLen?: number;
    maxLen?: number;
    idleGapMs?: number;
  },
): PatternCandidate[] {
  const minRepeats = opts?.minRepeats ?? resolveRepeatCount();
  const minLen = Math.max(1, opts?.minLen ?? 2);
  const maxLen = Math.max(minLen, opts?.maxLen ?? 64);
  const idleGapMs = opts?.idleGapMs ?? 30_000;

  const episodes = splitEpisodes(steps, idleGapMs);
  if (episodes.length === 0) return [];

  const sessionTotalSteps = new Map<string, number>();
  for (const episode of episodes) {
    sessionTotalSteps.set(
      episode.session,
      (sessionTotalSteps.get(episode.session) ?? 0) + episode.steps.length,
    );
  }

  const candidatesBySession = new Map<
    string,
    Map<string, { actions: V2Action[]; instances: PatternInstance[] }>
  >();

  for (const episode of episodes) {
    let sessionCandidates = candidatesBySession.get(episode.session);
    if (!sessionCandidates) {
      sessionCandidates = new Map();
      candidatesBySession.set(episode.session, sessionCandidates);
    }

    const n = episode.steps.length;
    const totalInSession = sessionTotalSteps.get(episode.session) ?? n;
    const upperLen = Math.min(maxLen, n, Math.floor(totalInSession / minRepeats));

    for (let len = minLen; len <= upperLen; len++) {
      const nextAllowedIdx = new Map<string, number>();

      for (let i = 0; i <= n - len; i++) {
        const matchedSteps = episode.steps.slice(i, i + len);
        const actions = matchedSteps.map((s) => s.action);
        const signature = matchedSteps.map(stepSignaturePart).join("->");
        const allowedFrom = nextAllowedIdx.get(signature) ?? 0;
        if (i < allowedFrom) continue;

        nextAllowedIdx.set(signature, i + len);
        const instance: PatternInstance = {
          startTs: matchedSteps[0].ts,
          endTs: matchedSteps[matchedSteps.length - 1].ts,
          steps: matchedSteps,
          bindings: buildBindings(matchedSteps),
        };

        const entry = sessionCandidates.get(signature);
        if (entry) {
          entry.instances.push(instance);
        } else {
          sessionCandidates.set(signature, {
            actions,
            instances: [instance],
          });
        }
      }
    }
  }

  const bestBySignature = new Map<string, PatternCandidate>();
  for (const sessionCandidates of candidatesBySession.values()) {
    for (const [signature, entry] of sessionCandidates.entries()) {
      if (entry.actions.every((a) => TRANSITION_ONLY_ACTIONS.has(a))) continue;
      const count = entry.instances.length;
      if (count < minRepeats) continue;
      if (maxSharedPrimaryTargetCount(entry.instances) < minRepeats) continue;
      const existing = bestBySignature.get(signature);
      if (!existing || count > existing.count) {
        bestBySignature.set(signature, {
          signature,
          actions: entry.actions,
          count,
          apps: collectApps(entry.instances),
          instances: entry.instances,
        });
      }
    }
  }

  return Array.from(bestBySignature.values()).sort(
    (a, b) =>
      b.count - a.count ||
      b.actions.length - a.actions.length ||
      a.signature.localeCompare(b.signature),
  );
}

export function countRepeatedPatterns(
  steps: V2Step[],
  opts?: {
    minRepeats?: number;
    minLen?: number;
    maxLen?: number;
    idleGapMs?: number;
  },
): RepeatedPattern[] {
  return detectRepeatedCandidates(steps, opts).map((candidate) => ({
    signature: candidate.signature,
    actions: candidate.actions,
    count: candidate.count,
  }));
}
