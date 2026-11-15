import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/app.ts";
import { recordScriptReplay } from "../src/replay-video.ts";

const DEMO_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Profile Demo</title></head>
<body style="font-family: sans-serif; padding: 24px;">
  <form id="profile-form">
    <label>Company name <input name="company_name" placeholder="Nikolaidis Logistics SA" /></label>
    <button type="submit">Save profile</button>
    <span id="form-status"></span>
  </form>
  <script>
    document.getElementById("profile-form").addEventListener("submit", (e) => {
      e.preventDefault();
      document.getElementById("form-status").textContent = "Saved locally";
    });
  </script>
</body>
</html>`;

describe("live Playwright replay video for proposed ActionScript", () => {
  const servers: http.Server[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const srv of servers) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    servers.length = 0;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("records the actual proposed ActionScript running on the target page and serves it at GET /replay/:id.webm", async () => {
    const pageServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DEMO_HTML);
    });
    servers.push(pageServer);
    await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", () => resolve()));
    const pagePort = (pageServer.address() as AddressInfo).port;
    const pageUrl = `http://127.0.0.1:${pagePort}/`;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-replay-test-"));
    tempDirs.push(tmpRoot);
    const tracesDir = path.join(tmpRoot, "traces");
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(tracesDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const apiServer = createServer({ tracesDir, dataDir, autoPropose: false });
    servers.push(apiServer);
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", () => resolve()));
    const apiPort = (apiServer.address() as AddressInfo).port;
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

    const script = {
      name: "Update Company Profile",
      steps: [
        { action: "switchTab" as const, host: "127.0.0.1", url: pageUrl },
        {
          action: "fill" as const,
          target: [{ kind: "css" as const, value: 'input[name="company_name"]' }],
          value: "{{companyName}}",
        },
        {
          action: "click" as const,
          target: [{ kind: "text" as const, value: "Save profile" }],
        },
      ],
      params: [
        {
          name: "companyName",
          example: "nikolaidis logistics",
        },
      ],
    };

    const directBuffer = await recordScriptReplay(script);
    expect(directBuffer).not.toBeNull();
    expect(directBuffer!.byteLength).toBeGreaterThan(1000);

    const decidePromise = fetch(`${apiBaseUrl}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Update Company Profile",
        solution: "Enter company name and click Save profile.",
        script,
      }),
    });

    const nextRes = await fetch(`${apiBaseUrl}/hands/next?waitMs=2000`);
    expect(nextRes.status).toBe(200);
    const decideCmd = (await nextRes.json()) as {
      id: string;
      kind: string;
      videoUrl?: string;
    };
    expect(decideCmd.kind).toBe("decide");
    expect(decideCmd.videoUrl).toBe(`/replay/${decideCmd.id}.webm`);

    const videoRes = await fetch(`${apiBaseUrl}${decideCmd.videoUrl}`);
    expect(videoRes.status).toBe(200);
    expect(videoRes.headers.get("content-type")).toBe("video/webm");
    const videoBytes = Buffer.from(await videoRes.arrayBuffer());
    expect(videoBytes.byteLength).toBeGreaterThan(1000);

    await fetch(`${apiBaseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: decideCmd.id, ok: true, decision: "approved" }),
    });
    const decideRes = await decidePromise;
    expect(decideRes.status).toBe(200);
  }, 25000);

  it("stops and returns null (and serves 404 instead of fallback demo video) when a step target is missing, hidden, or non-matching for the step resolver", async () => {
    const pageServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <body>
            <div aria-label="Search query">Not an input</div>
            <button style="display:none">Hidden Submit</button>
          </body>
        </html>`);
    });
    servers.push(pageServer);
    await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", () => resolve()));
    const pagePort = (pageServer.address() as AddressInfo).port;
    const pageUrl = `http://127.0.0.1:${pagePort}/`;

    // Non-editable div with matching aria-label must NOT resolve for fill (same resolver as step)
    const fillNonEditableResult = await recordScriptReplay({
      name: "Fill missing input",
      steps: [
        { action: "navigate", url: pageUrl },
        {
          action: "fill",
          target: [{ kind: "aria", value: "Search query" }],
          value: "dypa",
        },
      ],
    });
    expect(fillNonEditableResult).toBeNull();

    // Hidden element must NOT resolve or be outlined
    const hiddenTargetResult = await recordScriptReplay({
      name: "Click hidden button",
      steps: [
        { action: "navigate", url: pageUrl },
        {
          action: "click",
          target: [{ kind: "text", value: "Hidden Submit" }],
        },
      ],
    });
    expect(hiddenTargetResult).toBeNull();

    // Server must return 404 instead of serving unrelated fallback demo video
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-replay-404-"));
    tempDirs.push(tmpRoot);
    const tracesDir = path.join(tmpRoot, "traces");
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(tracesDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const apiServer = createServer({ tracesDir, dataDir, autoPropose: false });
    servers.push(apiServer);
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", () => resolve()));
    const apiPort = (apiServer.address() as AddressInfo).port;
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

    const decidePromise = fetch(`${apiBaseUrl}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Missing target workflow",
        solution: "Click a button that is not on the page.",
        script: {
          name: "Missing target workflow",
          steps: [
            { action: "navigate", url: pageUrl },
            { action: "click", target: [{ kind: "text", value: "Does Not Exist" }] },
          ],
        },
      }),
    });

    const nextRes = await fetch(`${apiBaseUrl}/hands/next?waitMs=2000`);
    expect(nextRes.status).toBe(200);
    const decideCmd = (await nextRes.json()) as { id: string; videoUrl?: string };
    expect(decideCmd.videoUrl).toBe(`/replay/${decideCmd.id}.webm`);

    const videoRes = await fetch(`${apiBaseUrl}${decideCmd.videoUrl}`);
    expect(videoRes.status).toBe(404);

    await fetch(`${apiBaseUrl}/hands/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: decideCmd.id, ok: true, decision: "dismissed" }),
    });
    await decidePromise;
  }, 25000);

  it("opens each step on its recorded host/URL via hostUrls and aborts instead of falling back to initialUrl on an unmapped host", async () => {
    const serverA = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><input name="q" /></body></html>`);
    });
    const serverB = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><button id="go">Proceed to DYPA</button></body></html>`);
    });
    servers.push(serverA, serverB);
    await new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve) => serverB.listen(0, "localhost", () => resolve()));

    const portA = (serverA.address() as AddressInfo).port;
    const portB = (serverB.address() as AddressInfo).port;
    const urlA = `http://127.0.0.1:${portA}/search`;
    const urlB = `http://localhost:${portB}/service`;

    const hostUrls = new Map<string, string>([
      [`127.0.0.1:${portA}`, urlA],
      [`localhost:${portB}`, urlB],
    ]);

    const multiHostBuf = await recordScriptReplay(
      {
        name: "Multi-host switchTab via hostUrls",
        steps: [
          { action: "switchTab", host: `127.0.0.1:${portA}` },
          { action: "fill", target: [{ kind: "css", value: 'input[name="q"]' }], value: "dypa" },
          { action: "switchTab", host: `localhost:${portB}` },
          { action: "click", target: [{ kind: "css", value: "#go" }] },
        ],
      },
      { hostUrls },
    );
    expect(multiHostBuf).not.toBeNull();
    expect(multiHostBuf!.byteLength).toBeGreaterThan(1000);

    // If switchTab targets an unmapped host without url, must NOT fall back to initialUrl (serverA)
    const unmappedHostBuf = await recordScriptReplay(
      {
        name: "Unmapped switchTab host",
        steps: [
          { action: "switchTab", host: `127.0.0.1:${portA}`, url: urlA },
          { action: "fill", target: [{ kind: "css", value: 'input[name="q"]' }], value: "dypa" },
          { action: "switchTab", host: "missing.local" },
          { action: "fill", target: [{ kind: "css", value: 'input[name="q"]' }], value: "wrong" },
        ],
      },
      { hostUrls },
    );
    expect(unmappedHostBuf).toBeNull();
  }, 25000);
});
