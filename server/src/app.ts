import http from "node:http";
import { buildReport } from "./report.ts";
import { appendEvents } from "./trace.ts";
import { parseEvents } from "./validate.ts";

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

export function createServer(opts: { tracesDir: string }): http.Server {
  let latestSession = "none";

  return http.createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/report") {
        const sessionParam = url.searchParams.get("session");
        const session = sessionParam && sessionParam.length > 0 ? sessionParam : latestSession;
        sendJson(res, 200, buildReport(session));
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
        if (validation.events.length > 0) {
          latestSession = validation.events[validation.events.length - 1].session;
        }
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
