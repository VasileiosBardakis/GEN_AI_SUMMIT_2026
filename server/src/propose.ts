import crypto from "node:crypto";
import type { Event, Finding, Verdict } from "@gen/shared";
import { normalizeText, primaryTargetKey } from "./common/target.ts";
import { toLocatorList, type ActionScript } from "./hands/types.ts";
import {
  compiledWorkflowToActionScript,
  compiledWorkflowToFinding,
  pickPrimaryCandidate,
} from "./report.ts";
import { hasRepeatedInteraction, type FlowTip } from "./tips.ts";
import {
  detectRepeatedCandidates,
  eventsToSteps,
  normalizeHost,
  resolveRepeatCount,
  type CompileInput,
  type CompiledWorkflow,
  type PatternInstance,
  type V2Action,
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
  | "precompile"
  | "cache_hit"
  | "diff_recompile"
  | "precheck"
  | "rate_limit"
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
  debounceMs?: number;
  log?: (line: string) => void;
  readSessionEvents: (sessionId: string) => Promise<Event[]>;
  compileV2: (input: CompileInput) => Promise<CompiledWorkflow | null>;
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
  siteCooldownMs?: number;
  now?: () => number;
  stageLog?: (event: StageLogEvent) => void;
};

export type Proposer = {
  onEvents: (sessionId: string) => void;
  close: () => void;
};

const DEFAULT_DEBOUNCE_MS = 2500;
const DEFAULT_SITE_COOLDOWN_MS = 5 * 60 * 1000;

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

type StepConstant = {
  value?: string;
  targetKey?: string;
};

type Rep2CacheEntry = {
  signature: string;
  actions: V2Action[];
  constants: Map<number, StepConstant>;
  compiled: CompiledWorkflow | null;
  stepCount: number;
};

function extractConstantsFromPair(
  instances: readonly PatternInstance[],
  actionCount: number,
): Map<number, StepConstant> {
  const constants = new Map<number, StepConstant>();
  if (instances.length < 2) return constants;
  const inst0 = instances[0];
  const inst1 = instances[1];
  for (let j = 0; j < actionCount; j++) {
    const s0 = inst0.steps[j];
    const s1 = inst1.steps[j];
    if (!s0 || !s1) continue;
    const entry: StepConstant = {};
    if (s0.value !== undefined && s0.value === s1.value) {
      entry.value = s0.value;
    }
    const t0 = primaryTargetKey(s0);
    const t1 = primaryTargetKey(s1);
    if (t0 !== undefined && t0 === t1) {
      entry.targetKey = t0;
    }
    if (entry.value !== undefined || entry.targetKey !== undefined) {
      constants.set(j, entry);
    }
  }
  return constants;
}

function detectConstantDiff(
  constants: ReadonlyMap<number, StepConstant>,
  instances: readonly PatternInstance[],
): string | null {
  for (let i = 2; i < instances.length; i++) {
    const inst = instances[i];
    for (const [stepIdx, expected] of constants.entries()) {
      const step = inst.steps[stepIdx];
      if (!step) return "missing_step";
      if (expected.value !== undefined && step.value !== expected.value) {
        return `constant_value_changed_at_${stepIdx}`;
      }
      if (expected.targetKey !== undefined && primaryTargetKey(step) !== expected.targetKey) {
        return `constant_target_changed_at_${stepIdx}`;
      }
    }
  }
  return null;
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
  const debounceMs =
    typeof deps.debounceMs === "number" &&
    Number.isFinite(deps.debounceMs) &&
    deps.debounceMs >= 0
      ? deps.debounceMs
      : DEFAULT_DEBOUNCE_MS;
  const siteCooldownMs =
    typeof deps.siteCooldownMs === "number" &&
    Number.isFinite(deps.siteCooldownMs) &&
    deps.siteCooldownMs >= 0
      ? deps.siteCooldownMs
      : DEFAULT_SITE_COOLDOWN_MS;
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
  const proposedSignaturesBySession = new Map<string, Set<string>>();
  const rep2Cache = new Map<string, Rep2CacheEntry>();
  const lastSitePopupAt = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queuedSessions = new Set<string>();
  const shownFlowTipsBySession = new Map<string, Set<string>>();
  const flowTipCheckedAt = new Map<string, number>();
  let flowTipPending = false;
  let queue: Promise<void> = Promise.resolve();
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
    if (!hasRepeatedInteraction(events)) return;
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
    const repeatCount = resolveRepeatCount();
    const precompileAt = Math.max(2, repeatCount - 1);
    const candidates = detectRepeatedCandidates(steps, { minRepeats: precompileAt });
    if (candidates.length === 0) return;

    const proposedSigs = proposedSignaturesBySession.get(sessionId);
    const unproposed = proposedSigs
      ? candidates.filter((c) => !proposedSigs.has(c.signature))
      : candidates;
    const candidate = pickPrimaryCandidate(unproposed, repeatCount);
    if (!candidate) return;

    emitStageLog({
      stage: "detect",
      session: sessionId,
      signature: candidate.signature,
      count: candidate.count,
      apps: candidate.apps,
    });

    const cacheKey = `${sessionId}::${candidate.signature}`;
    let compiled: CompiledWorkflow | null = null;

    if (candidate.count < repeatCount) {
      const existingRep2 = rep2Cache.get(cacheKey);
      if (existingRep2 && (existingRep2.compiled !== null || steps.length <= existingRep2.stepCount)) {
        if (!existingRep2.compiled || !existingRep2.compiled.offerAt2) {
          return;
        }
        compiled = {
          ...existingRep2.compiled,
          stats: {
            ...existingRep2.compiled.stats,
            repetitions: candidate.count,
          },
        };
      } else {
        try {
          compiled = await deps.compileV2({
            events,
            steps,
            piiMap,
            repeatCount: candidate.count,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          safeLog(`[propose:v2] rep-${candidate.count} precompile failed for ${sessionId}: ${message}`);
          return;
        }

        rep2Cache.set(cacheKey, {
          signature: candidate.signature,
          actions: candidate.actions,
          constants: extractConstantsFromPair(
            candidate.instances,
            candidate.actions.length,
          ),
          compiled,
          stepCount: steps.length,
        });

        safeLog(
          `[propose:v2] rep-${candidate.count} precompile session=${sessionId} sig=${candidate.signature} offerAt2=${Boolean(compiled?.offerAt2)} name=${compiled?.name ?? "none"}`,
        );
        emitStageLog({
          stage: "precompile",
          session: sessionId,
          repeatCount: candidate.count,
          signature: candidate.signature,
          offerAt2: Boolean(compiled?.offerAt2),
          compiled: Boolean(compiled),
          ...(compiled ? { name: compiled.name } : {}),
        });

        if (!compiled || !compiled.offerAt2) {
          return;
        }
      }
    } else {
      const cached = rep2Cache.get(cacheKey);
      if (cached && cached.compiled) {
        const diffReason = detectConstantDiff(cached.constants, candidate.instances);
        if (diffReason === null) {
          compiled = {
            ...cached.compiled,
            stats: {
              ...cached.compiled.stats,
              repetitions: candidate.count,
            },
          };
          safeLog(
            `[propose:v2] rep-${candidate.count} cache hit session=${sessionId} name=${compiled.name}`,
          );
          emitStageLog({
            stage: "cache_hit",
            session: sessionId,
            repeatCount: candidate.count,
            signature: candidate.signature,
            name: compiled.name,
          });
        } else {
          safeLog(
            `[propose:v2] rep-${candidate.count} diff recompile (${diffReason}) session=${sessionId}`,
          );
          emitStageLog({
            stage: "diff_recompile",
            session: sessionId,
            repeatCount: candidate.count,
            signature: candidate.signature,
            reason: diffReason,
          });
          try {
            compiled = await deps.compileV2({
              events,
              steps,
              piiMap,
              repeatCount: candidate.count,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            safeLog(`[propose:v2] recompile failed for ${sessionId}: ${message}`);
            return;
          }
        }
      } else {
        try {
          compiled = await deps.compileV2({
            events,
            steps,
            piiMap,
            repeatCount: candidate.count,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          safeLog(`[propose:v2] compile failed for ${sessionId}: ${message}`);
          return;
        }
      }
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
    const willShowPopup =
      script.runMode === "run_remaining" || compiled.kind === "snippet";

    const nowMs = now();
    if (willShowPopup && site) {
      const lastPopup = lastSitePopupAt.get(site);
      if (lastPopup !== undefined && nowMs - lastPopup < siteCooldownMs) {
        const remainingMs = siteCooldownMs - (nowMs - lastPopup);
        safeLog(
          `[propose:v2] rate-limited popup for site=${site} remainingMs=${remainingMs}`,
        );
        emitStageLog({
          stage: "rate_limit",
          session: sessionId,
          site,
          cooldownMs: siteCooldownMs,
          remainingMs,
          name: compiled.name,
        });
        return;
      }
    }

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

    const decidedAt = now();
    proposedKeys.add(sessionScopedKey);
    let sigSet = proposedSignaturesBySession.get(sessionId);
    if (!sigSet) {
      sigSet = new Set<string>();
      proposedSignaturesBySession.set(sessionId, sigSet);
    }
    sigSet.add(candidate.signature);
    if (willShowPopup && site) {
      lastSitePopupAt.set(site, decidedAt);
    }

    await proposeV2Finding(sessionId, site, finding, script, compiled);
  }

  async function processSession(sessionId: string): Promise<void> {
    if (closed) return;
    await processSessionV2(sessionId);
  }

  function onEvents(sessionId: string): void {
    if (closed || !sessionId) return;
    const existing = timers.get(sessionId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      if (closed || queuedSessions.has(sessionId)) return;
      queuedSessions.add(sessionId);
      queue = queue
        .then(() => {
          queuedSessions.delete(sessionId);
          return processSession(sessionId);
        })
        .catch((err) => {
          queuedSessions.delete(sessionId);
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
