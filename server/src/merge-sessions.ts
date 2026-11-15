import type { Event } from "@gen/shared";

export type MergeSessionsConfig = {
  gapMs: number;
};

export const DEFAULT_MERGE_SESSIONS_CONFIG: MergeSessionsConfig = {
  gapMs: 10 * 60_000,
};

export type MergedSession = {
  session: string;
  events: Event[];
};

export type EventsBySession =
  | ReadonlyArray<ReadonlyArray<Event>>
  | ReadonlyMap<string, ReadonlyArray<Event>>
  | Record<string, ReadonlyArray<Event>>;

function collectSessionLists(
  eventsBySession: EventsBySession,
): ReadonlyArray<ReadonlyArray<Event>> {
  if (Array.isArray(eventsBySession)) {
    return eventsBySession;
  }
  if (eventsBySession instanceof Map) {
    return Array.from(eventsBySession.values());
  }
  return Object.values(eventsBySession as Record<string, ReadonlyArray<Event>>);
}

export function mergeSessions(
  eventsBySession: EventsBySession,
  config: Partial<MergeSessionsConfig> = {},
): MergedSession[] {
  const { gapMs = DEFAULT_MERGE_SESSIONS_CONFIG.gapMs } = config;
  const sessionLists = collectSessionLists(eventsBySession);

  const indexed: Array<{ event: Event; index: number }> = [];
  let index = 0;
  for (const events of sessionLists) {
    for (const event of events) {
      indexed.push({ event, index: index++ });
    }
  }

  if (indexed.length === 0) {
    return [];
  }

  indexed.sort((a, b) => a.event.ts - b.event.ts || a.index - b.index);

  const groups: Event[][] = [];
  let currentGroup: Event[] = [indexed[0].event];

  for (let i = 1; i < indexed.length; i++) {
    const prev = indexed[i - 1].event;
    const curr = indexed[i].event;
    if (curr.ts - prev.ts > gapMs) {
      groups.push(currentGroup);
      currentGroup = [curr];
    } else {
      currentGroup.push(curr);
    }
  }
  groups.push(currentGroup);

  return groups.map((groupEvents) => {
    const session = `merged_${groupEvents[0].ts}`;
    return {
      session,
      events: groupEvents.map((event) => ({
        ...event,
        session,
      })),
    };
  });
}

export function mergeWithinSession(
  eventsBySession: EventsBySession,
): MergedSession[] {
  const sessionLists = collectSessionLists(eventsBySession);
  const bySession = new Map<string, Array<{ event: Event; index: number }>>();

  let index = 0;
  for (const events of sessionLists) {
    for (const event of events) {
      let bucket = bySession.get(event.session);
      if (!bucket) {
        bucket = [];
        bySession.set(event.session, bucket);
      }
      bucket.push({ event, index: index++ });
    }
  }

  const result: MergedSession[] = [];
  for (const [session, indexed] of bySession.entries()) {
    indexed.sort((a, b) => a.event.ts - b.event.ts || a.index - b.index);
    result.push({
      session,
      events: indexed.map((item) => ({ ...item.event })),
    });
  }

  return result;
}
