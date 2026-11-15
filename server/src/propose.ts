import crypto from "node:crypto";
import type { Event, Finding, Verdict } from "@gen/shared";
import { normalizeText } from "./common/target.ts";
import { toLocatorList, type ActionScript } from "./hands/types.ts";
import type { WorkflowIrisJudgment } from "./llm/iris.ts";
import {
  compiledWorkflowToActionScript,
  compiledWorkflowToFinding,
} from "./report.ts";
export type FlowTip = {
  tip: string;
  keys?: string[];
};
import {
  buildMeaningfulWindow,
  eventsToSteps,
  normalizeHost,
  type CompileInput,
  type CompiledWorkflow,
} from "./v2/index.ts";

export type HandsDecision = "approved" | "dismissed";

export type HandsOutcome = {
  ok: boolean;
  results?: unknown;
  decision?: HandsDecision;
  params?: Record<string, string>;
  error?: string;
};

export type PrecheckStepOutcome = {
  index?: number;
  action?: string;
  ok?: boolean;
  matchCount: number;
  unique?: boolean;
  error?: string;
};

export type PrecheckOutcome = {
  ok: boolean;
  results?: unknown;
  error?: string;
};

export type StageLogName =
  | "detect"
  | "precheck"
  | "decide"
  | "save_skill"
  | "run"
  | "recall_match";

export type StageLogEvent = {
  stage: StageLogName;
  session: string;
  ts: number;
  [key: string]: unknown;
};

export type ScriptMap = ReadonlyMap<string, ActionScript> | Record<string, ActionScript>;

export type ProposerReportResult = {
  findings: Finding[];
  scripts: ScriptMap;
};

export type ProposerDeps = {
  requestDecision: (
    name: string,
    solution: string,
    script: ActionScript,
    primaryLabel?: string,
  ) => Promise<HandsOutcome>;
  runScript: (
    script: ActionScript,
    params?: Record<string, string>,
  ) => Promise<HandsOutcome>;
  log?: (line: string) => void;
  readSessionEvents: (sessionId: string) => Promise<Event[]>;
  judgeIris?: (digest: Record<string, unknown>) => Promise<WorkflowIrisJudgment | null>;
  compileV2: (
    input: CompileInput,
    opts?: { irisJudgment?: WorkflowIrisJudgment | null },
  ) => Promise<CompiledWorkflow | null>;
  suggestFlowTip?: (events: Event[]) => Promise<FlowTip | null>;
  precheck?: (script: ActionScript, meta: { startUrl?: string }) => Promise<PrecheckOutcome>;
  onCompiled?: (info: {
    sessionId: string;
    finding: Finding;
    script: ActionScript;
    workflow: CompiledWorkflow;
  }) => void;
  onApproved?: (info: {
    sessionId: string;
    script: ActionScript;
    workflow?: CompiledWorkflow;
    finding: Finding;
  }) => Promise<{ shouldRun?: boolean } | void>;
  now?: () => number;
  stageLog?: (event: StageLogEvent) => void;
};

export type Proposer = {
  onEvents: (sessionId: string) => void;
  close: () => void;
};

function inferDetector(finding: Finding): string {
  if (finding.workflowId || finding.id.startsWith("wf_")) return "wf";
  if (finding.id.startsWith("snip_")) return "snip";
  if (finding.artifact?.kind === "snippet") return "snip";
  return "finding";
}

export function collectFlatSteps(steps: ActionScript["steps"]): ActionScript["steps"] {
  const flat: ActionScript["steps"] = [];
  for (const step of steps) {
    if (step.action === "forEach") {
      flat.push(...collectFlatSteps(step.steps));
    } else {
      flat.push(step);
    }
  }
  return flat;
}

function collectStepSignatures(steps: ActionScript["steps"], verdict: Verdict): string[] {
  const parts: string[] = [];
  for (const step of steps) {
    if (step.action === "forEach") {
      parts.push(`forEach:${step.items}`);
      parts.push(...collectStepSignatures(step.steps, verdict));
      continue;
    }
    const target = "target" in step ? toLocatorList(step.target)[0] : undefined;
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

function isPrecheckPassed(outcome: PrecheckOutcome | HandsOutcome): boolean {
  if (!outcome.ok) return false;
  const results = outcome.results;
  if (results === undefined) return true;
  if (Array.isArray(results)) {
    return results.every((item) => {
      if (!item || typeof item !== "object") return false;
      const rec = item as { ok?: unknown; matchCount?: unknown };
      if (rec.ok === false) return false;
      if (typeof rec.matchCount !== "number") return false;
      return rec.matchCount === 1;
    });
  }
  if (typeof results === "object" && results !== null && "matchCount" in results) {
    const rec = results as { ok?: unknown; matchCount?: unknown };
    return rec.ok !== false && rec.matchCount === 1;
  }
  return false;
}

function extractSiteHost(
  compiled: CompiledWorkflow,
  script: ActionScript,
  events: readonly Event[],
): string {
  if (compiled.startUrl) {
    try {
      const host = new URL(compiled.startUrl).hostname;
      if (host) return normalizeHost(host);
    } catch {
      // ignore invalid URL
    }
  }
  if (compiled.apps[0]) {
    return normalizeHost(compiled.apps[0]);
  }
  for (const step of script.steps) {
    if (step.action === "switchTab" && step.host) {
      return normalizeHost(step.host);
    }
    if (step.action === "navigate" && step.url) {
      try {
        const host = new URL(step.url).hostname;
        if (host) return normalizeHost(host);
      } catch {
        // ignore
      }
    }
  }
  const fallbackApp = events[events.length - 1]?.app ?? events[0]?.app ?? "";
  return fallbackApp ? normalizeHost(fallbackApp) : "";
}

export function createProposer(deps: ProposerDeps): Proposer {
  const now = deps.now ?? (() => Date.now());

  const safeLog = (line: string): void => {
    try {
      (deps.log ?? ((msg: string) => console.log(msg)))(line);
    } catch {
      // Never let logging errors propagate
    }
  };

  const emitStageLog = (
    event: { stage: StageLogName; session: string; ts?: number } & Record<string, unknown>,
  ): void => {
    if (!deps.stageLog) return;
    try {
      deps.stageLog({ ...event, ts: event.ts ?? now() });
    } catch {
      // Never let stage logging errors propagate
    }
  };

  const proposedKeys = new Set<string>();
  const inFlightSessions = new Set<string>();
  const pendingRerunSessions = new Set<string>();
  const shownFlowTipsBySession = new Map<string, Set<string>>();
  const flowTipCheckedAt = new Map<string, number>();
  let flowTipPending = false;
  let closed = false;

  async function proposeV2Finding(
    sessionId: string,
    site: string,
    finding: Finding,
    script: ActionScript,
    workflow: CompiledWorkflow,
  ): Promise<void> {
    const name = finding.title.trim() || script.name?.trim() || "Proposed automation";
    const solution = finding.why.trim() || name;
    let shouldRun =
      script.runMode === "run_remaining" || workflow.kind === "snippet";
    let runParams: Record<string, string> | undefined;

    if (shouldRun) {
      const decideScript: ActionScript =
        script.runMode === "save_only"
          ? { ...script, runMode: "run_remaining" }
          : script;
      let outcome: HandsOutcome;
      try {
        outcome = await deps.requestDecision(name, solution, decideScript);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safeLog(`[propose:v2] ${name} -> error: ${message}`);
        emitStageLog({ stage: "decide", session: sessionId, site, decision: "error", error: message, name });
        return;
      }

      if (closed) return;

      if (!outcome.ok || outcome.decision !== "approved") {
        const isTimeout = !outcome.ok && /timed?\s*out/i.test(outcome.error ?? "");
        const decision = outcome.decision === "dismissed" ? "dismissed" : isTimeout ? "timeout" : "dismissed";
        safeLog(`[propose:v2] ${name} -> ${decision}`);
        emitStageLog({ stage: "decide", session: sessionId, site, decision, name });
        return;
      }

      safeLog(`[propose:v2] ${name} -> approved`);
      emitStageLog({ stage: "decide", session: sessionId, site, decision: "approved", name });
      runParams = outcome.params;
    }

    if (deps.onApproved) {
      try {
        const hookRes = await deps.onApproved({
          sessionId,
          script,
          workflow,
          finding,
        });
        if (hookRes && typeof hookRes.shouldRun === "boolean") {
          shouldRun = hookRes.shouldRun;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        safeLog(`[propose:v2] ${name} -> save failed: ${msg}`);
      }
    }

    if (closed) return;

    if (!shouldRun) {
      safeLog(`[propose:v2] ${name} -> saved (save_only)`);
      emitStageLog({
        stage: "run",
        session: sessionId,
        skipped: true,
        reason: "save_only",
        name,
      });
      return;
    }

    try {
      const runOutcome = await deps.runScript(script, runParams);
      safeLog(`[propose:v2] ${name} -> ${runOutcome.ok ? "run ok" : "run failed"}`);
      emitStageLog({ stage: "run", session: sessionId, ok: runOutcome.ok, name });
    } catch {
      safeLog(`[propose:v2] ${name} -> run failed`);
      emitStageLog({ stage: "run", session: sessionId, ok: false, name });
    }
  }

  async function maybeFlowTip(sessionId: string, events: Event[]): Promise<void> {
    if (!deps.suggestFlowTip || flowTipPending) return;
    const lastCheck = flowTipCheckedAt.get(sessionId) ?? 0;
    if (now() - lastCheck < 60_000) return;
    flowTipCheckedAt.set(sessionId, now());

    let suggestion: FlowTip | null;
    try {
      suggestion = await deps.suggestFlowTip(events);
    } catch {
      return;
    }
    if (closed || !suggestion?.tip?.trim()) return;

    const name = suggestion.keys?.join(" → ") || suggestion.tip.trim();
    const key = `${name}::${suggestion.tip.trim()}`;
    let shown = shownFlowTipsBySession.get(sessionId);
    if (!shown) {
      shown = new Set<string>();
      shownFlowTipsBySession.set(sessionId, shown);
    }
    if (shown.has(key)) return;
    shown.add(key);

    flowTipPending = true;
    try {
      await deps.requestDecision(
        name,
        suggestion.tip.trim(),
        { name, steps: [{ action: "wait", ms: 0 }] },
        "Got it",
      );
    } catch {
      // Never let tip delivery affect workflow proposals
    } finally {
      flowTipPending = false;
    }
  }

  async function processSessionV2(sessionId: string): Promise<void> {
    if (closed || !deps.readSessionEvents || !deps.compileV2) return;

    let events: Event[];
    try {
      events = await deps.readSessionEvents(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeLog(`[propose:v2] readSessionEvents failed for ${sessionId}: ${message}`);
      return;
    }
    if (closed || events.length === 0) return;

    if (deps.suggestFlowTip) void maybeFlowTip(sessionId, events);

    const { steps, piiMap } = eventsToSteps(events);
    const window = buildMeaningfulWindow(steps, events);
    if (window.meaningfulCount < 2) return;

    emitStageLog({
      stage: "detect",
      session: sessionId,
      meaningfulCount: window.meaningfulCount,
      windowSteps: window.steps.length,
    });

    let irisJudgment: WorkflowIrisJudgment | null | undefined;
    if (deps.judgeIris) {
      try {
        irisJudgment = await deps.judgeIris(window);
      } catch {
        irisJudgment = null;
      }
      if (closed) return;
      if (irisJudgment?.worthAutomating === false) {
        return;
      }
    }

    let compiled: CompiledWorkflow | null = null;
    try {
      compiled = await deps.compileV2(
        { events, steps, piiMap },
        irisJudgment !== undefined ? { irisJudgment } : undefined,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeLog(`[propose:v2] compile failed for ${sessionId}: ${message}`);
      return;
    }

    if (closed || !compiled) return;

    const finding = compiledWorkflowToFinding(compiled);
    const script = compiledWorkflowToActionScript(compiled);
    deps.onCompiled?.({ sessionId, finding, script, workflow: compiled });

    const sessionScopedKey = `${sessionId}::${buildFindingKey(finding, script)}`;
    if (proposedKeys.has(sessionScopedKey)) {
      return;
    }

    const site = extractSiteHost(compiled, script, events);

    if (deps.precheck) {
      let precheckOutcome: PrecheckOutcome;
      try {
        precheckOutcome = await deps.precheck(script, { startUrl: compiled.startUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safeLog(`[propose:v2] precheck error for ${compiled.name}: ${message}`);
        emitStageLog({
          stage: "precheck",
          session: sessionId,
          passed: false,
          site,
          name: compiled.name,
          error: message,
        });
        return;
      }

      const passed = isPrecheckPassed(precheckOutcome);
      emitStageLog({
        stage: "precheck",
        session: sessionId,
        passed,
        site,
        name: compiled.name,
      });
      if (!passed) {
        safeLog(
          `[propose:v2] precheck blocked popup for ${compiled.name} (${precheckOutcome.error ?? "matchCount !== 1"})`,
        );
        return;
      }
    }

    if (closed) return;

    proposedKeys.add(sessionScopedKey);

    await proposeV2Finding(sessionId, site, finding, script, compiled);
  }

  function runSession(sessionId: string): void {
    if (closed) return;
    inFlightSessions.add(sessionId);
    void processSessionV2(sessionId)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        safeLog(`[propose] unexpected error: ${message}`);
      })
      .finally(() => {
        inFlightSessions.delete(sessionId);
        if (!closed && pendingRerunSessions.delete(sessionId)) {
          runSession(sessionId);
        }
      });
  }

  function onEvents(sessionId: string): void {
    if (closed || !sessionId) return;
    if (inFlightSessions.has(sessionId)) {
      pendingRerunSessions.add(sessionId);
      return;
    }
    runSession(sessionId);
  }

  function close(): void {
    closed = true;
    pendingRerunSessions.clear();
  }

  return { onEvents, close };
}
