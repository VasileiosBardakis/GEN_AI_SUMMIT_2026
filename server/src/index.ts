import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./app.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tracesDir = path.resolve(__dirname, "../../traces");
const port = Number(process.env.PORT) || 8787;

const server = createServer({ tracesDir });

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
