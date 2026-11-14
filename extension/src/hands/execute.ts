import type { DomStep, Locator, StepResult } from "../types.js";

export async function executeStep(
  step: DomStep,
  targetOverride?: Element | null,
): Promise<StepResult> {
  function escapeValue(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return value.replace(/["\\]/g, "\\$&");
  }

  function resolveAll(locator: Locator, root: ParentNode = document): Element[] {
    if (locator.kind === "css") return Array.from(root.querySelectorAll(locator.value));
    if (locator.kind === "xpath") {
      const snapshot = document.evaluate(
        locator.value,
        root as Node,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      const found: Element[] = [];
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const node = snapshot.snapshotItem(index);
        if (node instanceof Element) found.push(node);
      }
      return found;
    }
    if (locator.kind === "testid") {
      return Array.from(root.querySelectorAll(`[data-testid="${escapeValue(locator.value)}"]`));
    }
    if (locator.kind === "aria") {
      const roleNameMatch = /^([a-z]+)\[name="(.+)"\]$/i.exec(locator.value.trim());
      if (roleNameMatch) {
        const wantedRaw = roleNameMatch[2]!.replace(/\\"/g, '"');
        const wantedLabel = wantedRaw.toLowerCase();
        const byAria = Array.from(
          root.querySelectorAll(`[aria-label="${escapeValue(wantedRaw)}"]`),
        );
        if (byAria.length > 0) return byAria;
        const fields = Array.from(
          root.querySelectorAll<HTMLElement>("input, textarea, select, button, a, [role]"),
        );
        return fields.filter((el) => {
          const aria = el.getAttribute("aria-label")?.trim().toLowerCase();
          if (aria === wantedLabel) return true;
          if (
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement
          ) {
            const labelText = Array.from(el.labels ?? [])
              .map((l) => l.textContent?.trim() || "")
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            if (labelText === wantedLabel) return true;
          }
          return false;
        });
      }
      return Array.from(root.querySelectorAll(`[aria-label="${escapeValue(locator.value)}"]`));
    }
    const wanted = locator.value.trim();
    if (!wanted) return [];
    return Array.from(root.querySelectorAll("*")).filter(
      (element) => (element.textContent ?? "").trim() === wanted,
    );
  }

  function resolve(locator: Locator, root: ParentNode = document): Element | null {
    return resolveAll(locator, root)[0] ?? null;
  }

  function readValue(element: Element): string {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value;
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return element.innerText;
    }
    return (element.textContent ?? "").trim();
  }

  function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function insertIntoEditable(element: HTMLElement, value: string): void {
    element.focus();
    const selection = window.getSelection();
    if (selection) {
      const hasRangeInside =
        selection.rangeCount > 0 &&
        element.contains(selection.getRangeAt(0).commonAncestorContainer);
      if (!hasRangeInside) {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    const inserted = document.execCommand("insertText", false, value);
    if (!inserted) {
      element.textContent = `${element.textContent ?? ""}${value}`;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }
  }

  function insertText(element: Element, value: string): void {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      const existingNorm = element.value.trim().toLowerCase();
      const incomingNorm = value.trim().toLowerCase();
      if (
        existingNorm.length > 0 &&
        incomingNorm.length > 0 &&
        incomingNorm.startsWith(existingNorm)
      ) {
        setNativeValue(element, value);
      } else {
        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? element.value.length;
        setNativeValue(element, `${element.value.slice(0, start)}${value}${element.value.slice(end)}`);
      }
      const caret = element.value.length;
      try {
        element.setSelectionRange(caret, caret);
      } catch {
        /* ignore */
      }
      return;
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      insertIntoEditable(element, value);
      return;
    }
    throw new Error("Target is not editable");
  }

  function click(element: Element): void {
    if (element instanceof HTMLElement) {
      element.click();
      return;
    }
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function selectOption(element: Element, value: string): void {
    if (!(element instanceof HTMLSelectElement)) throw new Error("Target is not a select");
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  const winFlag = window as unknown as { __EYES_SUPPRESS_SYNTHETIC__?: boolean };
  const prevSuppress = winFlag.__EYES_SUPPRESS_SYNTHETIC__;
  winFlag.__EYES_SUPPRESS_SYNTHETIC__ = true;
  try {
    switch (step.action) {
      case "click": {
        const element = resolve(step.target);
        if (!element) throw new Error("Target not found");
        click(element);
        return { ok: true, url: location.href };
      }
      case "fill": {
        const element = resolve(step.target);
        if (!element) throw new Error("Target not found");
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          setNativeValue(element, step.value);
        } else if (element instanceof HTMLElement && element.isContentEditable) {
          element.textContent = "";
          insertIntoEditable(element, step.value);
        } else {
          throw new Error("Target is not fillable");
        }
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "insertText": {
        let active: Element | null = document.activeElement;
        while (active && active.shadowRoot && active.shadowRoot.activeElement) {
          active = active.shadowRoot.activeElement;
        }
        const remembered = (window as unknown as { __HANDS_LAST_EDITABLE__?: Element | null })
          .__HANDS_LAST_EDITABLE__;
        const lastEditable = remembered && remembered.isConnected ? remembered : null;
        const element =
          targetOverride ?? ((step.target ? resolve(step.target) : null) ?? lastEditable ?? active);
        if (!element) throw new Error("No target and nothing focused");
        insertText(element, step.value);
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "select": {
        const element = resolve(step.target);
        if (!element) throw new Error("Target not found");
        selectOption(element, step.value);
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "waitFor": {
        const deadline = Date.now() + (step.timeoutMs ?? 5000);
        while (Date.now() < deadline) {
          if (resolve(step.target)) return { ok: true, url: location.href };
          await wait(100);
        }
        throw new Error("Timed out waiting for target");
      }
      case "readText":
      case "readValue": {
        const element = resolve(step.target);
        if (!element) throw new Error("Target not found");
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "extractList": {
        const roots = resolveAll(step.target);
        if (roots.length === 0) throw new Error("Target not found");
        const items = roots.map((row) => {
          if (!step.fields) return { text: readValue(row) };
          const item: Record<string, string> = {};
          for (const [name, locator] of Object.entries(step.fields)) {
            const field = resolve(locator, row);
            item[name] = field ? readValue(field) : "";
          }
          return item;
        });
        return { ok: true, url: location.href, items };
      }
      default:
        throw new Error(`Unsupported step: ${(step as { action?: string }).action ?? "unknown"}`);
    }
  } catch (error) {
    return {
      ok: false,
      url: location.href,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    winFlag.__EYES_SUPPRESS_SYNTHETIC__ = prevSuppress;
  }
}
