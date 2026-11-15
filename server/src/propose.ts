import crypto from "node:crypto";
import type { Event, Finding, Verdict } from "@gen/shared";
import {
  hostnameFromUrl,
  isPlaceholderHost,
  normalizeHost as normalizeHostWithOpts,
  resolveEventHost,
} from "./common/host.ts";
import { normalizeText } from "./common/target.ts";
import {
  buildLibraryEntryFromScript,
  buildStartSignature,
  formatStartSignature,
  type ImplementContext,
} from "./hands/implementor.ts";
import {
  canonicalStepCount,
  canonicalStepsMatch,
  extractCanonicalSteps,
  findMatchingLibraryEntry,
} from "./hands/library.ts";
import { toLocatorList, type ActionScript, type LibraryEntry } from "./hands/types.ts";
import type { SameTaskIrisJudgment, WorkflowIrisJudgment } from "./llm/iris.ts";
import {
  compiledWorkflowToActionScript,
  compiledWorkflowToFinding,
} from "./report.ts";
import type { FlowTip } from "./tips.ts";
import {
  eventsToSteps,
  normalizeHost,
  selectMeaningfulWindow,
  type CompileInput,
  type CompiledWorkflow,
} from "./v2/index.ts";

export type HandsDecision = "approved" | "dismissed" | "never";

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

export type ProposerDecisionMeta = {
  startUrl?: string;
  tabId?: number;
};

export type ProposerDeps = {
  requestDecision: (
    name: string,
    solution: string,
    script: ActionScript,
    primaryLabel?: string,
    meta?: ProposerDecisionMeta,
  ) => Promise<HandsOutcome>;
  runScript: (
    script: ActionScript,
    params?: Record<string, string>,
    meta?: ProposerDecisionMeta,
  ) => Promise<HandsOutcome>;
  log?: (line: string) => void;
  readSessionEvents: (sessionId: string) => Promise<Event[]>;
  readLibrary?: () => Promise<LibraryEntry[]>;
  judgeIris?: (digest: Record<string, unknown>) => Promise<WorkflowIrisJudgment | null>;
  judgeSameTask?: (
    comparison: Record<string, unknown>,
  ) => Promise<SameTaskIrisJudgment | null>;
  compileV2: (
    input: CompileInput,
    opts?: { irisJudgment?: WorkflowIrisJudgment | null },
  ) => Promise<CompiledWorkflow | null>;
  suggestFlowTip?: (events: Event[], exclude?: string[]) => Promise<FlowTip | null>;
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
    replaceEntryId?: string;
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

function summarizePrecheckCounts(outcome: PrecheckOutcome | HandsOutcome): unknown {
  const results = outcome.results;
  if (!Array.isArray(results)) return results ?? null;
  return results.map((item) => {
    const rec = (item ?? {}) as { index?: unknown; action?: unknown; matchCount?: unknown };
    return `${String(rec.index)}:${String(rec.action)}=${String(rec.matchCount)}`;
  });
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
      // 0 = target not found; 2+ = ambiguous here, but Run narrows with within/stepIndex and fails closed.
      return rec.matchCount >= 1;
    });
  }
  if (typeof results === "object" && results !== null && "matchCount" in results) {
    const rec = results as { ok?: unknown; matchCount?: unknown };
    return rec.ok !== false && typeof rec.matchCount === "number" && rec.matchCount >= 1;
  }
  return false;
}

const MEANINGFUL_EVENT_TYPES = new Set<Event["type"]>([
  "click",
  "dblclick",
  "input",
  "change",
  "paste",
  "copy",
  "cut",
  "submit",
  "select",
  "key",
  "keydown",
  "drop",
  "contextmenu",
]);

function findLastMeaningfulEventMeta(
  events: readonly Event[],
  compiled?: Pick<CompiledWorkflow, "apps" | "startUrl">,
): { tabId?: number; url?: string } {
  const flowHosts = new Set<string>();
  if (compiled) {
    for (const app of compiled.apps) {
      const normalized = normalizeHost(app);
      if (normalized) flowHosts.add(normalized);
    }
    const startHost = hostnameFromUrl(compiled.startUrl);
    if (startHost) flowHosts.add(startHost);
  }

  let fallback: { tabId?: number; url?: string } | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev) continue;
    const isMeaningful =
      ev.type === "focus" ? Boolean(ev.target) : MEANINGFUL_EVENT_TYPES.has(ev.type);
    if (!isMeaningful) continue;
    const tabId = typeof ev.meta?.tabId === "number" ? ev.meta.tabId : undefined;
    const url = typeof ev.url === "string" ? ev.url : undefined;
    if (tabId === undefined && !url) continue;

    if (flowHosts.size > 0) {
      const evHost = resolveEventHost(ev, { preferUrl: true });
      if (evHost && flowHosts.has(normalizeHost(evHost))) {
        if (tabId !== undefined) return { tabId, ...(url ? { url } : {}) };
        if (!fallback) fallback = { ...(url ? { url } : {}) };
      }
      continue;
    }

    if (tabId !== undefined) return { tabId, ...(url ? { url } : {}) };
    if (!fallback) fallback = { ...(url ? { url } : {}) };
  }
  return fallback ?? {};
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

function addNormalizedHost(out: Set<string>, raw?: string): void {
  if (!raw) return;
  const h = normalizeHostWithOpts(raw, { collapseLoopback: true });
  if (h && !isPlaceholderHost(h)) {
    out.add(h);
  }
}

function collectScriptHosts(steps: ActionScript["steps"], hosts: Set<string>): void {
  for (const step of collectFlatSteps(steps)) {
    if ("host" in step && typeof step.host === "string") {
      addNormalizedHost(hosts, step.host);
    }
    if ("url" in step && typeof step.url === "string") {
      addNormalizedHost(hosts, hostnameFromUrl(step.url, { collapseLoopback: true }));
    }
    if ("target" in step && step.target) {
      for (const loc of toLocatorList(step.target)) {
        const matches = loc.value.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi);
        for (const m of matches) {
          addNormalizedHost(hosts, hostnameFromUrl(m[0], { collapseLoopback: true }));
        }
      }
    }
  }
}

function isLongerAndContains(
  newScript: ActionScript,
  savedScript: ActionScript,
): boolean {
  const savedCanonical = extractCanonicalSteps(savedScript.steps);
  const newCanonical = extractCanonicalSteps(newScript.steps);
  if (savedCanonical.length === 0) return false;

  const savedFlatLen = collectFlatSteps(savedScript.steps).length;
  const newFlatLen = collectFlatSteps(newScript.steps).length;
  const isStrictlyLonger =
    newCanonical.length > savedCanonical.length ||
    (newCanonical.length === savedCanonical.length && newFlatLen > savedFlatLen);
  if (!isStrictlyLonger) return false;

  let si = 0;
  for (let ni = 0; ni < newCanonical.length && si < savedCanonical.length; ni += 1) {
    if (canonicalStepsMatch(savedCanonical[si]!, newCanonical[ni]!)) {
      si += 1;
    }
  }
  return si === savedCanonical.length;
}

function collectWorkflowHosts(
  site: string,
  workflow: CompiledWorkflow,
  script: ActionScript,
): Set<string> {
  const hosts = new Set<string>();
  addNormalizedHost(hosts, site);
  for (const app of workflow.apps) {
    addNormalizedHost(hosts, app);
  }
  addNormalizedHost(hosts, hostnameFromUrl(workflow.startUrl, { collapseLoopback: true }));
  collectScriptHosts(script.steps, hosts);
  return hosts;
}

function collectLibraryEntryHosts(entry: LibraryEntry): Set<string> {
  const hosts = new Set<string>();
  for (const app of entry.eyes.scope.apps) {
    addNormalizedHost(hosts, app);
  }
  for (const pat of entry.eyes.scope.urlPatterns) {
    if (/^https?:\/\//i.test(pat)) {
      addNormalizedHost(hosts, hostnameFromUrl(pat, { collapseLoopback: true }));
    } else if (!pat.startsWith("/") && !pat.startsWith("*") && pat.includes(".")) {
      addNormalizedHost(hosts, pat);
    }
  }
  if (entry.startSignature) {
    const parts = entry.startSignature.split("|");
    const firstPart = parts[0]?.trim();
    if (firstPart && (firstPart.includes(".") || firstPart === "localhost")) {
      addNormalizedHost(hosts, firstPart);
    }
    const secondPart = parts[1]?.trim();
    if (secondPart && /^https?:\/\//i.test(secondPart)) {
      addNormalizedHost(hosts, hostnameFromUrl(secondPart, { collapseLoopback: true }));
    }
  }
  collectScriptHosts(entry.script.steps, hosts);
  return hosts;
}

function stripWww(host: string): string {
  return host.startsWith("www.") && host.length > 4 ? host.slice(4) : host;
}

function hasHostOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const bNorm = new Set<string>();
  for (const h of b) {
    bNorm.add(h);
    bNorm.add(stripWww(h));
  }
  for (const h of a) {
    if (bNorm.has(h) || bNorm.has(stripWww(h))) return true;
  }
  return false;
}

function resolveLatestSessionHost(
  steps: readonly { app?: string; url?: string }[],
  events: readonly Event[],
): string {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (!step) continue;
    const h = resolveEventHost(step, { preferUrl: true, collapseLoopback: true });
    if (h && !isPlaceholderHost(h)) return h;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev) continue;
    const h = resolveEventHost(ev, { preferUrl: true, collapseLoopback: true });
    if (h && !isPlaceholderHost(h)) return h;
  }
  return "";
}

function firstTargetLabel(target: unknown): string {
  if (!target) return "";
  const locs = toLocatorList(target as Parameters<typeof toLocatorList>[0]);
  const preferred =
    locs.find((l) => l.kind === "aria") ??
    locs.find((l) => l.kind === "text") ??
    locs.find((l) => l.kind === "testid") ??
    locs[0];
  return preferred?.value ?? "";
}

function summarizeScriptSteps(steps: readonly ActionScript["steps"][number][]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if (step.action === "forEach") {
      out.push(`forEach(${summarizeScriptSteps(step.steps).join(" -> ")})`);
      continue;
    }
    const label = "target" in step ? firstTargetLabel(step.target) : "";
    switch (step.action) {
      case "switchTab":
        out.push(
          `switchTab(${step.host || ""}${step.url ? ` ${step.url}` : ""})`.trim(),
        );
        break;
      case "navigate":
        out.push(`navigate(${step.url})`);
        break;
      case "readText":
      case "readValue":
        out.push(`${step.action}(${label} -> ${step.bind})`);
        break;
      case "fill":
      case "insertText":
      case "select":
        out.push(`${step.action}(${label || "focused"}, ${step.value})`);
        break;
      case "click":
        out.push(`click(${label})`);
        break;
      case "pressKey":
        out.push(`pressKey(${step.key})`);
        break;
      case "extractList":
        out.push(`extractList(${label} -> ${step.bind})`);
        break;
      default:
        out.push(step.action);
        break;
    }
  }
  return out;
}

const MAX_SAME_TASK_COMPARISONS = 6;

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
  const neverFlowTipKeys = new Set<string>();
  const pendingOfferSessionHosts = new Set<string>();
  const activeOfferHosts = new Map<string, number>();
  const inFlightSessions = new Set<string>();
  const pendingRerunSessions = new Set<string>();
  const shownFlowTipLabels: string[] = [];
  const flowTipCheckedAt = new Map<string, number>();
  const knownWorkflowHostsByKey = new Map<string, Set<string>>();
  let flowTipPending = false;
  let closed = false;
  // Compiles from different sessions can finish together. Everything from the
  // library check to the save runs one at a time, so a later compile always sees
  // the entry an earlier one just saved.
  let libraryChain: Promise<void> = Promise.resolve();
  function withLibraryLock(fn: () => Promise<void>): Promise<void> {
    const run = libraryChain.then(fn, fn);
    libraryChain = run.catch(() => {});
    return run;
  }

  function entryLookupKey(name: string, solution: string): string {
    return `${name.trim().toLowerCase()}::${solution.trim().toLowerCase()}`;
  }

  function getLibraryEntryHosts(entry: LibraryEntry): Set<string> {
    const hosts = collectLibraryEntryHosts(entry);
    const extra = knownWorkflowHostsByKey.get(
      entryLookupKey(entry.name, entry.solution),
    );
    if (extra) {
      for (const h of extra) {
        hosts.add(h);
      }
    }
    return hosts;
  }

  async function proposeV2Finding(
    sessionId: string,
    site: string,
    finding: Finding,
    script: ActionScript,
    workflow: CompiledWorkflow,
    decisionMeta?: ProposerDecisionMeta,
  ): Promise<void> {
    const name = finding.title.trim() || script.name?.trim() || "Proposed automation";
    const solution = finding.why.trim() || name;

    // No "Save skill" popup: every offered flow is offered as Run.
    let shouldRun = true;
    const decideScript: ActionScript =
      script.runMode === "save_only"
        ? { ...script, runMode: "run_remaining" }
        : script;

    const offerHosts =
      workflow.kind === "workflow"
        ? Array.from(collectWorkflowHosts(site, workflow, script))
        : [];
    for (const h of offerHosts) {
      pendingOfferSessionHosts.add(`${sessionId}::${h}`);
      activeOfferHosts.set(h, (activeOfferHosts.get(h) ?? 0) + 1);
    }
    // Release on every popup end (answer, timeout or error) so a site never stays locked.
    const clearOfferPending = (): void => {
      for (const h of offerHosts) {
        pendingOfferSessionHosts.delete(`${sessionId}::${h}`);
      }
    };

    safeLog(`[propose:v2] ${name} -> kind=${workflow.kind} offered`);
    let outcome: HandsOutcome;
    try {
      outcome = await deps.requestDecision(
        name,
        solution,
        decideScript,
        undefined,
        decisionMeta,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeLog(`[propose:v2] ${name} -> error: ${message}`);
      emitStageLog({ stage: "decide", session: sessionId, site, decision: "error", error: message, name });
      return;
    } finally {
      clearOfferPending();
      for (const h of offerHosts) {
        const nextCount = (activeOfferHosts.get(h) ?? 0) - 1;
        if (nextCount > 0) {
          activeOfferHosts.set(h, nextCount);
        } else {
          activeOfferHosts.delete(h);
        }
      }
    }

    if (closed) return;

    if (!outcome.ok || outcome.decision !== "approved") {
      const isTimeout = !outcome.ok && /timed?\s*out/i.test(outcome.error ?? "");
      clearOfferPending();
      const decision = outcome.decision === "dismissed" ? "dismissed" : isTimeout ? "timeout" : "dismissed";
      safeLog(`[propose:v2] ${name} -> ${decision}`);
      emitStageLog({ stage: "decide", session: sessionId, site, decision, name });
      return;
    }

    clearOfferPending();

    safeLog(`[propose:v2] ${name} -> approved`);
    emitStageLog({ stage: "decide", session: sessionId, site, decision: "approved", name });
    const runParams = outcome.params;

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
        if (workflow.kind === "workflow") {
          knownWorkflowHostsByKey.set(
            entryLookupKey(workflow.name ?? name, finding.why || script.name || finding.title),
            collectWorkflowHosts(site, workflow, script),
          );
          knownWorkflowHostsByKey.set(
            entryLookupKey(name, solution),
            collectWorkflowHosts(site, workflow, script),
          );
        }
        safeLog(`[propose:v2] ${name} -> kind=${workflow.kind} saved`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        safeLog(`[propose:v2] ${name} -> save failed: ${msg}`);
      }
    }

    if (closed) return;

    if (!shouldRun) {
      safeLog(`[propose:v2] ${name} -> kind=${workflow.kind} saved (save_only)`);
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
      const runOutcome = await deps.runScript(decideScript, runParams, decisionMeta);
      safeLog(`[propose:v2] ${name} -> ${runOutcome.ok ? "run ok" : "run failed"}`);
      emitStageLog({ stage: "run", session: sessionId, ok: runOutcome.ok, name });
    } catch {
      safeLog(`[propose:v2] ${name} -> run failed`);
      emitStageLog({ stage: "run", session: sessionId, ok: false, name });
    }
  }

  function flowTipDedupeKey(suggestion: FlowTip): string {
    const keysNorm = suggestion.keys
      ?.map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter(Boolean)
      .join("");
    if (keysNorm) return `keys:${keysNorm}`;
    return `tip:${(suggestion.tip ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;
  }

  async function maybeFlowTip(sessionId: string, events: Event[]): Promise<void> {
    if (!deps.suggestFlowTip) return;
    if (flowTipPending) {
      safeLog(`[tip] session=${sessionId} skipped reason=pending`);
      return;
    }
    const lastCheck = flowTipCheckedAt.get(sessionId);
    if (lastCheck !== undefined && now() - lastCheck < 60_000) {
      safeLog(`[tip] session=${sessionId} skipped reason=cooldown`);
      return;
    }
    flowTipCheckedAt.set(sessionId, now());

    let suggestion: FlowTip | null;
    try {
      suggestion = await deps.suggestFlowTip(
        events,
        shownFlowTipLabels.length > 0 ? [...shownFlowTipLabels] : undefined,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeLog(`[tip] session=${sessionId} skipped reason=error:${message}`);
      return;
    }
    if (closed) return;
    if (!suggestion?.tip?.trim()) {
      safeLog(`[tip] session=${sessionId} skipped reason=empty`);
      return;
    }

    const tipKey = flowTipDedupeKey(suggestion);
    if (neverFlowTipKeys.has(tipKey)) {
      safeLog(`[tip] session=${sessionId} skipped reason=never`);
      return;
    }
    const key = `${sessionId}::${tipKey}`;
    if (proposedKeys.has(key)) {
      safeLog(`[tip] session=${sessionId} skipped reason=duplicate`);
      return;
    }
    const name = suggestion.keys?.join(" → ") || suggestion.tip.trim();
    proposedKeys.add(key);
    shownFlowTipLabels.push(name);
    safeLog(`[tip] session=${sessionId} shown reason=${name}`);

    flowTipPending = true;
    try {
      const tipEventMeta = findLastMeaningfulEventMeta(events);
      const outcome = await deps.requestDecision(
        name,
        suggestion.tip.trim(),
        { name, steps: [{ action: "wait", ms: 0 }] },
        "Got it",
        tipEventMeta.tabId !== undefined || tipEventMeta.url
          ? {
              ...(tipEventMeta.url ? { startUrl: tipEventMeta.url } : {}),
              ...(tipEventMeta.tabId !== undefined ? { tabId: tipEventMeta.tabId } : {}),
            }
          : undefined,
      );
      if (outcome?.decision === "never") {
        neverFlowTipKeys.add(tipKey);
        safeLog(`[tip] session=${sessionId} never key=${tipKey}`);
      }
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

    const { steps, piiMap } = eventsToSteps(events);
    const {
      window,
      steps: windowedSteps,
      events: windowedEvents,
    } = selectMeaningfulWindow(steps, events);
    if (window.meaningfulCount < 2) {
      safeLog(
        `[iris] session=${sessionId} meaningful=${window.meaningfulCount} verdict=skip reason=meaningfulCount<2`,
      );
      return;
    }

    const latestHost = resolveLatestSessionHost(windowedSteps, windowedEvents);
    if (
      latestHost &&
      (pendingOfferSessionHosts.has(`${sessionId}::${latestHost}`) ||
        (activeOfferHosts.get(latestHost) ?? 0) > 0)
    ) {
      safeLog(
        `[propose:v2] skipped compile for ${sessionId} host=${latestHost} (awaiting popup answer)`,
      );
      return;
    }

    emitStageLog({
      stage: "detect",
      session: sessionId,
      meaningfulCount: window.meaningfulCount,
      windowSteps: window.steps.length,
    });

    let irisJudgment: WorkflowIrisJudgment | null | undefined;
    if (deps.judgeIris) {
      let irisError: string | null = null;
      try {
        irisJudgment = await deps.judgeIris(window);
      } catch (err) {
        irisJudgment = null;
        irisError = err instanceof Error ? err.message : String(err);
      }
      const verdict =
        irisJudgment == null
          ? "null"
          : irisJudgment.worthAutomating
            ? "yes"
            : "no";
      const reason =
        irisError !== null
          ? irisError
          : irisJudgment == null
            ? "null_response"
            : `pauseBeforeSubmit=${irisJudgment.pauseBeforeSubmit}`;
      safeLog(
        `[iris] session=${sessionId} meaningful=${window.meaningfulCount} verdict=${verdict} reason=${reason}`,
      );
      if (closed) return;
      if (irisJudgment == null || irisJudgment.worthAutomating === false) {
        return;
      }
    }

    const irisYes = irisJudgment?.worthAutomating === true;

    let compiled: CompiledWorkflow | null = null;
    try {
      compiled = await deps.compileV2(
        { events: windowedEvents, steps: windowedSteps, piiMap },
        irisJudgment !== undefined ? { irisJudgment } : undefined,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeLog(`[propose:v2] compile failed for ${sessionId}: ${message}`);
      if (!closed && irisYes && deps.suggestFlowTip) {
        await maybeFlowTip(sessionId, events);
      }
      return;
    }

    if (closed) return;
    if (!compiled) {
      if (irisYes && deps.suggestFlowTip) {
        await maybeFlowTip(sessionId, events);
      }
      return;
    }

    const finding = compiledWorkflowToFinding(compiled);
    const script = compiledWorkflowToActionScript(compiled);
    deps.onCompiled?.({ sessionId, finding, script, workflow: compiled });

    const sessionScopedKey = `${sessionId}::${buildFindingKey(finding, script)}`;
    if (proposedKeys.has(sessionScopedKey)) {
      return;
    }

    const site = extractSiteHost(compiled, script, windowedEvents);

    await withLibraryLock(async () => {
    if (deps.readLibrary) {
      const existingEntries = await deps.readLibrary().catch(() => []);
      if (existingEntries.length > 0) {
        let irisAnswered = false;
        if (compiled.kind === "workflow" && deps.judgeSameTask) {
          const name =
            finding.title.trim() || script.name?.trim() || "Proposed automation";
          const solution = finding.why.trim() || name;
          const candidateHosts = collectWorkflowHosts(site, compiled, script);
          // Iris decides sameness. Host overlap only orders the entries; a flow
          // that starts on another site can still be the same task.
          const workflowEntries = existingEntries.filter(
            (entry) => entry.kind === "workflow",
          );
          const overlapping = workflowEntries.filter((entry) =>
            hasHostOverlap(candidateHosts, getLibraryEntryHosts(entry)),
          );
          const sameHostEntries = [
            ...overlapping,
            ...workflowEntries.filter((entry) => !overlapping.includes(entry)),
          ].slice(0, MAX_SAME_TASK_COMPARISONS);
          if (sameHostEntries.length > 0) {
            const candidateSummary = {
              name,
              reason: solution,
              host: site,
              hosts: Array.from(candidateHosts),
              steps: summarizeScriptSteps(script.steps),
            };
            const judgments = await Promise.all(
              sameHostEntries.map((entry) => {
                const entryHosts = getLibraryEntryHosts(entry);
                const sharedHosts = Array.from(candidateHosts).filter((h) =>
                  hasHostOverlap(new Set([h]), entryHosts),
                );
                return deps
                  .judgeSameTask!({
                    host: site,
                    sharedHosts,
                    candidate: candidateSummary,
                    existing: {
                      id: entry.id,
                      name: entry.name,
                      description: entry.description,
                      hosts: Array.from(entryHosts),
                      steps: summarizeScriptSteps(entry.script.steps),
                    },
                  })
                  .catch(() => null);
              }),
            );
            irisAnswered = judgments.some((j) => j !== null);
            const matchedIdx = judgments.findIndex((j) => j?.sameTask === true);
            if (matchedIdx >= 0) {
              const matchedEntry = sameHostEntries[matchedIdx]!;
              proposedKeys.add(sessionScopedKey);
              if (isLongerAndContains(script, matchedEntry.script)) {
                if (deps.onApproved) {
                  await deps
                    .onApproved({
                      sessionId,
                      script,
                      workflow: compiled,
                      finding,
                      replaceEntryId: matchedEntry.id,
                    })
                    .catch(() => {});
                }
                knownWorkflowHostsByKey.set(
                  entryLookupKey(matchedEntry.name, matchedEntry.solution),
                  candidateHosts,
                );
                knownWorkflowHostsByKey.set(
                  entryLookupKey(name, solution),
                  candidateHosts,
                );
                safeLog(
                  `[propose:v2] ${name} -> replaces ${matchedEntry.id} (more complete)`,
                );
              } else {
                safeLog(`[propose:v2] ${name} -> same as ${matchedEntry.id}, skipped`);
              }
              return;
            }
          }
        }
        if (!irisAnswered) {
          const context: ImplementContext = {
            ...(compiled.apps[0] ? { app: compiled.apps[0] } : {}),
            ...(compiled.startUrl ? { url: compiled.startUrl } : {}),
          };
          const candidateEntry = buildLibraryEntryFromScript({
            name: compiled.name || script.name || finding.title,
            description: compiled.reason || finding.why,
            kind: compiled.kind ?? (finding.verdict === "rung1" ? "snippet" : "workflow"),
            solution: finding.why || script.name || finding.title,
            script,
            context,
            status: "active",
          });
          const sigObj = buildStartSignature(script, context);
          const candidateWithSig: LibraryEntry = {
            ...candidateEntry,
            startSignature: formatStartSignature(sigObj),
          };
          const matched = findMatchingLibraryEntry(existingEntries, candidateWithSig);
          if (matched) {
            proposedKeys.add(sessionScopedKey);

            const isUpgrade =
              canonicalStepCount(script) > canonicalStepCount(matched.script);
            if (isUpgrade && deps.onApproved) {
              safeLog(
                `[propose:v2] upgrading existing library entry id=${matched.id} name="${matched.name}"`,
              );
              await deps.onApproved({
                sessionId,
                script,
                workflow: compiled,
                finding,
              }).catch(() => {});
            } else {
              safeLog(
                `[propose:v2] skipping duplicate of existing library entry id=${matched.id} name="${matched.name}"`,
              );
            }
            return;
          }
        }
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
          `[propose:v2] precheck blocked popup for ${compiled.name} (${precheckOutcome.error ?? `matchCounts ${JSON.stringify(summarizePrecheckCounts(precheckOutcome))}`})`,
        );
        if (!closed && irisYes && deps.suggestFlowTip) {
          await maybeFlowTip(sessionId, events);
        }
        return;
      }
    }

    if (closed) return;

    proposedKeys.add(sessionScopedKey);
    if (irisYes && deps.suggestFlowTip) {
      safeLog(`[tip] session=${sessionId} skipped reason=offer`);
    }

    const eventMeta = findLastMeaningfulEventMeta(events, compiled);
    const startUrl = compiled.startUrl ?? eventMeta.url;
    const decisionMeta: ProposerDecisionMeta | undefined =
      startUrl || eventMeta.tabId !== undefined
        ? {
            ...(startUrl ? { startUrl } : {}),
            ...(eventMeta.tabId !== undefined ? { tabId: eventMeta.tabId } : {}),
          }
        : undefined;

    await proposeV2Finding(
      sessionId,
      site,
      finding,
      script,
      compiled,
      decisionMeta,
    );
    });
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
