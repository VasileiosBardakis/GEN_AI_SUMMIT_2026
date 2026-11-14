import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "@gen/shared";

export type SnippetArtifact = {
  id: string;
  kind: "snippet";
  text: string;
};

export function isValidArtifactId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

export function writeSnippetArtifact(
  dataDir: string,
  finding: Finding,
  text: string,
): Finding {
  const artifactPath = `snippets/${finding.id}.txt`;
  if (text.includes("[REDACTED:") || !isValidArtifactId(finding.id)) {
    return {
      ...finding,
      artifact: {
        kind: "snippet",
        path: artifactPath,
        verified: false,
      },
    };
  }

  const snippetsDir = path.join(dataDir, "snippets");
  mkdirSync(snippetsDir, { recursive: true });
  writeFileSync(path.join(snippetsDir, `${finding.id}.txt`), text, "utf8");

  return {
    ...finding,
    artifact: {
      kind: "snippet",
      path: artifactPath,
      verified: true,
    },
  };
}

export async function readSnippetArtifact(
  dataDir: string,
  id: string,
): Promise<SnippetArtifact | null> {
  if (!isValidArtifactId(id)) {
    return null;
  }

  const filePath = path.join(dataDir, "snippets", `${id}.txt`);
  try {
    const text = await readFile(filePath, "utf8");
    return { id, kind: "snippet", text };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
