import type { DomStep, Locator, StepResult } from "../types.js";

export async function executeStep(
  step: DomStep,
  targetOverride?: Element | null,
): Promise<StepResult> {
  function escapeValue(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return value.replace(/["\\]/g, "\\$&");
  }

  function collapseWs(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function isVisible(element: Element): boolean {
    if (element instanceof HTMLInputElement && element.type.toLowerCase() === "hidden") {
      return false;
    }
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return typeof element.getClientRects === "function" && element.getClientRects().length > 0;
  }

  const TAG_ROLES: Record<string, string> = {
    button: "button",
    summary: "button",
    a: "link",
    select: "combobox",
    textarea: "textbox",
    td: "gridcell",
    th: "gridcell",
    option: "option",
  };
  const INPUT_ROLES: Record<string, string> = {
    checkbox: "checkbox",
    radio: "radio",
    search: "searchbox",
    button: "button",
    submit: "button",
    reset: "button",
  };
  const TEXT_NAMED_ROLES = new Set(["button", "link", "menuitem", "tab", "option"]);
  const TEXTBOX_EQUIVALENTS = new Set(["textbox", "searchbox"]);

  function implicitRole(element: Element): string {
    const explicit = element.getAttribute("role")?.trim().toLowerCase();
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      const inputType = (element.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLES[inputType] ?? "textbox";
    }
    return TAG_ROLES[tag] ?? "";
  }

  function roleMatches(actual: string, wanted: string): boolean {
    return actual === wanted || (TEXTBOX_EQUIVALENTS.has(actual) && TEXTBOX_EQUIVALENTS.has(wanted));
  }

  function cleanLabelNode(label: HTMLElement): string {
    const clone = label.cloneNode(true) as HTMLElement;
    for (const nested of Array.from(
      clone.querySelectorAll("input, select, textarea, button, datalist, script, style"),
    )) {
      nested.remove();
    }
    return collapseWs(clone.textContent ?? "");
  }

  function accessibleNames(element: Element): string[] {
    const names: string[] = [];
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) names.push(collapseWs(ariaLabel));

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => collapseWs(document.getElementById(id)?.textContent ?? ""))
        .filter(Boolean)
        .join(" ");
      if (joined) names.push(joined);
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      if (element.labels && element.labels.length > 0) {
        const labelText = Array.from(element.labels)
          .map((label) => cleanLabelNode(label))
          .filter(Boolean)
          .join(" ");
        if (labelText) names.push(labelText);
      }
      if (
        element instanceof HTMLInputElement &&
        /^(submit|button|reset)$/i.test(element.type) &&
        element.value
      ) {
        names.push(collapseWs(element.value));
      }
      const placeholder = element.getAttribute("placeholder");
      if (placeholder) names.push(collapseWs(placeholder));
    }

    const title = element.getAttribute("title");
    if (title) names.push(collapseWs(title));

    const role = implicitRole(element);
    if (
      !(element instanceof HTMLSelectElement) &&
      (TEXT_NAMED_ROLES.has(role) || element.tagName.toLowerCase() === "label")
    ) {
      const text = collapseWs(element.textContent ?? "");
      if (text) names.push(text);
    }

    return names.filter(Boolean);
  }

  function resolveAria(raw: string, root: ParentNode): Element[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("[")) {
      try {
        return Array.from(root.querySelectorAll(trimmed));
      } catch {
        return [];
      }
    }

    const roleSyntax = /^([a-z]+)\[\s*name\s*=\s*["']([\s\S]*?)["']\s*\]$/i.exec(trimmed);
    const wantedRole = roleSyntax ? roleSyntax[1].toLowerCase() : null;
    const wantedName = collapseWs(
      roleSyntax ? roleSyntax[2].replace(/\\(["'\\])/g, "$1") : trimmed,
    );
    if (!wantedName) return [];
    const wantedLower = wantedName.toLowerCase();

    const candidates = Array.from(
      root.querySelectorAll(
        'input, textarea, select, button, a, summary, [role], [aria-label], [aria-labelledby], [contenteditable="true"]',
      ),
    ).filter((el) => !wantedRole || roleMatches(implicitRole(el), wantedRole));

    const exact: Element[] = [];
    const partial: Element[] = [];
    for (const candidate of candidates) {
      const names = accessibleNames(candidate).map((n) => n.toLowerCase());
      if (names.some((n) => n === wantedLower)) {
        exact.push(candidate);
      } else if (names.some((n) => n.includes(wantedLower))) {
        partial.push(candidate);
      }
    }
    return [...exact, ...partial];
  }

  function isInteractiveControl(element: Element): boolean {
    return element.matches(
      'button, a, input, select, textarea, summary, label, option, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="radio"], [role="checkbox"]',
    );
  }

  function resolveText(raw: string, root: ParentNode): Element[] {
    const wanted = collapseWs(raw);
    if (!wanted) return [];
    const wantedLower = wanted.toLowerCase();

    const submitInputs = Array.from(
      root.querySelectorAll('input[type="submit"], input[type="button"], input[type="reset"]'),
    ).filter((el) => {
      const val = collapseWs((el as HTMLInputElement).value);
      return val === wanted || val.toLowerCase() === wantedLower;
    });

    const allNodes = Array.from(root.querySelectorAll("*"));
    let textMatched = allNodes.filter((el) => collapseWs(el.textContent ?? "") === wanted);
    if (textMatched.length === 0) {
      textMatched = allNodes.filter(
        (el) => collapseWs(el.textContent ?? "").toLowerCase() === wantedLower,
      );
    }

    const matchedSet = new Set(textMatched);
    textMatched.sort((a, b) => {
      const aInteractive = isInteractiveControl(a) ? 0 : 1;
      const bInteractive = isInteractiveControl(b) ? 0 : 1;
      if (aInteractive !== bInteractive) return aInteractive - bInteractive;
      const aHasChild = Array.from(a.children).some((c) => matchedSet.has(c)) ? 1 : 0;
      const bHasChild = Array.from(b.children).some((c) => matchedSet.has(c)) ? 1 : 0;
      return aHasChild - bHasChild;
    });

    return [...submitInputs, ...textMatched];
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
      return resolveAria(locator.value, root);
    }
    return resolveText(locator.value, root);
  }

  function resolve(locator: Locator, root: ParentNode = document): Element | null {
    const found = resolveAll(locator, root);
    return found.find(isVisible) ?? found[0] ?? null;
  }

  function unwrapControl(element: Element): Element {
    if (element instanceof HTMLLabelElement && element.control) {
      return element.control;
    }
    return element;
  }

  function readValue(rawElement: Element): string {
    const element = unwrapControl(rawElement);
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
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
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      setNativeValue(element, `${element.value.slice(0, start)}${value}${element.value.slice(end)}`);
      const caret = start + value.length;
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

  function selectOption(rawElement: Element, value: string): void {
    const element = unwrapControl(rawElement);
    if (!(element instanceof HTMLSelectElement)) throw new Error("Target is not a select");
    const wanted = collapseWs(value);
    const wantedLower = wanted.toLowerCase();
    const options = Array.from(element.options);
    const matched =
      options.find((opt) => opt.value === value) ??
      options.find((opt) => opt.value.toLowerCase() === wantedLower) ??
      options.find((opt) => collapseWs(opt.label || opt.textContent || "").toLowerCase() === wantedLower) ??
      options.find((opt) =>
        collapseWs(opt.label || opt.textContent || "").toLowerCase().includes(wantedLower),
      );
    if (!matched) throw new Error(`Option not found: ${value}`);
    element.value = matched.value;
    matched.selected = true;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  try {
    switch (step.action) {
      case "click": {
        const element = resolve(step.target);
        if (!element) throw new Error("Target not found");
        click(element);
        return { ok: true, url: location.href };
      }
      case "fill": {
        const rawElement = resolve(step.target);
        if (!rawElement) throw new Error("Target not found");
        const element = unwrapControl(rawElement);
        if (
          element instanceof HTMLInputElement &&
          (element.type === "checkbox" || element.type === "radio")
        ) {
          if (element.type === "radio") {
            if (!element.checked) click(element);
          } else {
            const wantChecked = !/^(false|0|off|no|unchecked)$/i.test(step.value.trim());
            if (element.checked !== wantChecked) click(element);
          }
          return { ok: true, url: location.href, value: String(element.checked) };
        }
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
        const element = targetOverride ?? (step.target ? resolve(step.target) : (lastEditable ?? active));
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
  }
}
