import type { Event, Step } from "@gen/shared";
import { normalize } from "./normalize.ts";

export type SplitStream = {
  key: string;
  tab: string;
  host: string;
  events: Event[];
  steps: Step[];
};

export type SplitStreamsOptions = {
  includeEmptySteps?: boolean;
};

export function extractHost(event: Event): string {
  if (event.url) {
    try {
      const hostname = new URL(event.url).hostname;
      if (hostname.length > 0) {
        return hostname;
      }
    } catch {
      // Fall back to event.app when event.url is malformed.
    }
  }
  return event.app;
}

export function extractTab(event: Event): string {
  const tabId = event.meta?.tabId;
  if (typeof tabId === "number" && Number.isFinite(tabId)) {
    return String(tabId);
  }
  if (typeof tabId === "string" && tabId.trim().length > 0) {
    return tabId;
  }

  if (typeof event.window === "string") {
    const trimmed = event.window.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return "default";
}

export function splitStreams(
  events: Event[],
  opts?: SplitStreamsOptions,
): SplitStream[] {
  const groups = new Map<
    string,
    { key: string; tab: string; host: string; events: Event[] }
  >();

  for (const event of events) {
    const tab = extractTab(event);
    const host = extractHost(event);
    const key = `${tab}::${host}`;

    let group = groups.get(key);
    if (!group) {
      group = { key, tab, host, events: [] };
      groups.set(key, group);
    }
    group.events.push(event);
  }

  const includeEmptySteps = opts?.includeEmptySteps === true;
  const streams: SplitStream[] = [];

  for (const group of groups.values()) {
    const steps = normalize(group.events);
    if (steps.length === 0 && !includeEmptySteps) {
      continue;
    }
    streams.push({
      key: group.key,
      tab: group.tab,
      host: group.host,
      events: group.events,
      steps,
    });
  }

  return streams;
}
