/* global process, URL */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Serve the local demo app (default: apps/demo) on localhost.
 * Tries the next port when the requested one is already in use.
 */
export async function startDemoServer({
  dir,
  port = 5173,
  host = "127.0.0.1",
  maxPortTries = 10,
} = {}) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }

    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  });

  let lastError;
  for (let attempt = 0; attempt < maxPortTries; attempt++) {
    const candidate = port + attempt;
    try {
      await listen(server, candidate, host);
      return {
        server,
        port: server.address().port,
        url: `http://${host}:${server.address().port}/`,
        close: () => new Promise((resolve) => server.close(resolve)),
      };
    } catch (err) {
      lastError = err;
      if (err.code !== "EADDRINUSE") throw err;
    }
  }
  throw lastError;
}

export function parsePortArg(flag, fallback) {
  const found = process.argv.find((arg) => arg.startsWith(`--${flag}=`));
  const value = found ? Number(found.slice(flag.length + 3)) : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
}
