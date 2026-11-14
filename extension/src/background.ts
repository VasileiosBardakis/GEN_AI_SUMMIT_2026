import { executeStep } from "./hands/execute.js";
import type { BindingValue, DomStep, Plan, Step, StepResult } from "./types.js";

const DEMO_PLAN: Plan = {
  name: "Demo",
  steps: [{ action: "insertText", value: "Hello from Hands" }],
};

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void runPlan(tab.id, DEMO_PLAN).catch((error: unknown) => {
    console.error("Hands plan failed", error);
  });
});

async function runPlan(tabId: number, plan: Plan): Promise<void> {
  const bindings: Record<string, BindingValue> = {};
  await runSteps(tabId, plan.steps, bindings, {});
}

async function runSteps(
  tabId: number,
  steps: Step[],
  bindings: Record<string, BindingValue>,
  scope: Record<string, unknown>,
): Promise<void> {
  for (const rawStep of steps) {
    let step: Step;
    try {
      step = substitute(rawStep, { ...bindings, ...scope }) as Step;
    } catch (error) {
      if (rawStep.optional) continue;
      throw error;
    }

    try {
      if (step.action === "navigate") {
        await chrome.tabs.update(tabId, { url: step.url });
        await waitForTabLoad(tabId);
        continue;
      }

      if (step.action === "wait") {
        await sleep(step.ms);
        continue;
      }

      if (step.action === "forEach") {
        const items = Array.isArray(step.items) ? step.items : bindings[step.items];
        if (!Array.isArray(items)) throw new Error(`No array binding: ${step.items}`);
        for (const item of items) {
          await runSteps(tabId, step.steps, bindings, { ...scope, ...item, item });
        }
        continue;
      }

      const result = await executeDomStep(tabId, step);
      if (!result.ok) {
        if (step.optional) continue;
        throw new Error(result.error ?? "Step failed");
      }

      if (step.action === "readText" || step.action === "readValue") {
        bindings[step.bind] = result.value ?? "";
      }

      if (step.action === "extractList") {
        bindings[step.bind] = result.items ?? [];
      }
    } catch (error) {
      if (step.optional) continue;
      throw error;
    }
  }
}

async function executeDomStep(tabId: number, step: DomStep): Promise<StepResult> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: executeStep,
    args: [step],
  });
  if (!injection?.result) throw new Error("Executor returned no result");
  return injection.result;
}

function substitute<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === "string") return substituteString(value, vars) as T;
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars)) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = substitute(child, vars);
    }
    return result as T;
  }
  return value;
}

function substituteString(value: string, vars: Record<string, unknown>): unknown {
  const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
  if (whole) return lookup(vars, whole[1]);
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    const found = lookup(vars, path);
    return found === undefined ? "" : String(found);
  });
}

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let current: unknown = vars;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for page load")), 30000);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish();
      })
      .catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error("Failed to read tab"));
      });
  });
}
