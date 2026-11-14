import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import type { Report } from "@gen/shared";
import { ReportSchema } from "@gen/shared/schema.ts";
import { isValidArtifactId, readSnippetArtifact } from "./artifacts.ts";
import {
  buildLibraryEntryFromScript,
  implementForLibrary,
  implementSolution,
  type ImplementContext,
} from "./hands/implementor.ts";
import {
  deleteLibraryEntry,
  readLibrary,
  recordLibraryRun,
  upsertLibraryEntry,
} from "./hands/library.ts";
import { createLibraryRecallMatcher } from "./hands/recall.ts";
import {
  LibraryEntrySchema,
  parseActionScript,
  type ActionScript,
  type LibraryEntry,
} from "./hands/types.ts";
import type { GeminiClient, GeminiClientOptions } from "./llm/gemini.ts";
import { createProposer, type HandsDecision, type HandsOutcome } from "./propose.ts";
import { buildCombinedReport, buildReport } from "./report.ts";
import { scrubEvents } from "./scrub.ts";
import { appendEvents, listSessions, readEvents } from "./trace.ts";
import { parseEvents } from "./validate.ts";

const RECENT_SESSION_WINDOW_MS = 30 * 60 * 1000;

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
  implementLibrary?: (
    solution: string,
    opts?: { name?: string; context?: ImplementContext },
  ) => Promise<LibraryEntry>;
  autoPropose?: boolean;
  proposeDebounceMs?: number;
};

type HandsCommand =
  | { id: string; kind?: "run"; script: ActionScript }
  | { id: string; kind: "decide"; name: string; solution: string; script: ActionScript };

export function createServer(opts: CreateServerOptions): http.Server {
  const dataDir = opts.dataDir ?? path.resolve(opts.tracesDir, "..", "data");
  let latestScript: ActionScript | null = null;
  const scriptsByFindingId = new Map<string, ActionScript>();
  const reportCache = new Map<string, Report>();
  const liveSessions = new Set<string>();
  const implement =
    opts.implement ??
    ((solution: string, o?: { name?: string }) => implementSolution(solution, o));
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
  let activeLibraryDecideId: string | null = null;

  function dispatchNext(cmd: HandsCommand): void {
    if (nextPollResolver) {
      const resolve = nextPollResolver;
      nextPollResolver = null;
      resolve(cmd);
    } else {
      commandQueue.push(cmd);
    }
  }

  function awaitHands(
    cmd: HandsCommand,
    timeoutMs: number,
    timeoutError?: string,
  ): Promise<HandsOutcome> {
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
    name: string;
    solution: string;
    script: ActionScript;
    timeoutMs?: number;
  }): Promise<{ id: string; outcome: HandsOutcome }> {
    const id = crypto.randomUUID();
    const timeoutMs = input.timeoutMs ?? 60000;
    console.log(
      `[server] decide id=${id} name="${input.name}" steps=${input.script.steps.length}`,
    );
    const outcome = await awaitHands(
      { id, kind: "decide", name: input.name, solution: input.solution, script: input.script },
      timeoutMs,
      "Timed out waiting for user decision",
    );
    console.log(`[server] decide id=${id} resolved:`, outcome.decision ?? outcome.error);
    return { id, outcome };
  }

  async function triggerLibraryRecall(entry: LibraryEntry): Promise<void> {
    if (activeLibraryDecideId) return;
    activeLibraryDecideId = entry.id;
    recallMatcher.markTriggered(entry.id);
    try {
      const { outcome } = await requestDecision({
        name: entry.name,
        solution: entry.solution,
        script: entry.script,
      });
      recallMatcher.markTriggered(entry.id);
      if (outcome.ok && outcome.decision === "approved") {
        await recordLibraryRun(dataDir, entry.id).catch(() => {});
        const runId = crypto.randomUUID();
        console.log(
          `[server] library recall approved id=${entry.id} -> running script runId=${runId}`,
        );
        void awaitHands(
          { id: runId, script: entry.script },
          30000,
          "Timed out waiting for extension to execute script",
        );
      }
    } finally {
      if (activeLibraryDecideId === entry.id) {
        activeLibraryDecideId = null;
      }
    }
  }

  const autoPropose = opts.autoPropose ?? process.env.BRAIN_AUTO_PROPOSE !== "0";
  const proposer = autoPropose
    ? createProposer({
        runReport: async (sessionId) => {
          const reportOpts = {
            dataDir,
            llm: true,
            gemini: opts.gemini,
            implement,
            scriptStore: scriptsByFindingId,
          };
          const targetSessions =
            liveSessions.size > 0 ? [...liveSessions] : [sessionId];
          if (targetSessions.length <= 1) {
            const targetSession = targetSessions[0] ?? sessionId;
            const events = await readEvents(opts.tracesDir, targetSession);
            const report = await buildReport(targetSession, events, reportOpts);
            return { findings: report.findings, scripts: scriptsByFindingId };
          }
          const allEvents = await Promise.all(
            targetSessions.map((s) => readEvents(opts.tracesDir, s)),
          );
          const report = await buildCombinedReport(allEvents, reportOpts);
          return { findings: report.findings, scripts: scriptsByFindingId };
        },
        requestDecision: (name, solution, script) =>
          awaitHands(
            { id: crypto.randomUUID(), kind: "decide", name, solution, script },
            60000,
          ),
        runScript: (script) => awaitHands({ id: crypto.randomUUID(), script }, 30000),
        debounceMs: opts.proposeDebounceMs,
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
        sendJson(res, 200, { ok: true });
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
          implement,
          scriptStore: scriptsByFindingId,
        };
        let report: unknown;
        let cacheSig: string;
        if (sessionParam && sessionParam.length > 0) {
          const events = await readEvents(opts.tracesDir, sessionParam);
          cacheSig = `${sessionParam}|${llm ? 1 : 0}|${sessionParam}:${events.length}:${events.at(-1)?.ts ?? 0}`;
          const cached = reportCache.get(cacheSig);
          if (cached && hasAllCachedScripts(cached, scriptsByFindingId)) {
            sendJson(res, 200, cached);
            return;
          }
          report = await buildReport(sessionParam, events, reportOpts);
        } else {
          const cutoffMs = Date.now() - RECENT_SESSION_WINDOW_MS;
          const sessions = await listSessions(opts.tracesDir);
          const recentSessions = sessions.filter((s) => s.mtimeMs >= cutoffMs);
          const sessionEvents = await Promise.all(
            recentSessions.map((s) => readEvents(opts.tracesDir, s.session)),
          );
          const perSessionSig = recentSessions
            .map((s, idx) => {
              const evs = sessionEvents[idx] ?? [];
              return `${s.session}:${evs.length}:${evs.at(-1)?.ts ?? 0}`;
            })
            .join(",");
          cacheSig = `all|${llm ? 1 : 0}|${perSessionSig}`;
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
        if (events.some((e) => e.type === "nav" && e.meta?.subType === "page_load")) {
          for (let i = commandQueue.length - 1; i >= 0; i--) {
            if (commandQueue[i]?.kind === "decide") {
              const stale = commandQueue.splice(i, 1)[0];
              if (stale) {
                waiters.get(stale.id)?.({ ok: false, error: "Page navigated before decision" });
              }
            }
          }
          if (commandQueue.every((c) => c.kind !== "decide") && waiters.size === 0) {
            activeLibraryDecideId = null;
          }
        }
        if (!activeLibraryDecideId) {
          const entries = await readLibrary(dataDir).catch(() => []);
          const matched = recallMatcher.matchEvents(events, entries);
          if (matched) {
            console.log(
              `[server] half-detected library match id=${matched.id} name="${matched.name}" -> /decide`,
            );
            void triggerLibraryRecall(matched);
          }
        }
        sendJson(res, 200, { ok: true, n: events.length, scrubbed });
        const sessionIds = new Set(events.map((e) => e.session));
        for (const sessionId of sessionIds) {
          liveSessions.add(sessionId);
        }
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
        const items = await readLibrary(dataDir);
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
        if (outcome.ok && outcome.decision !== "approved" && outcome.decision !== "dismissed") {
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
          error?: unknown;
        };
        if (typeof body.id !== "string" || typeof body.ok !== "boolean") {
          sendJson(res, 400, { ok: false, error: "Expected id and ok boolean" });
          return;
        }
        const decision: HandsDecision | undefined =
          body.decision === "approved" || body.decision === "dismissed"
            ? body.decision
            : undefined;
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
