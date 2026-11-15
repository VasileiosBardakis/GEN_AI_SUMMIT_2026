import type { FlowNode } from "./suggestion.ts";

export const DEFAULT_SERVER_URL = "http://localhost:8787";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function nodeKindIcon(kind: FlowNode["kind"]): string {
  switch (kind) {
    case "click":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 1.8l6.8 3.6-3.1 1-1.3 3.1-2.4-7.7Z"/></svg>';
    case "input":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2 3.5h8M2 6h6M2 8.5h4.5"/></svg>';
    case "tab":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="9" height="7" rx="1.2"/><path d="M1.5 5h9M5.5 2.5V5"/></svg>';
    case "paste":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="6.5" height="7.5" rx="1"/><path d="M4.5 3V2a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1v1"/></svg>';
    case "loop":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 4.5A3.8 3.8 0 0 0 3 3.4M2.5 7.5A3.8 3.8 0 0 0 9 8.6"/><path d="M9.7 2.4v2.2H7.5M2.3 9.6V7.4h2.2"/></svg>';
    case "ai":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true"><path d="M1.5 6c1.2-2 2.8-3 4.5-3s3.3 1 4.5 3c-1.2 2-2.8 3-4.5 3S2.7 8 1.5 6Z" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6" r="1.3" fill="currentColor"/></svg>';
    case "done":
      return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4.3"/><path d="M4.2 6.1l1.2 1.2 2.5-2.5"/></svg>';
  }
}

export function nodeKindTitle(kind: FlowNode["kind"]): string {
  switch (kind) {
    case "ai":
      return "Eyes";
    case "loop":
      return "Loop";
    default:
      return kind[0].toUpperCase() + kind.slice(1);
  }
}

export function renderFlowNodes(nodes: FlowNode[], arrowSize: "sm" | "md" = "md"): string {
  const dims = arrowSize === "sm" ? 'width="11" height="9"' : 'width="12" height="10"';
  const arrowSvg = `<svg class="flow-arrow" viewBox="0 0 14 10" ${dims} aria-hidden="true"><path d="M1 5h10M8.5 2.5L11.5 5l-3 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
  return nodes
    .map((node, index) => {
      const arrow = index < nodes.length - 1 ? arrowSvg : "";
      const kindClass = node.kind === "ai" ? "eyes-step" : node.kind;
      return `
        <div class="flow-node ${kindClass}" title="${escapeHtml(node.label)}">
          <div class="flow-kind">${nodeKindIcon(node.kind)}<span>${escapeHtml(nodeKindTitle(node.kind))}</span></div>
          <div class="flow-label">${escapeHtml(node.label)}</div>
        </div>${arrow}
      `;
    })
    .join("");
}

export function lookupBinding(vars: Record<string, unknown>, path: string): unknown {
  let current: unknown = vars;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function substituteString(value: string, vars: Record<string, unknown>): unknown {
  const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
  if (whole) return lookupBinding(vars, whole[1]);
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    const found = lookupBinding(vars, path);
    return found === undefined ? "" : String(found);
  });
}

export function substituteBindings<T>(
  value: T,
  vars: Record<string, unknown>,
  opts?: { skipBindKey?: boolean },
): T {
  if (typeof value === "string") return substituteString(value, vars) as T;
  if (Array.isArray(value)) {
    return value.map((item) => substituteBindings(item, vars, opts)) as T;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const isForEach = obj.action === "forEach";
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      if ((opts?.skipBindKey && key === "bind") || (isForEach && key === "steps")) {
        result[key] = child;
      } else {
        result[key] = substituteBindings(child, vars, opts);
      }
    }
    return result as T;
  }
  return value;
}

export function normalizeUrlPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function normalizeLoopbackHost(host: string): string {
  return host.trim().toLowerCase();
}

export function isExactHostMatch(url: string | undefined, targetHost: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const want = targetHost.trim().toLowerCase();
    const got = want.includes(":") ? parsed.host.toLowerCase() : parsed.hostname.toLowerCase();
    return got === want;
  } catch {
    return false;
  }
}

export function tabMatchesHost(url: string | undefined, targetHost: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const want = normalizeLoopbackHost(targetHost);
    if (!want) return false;
    const got = normalizeLoopbackHost(want.includes(":") ? parsed.host : parsed.hostname);
    return got === want;
  } catch {
    return false;
  }
}

export function scoreTabUrlMatch(tabUrl: string | undefined, targetUrl: string): number {
  if (!tabUrl) return 0;
  if (tabUrl === targetUrl) return 4;
  try {
    const tabParsed = new URL(tabUrl);
    if (targetUrl.startsWith("/")) {
      const targetPath = normalizeUrlPath(targetUrl.split("?")[0]);
      if (normalizeUrlPath(tabParsed.pathname) === targetPath) return 2;
      if (tabParsed.pathname.startsWith(targetPath)) return 1;
      return 0;
    }
    const targetParsed = new URL(targetUrl);
    if (tabParsed.href.replace(/#.*$/, "") === targetParsed.href.replace(/#.*$/, "")) return 4;
    if (normalizeLoopbackHost(tabParsed.host) !== normalizeLoopbackHost(targetParsed.host)) {
      return 0;
    }
    if (
      normalizeUrlPath(tabParsed.pathname) === normalizeUrlPath(targetParsed.pathname) &&
      tabParsed.search === targetParsed.search
    ) {
      return 3;
    }
    if (normalizeUrlPath(tabParsed.pathname) === normalizeUrlPath(targetParsed.pathname)) {
      return targetParsed.search ? 0 : 2;
    }
    if (tabUrl.startsWith(targetUrl)) return 1;
    return 0;
  } catch {
    return tabUrl.startsWith(targetUrl) ? 1 : 0;
  }
}

type SliceStepLike = {
  action: string;
  host?: string;
  url?: string;
  bind?: string;
  items?: unknown;
  target?: unknown;
  targets?: unknown;
  within?: unknown;
  value?: unknown;
  steps?: SliceStepLike[];
};

type SliceScriptLike<TStep extends SliceStepLike = SliceStepLike> = {
  steps: TStep[];
  params?: Array<{ name: string; example?: string; piiHash?: string }>;
};

function stripWwwPrefix(host: string): string {
  return host.startsWith("www.") && host.length > 4 ? host.slice(4) : host;
}

function urlsMatchStepPage(candidateUrl: string, currentParsed: URL): boolean {
  try {
    const cand = new URL(candidateUrl);
    if (cand.port !== currentParsed.port) return false;
    const candHost = normalizeLoopbackHost(cand.hostname);
    const currHost = normalizeLoopbackHost(currentParsed.hostname);
    if (candHost !== currHost && stripWwwPrefix(candHost) !== stripWwwPrefix(currHost)) {
      return false;
    }
    return normalizeUrlPath(cand.pathname) === normalizeUrlPath(currentParsed.pathname);
  } catch {
    return false;
  }
}

function extractTargetLocators(target: unknown): Array<{ kind?: string; value?: string }> {
  if (!target) return [];
  return Array.isArray(target)
    ? (target as Array<{ kind?: string; value?: string }>)
    : [target as { kind?: string; value?: string }];
}

function extractClickHrefUrl(step: SliceStepLike, baseUrl?: string): string | undefined {
  if (step.action !== "click") return undefined;
  const locs = [...extractTargetLocators(step.target), ...extractTargetLocators(step.targets)];
  for (const loc of locs) {
    if ((loc.kind !== "css" && loc.kind !== "xpath") || typeof loc.value !== "string") continue;
    const match = /href\s*=\s*["']([^"']+)["']/i.exec(loc.value);
    const rawHref = match?.[1]?.trim();
    if (!rawHref || rawHref.startsWith("#") || /^javascript:/i.test(rawHref)) continue;
    try {
      const resolved = baseUrl ? new URL(rawHref, baseUrl) : new URL(rawHref);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        return resolved.href;
      }
    } catch {
      // ignore unresolvable href
    }
  }
  return undefined;
}

function collectTemplateRefs(val: unknown, out: Set<string>): void {
  if (typeof val === "string") {
    for (const m of val.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      const name = m[1]?.trim();
      if (name) out.add(name);
    }
    return;
  }
  if (Array.isArray(val)) {
    for (const item of val) collectTemplateRefs(item, out);
    return;
  }
  if (val && typeof val === "object") {
    for (const child of Object.values(val)) collectTemplateRefs(child, out);
  }
}

function canSliceStepsAt(
  steps: readonly SliceStepLike[],
  startIdx: number,
  providedBindings: ReadonlySet<string>,
): boolean {
  if (startIdx <= 0) return true;
  const skippedBinds = new Set<string>();
  for (let i = 0; i < startIdx; i += 1) {
    const s = steps[i];
    if (s && (s.action === "readText" || s.action === "readValue" || s.action === "extractList")) {
      if (typeof s.bind === "string" && s.bind) {
        skippedBinds.add(s.bind);
      }
    }
  }
  if (skippedBinds.size === 0) return true;
  const refs = new Set<string>();
  for (let i = startIdx; i < steps.length; i += 1) {
    const s = steps[i];
    if (!s) continue;
    if (s.action === "forEach" && typeof s.items === "string" && s.items.trim()) {
      refs.add(s.items.trim());
    }
    collectTemplateRefs(s, refs);
  }
  for (const ref of refs) {
    if (skippedBinds.has(ref) && !providedBindings.has(ref)) {
      return false;
    }
  }
  return true;
}

export function findStartStepIndexForUrl(
  script: SliceScriptLike,
  currentTabUrl: string | undefined,
  initialParams?: Record<string, string>,
): number {
  if (!currentTabUrl) return 0;
  let parsedTab: URL;
  try {
    parsedTab = new URL(currentTabUrl);
    if (parsedTab.protocol !== "http:" && parsedTab.protocol !== "https:") return 0;
  } catch {
    return 0;
  }

  const provided = new Set<string>();
  if (Array.isArray(script.params)) {
    for (const p of script.params) {
      if (p?.name && (typeof p.example === "string" || typeof p.piiHash === "string")) {
        provided.add(p.name);
      }
    }
  }
  if (initialParams) {
    for (const k of Object.keys(initialParams)) {
      provided.add(k);
    }
  }

  const steps = script.steps;
  let pageUrl: string | undefined;
  let sawNonSetupStep = false;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action === "switchTab") {
      pageUrl = step.url;
      const matches = step.url
        ? urlsMatchStepPage(step.url, parsedTab)
        : Boolean(
            step.host &&
              (tabMatchesHost(currentTabUrl, step.host) ||
                stripWwwPrefix(normalizeLoopbackHost(step.host)) ===
                  stripWwwPrefix(normalizeLoopbackHost(parsedTab.hostname))),
          );
      if (matches) {
        if (!sawNonSetupStep) return 0;
        let targetIdx = i;
        while (
          targetIdx + 1 < steps.length &&
          (steps[targetIdx]!.action === "switchTab" || steps[targetIdx]!.action === "navigate")
        ) {
          targetIdx += 1;
        }
        if (canSliceStepsAt(steps, targetIdx, provided)) return targetIdx;
      }
      continue;
    }
    if (step.action === "navigate" && typeof step.url === "string") {
      pageUrl = step.url;
      if (urlsMatchStepPage(step.url, parsedTab)) {
        if (!sawNonSetupStep) return 0;
        let targetIdx = i;
        while (
          targetIdx + 1 < steps.length &&
          (steps[targetIdx]!.action === "switchTab" || steps[targetIdx]!.action === "navigate")
        ) {
          targetIdx += 1;
        }
        if (canSliceStepsAt(steps, targetIdx, provided)) return targetIdx;
      }
      continue;
    }

    if (typeof step.url === "string" && /^https?:\/\//i.test(step.url)) {
      pageUrl = step.url;
    }

    if (pageUrl && urlsMatchStepPage(pageUrl, parsedTab)) {
      if (!sawNonSetupStep) return 0;
      if (canSliceStepsAt(steps, i, provided)) return i;
    }

    sawNonSetupStep = true;
    const nextUrl = extractClickHrefUrl(step, pageUrl);
    if (nextUrl) {
      pageUrl = nextUrl;
    }
  }
  return 0;
}

export function sliceScriptForTabUrl<TScript extends SliceScriptLike>(
  script: TScript,
  currentTabUrl: string | undefined,
  initialParams?: Record<string, string>,
): { script: TScript; startStepIndex: number; sliced: boolean } {
  const startStepIndex = findStartStepIndexForUrl(script, currentTabUrl, initialParams);
  if (startStepIndex <= 0 || startStepIndex >= script.steps.length) {
    return { script, startStepIndex: 0, sliced: false };
  }
  return {
    script: {
      ...script,
      steps: script.steps.slice(startStepIndex),
    },
    startStepIndex,
    sliced: true,
  };
}
