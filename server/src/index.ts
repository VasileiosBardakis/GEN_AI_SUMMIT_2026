import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createServer } from "./app.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../.env"), quiet: true });

const tracesDir = path.resolve(__dirname, "../../traces");
const port = Number(process.env.PORT) || 8787;

const server = createServer({ tracesDir });

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
