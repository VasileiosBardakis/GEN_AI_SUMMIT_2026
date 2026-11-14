/* global console, process, setTimeout, clearTimeout */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(rootDir, "extension");
const srcDir = path.join(extensionDir, "src");
const buildScript = path.join(extensionDir, "build.mjs");

let debounceTimer = null;
let building = false;
let queued = false;

function build(reason) {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  console.log(`[watch] building (${reason})`);
  const child = spawn(process.execPath, [buildScript], { cwd: extensionDir, stdio: "inherit" });
  child.on("exit", (code) => {
    building = false;
    if (code !== 0) console.error(`[watch] build failed with exit code ${code}`);
    if (queued) {
      queued = false;
      schedule("queued change");
    }
  });
}

function schedule(reason) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => build(reason), 150);
}

function watch(target, options) {
  try {
    return fs.watch(target, options, (...args) => {
      const file = args[1];
      if (!file || /\.(ts|mjs|html|css|json)$/.test(String(file))) schedule(String(file));
    });
  } catch (err) {
    console.error(`[watch] cannot watch ${target}: ${err.message}`);
    return undefined;
  }
}

const watchers = [watch(srcDir), watch(extensionDir)].filter(Boolean);

function stop() {
  for (const watcher of watchers) watcher.close();
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log("[watch] watching extension/ (Ctrl+C to stop)");
build("startup");
