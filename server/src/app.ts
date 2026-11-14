import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { ReportSchema } from "@gen/shared/schema.ts";
import { isValidArtifactId, readSnippetArtifact } from "./artifacts.ts";
import { implementSolution } from "./hands/implementor.ts";
import { parseActionScript, type ActionScript } from "./hands/types.ts";
import type { GeminiClient, GeminiClientOptions } from "./llm/gemini.ts";
import { buildCombinedReport, buildReport } from "./report.ts";
import { scrubEvents } from "./scrub.ts";
import { appendEvents, listSessions, readEvents } from "./trace.ts";
import { parseEvents } from "./validate.ts";

const RECENT_SESSION_WINDOW_MS = 30 * 60 * 1000;

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

export type CreateServerOptions = {
  tracesDir: string;
  dataDir?: string;
  implement?: (solution: string, opts?: { name?: string }) => Promise<ActionScript>;
  gemini?: GeminiClient | GeminiClientOptions;
};

type HandsCommand = { id: string; script: ActionScript };
type HandsOutcome = { ok: boolean; results?: unknown; error?: string };

export function createServer(opts: CreateServerOptions): http.Server {
  const dataDir = opts.dataDir ?? path.resolve(opts.tracesDir, "..", "data");
  let latestScript: ActionScript | null = null;
  const scriptsByFindingId = new Map<string, ActionScript>();
  const implement =
    opts.implement ??
    ((solution: string, o?: { name?: string }) => implementSolution(solution, o));

  const commandQueue: HandsCommand[] = [];
  const waiters = new Map<string, (outcome: HandsOutcome) => void>();
  let nextPollResolver: ((cmd: HandsCommand | null) => void) | null = null;

  function dispatchNext(cmd: HandsCommand): void {
    if (nextPollResolver) {
      const resolve = nextPollResolver;
      nextPollResolver = null;
      resolve(cmd);
    } else {
      commandQueue.push(cmd);
    }
  }
  return http.createServer(async (req, res) => {
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
        if (sessionParam && sessionParam.length > 0) {
          const events = await readEvents(opts.tracesDir, sessionParam);
          report = await buildReport(sessionParam, events, reportOpts);
        } else {
          const cutoffMs = Date.now() - RECENT_SESSION_WINDOW_MS;
          const sessions = await listSessions(opts.tracesDir);
          const recentSessions = sessions.filter((s) => s.mtimeMs >= cutoffMs);
          const sessionEvents = await Promise.all(
            recentSessions.map((s) => readEvents(opts.tracesDir, s.session)),
          );
          report = await buildCombinedReport(sessionEvents, reportOpts);
        }
        const parsed = ReportSchema.safeParse(report);
        if (!parsed.success) {
          sendJson(res, 500, { ok: false, error: parsed.error.message });
          return;
        }
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
        sendJson(res, 200, { ok: true, n: events.length, scrubbed });
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

      if (req.method === "POST" && url.pathname === "/implement") {
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

        const body = parsedJson as { solution: string; name?: unknown };
        const name = typeof body.name === "string" ? body.name : undefined;
        const script = await implement(body.solution, { name });
        latestScript = script;
        sendJson(res, 200, { ok: true, script });
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
        const outcomePromise = new Promise<HandsOutcome>((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(id);
            const idx = commandQueue.findIndex((c) => c.id === id);
            if (idx >= 0) commandQueue.splice(idx, 1);
            resolve({ ok: false, error: "Timed out waiting for extension to execute script" });
          }, timeoutMs);
          waiters.set(id, (outcome) => {
            clearTimeout(timer);
            waiters.delete(id);
            resolve(outcome);
          });
        });

        dispatchNext({ id, script });
        const outcome = await outcomePromise;
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
        const body = parsedJson as { id?: unknown; ok?: unknown; results?: unknown; error?: unknown };
        if (typeof body.id !== "string" || typeof body.ok !== "boolean") {
          sendJson(res, 400, { ok: false, error: "Expected id and ok boolean" });
          return;
        }
        const resolve = waiters.get(body.id);
        if (!resolve) {
          sendJson(res, 404, { ok: false, error: "No pending run for id" });
          return;
        }
        resolve({
          ok: body.ok,
          ...(body.results !== undefined ? { results: body.results } : {}),
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
}
