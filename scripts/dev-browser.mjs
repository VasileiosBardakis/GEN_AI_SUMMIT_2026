/* global console, process, URL */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { resolveChromeExecutable } from "./lib/chrome.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(rootDir, "extension");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

if (!fs.existsSync(path.join(extensionDir, "manifest.json"))) {
  console.error("extension/manifest.json is missing.");
  process.exit(1);
}

if (!fs.existsSync(path.join(extensionDir, "dist", "content.js"))) {
  console.error("extension/dist is missing. Run `pnpm dev:build` first.");
  process.exit(1);
}

const urls = process.argv
  .filter((value) => value.startsWith("--url="))
  .map((value) => value.slice("--url=".length));
if (urls.length === 0) {
  urls.push(arg("url", process.env.DEV_APP_URL || "http://127.0.0.1:5173/"));
}

const profileDir = path.resolve(rootDir, arg("profile", path.join(".dev", "chrome-profile")));
const headless = flag("headless");
const openPanel = !flag("no-panel");
const debugPort = arg("debug-port", process.env.DEV_DEBUG_PORT || "");

fs.mkdirSync(profileDir, { recursive: true });
// Clear Chrome's cached MV3 Service Worker so unpacked extension changes in dist/background.js always load fresh.
const swCacheDir = path.join(profileDir, "Default", "Service Worker");
if (fs.existsSync(swCacheDir)) {
  fs.rmSync(swCacheDir, { recursive: true, force: true });
}

const executablePath = await resolveChromeExecutable();

console.log(`[browser] launching ${executablePath}`);
console.log(`[browser] profile   ${profileDir}`);
console.log(`[browser] extension ${extensionDir}`);

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless,
  viewport: null,
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--window-size=1440,960",
    ...(debugPort ? [`--remote-debugging-port=${debugPort}`] : []),
  ],
});

let serviceWorker = context.serviceWorkers()[0];
if (!serviceWorker) {
  serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => undefined);
}

let extensionId;
if (serviceWorker) {
  extensionId = new URL(serviceWorker.url()).host;
  console.log(`[browser] extension id ${extensionId}`);
} else {
  console.warn("[browser] service worker not detected; is the extension allowed to load?");
}

const page = context.pages()[0] || (await context.newPage());
for (const target of urls) {
  const tab = target === urls[0] ? page : await context.newPage();
  await tab.goto(target).catch((err) => {
    console.warn(`[browser] cannot open ${target}: ${err.message}`);
  });
}

if (openPanel && extensionId) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/dist/panel.html`);
}

await page.bringToFront();

console.log("[browser] close the window or press Ctrl+C to stop.");

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await context.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise((resolve) => context.on("close", resolve));
process.exit(0);
