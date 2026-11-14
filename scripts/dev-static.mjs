/* global console, process */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePortArg, startDemoServer } from "./lib/static-server.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = path.join(rootDir, "apps", "demo");
const port = parsePortArg("port", Number(process.env.DEV_APP_PORT || 5173));

const demo = await startDemoServer({ dir: demoDir, port });
console.log(`[demo] serving apps/demo at ${demo.url} (Ctrl+C to stop)`);

async function shutdown() {
  await demo.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
