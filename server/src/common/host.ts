export const PLACEHOLDER_HOSTS = new Set(["", "browser", "unknown", "local-page"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);

export function isPlaceholderHost(host?: string): boolean {
  if (!host) return true;
  const trimmed = host.trim().toLowerCase();
  const hostname = trimmed.split(":")[0] ?? "";
  return PLACEHOLDER_HOSTS.has(trimmed) || PLACEHOLDER_HOSTS.has(hostname);
}

export function normalizeHost(
  host: string,
  opts?: { collapseLoopback?: boolean },
): string {
  const trimmed = host.trim().toLowerCase();
  if (!opts?.collapseLoopback) {
    return trimmed;
  }
  if (!trimmed) return "";
  let parsedHost = trimmed;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    parsedHost = new URL(withScheme).hostname.toLowerCase();
  } catch {
    parsedHost = trimmed.replace(/^https?:\/\//, "").split(/[/?#]/)[0] ?? "";
  }
  return LOOPBACK_HOSTS.has(parsedHost) ? "localhost" : parsedHost;
}

export function hostnameFromUrl(
  rawUrl?: string,
  opts?: { collapseLoopback?: boolean },
): string | undefined {
  if (!rawUrl || !rawUrl.trim()) return undefined;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    const host = normalizeHost(parsed.hostname, opts);
    return isPlaceholderHost(host) ? undefined : host;
  } catch {
    return undefined;
  }
}

export function resolveEventHost(
  ev?: { app?: string; url?: string },
  opts?: { preferUrl?: boolean; collapseLoopback?: boolean },
): string | undefined {
  if (!ev) return undefined;
  if (opts?.preferUrl) {
    const fromUrl = hostnameFromUrl(ev.url, opts);
    if (fromUrl) return fromUrl;
    if (ev.app) {
      const normalized = normalizeHost(ev.app, opts);
      if (!isPlaceholderHost(normalized)) return normalized;
    }
    return undefined;
  }
  if (ev.app && !isPlaceholderHost(ev.app)) {
    return opts?.collapseLoopback
      ? normalizeHost(ev.app, opts)
      : ev.app.trim();
  }
  return hostnameFromUrl(ev.url, opts);
}
