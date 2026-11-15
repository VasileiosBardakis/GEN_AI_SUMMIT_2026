import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionScript } from "../src/types.ts";

class FakeElement {
  tagName: string;
  id = "";
  hidden = false;
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  shadowRoot: FakeShadowRoot | null = null;
  private attributes = new Map<string, string>();
  private listeners = new Map<string, Array<() => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }

  attachShadow(): FakeShadowRoot {
    const shadow = new FakeShadowRoot();
    this.shadowRoot = shadow;
    return shadow;
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener();
    }
  }

  findById(targetId: string): FakeElement | null {
    if (this.id === targetId) return this;
    for (const child of this.children) {
      const match = child.findById(targetId);
      if (match) return match;
    }
    return null;
  }
}

class FakeShadowRoot {
  private html = "";
  private bySelector = new Map<string, FakeElement[]>();

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    this.bySelector.clear();

    const dismissMatches = value.match(/data-eyes-dismiss\b/g) ?? [];
    if (dismissMatches.length > 0) {
      this.bySelector.set(
        "[data-eyes-dismiss]",
        dismissMatches.map(() => new FakeElement("button"))
      );
    }
    if (value.includes("data-eyes-primary")) {
      this.bySelector.set("[data-eyes-primary]", [new FakeElement("button")]);
    }
    if (value.includes("data-eyes-content")) {
      this.bySelector.set("[data-eyes-content]", [new FakeElement("div")]);
    }
    if (value.includes("data-eyes-success")) {
      const success = new FakeElement("div");
      success.hidden = true;
      this.bySelector.set("[data-eyes-success]", [success]);
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.bySelector.get(selector) ?? [];
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

interface FakeWindow {
  self: FakeWindow;
  top: FakeWindow;
  __EYES_WATCHER_ACTIVE__: boolean;
  __HANDS_CLEANUP__?: () => void;
  __HANDS_ON_MESSAGE__?: (
    message: unknown,
    sender: unknown,
    sendResponse: (res?: unknown) => void
  ) => boolean;
  addEventListener: () => void;
  removeEventListener: () => void;
}

interface FakeDocument {
  documentElement: FakeElement;
  activeElement: FakeElement | null;
  createElement: (tag: string) => FakeElement;
  getElementById: (id: string) => FakeElement | null;
  addEventListener: () => void;
  removeEventListener: () => void;
}

function makeDeciderPayload(name: string, solution: string): {
  kind: "EYES_SHOW_DECIDER";
  name: string;
  solution: string;
  script: ActionScript;
} {
  return {
    kind: "EYES_SHOW_DECIDER",
    name,
    solution,
    script: {
      name,
      steps: [{ action: "click", target: { kind: "css", value: "#submit" } }],
    },
  };
}

describe("EYES_SHOW_DECIDER popup replacement", () => {
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const originalDocument = (globalThis as Record<string, unknown>).document;
  const originalHTMLElement = (globalThis as Record<string, unknown>).HTMLElement;

  let fakeWindow: FakeWindow;
  let fakeDocument: FakeDocument;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const docElement = new FakeElement("html");
    fakeDocument = {
      documentElement: docElement,
      activeElement: null,
      createElement: (tag: string) => new FakeElement(tag),
      getElementById: (id: string) => docElement.findById(id),
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    fakeWindow = {
      self: null as unknown as FakeWindow,
      top: null as unknown as FakeWindow,
      __EYES_WATCHER_ACTIVE__: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    fakeWindow.self = fakeWindow;
    fakeWindow.top = fakeWindow;

    (globalThis as Record<string, unknown>).window = fakeWindow;
    (globalThis as Record<string, unknown>).document = fakeDocument;
    (globalThis as Record<string, unknown>).HTMLElement = FakeElement;

    await import("../src/content.ts");
  });

  afterEach(() => {
    fakeWindow.__HANDS_CLEANUP__?.();
    vi.useRealTimers();

    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
    if (originalDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = originalDocument;
    }
    if (originalHTMLElement === undefined) {
      delete (globalThis as Record<string, unknown>).HTMLElement;
    } else {
      (globalThis as Record<string, unknown>).HTMLElement = originalHTMLElement;
    }
  });

  it("synchronously resolves popup A as dismissed when replaced by popup B", () => {
    const onMessage = fakeWindow.__HANDS_ON_MESSAGE__;
    expect(onMessage).toBeTypeOf("function");

    const sendResponseA = vi.fn();
    const handledA = onMessage?.(
      makeDeciderPayload("Workflow A", "Run workflow A"),
      null,
      sendResponseA
    );
    expect(handledA).toBe(true);
    expect(sendResponseA).not.toHaveBeenCalled();

    const hostA = fakeDocument.getElementById("__eyes_suggestion_host__");
    expect(hostA).not.toBeNull();

    const sendResponseB = vi.fn();
    const handledB = onMessage?.(
      makeDeciderPayload("Workflow B", "Run workflow B"),
      null,
      sendResponseB
    );
    expect(handledB).toBe(true);

    expect(sendResponseA).toHaveBeenCalledTimes(1);
    expect(sendResponseA).toHaveBeenCalledWith({ ok: true, decision: "dismissed" });
    expect(sendResponseB).not.toHaveBeenCalled();

    const hostB = fakeDocument.getElementById("__eyes_suggestion_host__");
    expect(hostB).not.toBeNull();
    expect(hostB).not.toBe(hostA);
    expect(fakeDocument.documentElement.children).toEqual([hostB]);
  });

  it("resolves popup B on primary click without double-resolving popup A", () => {
    const onMessage = fakeWindow.__HANDS_ON_MESSAGE__;
    expect(onMessage).toBeTypeOf("function");

    const sendResponseA = vi.fn();
    onMessage?.(makeDeciderPayload("Workflow A", "Run workflow A"), null, sendResponseA);
    const hostA = fakeDocument.getElementById("__eyes_suggestion_host__");

    const sendResponseB = vi.fn();
    onMessage?.(makeDeciderPayload("Workflow B", "Run workflow B"), null, sendResponseB);

    expect(sendResponseA).toHaveBeenCalledTimes(1);
    expect(sendResponseA).toHaveBeenCalledWith({ ok: true, decision: "dismissed" });
    expect(sendResponseB).not.toHaveBeenCalled();

    const hostB = fakeDocument.getElementById("__eyes_suggestion_host__");
    const primaryBtn = hostB?.shadowRoot?.querySelector("[data-eyes-primary]");
    expect(primaryBtn).not.toBeNull();

    primaryBtn?.click();

    expect(sendResponseB).toHaveBeenCalledTimes(1);
    expect(sendResponseB).toHaveBeenCalledWith({ ok: true, decision: "approved" });
    expect(sendResponseA).toHaveBeenCalledTimes(1);

    // Extra clicks on either popup cannot double-resolve.
    primaryBtn?.click();
    hostB?.shadowRoot?.querySelector("[data-eyes-dismiss]")?.click();
    hostA?.shadowRoot?.querySelector("[data-eyes-dismiss]")?.click();
    expect(sendResponseA).toHaveBeenCalledTimes(1);
    expect(sendResponseB).toHaveBeenCalledTimes(1);
  });

  it("resolves popup B as dismissed on dismiss click without double-resolving popup A", () => {
    const onMessage = fakeWindow.__HANDS_ON_MESSAGE__;
    expect(onMessage).toBeTypeOf("function");

    const sendResponseA = vi.fn();
    onMessage?.(makeDeciderPayload("Workflow A", "Run workflow A"), null, sendResponseA);

    const sendResponseB = vi.fn();
    onMessage?.(makeDeciderPayload("Workflow B", "Run workflow B"), null, sendResponseB);

    const hostB = fakeDocument.getElementById("__eyes_suggestion_host__");
    const dismissBtn = hostB?.shadowRoot?.querySelector("[data-eyes-dismiss]");
    expect(dismissBtn).not.toBeNull();

    dismissBtn?.click();

    expect(sendResponseB).toHaveBeenCalledTimes(1);
    expect(sendResponseB).toHaveBeenCalledWith({ ok: true, decision: "dismissed" });
    expect(sendResponseA).toHaveBeenCalledTimes(1);
    expect(fakeDocument.getElementById("__eyes_suggestion_host__")).toBeNull();
  });
});
