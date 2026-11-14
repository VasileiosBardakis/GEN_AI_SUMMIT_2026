import crypto from "node:crypto";
import type { Finding, Verdict } from "@gen/shared";
import type { ActionScript } from "./hands/types.ts";

export type HandsDecision = "approved" | "dismissed";

export type HandsOutcome = {
  ok: boolean;
  results?: unknown;
  decision?: HandsDecision;
  error?: string;
};

export type ScriptMap = ReadonlyMap<string, ActionScript> | Record<string, ActionScript>;

export type ProposerReportResult = {
  findings: Finding[];
  scripts: ScriptMap;
};

export type ProposerDeps = {
  runReport: (sessionId: string) => Promise<ProposerReportResult>;
  requestDecision: (
    name: string,
    solution: string,
    script: ActionScript,
  ) => Promise<HandsOutcome>;
  runScript: (script: ActionScript) => Promise<HandsOutcome>;
  debounceMs?: number;
  log?: (line: string) => void;
};

export type Proposer = {
  onEvents: (sessionId: string) => void;
  close: () => void;
};

const DEFAULT_DEBOUNCE_MS = 2500;

function lookupScript(scripts: ScriptMap, findingId: string): ActionScript | undefined {
  if (typeof (scripts as ReadonlyMap<string, ActionScript>).get === "function") {
    return (scripts as ReadonlyMap<string, ActionScript>).get(findingId);
  }
  return (scripts as Record<string, ActionScript>)[findingId];
}

function inferDetector(finding: Finding): string {
  if (finding.workflowId || finding.id.startsWith("wf_")) return "wf";
  if (finding.id.startsWith("snip_")) return "snip";
  if (finding.id.startsWith("short_")) return "short";
  if (finding.artifact?.kind === "snippet") return "snip";
  return "finding";
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function collectStepSignatures(steps: ActionScript["steps"], verdict: Verdict): string[] {
  const parts: string[] = [];
  for (const step of steps) {
    if (step.action === "forEach") {
      parts.push(`forEach:${step.items}`);
      parts.push(...collectStepSignatures(step.steps, verdict));
      continue;
    }
    const target = "target" in step && step.target ? step.target : undefined;
    const loc = target ? `${target.kind}:${target.value}` : "";
    if (verdict === "rung1" || !target) {
      const rawVal =
        "value" in step && typeof step.value === "string"
          ? step.value
          : "url" in step && typeof step.url === "string"
            ? step.url
            : "";
      const text = normalizeText(rawVal);
      parts.push(`${step.action}:${loc}:${text}`);
    } else {
      parts.push(`${step.action}:${loc}`);
    }
  }
  return parts;
}

export function buildFindingKey(finding: Finding, script: ActionScript): string {
  const detector = inferDetector(finding);
  const parts = collectStepSignatures(script.steps, finding.verdict);
  const hash = crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `${detector}:${finding.verdict}:${hash}`;
}

export function createProposer(deps: ProposerDeps): Proposer {
  const debounceMs =
    typeof deps.debounceMs === "number" &&
    Number.isFinite(deps.debounceMs) &&
    deps.debounceMs >= 0
      ? deps.debounceMs
      : DEFAULT_DEBOUNCE_MS;

  const safeLog = (line: string): void => {
    try {
      (deps.log ?? ((msg: string) => console.log(msg)))(line);
    } catch {
      // Never let logging errors propagate
    }
  };

  const proposedKeys = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  async function proposeFinding(finding: Finding, script: ActionScript): Promise<void> {
    const name = finding.title.trim() || script.name?.trim() || "Proposed automation";
    const solution = finding.why.trim() || name;

    let outcome: HandsOutcome;
    try {
      outcome = await deps.requestDecision(name, solution, script);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeLog(`[propose] ${name} -> error: ${message}`);
      return;
    }

    if (closed) return;

    if (outcome.ok && outcome.decision === "approved") {
      safeLog(`[propose] ${name} -> approved`);
      try {
        const runOutcome = await deps.runScript(script);
        safeLog(`[propose] ${name} -> ${runOutcome.ok ? "run ok" : "run failed"}`);
      } catch {
        safeLog(`[propose] ${name} -> run failed`);
      }
      return;
    }

    if (outcome.decision === "dismissed") {
      safeLog(`[propose] ${name} -> dismissed`);
      return;
    }

    if (!outcome.ok && /timed?\s*out/i.test(outcome.error ?? "")) {
      safeLog(`[propose] ${name} -> timeout`);
      return;
    }

    safeLog(`[propose] ${name} -> dismissed`);
  }

  async function processSession(sessionId: string): Promise<void> {
    if (closed) return;

    let reportResult: ProposerReportResult;
    try {
      reportResult = await deps.runReport(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeLog(`[propose] report failed for ${sessionId}: ${message}`);
      return;
    }

    const findings = Array.isArray(reportResult?.findings) ? reportResult.findings : [];
    const scripts = reportResult?.scripts;
    if (!scripts) return;

    for (const finding of findings) {
      if (closed) return;
      if (finding.verdict !== "rung1" && finding.verdict !== "rung2") {
        continue;
      }
      const script = lookupScript(scripts, finding.id);
      if (!script) {
        continue;
      }
      const key = buildFindingKey(finding, script);
      if (proposedKeys.has(key)) {
        continue;
      }
      proposedKeys.add(key);
      await proposeFinding(finding, script);
    }
  }

  function onEvents(sessionId: string): void {
    if (closed || !sessionId) return;
    const existing = timers.get(sessionId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      if (closed) return;
      queue = queue
        .then(() => processSession(sessionId))
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          safeLog(`[propose] unexpected error: ${message}`);
        });
    }, debounceMs);
    timers.set(sessionId, timer);
  }

  function close(): void {
    closed = true;
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  }

  return { onEvents, close };
}
