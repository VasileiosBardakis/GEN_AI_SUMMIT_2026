import type { ActionScript, Locator, Step } from "./types.ts";

export type BlockedStep = {
  step: Step;
  reason: string;
};

export type SafetyResult = {
  script: ActionScript;
  blockedSteps: BlockedStep[];
};

const IRREVERSIBLE_CLICK_RE =
  /\b(send|submit|delete|remove|destroy|pay|checkout|purchase|confirm|place\s+order|complete\s+order|authorize)\b/i;

const SUBMIT_SELECTOR_RE = /\[type\s*=\s*["']?submit["']?\]/i;

const SENSITIVE_TARGET_RE =
  /\b(password|passwd|passcode|cvv|cvc|card[-_\s]?number|credit[-_\s]?card|cc-number|cc-csc|iban|ssn)\b|type\s*=\s*["']?password["']?/i;

const REDACTED_TOKEN_RE = /\[REDACTED:/i;

function targetMatches(target: Locator | undefined, pattern: RegExp): boolean {
  return Boolean(target && pattern.test(target.value));
}

function getBlockReason(step: Step): string | null {
  if (step.action === "click") {
    if (
      targetMatches(step.target, SUBMIT_SELECTOR_RE) ||
      targetMatches(step.target, IRREVERSIBLE_CLICK_RE)
    ) {
      return `Blocked irreversible click target "${step.target.value}"`;
    }
    return null;
  }

  if (
    step.action === "fill" ||
    step.action === "insertText" ||
    step.action === "select" ||
    step.action === "readText" ||
    step.action === "readValue"
  ) {
    if (targetMatches(step.target, SENSITIVE_TARGET_RE)) {
      return `Blocked sensitive field target "${step.target?.value ?? ""}"`;
    }
    if ("value" in step && REDACTED_TOKEN_RE.test(step.value)) {
      return "Blocked redacted secret value";
    }
    return null;
  }

  if (step.action === "extractList") {
    if (targetMatches(step.target, SENSITIVE_TARGET_RE)) {
      return `Blocked sensitive list target "${step.target.value}"`;
    }
    if (step.fields) {
      for (const [fieldName, locator] of Object.entries(step.fields)) {
        if (SENSITIVE_TARGET_RE.test(fieldName) || targetMatches(locator, SENSITIVE_TARGET_RE)) {
          return `Blocked sensitive extractList field "${fieldName}"`;
        }
      }
    }
    return null;
  }

  return null;
}

function sanitizeSteps(
  steps: Step[],
  blockedSteps: BlockedStep[],
): Step[] {
  const safeSteps: Step[] = [];

  for (const step of steps) {
    if (step.action === "forEach") {
      const nestedSafe = sanitizeSteps(step.steps, blockedSteps);
      if (nestedSafe.length > 0) {
        safeSteps.push({ ...step, steps: nestedSafe });
      }
      continue;
    }

    const reason = getBlockReason(step);
    if (reason) {
      blockedSteps.push({ step, reason });
      continue;
    }

    safeSteps.push(step);
  }

  return safeSteps;
}

export function sanitizeActionScript(script: ActionScript): SafetyResult {
  const blockedSteps: BlockedStep[] = [];
  const safeSteps = sanitizeSteps(script.steps, blockedSteps);
  return {
    script: {
      ...(script.name ? { name: script.name } : {}),
      steps: safeSteps,
    },
    blockedSteps,
  };
}
