/* global console, process, Buffer, setInterval */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const tracesDir = path.resolve(rootDir, arg("dir", "traces"));
fs.mkdirSync(tracesDir, { recursive: true });

const states = new Map();

function jsonlFiles() {
  return fs.readdirSync(tracesDir).filter((name) => name.endsWith(".jsonl"));
}

for (const name of jsonlFiles()) {
  try {
    states.set(name, { offset: fs.statSync(path.join(tracesDir, name)).size, partial: "" });
  } catch {
    // File disappeared between listing and stat.
  }
}

function readNewEvents(name) {
  const filePath = path.join(tracesDir, name);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }

  let state = states.get(name);
  if (!state) {
    state = { offset: 0, partial: "" };
    states.set(name, state);
  }
  if (stat.size < state.offset) {
    state.offset = 0;
    state.partial = "";
  }
  if (stat.size === state.offset) return [];

  const length = stat.size - state.offset;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, state.offset);
  } finally {
    fs.closeSync(fd);
  }
  state.offset = stat.size;

  const lines = (state.partial + buffer.toString("utf8")).split("\n");
  state.partial = lines.pop() || "";

  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed/partial trace lines.
    }
  }
  return events;
}

function describe(event, name) {
  const session = name.replace(/\.jsonl$/, "");
  const target =
    event.target?.label || event.target?.locators?.[0]?.value || event.target?.tag || "-";
  const value =
    event.value === undefined ? "" : ` = ${JSON.stringify(String(event.value).slice(0, 60))}`;
  const time = new Date(event.ts).toLocaleTimeString();
  return `[${time}] ${session} · ${event.type} · ${event.app} · ${target}${value}`;
}

console.log(`[tail] following ${tracesDir} (Ctrl+C to stop)`);

setInterval(() => {
  let names;
  try {
    names = jsonlFiles();
  } catch {
    return;
  }
  for (const name of names) {
    for (const event of readNewEvents(name)) {
      console.log(describe(event, name));
    }
  }
}, 500);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
