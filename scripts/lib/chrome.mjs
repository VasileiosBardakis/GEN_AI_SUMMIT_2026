/* global process */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function versionScore(name) {
  const digits = name.match(/\d+/g);
  return digits ? Number(digits.join("")) : 0;
}

function playwrightCacheCandidates() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : undefined,
  ].filter(Boolean);

  const candidates = [];
  for (const root of new Set(roots)) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      // Cache directory does not exist on this machine.
      continue;
    }

    const versions = entries
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => versionScore(b) - versionScore(a));

    for (const version of versions) {
      const base = path.join(root, version);
      candidates.push(
        path.join(base, "chrome-linux64", "chrome"),
        path.join(base, "chrome-linux", "chrome"),
        path.join(base, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        path.join(base, "chrome-win", "chrome.exe")
      );
    }
  }
  return candidates;
}

function systemCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA];
    return roots.filter(Boolean).flatMap((root) => [
      path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    "/snap/bin/chromium",
  ];
}

function isFile(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Find a Chromium binary usable for loading an unpacked extension.
 * Order: CHROME_BIN/CHROME_PATH -> Playwright's expected path -> Playwright cache -> system install.
 */
export async function resolveChromeExecutable() {
  const candidates = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);

  try {
    const { chromium } = await import("@playwright/test");
    candidates.push(chromium.executablePath());
  } catch {
    // Playwright is not installed; fall back to cache/system detection.
  }

  candidates.push(...playwrightCacheCandidates(), ...systemCandidates());

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }

  throw new Error(
    "Could not find a Chromium/Chrome binary. Run `pnpm exec playwright install chromium` " +
      "or set CHROME_BIN=/path/to/chrome."
  );
}
