import type { ActionScript, BindingValue, DomStep, Locator, Step } from "../types.ts";

export type PreviewStepStatus = "found" | "missing" | "skipped";

export type PreviewStepResult = {
  index: number;
  action: Step["action"];
  status: PreviewStepStatus;
  reason?: string;
};

export type PreviewResult = {
  ready: boolean;
  found: number;
  total: number;
  summary: string;
  steps: PreviewStepResult[];
};

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
const IGNORED_LABEL_TAGS = new Set([
  "input",
  "select",
  "textarea",
  "button",
  "datalist",
  "script",
  "style",
]);

function hasFormAncestor(el: Element): boolean {
  if (typeof el.closest === "function") {
    try {
      if (el.closest("form")) return true;
    } catch {
      // Minimal DOM mocks may not support selector matching in closest().
    }
  }
  let current: Element | null = el.parentElement;
  while (current) {
    if (current.tagName.toLowerCase() === "form") return true;
    current = current.parentElement;
  }
  return false;
}

export function isSubmitElement(el: Element): boolean {
  const role = el.getAttribute("role")?.trim().toLowerCase();
  if (role === "submit") return true;

  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    return el.getAttribute("type")?.trim().toLowerCase() === "submit";
  }
  if (tag === "button") {
    const explicitType = el.getAttribute("type");
    if (explicitType !== null && explicitType.trim() !== "") {
      return explicitType.trim().toLowerCase() === "submit";
    }
    return hasFormAncestor(el);
  }
  return false;
}

function escapeCssValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function collapseWs(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isElementVisible(element: Element): boolean {
  if (
    element.tagName.toLowerCase() === "input" &&
    (element.getAttribute("type") ?? "").toLowerCase() === "hidden"
  ) {
    return false;
  }
  if (element.getAttribute("hidden") !== null || element.getAttribute("aria-hidden") === "true") {
    return false;
  }
  if (typeof element.closest === "function") {
    try {
      if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    } catch {
      // Ignore unsupported selector syntax in minimal mocks.
    }
  }
  if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
    try {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
    } catch {
      // Ignore non-DOM mock elements.
    }
  }
  if (typeof element.getClientRects === "function") {
    return element.getClientRects().length > 0;
  }
  return true;
}

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

function readLabelTextWithoutNestedControls(label: Element): string {
  const childNodes = (label as { childNodes?: ArrayLike<Node> }).childNodes;
  if (!childNodes || childNodes.length === 0) {
    return collapseWs(label.textContent ?? "");
  }
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      if (node.nodeValue) parts.push(node.nodeValue);
      return;
    }
    if (node.nodeType === 1) {
      const el = node as Element;
      if (IGNORED_LABEL_TAGS.has(el.tagName.toLowerCase())) return;
      const children = (el as { childNodes?: ArrayLike<Node> }).childNodes;
      if (children) {
        for (let i = 0; i < children.length; i += 1) {
          visit(children[i]);
        }
      }
    }
  };
  for (let i = 0; i < childNodes.length; i += 1) {
    visit(childNodes[i]);
  }
  return collapseWs(parts.join(" "));
}

function getOwnerDocument(root: ParentNode): Document | null {
  const asNode = root as { nodeType?: number; ownerDocument?: Document | null };
  if (asNode.nodeType === 9) return root as Document;
  if (asNode.ownerDocument) return asNode.ownerDocument;
  if (typeof document !== "undefined") return document;
  return null;
}

function accessibleNames(element: Element, root: ParentNode): string[] {
  const names: string[] = [];
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) names.push(collapseWs(ariaLabel));

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const doc = getOwnerDocument(root);
    const joined = labelledBy
      .split(/\s+/)
      .map((id) => collapseWs(doc?.getElementById?.(id)?.textContent ?? ""))
      .filter(Boolean)
      .join(" ");
    if (joined) names.push(joined);
  }

  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    const labels = (element as { labels?: ArrayLike<Element> | null }).labels;
    if (labels && labels.length > 0) {
      const labelTexts: string[] = [];
      for (let i = 0; i < labels.length; i += 1) {
        const text = readLabelTextWithoutNestedControls(labels[i]);
        if (text) labelTexts.push(text);
      }
      if (labelTexts.length > 0) names.push(labelTexts.join(" "));
    }
    if (tag === "input") {
      const inputType = (element.getAttribute("type") ?? "text").toLowerCase();
      const inputValue =
        typeof (element as HTMLInputElement).value === "string"
          ? (element as HTMLInputElement).value
          : (element.getAttribute("value") ?? "");
      if (/^(submit|button|reset)$/.test(inputType) && inputValue) {
        names.push(collapseWs(inputValue));
      }
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

  let candidates: Element[];
  try {
    candidates = Array.from(
      root.querySelectorAll(
        'input, textarea, select, button, a, summary, [role], [aria-label], [aria-labelledby], [contenteditable="true"]',
      ),
    );
  } catch {
    return [];
  }

  const filtered = candidates.filter(
    (el) => !wantedRole || roleMatches(implicitRole(el), wantedRole),
  );

  const exact: Element[] = [];
  const partial: Element[] = [];
  for (const candidate of filtered) {
    const names = accessibleNames(candidate, root).map((n) => n.toLowerCase());
    if (names.some((n) => n === wantedLower)) {
      exact.push(candidate);
    } else if (names.some((n) => n.includes(wantedLower))) {
      partial.push(candidate);
    }
  }
  return [...exact, ...partial];
}

function isInteractiveControl(element: Element): boolean {
  if (typeof element.matches === "function") {
    try {
      return element.matches(
        'button, a, input, select, textarea, summary, label, option, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="radio"], [role="checkbox"]',
      );
    } catch {
      // Fallback below for minimal mocks.
    }
  }
  const tag = element.tagName.toLowerCase();
  if (
    tag === "button" ||
    tag === "a" ||
    tag === "input" ||
    tag === "select" ||
    tag === "textarea" ||
    tag === "summary" ||
    tag === "label" ||
    tag === "option"
  ) {
    return true;
  }
  const role = element.getAttribute("role")?.toLowerCase() ?? "";
  return (
    role === "button" ||
    role === "link" ||
    role === "menuitem" ||
    role === "tab" ||
    role === "radio" ||
    role === "checkbox"
  );
}

function resolveText(raw: string, root: ParentNode): Element[] {
  const wanted = collapseWs(raw);
  if (!wanted) return [];
  const wantedLower = wanted.toLowerCase();

  let submitInputs: Element[] = [];
  try {
    submitInputs = Array.from(
      root.querySelectorAll('input[type="submit"], input[type="button"], input[type="reset"]'),
    ).filter((el) => {
      const val = collapseWs(
        typeof (el as HTMLInputElement).value === "string"
          ? (el as HTMLInputElement).value
          : (el.getAttribute("value") ?? ""),
      );
      return val === wanted || val.toLowerCase() === wantedLower;
    });
  } catch {
    submitInputs = [];
  }

  let allNodes: Element[] = [];
  try {
    allNodes = Array.from(root.querySelectorAll("*"));
  } catch {
    allNodes = [];
  }

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
    const aChildren = Array.from(a.children ?? []);
    const bChildren = Array.from(b.children ?? []);
    const aHasChild = aChildren.some((c) => matchedSet.has(c)) ? 1 : 0;
    const bHasChild = bChildren.some((c) => matchedSet.has(c)) ? 1 : 0;
    return aHasChild - bHasChild;
  });

  return [...submitInputs, ...textMatched];
}

function resolveAll(locator: Locator, root: ParentNode): Element[] {
  if (locator.kind === "css") {
    try {
      return Array.from(root.querySelectorAll(locator.value));
    } catch {
      return [];
    }
  }
  if (locator.kind === "xpath") {
    const doc = getOwnerDocument(root);
    if (!doc || typeof doc.evaluate !== "function") return [];
    const snapshotType =
      typeof XPathResult !== "undefined" ? XPathResult.ORDERED_NODE_SNAPSHOT_TYPE : 7;
    try {
      const snapshot = doc.evaluate(locator.value, root as Node, null, snapshotType, null);
      const found: Element[] = [];
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const node = snapshot.snapshotItem(index);
        if (node && node.nodeType === 1) found.push(node as Element);
      }
      return found;
    } catch {
      return [];
    }
  }
  if (locator.kind === "testid") {
    try {
      return Array.from(root.querySelectorAll(`[data-testid="${escapeCssValue(locator.value)}"]`));
    } catch {
      return [];
    }
  }
  if (locator.kind === "aria") {
    return resolveAria(locator.value, root);
  }
  return resolveText(locator.value, root);
}

function resolveElement(locator: Locator, root: ParentNode): Element | null {
  const found = resolveAll(locator, root);
  return found.find(isElementVisible) ?? found[0] ?? null;
}

function lookupBinding(
  vars: Record<string, unknown>,
  path: string,
): { found: boolean; value: unknown } {
  if (Object.prototype.hasOwnProperty.call(vars, path) && vars[path] !== undefined) {
    return { found: true, value: vars[path] };
  }
  let current: unknown = vars;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return { found: false, value: undefined };
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, part)) {
      return { found: false, value: undefined };
    }
    current = record[part];
  }
  return { found: current !== undefined, value: current };
}

function collectMissingBindings(value: unknown, vars: Record<string, unknown>): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      const pattern = /\{\{\s*([^}]+?)\s*\}\}/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(node)) !== null) {
        const key = match[1];
        if (!seen.has(key) && !lookupBinding(vars, key).found) {
          seen.add(key);
          missing.push(key);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const isForEach = obj.action === "forEach";
      for (const [key, child] of Object.entries(obj)) {
        if (isForEach && key === "steps") continue;
        visit(child);
      }
    }
  };

  visit(value);
  return missing;
}

function substituteKnownBindings<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
    if (whole) {
      const lookedUp = lookupBinding(vars, whole[1]);
      return (lookedUp.found ? lookedUp.value : value) as T;
    }
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (raw, path: string) => {
      const lookedUp = lookupBinding(vars, path);
      return lookedUp.found ? String(lookedUp.value) : raw;
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteKnownBindings(item, vars)) as T;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const isForEach = obj.action === "forEach";
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      out[key] = isForEach && key === "steps" ? child : substituteKnownBindings(child, vars);
    }
    return out as T;
  }
  return value;
}

function readElementValue(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    const val = (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
    if (typeof val === "string") return val;
  }
  return (element.textContent ?? "").trim();
}

function formatLocator(locator: Locator): string {
  return `${locator.kind}: ${locator.value}`;
}

function previewStep(
  rawStep: Step,
  index: number,
  root: ParentNode | null,
  bindings: Record<string, BindingValue>,
  runtimeExtractedKeys: Set<string>,
): PreviewStepResult {
  const missingBindings = collectMissingBindings(rawStep, bindings);
  const step = substituteKnownBindings(rawStep, bindings);

  if (step.action === "navigate" || step.action === "wait" || step.action === "switchTab") {
    if (missingBindings.length > 0) {
      return {
        index,
        action: step.action,
        status: "missing",
        reason: `Missing binding: ${missingBindings.join(", ")}`,
      };
    }
    return {
      index,
      action: step.action,
      status: "skipped",
      reason: `Non-DOM step (${step.action}) skipped in preview`,
    };
  }

  if (step.action === "forEach") {
    if (missingBindings.length > 0) {
      return {
        index,
        action: "forEach",
        status: "missing",
        reason: `Missing binding: ${missingBindings.join(", ")}`,
      };
    }
    let loopItems: Record<string, string>[] | undefined;
    if (Array.isArray(step.items)) {
      loopItems = step.items;
    } else if (typeof step.items === "string") {
      const bound = lookupBinding(bindings, step.items);
      if (!bound.found || !Array.isArray(bound.value)) {
        return {
          index,
          action: "forEach",
          status: "missing",
          reason: `Missing binding: ${step.items}`,
        };
      }
      if (!runtimeExtractedKeys.has(step.items)) {
        loopItems = bound.value;
      }
    }

    if (loopItems && loopItems.length > 0) {
      const sampleScope = { ...bindings, ...loopItems[0] } as Record<string, BindingValue>;
      for (let nestedIdx = 0; nestedIdx < step.steps.length; nestedIdx += 1) {
        const nestedResult = previewStep(
          step.steps[nestedIdx],
          nestedIdx,
          root,
          sampleScope,
          runtimeExtractedKeys,
        );
        if (nestedResult.status === "missing") {
          return {
            index,
            action: "forEach",
            status: "missing",
            reason: `Nested step ${nestedIdx} (${nestedResult.action}): ${nestedResult.reason ?? "missing"}`,
          };
        }
      }
    }

    return {
      index,
      action: "forEach",
      status: "skipped",
      reason: "Loop step (forEach) skipped in preview",
    };
  }

  const domStep = step as DomStep;
  const targetLocator = "target" in domStep ? domStep.target : undefined;

  let resolvedEl: Element | null = null;
  let targetMissing = false;

  if (targetLocator) {
    if (!root) {
      targetMissing = true;
    } else if (domStep.action === "extractList") {
      targetMissing = resolveAll(targetLocator, root).length === 0;
    } else {
      resolvedEl = resolveElement(targetLocator, root);
      targetMissing = resolvedEl === null;
    }
  }

  if (missingBindings.length > 0 && targetMissing && targetLocator) {
    return {
      index,
      action: domStep.action,
      status: "missing",
      reason: `Missing binding (${missingBindings.join(", ")}) and target not found (${formatLocator(targetLocator)})`,
    };
  }
  if (missingBindings.length > 0) {
    return {
      index,
      action: domStep.action,
      status: "missing",
      reason: `Missing binding: ${missingBindings.join(", ")}`,
    };
  }
  if (targetMissing && targetLocator) {
    return {
      index,
      action: domStep.action,
      status: "missing",
      reason: `Target not found (${formatLocator(targetLocator)})`,
    };
  }

  if (domStep.action === "click" && resolvedEl && isSubmitElement(resolvedEl)) {
    return {
      index,
      action: "click",
      status: "skipped",
      reason: "Submit click skipped in dry-run preview",
    };
  }

  if (domStep.action === "readText" && resolvedEl) {
    bindings[domStep.bind] = (resolvedEl.textContent ?? "").trim();
    runtimeExtractedKeys.add(domStep.bind);
  } else if (domStep.action === "readValue" && resolvedEl) {
    bindings[domStep.bind] = readElementValue(resolvedEl);
    runtimeExtractedKeys.add(domStep.bind);
  } else if (domStep.action === "extractList") {
    bindings[domStep.bind] = [];
    runtimeExtractedKeys.add(domStep.bind);
  }

  return {
    index,
    action: domStep.action,
    status: "found",
  };
}

export function previewRun(
  script: ActionScript,
  opts?: { root?: ParentNode; bindings?: Record<string, BindingValue> },
): PreviewResult {
  const root: ParentNode | null =
    opts?.root ?? (typeof document !== "undefined" ? document : null);
  const bindings: Record<string, BindingValue> = { ...(opts?.bindings ?? {}) };
  const runtimeExtractedKeys = new Set<string>();

  const steps: PreviewStepResult[] = script.steps.map((step, index) =>
    previewStep(step, index, root, bindings, runtimeExtractedKeys),
  );

  const total = steps.length;
  const found = steps.filter((s) => s.status === "found").length;
  const firstMissing = steps.find((s) => s.status === "missing");
  const ready = firstMissing === undefined;
  const summary = ready
    ? `ready: ${found} of ${total} steps found`
    : `not ready: step ${firstMissing.index} (${firstMissing.action}) — ${firstMissing.reason ?? "missing"}`;

  return {
    ready,
    found,
    total,
    summary,
    steps,
  };
}
