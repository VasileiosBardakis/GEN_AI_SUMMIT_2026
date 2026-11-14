import type { Event } from "@gen/shared";
import { sanitizeUrl } from "./privacy.ts";

const SERVER_URL = "http://localhost:8787";
const BATCH_INTERVAL_MS = 300;
const MAX_BATCH_SIZE = 40;

interface ClipboardState {
  fromApp: string;
  fromUrl?: string;
  fromCell?: string;
  text?: string;
  textHash?: string;
  copiedAt: number;
}

interface ChromeRuntimeMessage {
  kind?: string;
  event?: Event;
}

interface ChromeTab {
  url?: string;
  title?: string;
}

interface ChromeApi {
  runtime?: {
    onMessage?: {
      addListener: (
        cb: (
          msg: ChromeRuntimeMessage,
          sender: unknown,
          sendResponse: (res?: unknown) => void
        ) => boolean
      ) => void;
    };
  };
  tabs?: {
    get: (tabId: number) => Promise<ChromeTab>;
    onActivated?: {
      addListener: (cb: (activeInfo: { tabId: number; windowId: number }) => void) => void;
    };
    onUpdated?: {
      addListener: (
        cb: (tabId: number, changeInfo: { status?: string; url?: string }, tab: ChromeTab) => void
      ) => void;
    };
  };
  sidePanel?: {
    setPanelBehavior?: (opts: { openPanelOnActionClick: boolean }) => Promise<void>;
  };
}

let lastClipboard: ClipboardState | null = null;
let lastActiveTab: { tabId: number; app: string; url?: string; title?: string } | null = null;
const eventQueue: Event[] = [];
const recentEvents: Event[] = [];
const countsByType: Record<string, number> = {};
let totalEvents = 0;
let totalBytes = 0;
const startedAt = Date.now();

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "evt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
}

export function recordEvent(evt: Event): void {
  if ((evt.type === "copy" || evt.type === "cut") && evt.clipboard) {
    lastClipboard = {
      fromApp: evt.clipboard.fromApp || evt.app,
      fromUrl: evt.clipboard.fromUrl || evt.url,
      fromCell: evt.clipboard.fromCell,
      text: evt.clipboard.text,
      textHash: evt.clipboard.textHash,
      copiedAt: evt.ts,
    };
  } else if (evt.type === "paste" && lastClipboard) {
    evt.clipboard = {
      fromApp: lastClipboard.fromApp,
      fromUrl: lastClipboard.fromUrl,
      fromCell: lastClipboard.fromCell,
      toApp: evt.app,
      text: evt.clipboard?.text || lastClipboard.text,
      textHash: evt.clipboard?.textHash || lastClipboard.textHash,
      timeSinceCopyMs: Math.max(0, evt.ts - lastClipboard.copiedAt),
    };
  }

  const serialized = JSON.stringify(evt);
  totalEvents++;
  totalBytes += serialized.length + 1;
  countsByType[evt.type] = (countsByType[evt.type] || 0) + 1;

  recentEvents.push(evt);
  if (recentEvents.length > 100) recentEvents.shift();

  eventQueue.push(evt);
  if (eventQueue.length >= MAX_BATCH_SIZE) {
    void flushQueue();
  }
}

export async function flushQueue(): Promise<void> {
  if (eventQueue.length === 0) return;
  const batch = eventQueue.splice(0, eventQueue.length);
  try {
    await fetch(`${SERVER_URL}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
  } catch {
    // Server offline or unreachable
  }
}

setInterval(() => {
  void flushQueue();
}, BATCH_INTERVAL_MS);

const chromeApi = (globalThis as Record<string, unknown>).chrome as ChromeApi | undefined;

if (chromeApi?.runtime?.onMessage) {
  chromeApi.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.kind === "EYES_EVENT" && msg.event) {
      recordEvent(msg.event);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.kind === "EYES_GET_STATS") {
      const elapsedMin = Math.max(0.01, (Date.now() - startedAt) / 60000);
      sendResponse({
        totalEvents,
        totalBytes,
        eventsPerMin: Math.round(totalEvents / elapsedMin),
        bytesPerMin: Math.round(totalBytes / elapsedMin),
        countsByType,
        recentEvents: recentEvents.slice(-25),
      });
      return false;
    }
    return false;
  });
}

if (chromeApi?.tabs?.onActivated) {
  const tabsApi = chromeApi.tabs;
  chromeApi.tabs.onActivated.addListener((activeInfo) => {
    void (async () => {
      try {
        const tab = await tabsApi.get(activeInfo.tabId);
        if (!tab?.url || tab.url.startsWith("chrome://")) return;
        const cleanUrl = sanitizeUrl(tab.url).url;
        const host = new URL(tab.url).hostname || "local-page";
        const prevApp = lastActiveTab?.app;
        lastActiveTab = { tabId: activeInfo.tabId, app: host, url: cleanUrl, title: tab.title };

        recordEvent({
          v: 1,
          id: uuid(),
          ts: Date.now(),
          session: "sess_browser",
          source: "browser",
          app: host,
          window: tab.title,
          url: cleanUrl,
          type: "tab_switch",
          meta: {
            subType: prevApp && prevApp !== host ? "cross_app_switch" : "same_app_switch",
            fromApp: prevApp,
            toApp: host,
          },
        });
      } catch {
        // ignore tab lookup errors
      }
    })();
  });
}

if (chromeApi?.tabs?.onUpdated) {
  chromeApi.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab?.url && !tab.url.startsWith("chrome://")) {
      const cleanUrl = sanitizeUrl(tab.url).url;
      let host = "local-page";
      try {
        host = new URL(tab.url).hostname || "local-page";
      } catch {
        // ignore
      }
      recordEvent({
        v: 1,
        id: uuid(),
        ts: Date.now(),
        session: "sess_browser",
        source: "browser",
        app: host,
        window: tab.title,
        url: cleanUrl,
        type: "nav",
      });
    }
  });
}

if (chromeApi?.sidePanel?.setPanelBehavior) {
  chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
