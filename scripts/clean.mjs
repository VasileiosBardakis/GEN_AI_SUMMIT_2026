/* global console, process */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const includeTraces = process.argv.includes("--traces");

const targets = [
  path.join(rootDir, "extension", "dist"),
  path.join(rootDir, ".dev"),
  path.join(rootDir, "test-results"),
  path.join(rootDir, "playwright-report"),
];

for (const target of targets) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`[clean] removed ${path.relative(rootDir, target)}`);
}

if (includeTraces) {
  const tracesDir = path.join(rootDir, "traces");
  for (const name of fs.readdirSync(tracesDir)) {
    if (!name.endsWith(".jsonl")) continue;
    fs.rmSync(path.join(tracesDir, name));
    console.log(`[clean] removed traces/${name}`);
  }
} else {
  console.log("[clean] kept traces/ (pass --traces to delete captured *.jsonl files)");
}
