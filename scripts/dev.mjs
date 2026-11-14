/* global console, process, fetch, setTimeout, AbortSignal */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { startDemoServer } from "./lib/static-server.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(rootDir, ".env"), quiet: true });
const extensionDir = path.join(rootDir, "extension");
const demoDir = path.join(rootDir, "apps", "demo");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const backendPort = Number(arg("port", process.env.PORT || 8787));
const appPort = Number(arg("app-port", process.env.DEV_APP_PORT || 5173));
const eventsEndpoint = `http://localhost:${backendPort}/events`;

const children = new Set();
let demoServer;
let shuttingDown = false;

function spawnChild(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    stdio: "inherit",
    ...options,
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function killChildren() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Child already exited.
    }
  }
}

async function isHealthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${backendPort}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isHealthy()) return true;
    await sleep(250);
  }
  return false;
}

function buildExtension() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(extensionDir, "build.mjs")], {
      cwd: extensionDir,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`extension build failed with exit code ${code}`));
    });
  });
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[dev] shutting down...");
  killChildren();
  if (demoServer) {
    await Promise.race([demoServer.close(), sleep(2000)]);
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("exit", killChildren);

async function main() {
  if (flag("help")) {
    console.log(`Usage: pnpm dev [options]

  --no-browser          Start backend, demo app, watcher, and trace tail only
  --no-watch            Do not rebuild the extension on source changes
  --no-tail             Do not print captured events from traces/
  --headless            Launch the dev browser headless (if supported)
  --port=8787           Backend port (the extension defaults to 8787)
  --app-port=5173       Demo app port
  --url=<url>           Extra page to open in the dev browser (repeatable)
`);
    return;
  }

  if (!fs.existsSync(path.join(rootDir, "node_modules"))) {
    console.error("[dev] dependencies are missing. Run `pnpm install` first.");
    process.exit(1);
  }

  console.log("[dev] building extension...");
  await buildExtension();

  if (await isHealthy()) {
    console.log(`[dev] backend already running on port ${backendPort}; reusing it`);
  } else {
    console.log(`[dev] starting backend on http://localhost:${backendPort}`);
    const serverChild = spawnChild(["--experimental-strip-types", "server/src/index.ts"], {
      env: { ...process.env, PORT: String(backendPort) },
    });
    serverChild.on("exit", (code) => {
      if (!shuttingDown && code !== 0) {
        console.error(`[dev] backend exited with code ${code}`);
        void shutdown(1);
      }
    });
    if (!(await waitForHealth())) {
      console.error("[dev] backend did not become healthy in time");
      await shutdown(1);
      return;
    }
  }

  demoServer = await startDemoServer({ dir: demoDir, port: appPort });
  console.log(`[dev] demo app at ${demoServer.url}`);

  if (!flag("no-watch")) {
    spawnChild(["scripts/watch-extension.mjs", "--no-initial-build"]);
  }

  if (!flag("no-tail")) {
    spawnChild(["scripts/tail-traces.mjs"]);
  }

  const headless = flag("headless");
  const hasDisplay =
    process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const shouldOpenBrowser = !flag("no-browser") && (hasDisplay || headless);

  if (shouldOpenBrowser) {
    const urls = process.argv
      .filter((value) => value.startsWith("--url="))
      .map((value) => `--url=${value.slice("--url=".length)}`);
    const browserChild = spawnChild([
      "scripts/dev-browser.mjs",
      `--url=${demoServer.url}`,
      ...urls,
      ...(headless ? ["--headless"] : []),
    ]);
    browserChild.on("exit", (code) => {
      if (!shuttingDown && code === 0) {
        console.log("[dev] browser closed; backend is still running (Ctrl+C to stop)");
      }
    });
  } else if (!flag("no-browser")) {
    console.log("[dev] no display detected; skipping browser (use --headless to try anyway)");
  }

  console.log(`
[dev] ready
  backend   http://localhost:${backendPort}  (POST ${eventsEndpoint})
  demo      ${demoServer.url}
  traces    ${path.join(rootDir, "traces")}/*.jsonl
  profile   ${path.join(rootDir, ".dev", "chrome-profile")}
`);
}

main().catch(async (err) => {
  console.error("[dev]", err instanceof Error ? err.message : err);
  await shutdown(1);
});
