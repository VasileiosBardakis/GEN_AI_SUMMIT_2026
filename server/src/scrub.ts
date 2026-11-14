import type { Event } from "@gen/shared";

const PASSWORD_PREFIX = "[REDACTED:PASSWORD";
const SENSITIVE_URL_PARAM_RE =
  /(?<=[?&#])(access_token|id_token|refresh_token|code|token|key|secret|password)=([^&#]*)/gi;

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isPasswordInput(event: Event): boolean {
  return (
    event.type === "input" &&
    typeof event.value === "string" &&
    event.value.startsWith(PASSWORD_PREFIX)
  );
}

function passwordInputKey(event: Event): string {
  return `${event.session}::${event.target?.locators.map((l) => `${l.kind}:${l.value}`).join("|") ?? ""}`;
}

export function scrubEvents(events: Event[]): Event[] {
  const lastPasswordIndex = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (isPasswordInput(event)) {
      lastPasswordIndex.set(passwordInputKey(event), i);
    }
  }

  const result: Event[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (isPasswordInput(event)) {
      if (lastPasswordIndex.get(passwordInputKey(event)) === i) {
        result.push(event);
      }
      continue;
    }

    if (event.type === "nav" && typeof event.value === "string" && isValidUrl(event.value)) {
      const scrubbedValue = event.value.replace(SENSITIVE_URL_PARAM_RE, "$1=[REDACTED]");
      result.push(scrubbedValue !== event.value ? { ...event, value: scrubbedValue } : event);
      continue;
    }

    result.push(event);
  }

  return result;
}
