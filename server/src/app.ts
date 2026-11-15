import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import type { Event, Report } from "@gen/shared";
import { ReportSchema } from "@gen/shared/schema.ts";
import { isValidArtifactId, readSnippetArtifact } from "./artifacts.ts";
import {
  readFallbackDemoVideo,
  recordScriptReplay,
  warmReplayBrowser,
} from "./replay-video.ts";
import { STEP_TRIGGER_TYPES } from "./common/target.ts";
import {
  buildLibraryEntryFromScript,
  buildStartSignature,
  formatStartSignature,
  implementForLibrary,
  type ImplementContext,
} from "./hands/implementor.ts";
import {
  dedupeLibraryEntries,
  deleteLibraryEntry,
  readLibrary,
  recordLibraryRun,
  upsertLibraryEntry,
} from "./hands/library.ts";
import {
  computeMatchedPrefix,
  createLibraryRecallMatcher,
  extractMatchedPrefixBindings,
} from "./hands/recall.ts";
import {
  LibraryEntrySchema,
  parseActionScript,
  toLocatorList,
  type ActionScript,
  type LibraryEntry,
  type Locator,
} from "./hands/types.ts";
import {
  DEFAULT_GEMINI_MODEL,
  type GeminiClient,
  type GeminiClientOptions,
} from "./llm/gemini.ts";
import {
  judgeSameTaskIris,
  judgeWorkflowIris,
  type IrisJudgeOptions,
} from "./llm/iris.ts";
import {
  collectFlatSteps,
  createProposer,
  type HandsDecision,
  type HandsOutcome,
  type StageLogEvent,
} from "./propose.ts";
import { buildCombinedReport, buildReport } from "./report.ts";
import { scrubEvents } from "./scrub.ts";
import { suggestFlowTip } from "./tips.ts";
import { appendEvents, listSessions, readEvents } from "./trace.ts";
import { parseEvents } from "./validate.ts";
import { compileWorkflow, type IrisWorkflowJudge } from "./v2/index.ts";

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function hasAllCachedScripts(
  report: Report,
  scriptsByFindingId: ReadonlyMap<string, ActionScript>,
): boolean {
  return report.findings.every((f) => {
    if (f.artifact?.path.startsWith("/script/")) {
      const id = f.artifact.path.slice("/script/".length);
      return scriptsByFindingId.has(id);
    }
    return true;
  });
}

export type CreateServerOptions = {
  tracesDir: string;
  dataDir?: string;
  implement?: (solution: string, opts?: { name?: string }) => Promise<ActionScript>;
  gemini?: GeminiClient | GeminiClientOptions;
  iris?: IrisJudgeOptions | IrisWorkflowJudge;
  implementLibrary?: (
    solution: string,
    opts?: { name?: string; context?: ImplementContext },
  ) => Promise<LibraryEntry>;
  autoPropose?: boolean;
  flowTips?: boolean;
  tipGemini?: GeminiClient | GeminiClientOptions;
  proposeDebounceMs?: number;
  siteCooldownMs?: number;
  precheckTimeoutMs?: number;
  now?: () => number;
  stageLog?: (event: StageLogEvent) => void;
};

type HandsCommand =
  | {
      id: string;
      kind?: "run";
      script: ActionScript;
      paramValues?: Record<string, string>;
      url?: string;
      tabId?: number;
      skipRowValues?: string[];
    }
  | {
      id: string;
      kind: "decide";
      name: string;
      solution: string;
      script: ActionScript;
      videoUrl?: string;
      primaryLabel?: string;
      isRecall?: boolean;
      entryId?: string;
      url?: string;
      tabId?: number;
    }
  | {
      id: string;
      kind: "precheck";
      script: ActionScript;
      steps: ActionScript["steps"];
      url?: string;
    };

function isProposeTriggerEvent(ev: Event): boolean {
  if (STEP_TRIGGER_TYPES.has(ev.type)) return true;
  if (ev.type === "keydown" || ev.type === "key") {
    return ev.meta?.key === "Enter";
  }
  return false;
}

function countFlatScriptSteps(steps: ActionScript["steps"]): number {
  return collectFlatSteps(steps).length;
}

export function createServer(opts: CreateServerOptions): http.Server {
  const pipeline = "v2" as const;
  const dataDir = opts.dataDir ?? path.resolve(opts.tracesDir, "..", "data");
  const modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const stageLogEnvEnabled =
    process.env.BRAIN_STAGE_LOG === "1" || process.env.BRAIN_STAGE_LOG === "true";
  const emitStageLog =
    opts.stageLog || stageLogEnvEnabled
      ? (ev: StageLogEvent) => {
          opts.stageLog?.(ev);
          if (stageLogEnvEnabled) {
            console.log(`[v2:stage] ${JSON.stringify(ev)}`);
          }
        }
      : undefined;
  const precheckTimeoutMs = opts.precheckTimeoutMs ?? 10000;
  let latestScript: ActionScript | null = null;
  const scriptsByFindingId = new Map<string, ActionScript>();
  const lastUrlByHost = new Map<string, string>();
  let lastActiveUrl: string | undefined;
  let browserWarmed = false;
  const replayVideosByEntryId = new Map<string, Promise<Buffer | null>>();
  const replayVideosByScriptKey = new Map<string, Promise<Buffer | null>>();
  const decideMetaById = new Map<
    string,
    {
      script: ActionScript;
      entryId?: string;
      fallbackUrl?: string;
      videoPromise?: Promise<Buffer | null>;
    }
  >();

  function scriptCacheKey(script: ActionScript): string {
    return JSON.stringify(script.steps ?? []);
  }

  function startOrGetScriptReplay(
    script: ActionScript,
    fallbackUrl?: string,
  ): Promise<Buffer | null> {
    const key = scriptCacheKey(script);
    const existing = replayVideosByScriptKey.get(key);
    if (existing) return existing;
    const promise = recordScriptReplay(script, {
      hostUrls: lastUrlByHost,
      fallbackUrl: fallbackUrl ?? lastActiveUrl,
    });
    replayVideosByScriptKey.set(key, promise);
    return promise;
  }

  function getOrStartReplayVideo(id: string): Promise<Buffer | null> | undefined {
    const meta = decideMetaById.get(id);
    if (!meta) return undefined;
    if (meta.entryId && replayVideosByEntryId.has(meta.entryId)) {
      return replayVideosByEntryId.get(meta.entryId);
    }
    if (!meta.videoPromise) {
      const promise = startOrGetScriptReplay(meta.script, meta.fallbackUrl);
      meta.videoPromise = promise;
      if (meta.entryId) {
        replayVideosByEntryId.set(meta.entryId, promise);
      }
    }
    return meta.videoPromise;
  }
  const reportCache = new Map<string, Report>();
  const compileLibraryEntry = async (
    solution: string,
    o?: { name?: string; context?: ImplementContext },
  ): Promise<LibraryEntry> => {
    if (opts.implementLibrary) {
      return opts.implementLibrary(solution, o);
    }
    if (opts.implement) {
      const script = await opts.implement(solution, { name: o?.name });
      return buildLibraryEntryFromScript({
        name: o?.name,
        solution,
        script,
        context: o?.context,
      });
    }
    return implementForLibrary(solution, o);
  };

  const commandQueue: HandsCommand[] = [];
  const waiters = new Map<string, (outcome: HandsOutcome) => void>();
  let nextPollResolver: ((cmd: HandsCommand | null) => void) | null = null;
  const recallMatcher = createLibraryRecallMatcher();
  let activeLibraryDecide: {
    entryId: string;
    commandId: string;
    targetKey: string | null;
  } | null = null;

  function toHandsLocator(raw?: { kind: string; value: string }): Locator | undefined {
    if (!raw || !raw.value.trim()) return undefined;
    if (
      raw.kind === "testid" ||
      raw.kind === "css" ||
      raw.kind === "xpath" ||
      raw.kind === "aria" ||
      raw.kind === "text"
    ) {
      return { kind: raw.kind, value: raw.value };
    }
    return undefined;
  }

  function pickPreferredLocator(
    candidates: ReadonlyArray<{ kind: string; value: string }>,
  ): Locator | undefined {
    const valid = candidates.map(toHandsLocator).filter((l): l is Locator => Boolean(l));
    return (
      valid.find((l) => l.kind === "testid") ??
      valid.find(
        (l) =>
          l.kind === "css" &&
          !/^(html|body|main|section|header|footer|div)(\s|>|:|$)/i.test(l.value.trim()),
      ) ??
      valid.find((l) => l.kind === "xpath") ??
      valid.find((l) => l.kind === "css") ??
      valid.find((l) => l.kind === "aria") ??
      valid[0]
    );
  }

  function pickExecutableLocator(evt: Event | undefined, entry: LibraryEntry): Locator | undefined {
    const fromEntry = pickPreferredLocator(entry.eyes.targetHints.locators);
    if (fromEntry && (fromEntry.kind === "testid" || fromEntry.kind === "css" || fromEntry.kind === "xpath")) {
      return fromEntry;
    }
    const fromEvent = evt?.target?.locators ? pickPreferredLocator(evt.target.locators) : undefined;
    return fromEvent ?? fromEntry;
  }

  function extractEditableTargetKey(evt: Event): string | null {
    const tag = evt.target?.tag?.toLowerCase();
    const role = evt.target?.role?.toLowerCase();
    const isEditable =
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      role === "textbox" ||
      role === "searchbox" ||
      role === "gridcell" ||
      role === "combobox";
    if (!isEditable || !evt.target?.locators?.length) return null;
    const loc = pickPreferredLocator(evt.target.locators);
    return loc ? `${loc.kind}:${loc.value}` : null;
  }

  function cancelCommand(commandId: string, error: string): void {
    const idx = commandQueue.findIndex((c) => c.id === commandId);
    if (idx >= 0) commandQueue.splice(idx, 1);
    waiters.get(commandId)?.({ ok: false, error });
  }

  function dispatchNext(cmd: HandsCommand): void {
    if (nextPollResolver) {
      const resolve = nextPollResolver;
      nextPollResolver = null;
      resolve(cmd);
    } else if (cmd.kind === "decide") {
      commandQueue.push(cmd);
    } else {
      commandQueue.unshift(cmd);
    }
  }

  function awaitHands(
    cmd: HandsCommand,
    timeoutMs: number,
    timeoutError?: string,
  ): Promise<HandsOutcome> {
    if (cmd.kind === "decide") {
      const steps = cmd.script.steps ?? [];
      const firstStep = steps[0];
      const isSingleInsert =
        steps.length === 1 &&
        firstStep?.action === "insertText" &&
        !("target" in firstStep && firstStep.target);
      const isFlowTip = cmd.primaryLabel?.trim() === "Got it";
      if (!isSingleInsert && !isFlowTip && steps.length > 0) {
        cmd.videoUrl = `/replay/${cmd.id}.webm`;
        decideMetaById.set(cmd.id, {
          script: cmd.script,
          entryId: cmd.entryId,
          fallbackUrl: lastActiveUrl,
        });
        if (!process.env.VITEST) {
          void getOrStartReplayVideo(cmd.id);
        }
      }
    }
    return new Promise<HandsOutcome>((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(cmd.id);
        const idx = commandQueue.findIndex((c) => c.id === cmd.id);
        if (idx >= 0) commandQueue.splice(idx, 1);
        resolve({
          ok: false,
          error:
            timeoutError ??
            (cmd.kind === "decide"
              ? "Timed out waiting for user decision"
              : "Timed out waiting for extension to execute script"),
        });
      }, timeoutMs);
      timer.unref?.();
      waiters.set(cmd.id, (outcome) => {
        clearTimeout(timer);
        waiters.delete(cmd.id);
        resolve(outcome);
      });
      dispatchNext(cmd);
    });
  }

  async function requestDecision(input: {
    id?: string;
    name: string;
    solution: string;
    script: ActionScript;
    primaryLabel?: string;
    isRecall?: boolean;
    entryId?: string;
    url?: string;
    tabId?: number;
    timeoutMs?: number;
  }): Promise<{ id: string; outcome: HandsOutcome }> {
    const id = input.id ?? crypto.randomUUID();
    const timeoutMs = input.timeoutMs ?? 60000;
    console.log(
      `[server] decide id=${id} name="${input.name}" steps=${input.script.steps.length}`,
    );
    const outcome = await awaitHands(
      {
        id,
        kind: "decide",
        name: input.name,
        solution: input.solution,
        script: input.script,
        ...(input.primaryLabel ? { primaryLabel: input.primaryLabel } : {}),
        ...(input.isRecall ? { isRecall: true } : {}),
        ...(input.entryId ? { entryId: input.entryId } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
      },
      timeoutMs,
      "Timed out waiting for user decision",
    );
    console.log(`[server] decide id=${id} resolved:`, outcome.decision ?? outcome.error);
    return { id, outcome };
  }

  function sliceRecallSteps(
    steps: ActionScript["steps"],
    startStepIndex: number,
  ): ActionScript["steps"] {
    if (startStepIndex <= 0 || startStepIndex >= steps.length) {
      return steps;
    }
    const prefix = steps.slice(0, startStepIndex);
    const remaining = steps.slice(startStepIndex);
    const neededLoopBinds = new Set<string>();
    for (const s of remaining) {
      if (s.action === "forEach" && typeof s.items === "string" && s.items.trim()) {
        neededLoopBinds.add(s.items.trim());
      }
    }
    if (neededLoopBinds.size > 0) {
      const hasExtractInRemaining = new Set(
        remaining
          .filter(
            (s): s is Extract<ActionScript["steps"][number], { action: "extractList" }> =>
              s.action === "extractList",
          )
          .map((s) => s.bind),
      );
      const preservedExtracts = prefix.filter(
        (s): s is Extract<ActionScript["steps"][number], { action: "extractList" }> =>
          s.action === "extractList" &&
          neededLoopBinds.has(s.bind) &&
          !hasExtractInRemaining.has(s.bind),
      );
      if (preservedExtracts.length > 0) {
        return [...preservedExtracts, ...remaining];
      }
    }
    return remaining;
  }

  function mergeBoundParams(
    params: ActionScript["params"],
    boundValues: Record<string, string>,
  ): ActionScript["params"] {
    const entries = Object.entries(boundValues).filter(([, v]) => v.length > 0);
    if (entries.length === 0) return params;
    const out = params ? params.map((p) => ({ ...p })) : [];
    for (const [name, value] of entries) {
      const idx = out.findIndex((p) => p.name === name);
      if (idx >= 0) {
        if (!out[idx].example) out[idx].example = value;
      } else {
        out.push({ name, example: value });
      }
    }
    return out.length > 0 ? out : undefined;
  }

  function findTypedFieldEvent(
    sessionEvents: readonly Event[],
    typedStep: ActionScript["steps"][number] | undefined,
    stepLocators: readonly Locator[],
  ): Event | undefined {
    const candidates = sessionEvents.filter(
      (ev) =>
        (ev.type === "input" ||
          ev.type === "change" ||
          ev.type === "paste" ||
          ev.type === "focus") &&
        Boolean(ev.target?.locators?.length),
    );
    if (candidates.length === 0) return undefined;

    if (stepLocators.length > 0) {
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const ev = candidates[i];
        const hit = ev.target?.locators?.some((el) =>
          stepLocators.some(
            (sl) =>
              sl.kind === el.kind &&
              sl.value.trim().toLowerCase() === el.value.trim().toLowerCase(),
          ),
        );
        if (hit) return ev;
      }
    }

    if (
      typedStep &&
      "value" in typedStep &&
      typeof typedStep.value === "string" &&
      typedStep.value.trim().length > 0
    ) {
      const needle = typedStep.value.trim().toLowerCase();
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const ev = candidates[i];
        const val = (ev.value ?? ev.clipboard?.text ?? "").trim().toLowerCase();
        if (val && (val === needle || val.includes(needle))) {
          return ev;
        }
      }
    }

    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (candidates[i].type !== "focus") return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  function inferRoleFromTag(tag?: string): string | undefined {
    const clean = tag?.trim().toLowerCase();
    if (!clean) return undefined;
    if (clean === "input" || clean === "textarea") return "textbox";
    if (clean === "select") return "combobox";
    if (clean === "button") return "button";
    return undefined;
  }

  async function triggerLibraryRecall(entry: LibraryEntry, matchedEvent?: Event): Promise<void> {
    if (activeLibraryDecide) return;
    const commandId = crypto.randomUUID();
    const targetLocator = pickExecutableLocator(matchedEvent, entry);
    const targetKey = targetLocator ? `${targetLocator.kind}:${targetLocator.value}` : null;
    activeLibraryDecide = { entryId: entry.id, commandId, targetKey };
    try {
      const sessionEvents = matchedEvent?.session
        ? await readEvents(opts.tracesDir, matchedEvent.session).catch(() => [])
        : [];
      const { startStepIndex, completedValues } = computeMatchedPrefix(
        sessionEvents,
        entry,
      );
      const boundValues =
        startStepIndex > 0 ? extractMatchedPrefixBindings(sessionEvents, entry) : {};
      const adjustedSteps = sliceRecallSteps(entry.script.steps, startStepIndex);

      const recallDecideScript: ActionScript = {
        ...entry.script,
        steps: adjustedSteps,
        ...(entry.script.runMode === "save_only" ? { runMode: "run_remaining" as const } : {}),
      };
      const matchedTabId =
        typeof matchedEvent?.meta?.tabId === "number" ? matchedEvent.meta.tabId : undefined;
      const matchedUrl = typeof matchedEvent?.url === "string" ? matchedEvent.url : undefined;
      const { outcome } = await requestDecision({
        id: commandId,
        name: entry.name,
        solution: entry.solution,
        script: recallDecideScript,
        isRecall: true,
        entryId: entry.id,
        ...(matchedUrl ? { url: matchedUrl } : {}),
        ...(matchedTabId !== undefined ? { tabId: matchedTabId } : {}),
      });
      if (
        !outcome.ok &&
        (outcome.error === "Superseded" || outcome.error === "Page navigated before decision")
      ) {
        return;
      }
      if (outcome.ok && outcome.decision === "approved") {
        recallMatcher.suppressEntry(entry.id, 1000);
        if (activeLibraryDecide?.commandId === commandId) {
          activeLibraryDecide = null;
        }
        await recordLibraryRun(dataDir, entry.id).catch(() => {});
        const runId = crypto.randomUUID();
        const firstAdjusted = adjustedSteps[0];
        const runSteps: ActionScript["steps"] =
          entry.kind === "snippet" &&
          adjustedSteps.length === 1 &&
          firstAdjusted?.action === "insertText" &&
          !firstAdjusted.target &&
          targetLocator
            ? [{ ...firstAdjusted, target: targetLocator }]
            : adjustedSteps;
        const mergedParams = mergeBoundParams(entry.script.params, boundValues);
        const scriptToRun: ActionScript = {
          ...entry.script,
          steps: runSteps,
          ...(mergedParams ? { params: mergedParams } : {}),
        };
        console.log(
          `[server] library recall approved id=${entry.id} -> running script runId=${runId} startStepIndex=${startStepIndex} target=${targetLocator?.value ?? "focused"}`,
        );
        void awaitHands(
          {
            id: runId,
            script: scriptToRun,
            ...(outcome.params ? { paramValues: outcome.params } : {}),
            ...(entry.kind === "workflow" && matchedUrl ? { url: matchedUrl } : {}),
            ...(matchedTabId !== undefined ? { tabId: matchedTabId } : {}),
            ...(completedValues.length > 0 ? { skipRowValues: completedValues } : {}),
          },
          30000,
          "Timed out waiting for extension to execute script",
        ).then((runRes) => {
          console.log(
            `[server] library recall run id=${entry.id} ok=${runRes.ok}${runRes.error ? ` err=${runRes.error}` : ""}`,
          );
        });
      } else if (activeLibraryDecide?.commandId === commandId) {
        recallMatcher.suppressOnTarget(entry.id, targetKey, 10_000);
      }
    } finally {
      if (activeLibraryDecide?.commandId === commandId) {
        activeLibraryDecide = null;
      }
    }
  }

  const autoPropose = opts.autoPropose ?? process.env.BRAIN_AUTO_PROPOSE !== "0";
  const proposer = autoPropose
    ? createProposer({
        readSessionEvents: (sessionId) => readEvents(opts.tracesDir, sessionId),
        readLibrary: () => readLibrary(dataDir),
        judgeIris: (digest) =>
          typeof opts.iris === "function"
            ? opts.iris(digest)
            : judgeWorkflowIris(
                digest,
                typeof opts.iris === "object" ? opts.iris : undefined,
              ),
        judgeSameTask: (comparison) =>
          judgeSameTaskIris(
            comparison,
            opts.iris && typeof opts.iris === "object"
              ? opts.iris
              : typeof opts.iris === "function"
                ? { apiKey: "", envPath: "/nonexistent/oumi/env" }
                : undefined,
          ),
        compileV2: (input, compileOpts) =>
          compileWorkflow(input, {
            gemini: opts.gemini,
            iris: opts.iris,
            ...compileOpts,
          }),
        precheck: (script, meta) =>
          awaitHands(
            {
              id: crypto.randomUUID(),
              kind: "precheck",
              script,
              steps: script.steps,
              ...(meta.startUrl ? { url: meta.startUrl } : {}),
            },
            precheckTimeoutMs,
            "Timed out waiting for extension precheck",
          ),
        onCompiled: ({ finding, script, workflow }) => {
          scriptsByFindingId.set(finding.id, script);
          latestScript = script;
          if (!process.env.VITEST && workflow?.kind !== "snippet") {
            void startOrGetScriptReplay(script, workflow?.startUrl ?? lastActiveUrl);
          }
        },
        onApproved: async ({ sessionId, script, workflow, finding }) => {
          const flatSteps = collectFlatSteps(script.steps);
          const typedStep =
            flatSteps.find(
              (s) => s.action === "insertText" || s.action === "fill",
            ) ?? flatSteps.find((s) => "target" in s && Boolean(s.target));
          const stepLocators =
            typedStep && "target" in typedStep
              ? toLocatorList(typedStep.target)
              : [];
          const sessionEvents = await readEvents(opts.tracesDir, sessionId).catch(
            () => [],
          );
          const typedEvent = findTypedFieldEvent(
            sessionEvents,
            typedStep,
            stepLocators,
          );
          const eventLocators = typedEvent?.target?.locators
            ? typedEvent.target.locators
                .map(toHandsLocator)
                .filter((l): l is Locator => Boolean(l))
            : [];
          const mergedLocators: Locator[] = [];
          const seenLocKeys = new Set<string>();
          for (const loc of [...stepLocators, ...eventLocators]) {
            const key = `${loc.kind}:${loc.value}`;
            if (!seenLocKeys.has(key)) {
              seenLocKeys.add(key);
              mergedLocators.push(loc);
            }
          }
          const targetLabel = typedEvent?.target?.label?.trim() || undefined;
          const targetRole =
            typedEvent?.target?.role?.trim() ||
            inferRoleFromTag(typedEvent?.target?.tag);

          const context: ImplementContext = {
            ...(workflow?.apps[0] ? { app: workflow.apps[0] } : {}),
            ...(workflow?.startUrl ? { url: workflow.startUrl } : {}),
            ...(mergedLocators.length > 0 ? { locators: mergedLocators } : {}),
            ...(targetLabel ? { targetLabel } : {}),
            ...(targetRole ? { targetRole } : {}),
          };
          const built = buildLibraryEntryFromScript({
            name: workflow?.name ?? script.name ?? finding.title,
            description: workflow?.reason ?? finding.why,
            kind:
              workflow?.kind ??
              (finding.verdict === "rung1" ? "snippet" : "workflow"),
            solution: finding.why || script.name || finding.title,
            script,
            context,
            status: "active",
          });
          const sigObj = buildStartSignature(script, context);
          const startSignature = formatStartSignature(sigObj);
          const stats = workflow
            ? {
                repetitions: workflow.stats.repetitions,
                stepCount: countFlatScriptSteps(script.steps),
                manualSeconds: workflow.stats.manualSeconds,
                replaySeconds: workflow.stats.replaySeconds,
                timeSavedSeconds: Math.max(
                  0,
                  Number(
                    (
                      workflow.stats.manualSeconds - workflow.stats.replaySeconds
                    ).toFixed(2),
                  ),
                ),
              }
            : undefined;
          const entryWithMeta: LibraryEntry = {
            ...built,
            startSignature,
            ...(stats ? { stats } : {}),
          };
          const { entry } = await upsertLibraryEntry(dataDir, entryWithMeta);
          latestScript = entry.script;
          scriptsByFindingId.set(finding.id, entry.script);
          reportCache.clear();
          if (!process.env.VITEST && entry.kind === "workflow") {
            replayVideosByEntryId.set(
              entry.id,
              recordScriptReplay(entry.script, {
                hostUrls: lastUrlByHost,
                fallbackUrl: context.url ?? lastActiveUrl,
              }),
            );
          }
          emitStageLog?.({
            stage: "save_skill",
            session: sessionId,
            ts: opts.now ? opts.now() : Date.now(),
            entryId: entry.id,
            kind: entry.kind,
            runMode: script.runMode ?? "save_only",
            startSignature: entry.startSignature,
            name: entry.name,
          });
          return {
            shouldRun:
              script.runMode === "run_remaining" || entry.kind === "snippet",
          };
        },
        requestDecision: (name, solution, script, primaryLabel, meta) =>
          awaitHands(
            {
              id: crypto.randomUUID(),
              kind: "decide",
              name,
              solution,
              script,
              ...(primaryLabel ? { primaryLabel } : {}),
              ...(meta?.startUrl ? { url: meta.startUrl } : {}),
              ...(meta?.tabId !== undefined ? { tabId: meta.tabId } : {}),
            },
            60000,
          ),
        suggestFlowTip: opts.flowTips
          ? (events, exclude) =>
              suggestFlowTip(
                events,
                opts.tipGemini && "generateJson" in opts.tipGemini
                  ? { client: opts.tipGemini, exclude }
                  : { gemini: opts.tipGemini, exclude },
              )
          : undefined,
        runScript: (script, paramValues, meta) =>
          awaitHands(
            {
              id: crypto.randomUUID(),
              script,
              ...(paramValues ? { paramValues } : {}),
              ...(meta?.startUrl ? { url: meta.startUrl } : {}),
              ...(meta?.tabId !== undefined ? { tabId: meta.tabId } : {}),
            },
            30000,
          ),
        now: opts.now,
        stageLog: emitStageLog,
        log: (line) => console.log(line),
      })
    : null;

  const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const rawPath = (req.url ?? "/").split("?")[0];
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "GET" && rawPath.startsWith("/replay/")) {
        let rawName: string;
        try {
          rawName = decodeURIComponent(rawPath.slice("/replay/".length));
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid replay id" });
          return;
        }
        const id = rawName.replace(/\.webm$/i, "");
        const videoPromise = getOrStartReplayVideo(id);
        const buf = (await videoPromise) ?? (await readFallbackDemoVideo());
        if (!buf) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "video/webm",
          "Content-Length": String(buf.length),
          "Cache-Control": "no-store",
        });
        res.end(buf);
        return;
      }

      if (req.method === "GET" && rawPath.startsWith("/artifact/")) {
        let id: string;
        try {
          id = decodeURIComponent(rawPath.slice("/artifact/".length));
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid artifact id" });
          return;
        }

        if (!isValidArtifactId(id)) {
          sendJson(res, 400, { ok: false, error: "Invalid artifact id" });
          return;
        }

        const artifact = await readSnippetArtifact(dataDir, id);
        if (!artifact) {
          sendJson(res, 404, { ok: false, error: "Artifact not found" });
          return;
        }

        sendJson(res, 200, artifact);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, pipeline, autoPropose, model: modelName });
        return;
      }

      if (req.method === "GET" && url.pathname === "/report") {
        const sessionParam = url.searchParams.get("session");
        const llmParam = url.searchParams.get("llm");
        const llm = llmParam !== "0" && llmParam !== "false";
        const reportOpts = {
          dataDir,
          llm,
          gemini: opts.gemini,
          iris: opts.iris,
          scriptStore: scriptsByFindingId,
        };
        let report: unknown;
        let cacheSig: string;
        if (sessionParam && sessionParam.length > 0) {
          const events = await readEvents(opts.tracesDir, sessionParam);
          cacheSig = `${pipeline}|${sessionParam}|${llm ? 1 : 0}|${sessionParam}:${events.length}:${events.at(-1)?.ts ?? 0}`;
          const cached = reportCache.get(cacheSig);
          if (cached && hasAllCachedScripts(cached, scriptsByFindingId)) {
            sendJson(res, 200, cached);
            return;
          }
          report = await buildReport(sessionParam, events, reportOpts);
        } else {
          const targetSessions = await listSessions(opts.tracesDir);
          const sessionEvents = await Promise.all(
            targetSessions.map((s) => readEvents(opts.tracesDir, s.session)),
          );
          const perSessionSig = targetSessions
            .map((s, idx) => {
              const evs = sessionEvents[idx] ?? [];
              return `${s.session}:${evs.length}:${evs.at(-1)?.ts ?? 0}`;
            })
            .join(",");
          cacheSig = `${pipeline}|all|${llm ? 1 : 0}|${perSessionSig}`;
          const cached = reportCache.get(cacheSig);
          if (cached && hasAllCachedScripts(cached, scriptsByFindingId)) {
            sendJson(res, 200, cached);
            return;
          }
          report = await buildCombinedReport(sessionEvents, reportOpts);
        }
        const parsed = ReportSchema.safeParse(report);
        if (!parsed.success) {
          sendJson(res, 500, { ok: false, error: parsed.error.message });
          return;
        }
        reportCache.set(cacheSig, parsed.data);
        sendJson(res, 200, parsed.data);
        return;
      }

      if (req.method === "POST" && url.pathname === "/events") {
        const raw = await readBody(req);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }

        const validation = parseEvents(parsedJson);
        if (!validation.ok) {
          sendJson(res, 400, { ok: false, error: validation.error });
          return;
        }

        const events = scrubEvents(validation.events);
        const original = new Set(validation.events);
        const scrubbed = validation.events.length - events.filter((e) => original.has(e)).length;

        await appendEvents(opts.tracesDir, events);
        if (!browserWarmed && !process.env.VITEST) {
          browserWarmed = true;
          warmReplayBrowser();
        }
        for (const evt of events) {
          if (typeof evt.url === "string" && /^https?:\/\//i.test(evt.url)) {
            lastActiveUrl = evt.url;
            if (typeof evt.app === "string" && evt.app.trim().length > 0) {
              lastUrlByHost.set(evt.app.trim().toLowerCase(), evt.url);
            }
            try {
              lastUrlByHost.set(new URL(evt.url).hostname.toLowerCase(), evt.url);
            } catch {
              // ignore malformed URL
            }
          }
          if (evt.type === "focus" || evt.type === "click") {
            const visitedKey = extractEditableTargetKey(evt);
            if (visitedKey) recallMatcher.notifyTargetVisited(visitedKey);
          }
        }
        const entries = await readLibrary(dataDir).catch(() => []);
        if (entries.length > 0) {
          const irisOpts: IrisJudgeOptions | undefined =
            opts.iris && typeof opts.iris === "object"
              ? opts.iris
              : typeof opts.iris === "function"
                ? { apiKey: "", envPath: "/nonexistent/oumi/env" }
                : undefined;
          void recallMatcher
            .matchEventsWithIris(events, entries, { irisOpts })
            .then((matched) => {
              if (!matched) return;
              if (activeLibraryDecide && activeLibraryDecide.entryId !== matched.entry.id) {
                if (commandQueue.some((c) => c.id === activeLibraryDecide!.commandId)) {
                  cancelCommand(activeLibraryDecide.commandId, "Superseded");
                }
                activeLibraryDecide = null;
              }
              if (!activeLibraryDecide) {
                console.log(
                  `[server] half-detected library match id=${matched.entry.id} name="${matched.entry.name}" -> /decide`,
                );
                emitStageLog?.({
                  stage: "recall_match",
                  session: matched.event.session,
                  ts: opts.now ? opts.now() : Date.now(),
                  entryId: matched.entry.id,
                  name: matched.entry.name,
                  borderline: matched.borderline,
                });
                void triggerLibraryRecall(matched.entry, matched.event);
              }
            })
            .catch(() => {});
        }
        sendJson(res, 200, { ok: true, n: events.length, scrubbed });
        const sessionIds = new Set(
          events.filter(isProposeTriggerEvent).map((e) => e.session),
        );
        if (proposer) {
          for (const sessionId of sessionIds) {
            proposer.onEvents(sessionId);
          }
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/script/latest") {
        if (!latestScript) {
          sendJson(res, 404, { ok: false, error: "No action script compiled yet" });
          return;
        }
        sendJson(res, 200, { ok: true, script: latestScript });
        return;
      }

      if (req.method === "GET" && rawPath.startsWith("/script/")) {
        let findingId: string;
        try {
          findingId = decodeURIComponent(rawPath.slice("/script/".length));
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid finding id" });
          return;
        }

        if (!isValidArtifactId(findingId)) {
          sendJson(res, 400, { ok: false, error: "Invalid finding id" });
          return;
        }

        const script = scriptsByFindingId.get(findingId);
        if (!script) {
          sendJson(res, 404, { ok: false, error: "Script not found" });
          return;
        }

        sendJson(res, 200, { ok: true, script });
        return;
      }

      if (req.method === "POST" && url.pathname === "/library/auto") {
        const raw = await readBody(req);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }

        if (
          !parsedJson ||
          typeof parsedJson !== "object" ||
          Array.isArray(parsedJson) ||
          typeof (parsedJson as { solution?: unknown }).solution !== "string" ||
          (parsedJson as { solution: string }).solution.trim().length === 0
        ) {
          sendJson(res, 400, { ok: false, error: "Expected non-empty solution string" });
          return;
        }

        const body = parsedJson as {
          name?: unknown;
          solution: string;
          script?: unknown;
          context?: unknown;
          suppressRecallMs?: unknown;
        };

        let script: ActionScript;
        try {
          script = parseActionScript(body.script);
        } catch (err) {
          sendJson(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : "Invalid action script",
          });
          return;
        }

        const name = typeof body.name === "string" ? body.name : undefined;
        const context =
          body.context && typeof body.context === "object" && !Array.isArray(body.context)
            ? (body.context as ImplementContext)
            : undefined;

        const built = buildLibraryEntryFromScript({
          name,
          solution: body.solution,
          script,
          context,
          status: "active",
        });
        const { entry } = await upsertLibraryEntry(dataDir, built);
        latestScript = entry.script;
        reportCache.clear();
        console.log(
          `[server] saved snippet id=${entry.id} name="${entry.name}" locators=${entry.eyes.targetHints.locators.map((l) => `${l.kind}:${l.value}`).join(",")}`,
        );
        const suppressMs =
          typeof body.suppressRecallMs === "number" && Number.isFinite(body.suppressRecallMs)
            ? Math.max(0, body.suppressRecallMs)
            : 0;
        if (suppressMs > 0) {
          recallMatcher.suppressEntry(entry.id, suppressMs);
        }
        sendJson(res, 200, { ok: true, entry });
        return;
      }

      if (req.method === "POST" && (url.pathname === "/implement" || url.pathname === "/library/implement")) {
        const raw = await readBody(req);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }

        if (
          !parsedJson ||
          typeof parsedJson !== "object" ||
          Array.isArray(parsedJson) ||
          typeof (parsedJson as { solution?: unknown }).solution !== "string" ||
          (parsedJson as { solution: string }).solution.trim().length === 0
        ) {
          sendJson(res, 400, { ok: false, error: "Expected non-empty solution string" });
          return;
        }

        const body = parsedJson as {
          solution: string;
          name?: unknown;
          context?: unknown;
          includeEntry?: unknown;
        };
        const name = typeof body.name === "string" ? body.name : undefined;
        const context =
          body.context && typeof body.context === "object" && !Array.isArray(body.context)
            ? (body.context as ImplementContext)
            : undefined;

        const compiled = await compileLibraryEntry(body.solution, { name, context });
        const { entry } = await upsertLibraryEntry(dataDir, compiled);
        latestScript = entry.script;
        reportCache.clear();

        if (url.pathname === "/library/implement") {
          sendJson(res, 200, { ok: true, entry });
          return;
        }
        sendJson(
          res,
          200,
          body.includeEntry === true
            ? { ok: true, script: entry.script, entry }
            : { ok: true, script: entry.script },
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/library") {
        const items = dedupeLibraryEntries(await readLibrary(dataDir));
        sendJson(res, 200, { ok: true, items });
        return;
      }

      if (req.method === "POST" && url.pathname === "/library") {
        const raw = await readBody(req);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }

        const parsedEntry = LibraryEntrySchema.safeParse(parsedJson);
        if (!parsedEntry.success) {
          sendJson(res, 400, {
            ok: false,
            error: parsedEntry.error.issues
              .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
              .join("; "),
          });
          return;
        }

        const saved = await upsertLibraryEntry(dataDir, parsedEntry.data);
        reportCache.clear();
        sendJson(res, 200, { ok: true, entry: saved.entry, items: saved.items });
        return;
      }

      if (req.method === "DELETE" && rawPath.startsWith("/library/")) {
        let id: string;
        try {
          id = decodeURIComponent(rawPath.slice("/library/".length));
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid library entry id" });
          return;
        }
        if (!isValidArtifactId(id)) {
          sendJson(res, 400, { ok: false, error: "Invalid library entry id" });
          return;
        }
        const removed = await deleteLibraryEntry(dataDir, id);
        if (!removed.deleted) {
          sendJson(res, 404, { ok: false, error: "Library entry not found" });
          return;
        }
        reportCache.clear();
        sendJson(res, 200, { ok: true, items: removed.items });
        return;
      }

      if (req.method === "POST" && url.pathname === "/decide") {
        const raw = await readBody(req);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }

        if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
          sendJson(res, 400, { ok: false, error: "Expected JSON object" });
          return;
        }

        const body = parsedJson as { name?: unknown; solution?: unknown; script?: unknown };
        if (typeof body.solution !== "string" || body.solution.trim().length === 0) {
          sendJson(res, 400, { ok: false, error: "Expected non-empty solution string" });
          return;
        }

        let script: ActionScript;
        try {
          script = parseActionScript(body.script);
        } catch (err) {
          sendJson(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : "Invalid action script",
          });
          return;
        }

        const name =
          typeof body.name === "string" && body.name.trim().length > 0
            ? body.name.trim()
            : (script.name ?? "Proposed automation");
        const timeoutMs = Number(url.searchParams.get("timeoutMs")) || 60000;
        const { id, outcome } = await requestDecision({
          name,
          solution: body.solution.trim(),
          script,
          timeoutMs,
        });
        if (
          outcome.ok &&
          outcome.decision !== "approved" &&
          outcome.decision !== "dismissed" &&
          outcome.decision !== "never"
        ) {
          console.error(`[server] POST /decide id=${id} missing decision in outcome:`, outcome);
          sendJson(res, 502, {
            id,
            ok: false,
            error:
              "Extension did not return a valid decision (reload the Eyes extension in chrome://extensions)",
          });
          return;
        }
        sendJson(res, outcome.ok ? 200 : 504, { id, ...outcome });
        return;
      }

      if (req.method === "POST" && url.pathname === "/hands/run") {
        const raw = await readBody(req);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }

        let script: ActionScript;
        try {
          const payload =
            parsedJson && typeof parsedJson === "object" && "script" in parsedJson
              ? (parsedJson as { script: unknown }).script
              : parsedJson;
          script = parseActionScript(payload);
        } catch (err) {
          sendJson(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : "Invalid action script",
          });
          return;
        }

        const id = crypto.randomUUID();
        const timeoutMs = Number(url.searchParams.get("timeoutMs")) || 30000;
        console.log(`[server] POST /hands/run id=${id} steps=${script.steps.length}`);
        const outcome = await awaitHands(
          { id, script },
          timeoutMs,
          "Timed out waiting for extension to execute script",
        );
        console.log(`[server] POST /hands/run id=${id} ok=${outcome.ok}`);
        sendJson(res, outcome.ok ? 200 : 504, { id, ...outcome });
        return;
      }

      if (req.method === "GET" && url.pathname === "/hands/next") {
        const queued = commandQueue.shift();
        if (queued) {
          sendJson(res, 200, { ok: true, ...queued });
          return;
        }

        if (nextPollResolver) {
          nextPollResolver(null);
          nextPollResolver = null;
        }

        const waitMs = Math.min(25000, Math.max(0, Number(url.searchParams.get("waitMs")) || 20000));
        const cmd = await new Promise<HandsCommand | null>((resolve) => {
          let settled = false;
          const finish = (value: HandsCommand | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (nextPollResolver === finish) nextPollResolver = null;
            resolve(value);
          };
          const timer = setTimeout(() => finish(null), waitMs);
          req.on("close", () => finish(null));
          nextPollResolver = finish;
        });

        if (!cmd) {
          res.writeHead(204);
          res.end();
          return;
        }
        sendJson(res, 200, { ok: true, ...cmd });
        return;
      }

      if (req.method === "POST" && url.pathname === "/hands/result") {
        const raw = await readBody(req);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }
        if (!parsedJson || typeof parsedJson !== "object") {
          sendJson(res, 400, { ok: false, error: "Invalid result payload" });
          return;
        }
        const body = parsedJson as {
          id?: unknown;
          ok?: unknown;
          results?: unknown;
          decision?: unknown;
          params?: unknown;
          error?: unknown;
        };
        if (typeof body.id !== "string" || typeof body.ok !== "boolean") {
          sendJson(res, 400, { ok: false, error: "Expected id and ok boolean" });
          return;
        }
        const decision: HandsDecision | undefined =
          body.decision === "approved" ||
          body.decision === "dismissed" ||
          body.decision === "never"
            ? body.decision
            : undefined;
        let params: Record<string, string> | undefined;
        if (body.params && typeof body.params === "object" && !Array.isArray(body.params)) {
          const entries = Object.entries(body.params as Record<string, unknown>).filter(
            (pair): pair is [string, string] => typeof pair[1] === "string",
          );
          if (entries.length > 0) {
            params = Object.fromEntries(entries);
          }
        }
        const resolve = waiters.get(body.id);
        if (!resolve) {
          sendJson(res, 404, { ok: false, error: "No pending run for id" });
          return;
        }
        console.log(
          `[server] POST /hands/result id=${body.id} ok=${body.ok} decision=${decision ?? "-"}`
        );
        resolve({
          ok: body.ok,
          ...(body.results !== undefined ? { results: body.results } : {}),
          ...(decision ? { decision } : {}),
          ...(params ? { params } : {}),
          ...(typeof body.error === "string" ? { error: body.error } : {}),
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      sendJson(res, 500, { ok: false, error: message });
    }
  });

  server.on("close", () => {
    proposer?.close();
    for (const resolve of [...waiters.values()]) {
      resolve({ ok: false, error: "Server closed" });
    }
    waiters.clear();
    commandQueue.length = 0;
  });

  return server;
}
