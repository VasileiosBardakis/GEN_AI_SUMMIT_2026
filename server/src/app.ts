import http from "node:http";
import path from "node:path";
import { ReportSchema } from "@gen/shared/schema.ts";
import { isValidArtifactId, readSnippetArtifact } from "./artifacts.ts";
import { buildCombinedReport, buildReport } from "./report.ts";
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

export function createServer(opts: { tracesDir: string; dataDir?: string }): http.Server {
  const dataDir = opts.dataDir ?? path.join(opts.tracesDir, "data");

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
        let report: unknown;
        if (sessionParam && sessionParam.length > 0) {
          const events = await readEvents(opts.tracesDir, sessionParam);
          report = buildReport(sessionParam, events, { dataDir });
        } else {
          const cutoffMs = Date.now() - RECENT_SESSION_WINDOW_MS;
          const sessions = await listSessions(opts.tracesDir);
          const recentSessions = sessions.filter((s) => s.mtimeMs >= cutoffMs);
          const sessionEvents = await Promise.all(
            recentSessions.map((s) => readEvents(opts.tracesDir, s.session)),
          );
          report = buildCombinedReport(sessionEvents, { dataDir });
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

        await appendEvents(opts.tracesDir, validation.events);
        sendJson(res, 200, { ok: true, n: validation.events.length });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      sendJson(res, 500, { ok: false, error: message });
    }
  });
}
