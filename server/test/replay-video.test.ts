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
});
