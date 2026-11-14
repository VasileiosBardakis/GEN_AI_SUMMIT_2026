/* global console */
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "src");
const distDir = path.join(__dirname, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

function compileTs(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const stripped = stripTypeScriptTypes(raw, { mode: "strip" });
  return stripped
    .replace(/import\s+type\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?/g, "")
    .replace(/from\s+["']\.\/([a-zA-Z0-9_-]+)\.ts["']/g, 'from "./$1.js"');
}

const privacyCode = compileTs(path.join(srcDir, "privacy.ts")).replace(/export\s+/g, "");
const locatorsCode = compileTs(path.join(srcDir, "locators.ts"))
  .replace(/import\s+\{[^}]*\}\s+from\s+["']\.\/privacy\.js["'];?/g, "")
  .replace(/export\s+/g, "");
const handsCode = compileTs(path.join(srcDir, "hands", "execute.ts")).replace(/export\s+/g, "");
const suggestionCode = compileTs(path.join(srcDir, "suggestion.ts")).replace(/export\s+/g, "");
const libraryCode = compileTs(path.join(srcDir, "library.ts")).replace(/export\s+/g, "");

const contentCode = compileTs(path.join(srcDir, "content.ts"))
  .replace(/import\s+\{[^}]*\}\s+from\s+["']\.\/(locators|privacy|suggestion|library)\.js["'];?/g, "")
  .replace(/import\s+\{[^}]*\}\s+from\s+["']\.\/hands\/execute\.(ts|js)["'];?/g, "")
  .replace(/export\s+/g, "");

const bundledContent = `(() => {\n"use strict";\n${privacyCode}\n${locatorsCode}\n${handsCode}\n${suggestionCode}\n${libraryCode}\n${contentCode}\n})();\n`;
fs.writeFileSync(path.join(distDir, "content.js"), bundledContent, "utf8");

const backgroundSource = compileTs(path.join(srcDir, "background.ts")).replace(
  /import\s+\{[^}]*\}\s+from\s+["']\.\/(privacy|library|suggestion)\.js["'];?/g,
  ""
);
const backgroundImports = backgroundSource.match(/^import .*;$/gm) ?? [];
const backgroundBody = backgroundSource.replace(/^import .*;$/gm, "");
fs.writeFileSync(
  path.join(distDir, "background.js"),
  `${backgroundImports.join("\n")}\n${privacyCode}\n${suggestionCode}\n${libraryCode}\n${backgroundBody}\n`,
  "utf8"
);

const handsDir = path.join(distDir, "hands");
fs.mkdirSync(handsDir, { recursive: true });
fs.writeFileSync(
  path.join(handsDir, "execute.js"),
  compileTs(path.join(srcDir, "hands", "execute.ts")),
  "utf8"
);

const panelSource = compileTs(path.join(srcDir, "panel.ts"))
  .replace(/import\s+\{[^}]*\}\s+from\s+["']\.\/library\.js["'];?/g, "")
  .replace(/export\s+/g, "");
const panelCode = `(() => {\n"use strict";\n${libraryCode}\n${panelSource}\n})();\n`;
fs.writeFileSync(path.join(distDir, "panel.js"), panelCode, "utf8");
fs.copyFileSync(path.join(srcDir, "panel.html"), path.join(distDir, "panel.html"));

const assetsDir = path.join(__dirname, "assets");
if (fs.existsSync(assetsDir)) {
  fs.cpSync(assetsDir, distDir, { recursive: true });
}

console.log("Built extension/dist/{content.js, background.js, panel.js, panel.html, hands/execute.js, assets}");
