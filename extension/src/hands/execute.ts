import type { DomStep, Locator, StepResult } from "../types.js";

type TargetSpec = Locator | Locator[];

type V2StepExtras = {
  within?: TargetSpec;
  targets?: Locator[];
  watch?: boolean;
  timeoutMs?: number;
  role?: string;
  label?: string;
  text?: string;
};

export type V2DomStep =
  | (Omit<Extract<DomStep, { action: "click" }>, "target"> & { target?: TargetSpec } & V2StepExtras)
  | (Omit<Extract<DomStep, { action: "fill" }>, "target"> & { target?: TargetSpec } & V2StepExtras)
  | (Omit<Extract<DomStep, { action: "insertText" }>, "target"> & {
      target?: TargetSpec;
    } & V2StepExtras)
  | (Omit<Extract<DomStep, { action: "select" }>, "target"> & { target?: TargetSpec } & V2StepExtras)
  | (Omit<Extract<DomStep, { action: "waitFor" }>, "target"> & {
      target?: TargetSpec;
    } & V2StepExtras)
  | (Omit<Extract<DomStep, { action: "readText" }>, "target"> & {
      target?: TargetSpec;
    } & V2StepExtras)
  | (Omit<Extract<DomStep, { action: "readValue" }>, "target"> & {
      target?: TargetSpec;
    } & V2StepExtras)
  | (Omit<Extract<DomStep, { action: "extractList" }>, "target"> & {
      target?: TargetSpec;
    } & V2StepExtras)
  | ({
      action: "pressKey";
      key?: string;
      value?: string;
      target?: TargetSpec;
      optional?: boolean;
    } & V2StepExtras);

export async function executeStep(
  step: V2DomStep,
  targetOverride?: Element | null,
): Promise<StepResult> {
  function toLocatorList(
    target?: Locator | Locator[] | null,
    extraTargets?: Locator[],
  ): Locator[] {
    const out: Locator[] = [];
    const seen = new Set<string>();
    const add = (loc?: Locator | null): void => {
      if (!loc || typeof loc.kind !== "string" || typeof loc.value !== "string") return;
      if (!loc.value.trim()) return;
      const key = `${loc.kind}:${loc.value}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(loc);
    };
    if (Array.isArray(target)) {
      for (const loc of target) add(loc);
    } else if (target) {
      add(target);
    }
    if (Array.isArray(extraTargets)) {
      for (const loc of extraTargets) add(loc);
    }
    return out;
  }

  function escapeValue(value: string): string {
    return value.replace(/["\\]/g, "\\$&");
  }

  function collapseWs(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function isExplicitlyHidden(element: Element): boolean {
    if (
      typeof HTMLInputElement !== "undefined" &&
      element instanceof HTMLInputElement &&
      element.type.toLowerCase() === "hidden"
    ) {
      return true;
    }
    if (
      element.tagName.toLowerCase() === "input" &&
      element.getAttribute("type")?.toLowerCase() === "hidden"
    ) {
      return true;
    }
    if (
      typeof element.closest === "function" &&
      element.closest('[hidden], [aria-hidden="true"]')
    ) {
      return true;
    }
    const inlineStyle = (element as HTMLElement).style;
    if (
      inlineStyle &&
      (inlineStyle.display === "none" || inlineStyle.visibility === "hidden")
    ) {
      return true;
    }
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return true;
    }
    return false;
  }

  function isVisible(element: Element): boolean {
    if (isExplicitlyHidden(element)) return false;
    if (typeof element.getClientRects === "function") {
      return element.getClientRects().length > 0;
    }
    return true;
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
  const TEXT_NAMED_ROLES = new Set([
    "button",
    "link",
    "menuitem",
    "tab",
    "option",
    "treeitem",
    "checkbox",
    "radio",
    "switch",
    "gridcell",
  ]);
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
    if (typeof label.cloneNode !== "function") {
      return collapseWs(label.textContent ?? "");
    }
    const clone = label.cloneNode(true) as HTMLElement;
    if (typeof clone.querySelectorAll === "function") {
      for (const nested of Array.from(
        clone.querySelectorAll("input, select, textarea, button, datalist, script, style"),
      )) {
        nested.remove();
      }
    }
    return collapseWs(clone.textContent ?? "");
  }

  function accessibleNames(element: Element): string[] {
    const names: string[] = [];
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) names.push(collapseWs(ariaLabel));

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy && typeof document.getElementById === "function") {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => collapseWs(document.getElementById(id)?.textContent ?? ""))
        .filter(Boolean)
        .join(" ");
      if (joined) names.push(joined);
    }

    const tag = element.tagName.toLowerCase();
    const isFormControl =
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      (typeof HTMLInputElement !== "undefined" && element instanceof HTMLInputElement) ||
      (typeof HTMLTextAreaElement !== "undefined" && element instanceof HTMLTextAreaElement) ||
      (typeof HTMLSelectElement !== "undefined" && element instanceof HTMLSelectElement);

    if (isFormControl) {
      const labels = (element as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        const labelText = Array.from(labels)
          .map((label) => cleanLabelNode(label))
          .filter(Boolean)
          .join(" ");
        if (labelText) names.push(labelText);
      }
      const inputType = element.getAttribute("type") || "";
      const inputVal = (element as HTMLInputElement).value;
      if (tag === "input" && /^(submit|button|reset)$/i.test(inputType) && inputVal) {
        names.push(collapseWs(inputVal));
      }
      const placeholder = element.getAttribute("placeholder");
      if (placeholder) names.push(collapseWs(placeholder));
    }

    const title = element.getAttribute("title");
    if (title) names.push(collapseWs(title));

    const role = implicitRole(element);
    if (tag !== "select" && (TEXT_NAMED_ROLES.has(role) || tag === "label")) {
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
        'input, textarea, select, button, a, summary, td, th, [role], [aria-label], [aria-labelledby], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
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
    const exactVisible = exact.filter(isVisible);
    if (exactVisible.length > 0) return exactVisible;
    const partialVisible = partial.filter(isVisible);
    if (partialVisible.length > 0) return partialVisible;
    return [...exact, ...partial];
  }

  function isInteractiveControl(element: Element): boolean {
    if (typeof element.matches === "function") {
      return element.matches(
        'button, a, input, select, textarea, summary, label, option, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="radio"], [role="checkbox"]',
      );
    }
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();
    return (
      tag === "button" ||
      tag === "a" ||
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      tag === "summary" ||
      tag === "label" ||
      tag === "option" ||
      role === "button" ||
      role === "link" ||
      role === "menuitem" ||
      role === "tab" ||
      role === "radio" ||
      role === "checkbox"
    );
  }

  function containsElement(ancestor: Element, descendant: Element): boolean {
    if (typeof ancestor.contains === "function") {
      return ancestor.contains(descendant);
    }
    let curr: Element | null = descendant.parentElement;
    while (curr) {
      if (curr === ancestor) return true;
      curr = curr.parentElement;
    }
    return false;
  }

  function pruneNestedTextMatches(matches: Element[]): Element[] {
    return matches.filter((el) => {
      const elInteractive = isInteractiveControl(el);
      if (
        !elInteractive &&
        matches.some(
          (other) => other !== el && isInteractiveControl(other) && containsElement(other, el),
        )
      ) {
        return false;
      }
      return !matches.some((other) => {
        if (other === el) return false;
        if (!containsElement(el, other)) return false;
        if (elInteractive && !isInteractiveControl(other)) return false;
        return true;
      });
    });
  }

  function resolveText(raw: string, root: ParentNode): Element[] {
    const wanted = collapseWs(raw);
    if (!wanted) return [];
    const wantedLower = wanted.toLowerCase();

    const submitInputs = Array.from(
      root.querySelectorAll('input[type="submit"], input[type="button"], input[type="reset"]'),
    ).filter((el) => {
      const val = collapseWs((el as HTMLInputElement).value ?? el.getAttribute("value") ?? "");
      return val === wanted || val.toLowerCase() === wantedLower;
    });

    const allNodes = Array.from(root.querySelectorAll("*"));
    let textMatched = allNodes.filter((el) => collapseWs(el.textContent ?? "") === wanted);
    if (textMatched.length === 0) {
      textMatched = allNodes.filter(
        (el) => collapseWs(el.textContent ?? "").toLowerCase() === wantedLower,
      );
    }

    const prunedText = pruneNestedTextMatches(textMatched);
    const matchedSet = new Set(prunedText);
    prunedText.sort((a, b) => {
      const aInteractive = isInteractiveControl(a) ? 0 : 1;
      const bInteractive = isInteractiveControl(b) ? 0 : 1;
      if (aInteractive !== bInteractive) return aInteractive - bInteractive;
      const aHasChild = Array.from(a.children).some((c) => matchedSet.has(c)) ? 1 : 0;
      const bHasChild = Array.from(b.children).some((c) => matchedSet.has(c)) ? 1 : 0;
      return aHasChild - bHasChild;
    });

    const combined: Element[] = [];
    const seen = new Set<Element>();
    for (const el of [...submitInputs, ...prunedText]) {
      if (!seen.has(el)) {
        seen.add(el);
        combined.push(el);
      }
    }
    return combined;
  }

  function resolveAllForLocator(locator: Locator, root: ParentNode = document): Element[] {
    if (locator.kind === "css") {
      try {
        const direct = Array.from(root.querySelectorAll(locator.value));
        if (direct.length > 0) return direct;
      } catch {
        // fall through to structural fallbacks below
      }
      const trimmed = locator.value.trim();
      if (/^tr:has\(td\)$/i.test(trimmed)) {
        return Array.from(root.querySelectorAll("tr")).filter(
          (tr) => tr.querySelectorAll("td").length > 0,
        );
      }
      const nthTdMatch = /^td:nth-of-type\((\d+)\)$/i.exec(trimmed);
      if (nthTdMatch) {
        const idx = Number(nthTdMatch[1]) - 1;
        if (idx >= 0) {
          const children = Array.from((root as Element).children ?? []).filter(
            (el) => el.tagName.toLowerCase() === "td",
          );
          if (children[idx]) return [children[idx]];
          const allTds = Array.from(root.querySelectorAll("td"));
          if (allTds[idx]) return [allTds[idx]];
        }
      }
      return [];
    }
    if (locator.kind === "xpath") {
      if (typeof document.evaluate !== "function") return [];
      const expr =
        root !== document && locator.value.startsWith("/")
          ? `.${locator.value}`
          : locator.value;
      const snapshot = document.evaluate(
        expr,
        root as Node,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      const found: Element[] = [];
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const node = snapshot.snapshotItem(index);
        if (typeof Element === "undefined" || node instanceof Element) {
          if (node) found.push(node as Element);
        }
      }
      return found;
    }
    if (locator.kind === "testid") {
      const escaped = escapeValue(locator.value);
      return Array.from(
        root.querySelectorAll(
          `[data-testid="${escaped}"], [data-test-id="${escaped}"], [data-test="${escaped}"], [data-qa="${escaped}"], [data-cy="${escaped}"]`,
        ),
      );
    }
    if (locator.kind === "aria") {
      return resolveAria(locator.value, root);
    }
    return resolveText(locator.value, root);
  }

  function isEditableElement(element: Element): boolean {
    const tag = element.tagName.toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const inputType = (element.getAttribute("type") || "text").toLowerCase();
      return !/^(hidden|submit|button|reset|image)$/.test(inputType);
    }
    if ((element as HTMLElement).isContentEditable) return true;
    const role = (element.getAttribute("role") || "").toLowerCase();
    return (
      role === "textbox" ||
      role === "searchbox" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "switch"
    );
  }

  function extractSemanticHints(locators: Locator[]): {
    wantedRole: string | null;
    wantedTexts: string[];
  } {
    let wantedRole: string | null = step.role ? step.role.trim().toLowerCase() : null;
    const wantedTexts: string[] = [];
    const seen = new Set<string>();
    const addText = (val?: string | null): void => {
      if (!val) return;
      const clean = collapseWs(val);
      if (!clean || seen.has(clean.toLowerCase())) return;
      seen.add(clean.toLowerCase());
      wantedTexts.push(clean);
    };

    addText(step.label);
    addText(step.text);

    for (const loc of locators) {
      if (loc.kind === "text") {
        addText(loc.value);
      } else if (loc.kind === "aria") {
        const trimmed = loc.value.trim();
        const roleSyntax = /^([a-z]+)\[\s*name\s*=\s*["']([\s\S]*?)["']\s*\]$/i.exec(trimmed);
        if (roleSyntax) {
          if (!wantedRole) wantedRole = roleSyntax[1].toLowerCase();
          addText(roleSyntax[2].replace(/\\(["'\\])/g, "$1"));
        } else {
          const attrMatch = /^\[\s*aria-label\s*=\s*["']([\s\S]*?)["']\s*\]$/i.exec(trimmed);
          if (attrMatch) {
            addText(attrMatch[1].replace(/\\(["'\\])/g, "$1"));
          } else if (!trimmed.startsWith("[")) {
            addText(trimmed);
          }
        }
      } else if (loc.kind === "css") {
        const attrRe = /\[\s*(?:aria-label|placeholder|title|name)\s*=\s*["']([^"']+)["']\s*\]/gi;
        let match: RegExpExecArray | null;
        while ((match = attrRe.exec(loc.value)) !== null) {
          addText(match[1]);
        }
      }
    }

    return { wantedRole, wantedTexts };
  }

  function semanticNames(element: Element): string[] {
    const names = accessibleNames(element);
    const tag = element.tagName.toLowerCase();
    const attrName = element.getAttribute("name");
    if (attrName && (tag === "input" || tag === "textarea" || tag === "select" || tag === "button")) {
      names.push(collapseWs(attrName));
    }
    if (tag !== "select") {
      const text = collapseWs(element.textContent ?? "");
      if (text && text.length <= 120) {
        names.push(text);
      }
    }
    return names.filter(Boolean);
  }

  function matchesActionCategory(element: Element, action: V2DomStep["action"]): boolean {
    if (action === "fill" || action === "insertText") {
      return isEditableElement(element);
    }
    if (action === "select") {
      const tag = element.tagName.toLowerCase();
      const role = (element.getAttribute("role") || "").toLowerCase();
      return tag === "select" || role === "combobox";
    }
    return true;
  }

  function resolveSemanticFallback(
    locators: Locator[],
    root: ParentNode,
    action: V2DomStep["action"],
  ): { visible: Element[]; hidden: Element[] } {
    const { wantedRole, wantedTexts } = extractSemanticHints(locators);
    if (wantedTexts.length === 0) return { visible: [], hidden: [] };

    const allNodes = Array.from(root.querySelectorAll("*")).filter((el) =>
      matchesActionCategory(el, action),
    );

    const pickByPrecision = (
      mode: "exact" | "partial",
      wantedLower: string,
    ): Element[] => {
      const matched = allNodes.filter((el) => {
        const names = semanticNames(el).map((n) => n.toLowerCase());
        return mode === "exact"
          ? names.some((n) => n === wantedLower)
          : names.some((n) => n.includes(wantedLower));
      });
      if (matched.length === 0) return [];
      const roleFiltered = wantedRole
        ? matched.filter((el) => roleMatches(implicitRole(el), wantedRole))
        : [];
      const pool = roleFiltered.length > 0 ? roleFiltered : matched;
      if (action === "click" || action === "pressKey" || action === "waitFor") {
        const interactive = pool.filter(
          (el) =>
            isInteractiveControl(el) ||
            el.hasAttribute("tabindex") ||
            el.hasAttribute("onclick"),
        );
        if (interactive.length > 0) return pruneNestedTextMatches(interactive);
      }
      return pruneNestedTextMatches(pool);
    };

    for (const wantedText of wantedTexts) {
      const wantedLower = wantedText.toLowerCase();
      const exactMatches = pickByPrecision("exact", wantedLower);
      if (exactMatches.length > 0) {
        return {
          visible: exactMatches.filter(isVisible),
          hidden: exactMatches.filter((el) => !isVisible(el)),
        };
      }
    }

    for (const wantedText of wantedTexts) {
      const wantedLower = wantedText.toLowerCase();
      const partialMatches = pickByPrecision("partial", wantedLower);
      if (partialMatches.length > 0) {
        return {
          visible: partialMatches.filter(isVisible),
          hidden: partialMatches.filter((el) => !isVisible(el)),
        };
      }
    }

    return { visible: [], hidden: [] };
  }

  function resolveFromLocatorsOnce(
    locators: Locator[],
    root: ParentNode,
    allowSemanticFallback: boolean,
  ): { element: Element | null; hiddenCandidate: Element | null } {
    let firstHidden: Element | null = null;
    let sawAmbiguous = false;
    for (const locator of locators) {
      const found = resolveAllForLocator(locator, root);
      const visible = found.filter(isVisible);
      if (visible.length > 1) {
        sawAmbiguous = true;
        continue;
      }
      if (visible.length === 1) {
        return { element: visible[0], hiddenCandidate: null };
      }
      if (!firstHidden && found.length === 1) {
        firstHidden = found[0];
      }
    }

    if (sawAmbiguous) {
      throw new Error("Ambiguous target");
    }

    if (allowSemanticFallback) {
      const semantic = resolveSemanticFallback(locators, root, step.action);
      if (semantic.visible.length > 1) {
        throw new Error("Ambiguous target");
      }
      if (semantic.visible.length === 1) {
        return { element: semantic.visible[0], hiddenCandidate: null };
      }
      if (!firstHidden && semantic.hidden.length === 1) {
        firstHidden = semantic.hidden[0];
      }
    }

    return { element: null, hiddenCandidate: firstHidden };
  }

  function resolveAll(target: Locator | Locator[], root: ParentNode = document): Element[] {
    for (const locator of toLocatorList(target)) {
      const found = resolveAllForLocator(locator, root);
      if (found.length > 0) return found;
    }
    return [];
  }

  function resolve(target: Locator | Locator[], root: ParentNode = document): Element | null {
    for (const locator of toLocatorList(target)) {
      const found = resolveAllForLocator(locator, root);
      const match = found.find(isVisible) ?? found[0] ?? null;
      if (match) return match;
    }
    return null;
  }

  function resolveSingleInRoot(target: Locator | Locator[], root: ParentNode): Element | null {
    return resolve(target, root);
  }

  function isRowTagOrRole(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === "tr" || tag === "li") return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    return role === "row" || role === "listitem";
  }

  function findRowWithinBoundary(el: Element, boundary?: Element): Element {
    let curr: Element | null = el;
    while (curr && curr !== boundary) {
      if (isRowTagOrRole(curr) && (!boundary || containsElement(boundary, curr))) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return el;
  }

  function resolveWithinScope(
    withinLocators: Locator[],
    allowHidden: boolean,
  ): Element | null {
    const containerLocs = withinLocators.filter((loc) => loc.kind !== "text");
    const textLocs = withinLocators.filter((loc) => loc.kind === "text");

    if (containerLocs.length > 0 && textLocs.length > 0) {
      const containerAttempt = resolveFromLocatorsOnce(containerLocs, document, false);
      const container =
        containerAttempt.element ?? (allowHidden ? containerAttempt.hiddenCandidate : null);
      if (!container) return null;

      const textAttempt = resolveFromLocatorsOnce(textLocs, container, false);
      const textMatch =
        textAttempt.element ?? (allowHidden ? textAttempt.hiddenCandidate : null);
      if (!textMatch) return null;

      return findRowWithinBoundary(textMatch, container);
    }

    const attempt = resolveFromLocatorsOnce(withinLocators, document, false);
    const matched = attempt.element ?? (allowHidden ? attempt.hiddenCandidate : null);
    if (!matched) return null;
    if (containerLocs.length === 0 && textLocs.length > 0) {
      return findRowWithinBoundary(matched);
    }
    return matched;
  }

  async function resolveStepTarget(): Promise<Element | null> {
    const locators = toLocatorList(step.target, step.targets);
    const withinLocators = toLocatorList(step.within);
    const defaultTimeout = step.action === "waitFor" ? 5000 : step.optional ? 500 : 2000;
    const timeoutMs = step.timeoutMs ?? defaultTimeout;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      let scopeRoot: ParentNode = document;
      if (withinLocators.length > 0) {
        const container = resolveWithinScope(withinLocators, Date.now() >= deadline);
        if (!container) {
          if (Date.now() >= deadline) {
            throw new Error("Container not found");
          }
          await wait(50);
          continue;
        }
        scopeRoot = container;
      }

      if (locators.length === 0) {
        return scopeRoot === document ? null : (scopeRoot as Element);
      }

      const attempt = resolveFromLocatorsOnce(locators, scopeRoot, true);
      if (attempt.element) return attempt.element;

      if (Date.now() >= deadline) {
        if (step.action !== "waitFor" && attempt.hiddenCandidate) {
          return attempt.hiddenCandidate;
        }
        return null;
      }
      await wait(50);
    }
  }

  async function resolveExtractRoots(): Promise<Element[]> {
    const locators = toLocatorList(step.target, step.targets);
    const withinLocators = toLocatorList(step.within);
    const timeoutMs = step.timeoutMs ?? 500;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      let scopeRoot: ParentNode = document;
      if (withinLocators.length > 0) {
        const container = resolveWithinScope(withinLocators, Date.now() >= deadline);
        if (!container) {
          if (Date.now() >= deadline) {
            throw new Error("Container not found");
          }
          await wait(50);
          continue;
        }
        scopeRoot = container;
      }

      for (const locator of locators) {
        const roots = resolveAll(locator, scopeRoot);
        if (roots.length > 0) return roots;
      }

      if (Date.now() >= deadline) return [];
      await wait(50);
    }
  }

  function highlightTarget(element: Element): void {
    const winWatch = (window as unknown as { __EYES_WATCH_MODE__?: boolean }).__EYES_WATCH_MODE__;
    const stepWatch = Boolean(step.watch);
    const hasWatchBar =
      typeof document.getElementById === "function" &&
      Boolean(document.getElementById("__eyes_watch_bar__"));
    if (!winWatch && !stepWatch && !hasWatchBar) return;

    if (typeof document.querySelectorAll === "function") {
      for (const prev of Array.from(document.querySelectorAll('[data-eyes-highlighted="true"]'))) {
        if (prev !== element && typeof prev.removeAttribute === "function") {
          prev.removeAttribute("data-eyes-highlighted");
        }
      }
    }
    if (typeof element.setAttribute === "function") {
      element.setAttribute("data-eyes-highlighted", "true");
    }

    if (typeof document.getElementById === "function" && typeof document.createElement === "function") {
      let highlight = document.getElementById("__eyes_watch_highlight__");
      if (!highlight && document.documentElement) {
        highlight = document.createElement("div");
        highlight.id = "__eyes_watch_highlight__";
        highlight.setAttribute("data-eyes-ui", "true");
        highlight.style.position = "fixed";
        highlight.style.pointerEvents = "none";
        highlight.style.border = "2px solid #8a5a2b";
        highlight.style.background = "rgba(138, 90, 43, 0.12)";
        highlight.style.borderRadius = "6px";
        highlight.style.boxSizing = "border-box";
        highlight.style.zIndex = "2147483646";
        document.documentElement.appendChild(highlight);
      }
      if (highlight && typeof element.getBoundingClientRect === "function") {
        const rect = element.getBoundingClientRect();
        highlight.style.top = `${Math.max(0, rect.top - 3)}px`;
        highlight.style.left = `${Math.max(0, rect.left - 3)}px`;
        highlight.style.width = `${Math.max(0, rect.width + 6)}px`;
        highlight.style.height = `${Math.max(0, rect.height + 6)}px`;
      }
    }
  }

  function unwrapControl(element: Element): Element {
    if (
      typeof HTMLLabelElement !== "undefined" &&
      element instanceof HTMLLabelElement &&
      element.control
    ) {
      return element.control;
    }
    return element;
  }

  function readNonButtonText(element: Element): string {
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();
    if (tag === "button" || role === "button") {
      return (element.textContent ?? "").trim();
    }
    const childNodes = (element as { childNodes?: ArrayLike<Node> }).childNodes;
    if (!childNodes || childNodes.length === 0) {
      return (element.textContent ?? "").trim();
    }
    const parts: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        parts.push(node.textContent ?? "");
        return;
      }
      if (node.nodeType === 1) {
        const el = node as Element;
        const elTag = el.tagName?.toLowerCase();
        const elRole = (el.getAttribute?.("role") || "").toLowerCase();
        if (elTag === "button" || elRole === "button") return;
        if (isExplicitlyHidden(el)) return;
        const children = (el as { childNodes?: ArrayLike<Node> }).childNodes;
        if (children && children.length > 0) {
          for (const child of Array.from(children)) walk(child);
        } else if (el.textContent) {
          parts.push(el.textContent);
        }
      }
    };
    for (const child of Array.from(childNodes)) {
      walk(child);
    }
    const cleaned = collapseWs(parts.join(""));
    return cleaned || (element.textContent ?? "").trim();
  }

  function readValue(rawElement: Element): string {
    const element = unwrapControl(rawElement);
    const tag = element.tagName.toLowerCase();
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      (typeof HTMLInputElement !== "undefined" && element instanceof HTMLInputElement) ||
      (typeof HTMLTextAreaElement !== "undefined" && element instanceof HTMLTextAreaElement) ||
      (typeof HTMLSelectElement !== "undefined" && element instanceof HTMLSelectElement)
    ) {
      return (element as HTMLInputElement).value ?? "";
    }
    if ((element as HTMLElement).isContentEditable) {
      return (element as HTMLElement).innerText ?? element.textContent ?? "";
    }
    return readNonButtonText(element);
  }

  function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const isTextArea =
      (typeof HTMLTextAreaElement !== "undefined" && element instanceof HTMLTextAreaElement) ||
      element.tagName.toLowerCase() === "textarea";
    const prototype = isTextArea
      ? typeof HTMLTextAreaElement !== "undefined"
        ? HTMLTextAreaElement.prototype
        : undefined
      : typeof HTMLInputElement !== "undefined"
        ? HTMLInputElement.prototype
        : undefined;
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : undefined;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function insertIntoEditable(element: HTMLElement, value: string): void {
    if (typeof element.focus === "function") element.focus();
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (selection && typeof document.createRange === "function") {
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
    const inserted =
      typeof document.execCommand === "function" && document.execCommand("insertText", false, value);
    if (!inserted) {
      element.textContent = `${element.textContent ?? ""}${value}`;
      const InputCtor = typeof InputEvent === "function" ? InputEvent : Event;
      element.dispatchEvent(
        new InputCtor("input", { bubbles: true, inputType: "insertText", data: value } as InputEventInit),
      );
    }
  }

  function insertText(element: Element, value: string): void {
    const tag = element.tagName.toLowerCase();
    const isInputOrArea =
      tag === "input" ||
      tag === "textarea" ||
      (typeof HTMLInputElement !== "undefined" && element instanceof HTMLInputElement) ||
      (typeof HTMLTextAreaElement !== "undefined" && element instanceof HTMLTextAreaElement);
    if (isInputOrArea) {
      const inputEl = element as HTMLInputElement | HTMLTextAreaElement;
      if (typeof inputEl.focus === "function") inputEl.focus();
      const existing = inputEl.value ?? "";
      const existingNorm = existing.trim().toLowerCase();
      const incomingNorm = value.trim().toLowerCase();
      if (
        existingNorm.length > 0 &&
        incomingNorm.length > 0 &&
        incomingNorm.startsWith(existingNorm)
      ) {
        setNativeValue(inputEl, value);
      } else {
        const start = inputEl.selectionStart ?? existing.length;
        const end = inputEl.selectionEnd ?? existing.length;
        setNativeValue(inputEl, `${existing.slice(0, start)}${value}${existing.slice(end)}`);
      }
      const caret = (inputEl.value ?? "").length;
      try {
        inputEl.setSelectionRange?.(caret, caret);
      } catch {
        /* ignore */
      }
      return;
    }
    if ((element as HTMLElement).isContentEditable) {
      insertIntoEditable(element as HTMLElement, value);
      return;
    }
    throw new Error("Target is not editable");
  }

  function click(element: Element): void {
    const MouseCtor = typeof MouseEvent === "function" ? MouseEvent : Event;
    element.dispatchEvent(new MouseCtor("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseCtor("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    if (element.isConnected === false) return;
    if (typeof (element as HTMLElement).click === "function") {
      (element as HTMLElement).click();
      return;
    }
    element.dispatchEvent(new MouseCtor("click", { bubbles: true, cancelable: true, button: 0 }));
  }

  function selectOption(rawElement: Element, value: string): void {
    const element = unwrapControl(rawElement);
    const isSelect =
      element.tagName.toLowerCase() === "select" ||
      (typeof HTMLSelectElement !== "undefined" && element instanceof HTMLSelectElement);
    if (!isSelect) throw new Error("Target is not a select");
    const selectEl = element as HTMLSelectElement;
    const wanted = collapseWs(value);
    const wantedLower = wanted.toLowerCase();
    const options = Array.from(selectEl.options ?? []);
    const matched =
      options.find((opt) => opt.value === value) ??
      options.find((opt) => opt.value.toLowerCase() === wantedLower) ??
      options.find((opt) => collapseWs(opt.label || opt.textContent || "").toLowerCase() === wantedLower) ??
      options.find((opt) =>
        collapseWs(opt.label || opt.textContent || "").toLowerCase().includes(wantedLower),
      );
    if (!matched) throw new Error(`Option not found: ${value}`);
    selectEl.value = matched.value;
    matched.selected = true;
    selectEl.dispatchEvent(new Event("input", { bubbles: true }));
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchPressKey(element: Element, rawKey: string): void {
    const keyName = rawKey === "Esc" ? "Escape" : rawKey;
    const keyMeta: Record<string, { code: string; keyCode: number }> = {
      Enter: { code: "Enter", keyCode: 13 },
      Tab: { code: "Tab", keyCode: 9 },
      Escape: { code: "Escape", keyCode: 27 },
    };
    const meta = keyMeta[keyName] ?? {
      code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName,
      keyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0,
    };

    if (typeof (element as HTMLElement).focus === "function") {
      (element as HTMLElement).focus();
    }

    const createKeyEvent = (type: "keydown" | "keyup"): Event => {
      if (typeof KeyboardEvent === "function") {
        return new KeyboardEvent(type, {
          key: keyName,
          code: meta.code,
          keyCode: meta.keyCode,
          which: meta.keyCode,
          bubbles: true,
          cancelable: true,
        });
      }
      return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        key: keyName,
        code: meta.code,
        keyCode: meta.keyCode,
        which: meta.keyCode,
      });
    };

    const notCancelled = element.dispatchEvent(createKeyEvent("keydown"));
    if (keyName === "Enter" && notCancelled) {
      const tag = element.tagName?.toLowerCase() ?? "";
      const isInputOrTextarea =
        tag === "input" ||
        tag === "textarea" ||
        (typeof HTMLInputElement !== "undefined" && element instanceof HTMLInputElement) ||
        (typeof HTMLTextAreaElement !== "undefined" && element instanceof HTMLTextAreaElement);
      if (isInputOrTextarea) {
        const form =
          (element as HTMLInputElement).form ??
          (typeof element.closest === "function"
            ? (element.closest("form") as HTMLFormElement | null)
            : null);
        if (form) {
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
          } else if (typeof form.submit === "function") {
            form.submit();
          }
        }
      }
    }
    element.dispatchEvent(createKeyEvent("keyup"));
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
        const element = await resolveStepTarget();
        if (!element) throw new Error("Target not found");
        highlightTarget(element);
        click(element);
        return { ok: true, url: location.href };
      }
      case "fill": {
        const rawElement = await resolveStepTarget();
        if (!rawElement) throw new Error("Target not found");
        highlightTarget(rawElement);
        const element = unwrapControl(rawElement);
        const tag = element.tagName.toLowerCase();
        const inputType = (element.getAttribute("type") || "text").toLowerCase();
        if (tag === "input" && (inputType === "checkbox" || inputType === "radio")) {
          const inputEl = element as HTMLInputElement;
          if (inputType === "radio") {
            if (!inputEl.checked) click(inputEl);
          } else {
            const wantChecked = !/^(false|0|off|no|unchecked)$/i.test(step.value.trim());
            if (inputEl.checked !== wantChecked) click(inputEl);
          }
          return { ok: true, url: location.href, value: String(inputEl.checked) };
        }
        if (
          tag === "input" ||
          tag === "textarea" ||
          (typeof HTMLInputElement !== "undefined" && element instanceof HTMLInputElement) ||
          (typeof HTMLTextAreaElement !== "undefined" && element instanceof HTMLTextAreaElement)
        ) {
          setNativeValue(element as HTMLInputElement | HTMLTextAreaElement, step.value);
        } else if (
          tag === "select" ||
          (typeof HTMLSelectElement !== "undefined" && element instanceof HTMLSelectElement)
        ) {
          selectOption(element, step.value);
          return { ok: true, url: location.href, value: readValue(element) };
        } else if ((element as HTMLElement).isContentEditable) {
          element.textContent = "";
          insertIntoEditable(element as HTMLElement, step.value);
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
        const resolved =
          toLocatorList(step.target, step.targets).length > 0 || step.within
            ? await resolveStepTarget()
            : null;
        const element = targetOverride ?? resolved ?? lastEditable ?? active;
        if (!element) throw new Error("No target and nothing focused");
        highlightTarget(element);
        insertText(element, step.value);
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "select": {
        const element = await resolveStepTarget();
        if (!element) throw new Error("Target not found");
        highlightTarget(element);
        selectOption(element, step.value);
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "waitFor": {
        const element = await resolveStepTarget();
        if (!element) throw new Error("Timed out waiting for target");
        highlightTarget(element);
        return { ok: true, url: location.href };
      }
      case "readText":
      case "readValue": {
        const element = await resolveStepTarget();
        if (!element) throw new Error("Target not found");
        highlightTarget(element);
        return { ok: true, url: location.href, value: readValue(element) };
      }
      case "extractList": {
        const roots = await resolveExtractRoots();
        if (roots.length === 0) throw new Error("Target not found");
        const visibleRoots = roots.filter(isVisible);
        const targetRoots = visibleRoots.length > 0 ? visibleRoots : roots;
        const items = targetRoots.map((row) => {
          if (!step.fields) return { text: readValue(row) };
          const item: Record<string, string> = {};
          for (const [name, locator] of Object.entries(step.fields)) {
            const field = resolveSingleInRoot(locator, row);
            item[name] = field ? readValue(field) : "";
          }
          return item;
        });
        return { ok: true, url: location.href, items };
      }
      case "pressKey": {
        const keyToPress = (step.key ?? step.value ?? "").trim();
        if (!keyToPress) throw new Error("Missing key for pressKey");
        let active: Element | null = document.activeElement;
        while (active && active.shadowRoot && active.shadowRoot.activeElement) {
          active = active.shadowRoot.activeElement;
        }
        const hasTarget = toLocatorList(step.target, step.targets).length > 0 || Boolean(step.within);
        const target = hasTarget
          ? await resolveStepTarget()
          : (targetOverride ?? active ?? document.body ?? document.documentElement);
        if (!target) throw new Error("Target not found");
        highlightTarget(target);
        dispatchPressKey(target, keyToPress);
        return { ok: true, url: location.href, value: keyToPress };
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
