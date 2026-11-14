/* global console */
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "src");
const distDir = path.join(__dirname, "dist");

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
const contentCode = compileTs(path.join(srcDir, "content.ts"))
  .replace(/import\s+\{[^}]*\}\s+from\s+["']\.\/(locators|privacy)\.js["'];?/g, "")
  .replace(/export\s+/g, "");

const bundledContent = `(() => {\n"use strict";\n${privacyCode}\n${locatorsCode}\n${contentCode}\n})();\n`;
fs.writeFileSync(path.join(distDir, "content.js"), bundledContent, "utf8");

const backgroundCode = compileTs(path.join(srcDir, "background.ts"))
  .replace(/import\s+\{[^}]*\}\s+from\s+["']\.\/privacy\.js["'];?/g, "");
fs.writeFileSync(
  path.join(distDir, "background.js"),
  `${privacyCode}\n${backgroundCode}\n`,
  "utf8"
);

const panelCode = compileTs(path.join(srcDir, "panel.ts"));
fs.writeFileSync(path.join(distDir, "panel.js"), panelCode, "utf8");
fs.copyFileSync(path.join(srcDir, "panel.html"), path.join(distDir, "panel.html"));

console.log("Built extension/dist/{content.js, background.js, panel.js, panel.html}");
