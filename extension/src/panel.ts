import type { Event, Report } from "@gen/shared";

const SERVER_URL = "http://localhost:8787";

interface StatsResponse {
  totalEvents: number;
  totalBytes: number;
  eventsPerMin: number;
  bytesPerMin: number;
  countsByType: Record<string, number>;
  recentEvents: Event[];
}

interface ChromePanelApi {
  runtime?: {
    sendMessage?: (msg: { kind: string }, cb: (res?: StatsResponse) => void) => void;
  };
}

function renderEvents(events: Event[]): void {
  const container = document.getElementById("events");
  if (!container) return;
  container.innerHTML = events
    .slice()
    .reverse()
    .map((e) => {
      const redacted = e.meta?.privacy?.redacted ? " redacted" : "";
      const auth = e.type === "auth_flow" ? " auth" : "";
      const loc = e.target?.locators?.[0]?.value || e.target?.tag || "";
      const grid = e.meta?.grid?.cellRef ? ` [${e.meta.grid.cellRef}]` : "";
      const val = e.value ? ` = "${e.value.slice(0, 40)}"` : "";
      return `<div class="evt-row${redacted}${auth}"><strong>${e.type}</strong>${grid} ${loc}${val}</div>`;
    })
    .join("");
}

async function pollStats(): Promise<void> {
  const chromeApi = (globalThis as Record<string, unknown>).chrome as ChromePanelApi | undefined;
  if (chromeApi?.runtime?.sendMessage) {
    chromeApi.runtime.sendMessage({ kind: "EYES_GET_STATS" }, (res) => {
      if (!res) return;
      const evEl = document.getElementById("stat-events");
      const byEl = document.getElementById("stat-bytes");
      if (evEl) evEl.textContent = `${res.totalEvents} (${res.eventsPerMin}/m)`;
      if (byEl) byEl.textContent = `${(res.totalBytes / 1024).toFixed(1)} KB`;
      if (Array.isArray(res.recentEvents)) renderEvents(res.recentEvents);
    });
  }

  try {
    const resp = await fetch(`${SERVER_URL}/report`);
    if (resp.ok) {
      const report = (await resp.json()) as Report;
      const findingsEl = document.getElementById("findings");
      if (findingsEl && report.findings?.length) {
        findingsEl.innerHTML = report.findings
          .map(
            (f) =>
              `<div class="card"><strong>[${f.verdict.toUpperCase()}] ${f.title}</strong><div>${f.why}</div></div>`
          )
          .join("");
      }
    }
  } catch {
    // ignore offline server
  }
}

setInterval(() => {
  void pollStats();
}, 1000);
void pollStats();
