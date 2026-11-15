import type { V2Action, V2Step } from "./steps.ts";

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

export function countRepeatedPatterns(
  steps: V2Step[],
  opts?: {
    minRepeats?: number;
    minLen?: number;
    maxLen?: number;
    idleGapMs?: number;
  },
): RepeatedPattern[] {
  const minRepeats = opts?.minRepeats ?? 3;
  const minLen = Math.max(1, opts?.minLen ?? 2);
  const maxLen = Math.max(minLen, opts?.maxLen ?? 8);
  const idleGapMs = opts?.idleGapMs ?? 30_000;

  const episodes = splitEpisodes(steps, idleGapMs);
  if (episodes.length === 0) return [];

  const countsBySession = new Map<
    string,
    Map<string, { actions: V2Action[]; count: number }>
  >();

  for (const episode of episodes) {
    let sessionCounts = countsBySession.get(episode.session);
    if (!sessionCounts) {
      sessionCounts = new Map();
      countsBySession.set(episode.session, sessionCounts);
    }

    const actions = episode.steps.map((s) => s.action);
    const n = actions.length;
    const upperLen = Math.min(maxLen, n);

    for (let len = minLen; len <= upperLen; len++) {
      const nextAllowedIdx = new Map<string, number>();

      for (let i = 0; i <= n - len; i++) {
        const slice = actions.slice(i, i + len);
        const signature = slice.join("->");
        const allowedFrom = nextAllowedIdx.get(signature) ?? 0;
        if (i < allowedFrom) continue;

        nextAllowedIdx.set(signature, i + len);
        const entry = sessionCounts.get(signature);
        if (entry) {
          entry.count += 1;
        } else {
          sessionCounts.set(signature, { actions: slice, count: 1 });
        }
      }
    }
  }

  const bestBySignature = new Map<string, RepeatedPattern>();
  for (const sessionCounts of countsBySession.values()) {
    for (const [signature, entry] of sessionCounts.entries()) {
      if (entry.count < minRepeats) continue;
      const existing = bestBySignature.get(signature);
      if (!existing || entry.count > existing.count) {
        bestBySignature.set(signature, {
          signature,
          actions: entry.actions,
          count: entry.count,
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
