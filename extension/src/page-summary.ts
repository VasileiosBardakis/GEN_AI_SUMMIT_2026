import type { Locator } from "@gen/shared";
import { extractTarget } from "./locators.ts";
import { sanitizeValue } from "./privacy.ts";

export const PAGE_SUMMARY_MAX_BYTES = 4096;

export interface PageSummarySourceCell {
  text: string;
  locators: Locator[];
}

export interface PageSummarySourceRow {
  locators: Locator[];
  cells: PageSummarySourceCell[];
}

export interface PageSummarySource {
  containerLocators?: Locator[];
  rowTag: string;
  rows: PageSummarySourceRow[];
}

export interface PageSummaryControl {
  tag: string;
  type?: string;
  name?: string;
  label?: string;
  locators: Locator[];
}

export interface PageSummaryTarget {
  containerTag: string;
  containerLocators?: Locator[];
  emptyControls: PageSummaryControl[];
  submitLocators: Locator[];
}

export interface PageSummary {
  source?: PageSummarySource;
  target?: PageSummaryTarget;
}

const ROW_TAGS = new Set(["tr", "li"]);
const CELL_TAGS = new Set(["td", "th"]);
const CELL_ROLES = new Set(["gridcell", "cell", "columnheader", "rowheader"]);
const CONTROL_TAGS = new Set(["input", "select", "textarea"]);
const IGNORED_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
const CONTAINER_TAGS = new Set(["form", "fieldset", "section"]);
const TABLE_OR_LIST_CONTAINER_TAGS = new Set(["tbody", "table", "ul", "ol"]);
const TABLE_OR_LIST_ROLES = new Set(["table", "grid", "rowgroup", "list"]);

function collapseWs(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  return value.length * 2;
}

function isElementLike(node: unknown): node is HTMLElement {
  if (!node || typeof node !== "object") return false;
  const candidate = node as { tagName?: unknown; nodeType?: unknown };
  return typeof candidate.tagName === "string" && (candidate.nodeType === undefined || candidate.nodeType === 1);
}

function tagOf(el: HTMLElement): string {
  return (el.tagName || "").toLowerCase();
}

function attrOf(el: HTMLElement, name: string): string | null {
  if (typeof el.getAttribute === "function") {
    return el.getAttribute(name);
  }
  return null;
}

function childrenOf(node: ParentNode | HTMLElement | null | undefined): HTMLElement[] {
  if (!node) return [];
  if ("children" in node && node.children) {
    return Array.from(node.children as ArrayLike<unknown>).filter(isElementLike);
  }
  if ("documentElement" in node && isElementLike((node as Document).documentElement)) {
    return [(node as Document).documentElement];
  }
  return [];
}

function collectDescendants(root: ParentNode | HTMLElement, predicate: (el: HTMLElement) => boolean): HTMLElement[] {
  const result: HTMLElement[] = [];
  const visit = (node: ParentNode | HTMLElement): void => {
    for (const child of childrenOf(node)) {
      if (predicate(child)) {
        result.push(child);
      }
      visit(child);
    }
  };
  visit(root);
  return result;
}

function findClosest(
  el: HTMLElement | null,
  predicate: (candidate: HTMLElement) => boolean
): HTMLElement | null {
  let curr: HTMLElement | null = el;
  while (curr && isElementLike(curr)) {
    if (predicate(curr)) return curr;
    curr = (curr.parentElement as HTMLElement | null) ?? null;
  }
  return null;
}

function isRowElement(el: HTMLElement): boolean {
  const tag = tagOf(el);
  if (ROW_TAGS.has(tag)) return true;
  const role = (attrOf(el, "role") || "").toLowerCase();
  return role === "row" || role === "listitem";
}

function isSameRowGroup(candidate: HTMLElement, referenceRow: HTMLElement): boolean {
  const refTag = tagOf(referenceRow);
  const refRole = (attrOf(referenceRow, "role") || "").toLowerCase();
  const candTag = tagOf(candidate);
  const candRole = (attrOf(candidate, "role") || "").toLowerCase();
  if (refTag === "tr" || refRole === "row") {
    return candTag === "tr" || candRole === "row";
  }
  if (refTag === "li" || refRole === "listitem") {
    return candTag === "li" || candRole === "listitem";
  }
  return false;
}

function isCellElement(el: HTMLElement): boolean {
  const tag = tagOf(el);
  if (CELL_TAGS.has(tag)) return true;
  const role = (attrOf(el, "role") || "").toLowerCase();
  return CELL_ROLES.has(role);
}

function stripTagFragments(text: string): string {
  return collapseWs(text.replace(/<[^>]*>/g, " "));
}

function readNonButtonOwnText(el: HTMLElement): string {
  const tag = tagOf(el);
  if (tag === "button") return "";
  const hasButtonDescendant = collectDescendants(el, (c) => tagOf(c) === "button").length > 0;
  if (!hasButtonDescendant) {
    return (el as { innerText?: string }).innerText || el.textContent || "";
  }
  const cloneFn = (el as unknown as { cloneNode?: (deep?: boolean) => HTMLElement }).cloneNode;
  if (typeof cloneFn === "function") {
    const clone = cloneFn.call(el, true);
    if (typeof (clone as { querySelectorAll?: unknown }).querySelectorAll === "function") {
      for (const btn of Array.from(clone.querySelectorAll("button"))) {
        btn.remove();
      }
      const clonedText = (clone as { innerText?: string }).innerText || clone.textContent || "";
      if (clonedText.trim().length > 0) return clonedText;
    }
  }
  const parts: string[] = [];
  for (const child of childrenOf(el)) {
    if (tagOf(child) === "button") continue;
    const t = readNonButtonOwnText(child).trim();
    if (t) parts.push(t);
  }
  if (parts.length > 0) return parts.join(" ");
  return (el as { innerText?: string }).innerText || el.textContent || "";
}

function readSafeText(el: HTMLElement): string {
  const tag = tagOf(el);
  if (tag === "input") {
    const inputType = (attrOf(el, "type") || "text").toLowerCase();
    if (inputType === "password") {
      return "[REDACTED:PASSWORD]";
    }
    const val = (el as unknown as { value?: string }).value;
    if (typeof val === "string" && val.length > 0) {
      return stripTagFragments(val);
    }
  }
  if (tag === "textarea" || tag === "select") {
    const val = (el as unknown as { value?: string }).value;
    if (typeof val === "string" && val.length > 0) {
      return stripTagFragments(val);
    }
  }
  const raw = readNonButtonOwnText(el);
  return stripTagFragments(raw);
}

function scrubCellText(rawText: string, maxChars = 160): string {
  const { value } = sanitizeValue(rawText);
  const cleaned = stripTagFragments(value ?? "");
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function dedupeLocators(locators: Locator[]): Locator[] {
  const seen = new Set<string>();
  const out: Locator[] = [];
  for (const loc of locators) {
    const key = `${loc.kind}:${loc.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(loc);
    }
  }
  return out;
}

function sanitizeLocators(locators: Locator[]): Locator[] {
  const out: Locator[] = [];
  for (const loc of locators) {
    if (loc.kind === "aria" || loc.kind === "text") {
      const { privacy } = sanitizeValue(loc.value);
      if (privacy.redacted) {
        continue;
      }
      const cleaned = loc.value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (!cleaned) continue;
      out.push({ kind: loc.kind, value: cleaned });
    } else {
      out.push(loc);
    }
  }
  return out;
}

function escapeCssAttrLocal(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeCssIdentLocal(val: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(val);
  }
  return val.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~ ])/g, "\\$1");
}

function getElementLocators(el: HTMLElement): Locator[] {
  const { target } = extractTarget(el);
  if (target?.locators && target.locators.length > 0) {
    const sanitized = sanitizeLocators(target.locators);
    if (sanitized.length > 0) return sanitized;
  }
  const locators: Locator[] = [];
  for (const attr of ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"]) {
    const val = attrOf(el, attr);
    if (val) {
      locators.push({ kind: "testid", value: val });
      break;
    }
  }
  const ariaLabel = attrOf(el, "aria-label")?.trim();
  const role = attrOf(el, "role")?.trim();
  if (role && ariaLabel) {
    locators.push({ kind: "aria", value: `${role}[name="${escapeCssAttrLocal(ariaLabel)}"]` });
  } else if (ariaLabel) {
    locators.push({ kind: "aria", value: `[aria-label="${escapeCssAttrLocal(ariaLabel)}"]` });
  }
  const id = (el as { id?: string }).id || attrOf(el, "id");
  const name = attrOf(el, "name");
  const tag = tagOf(el) || "div";
  if (id) {
    locators.push({ kind: "css", value: `#${escapeCssIdentLocal(id)}` });
  } else if (name) {
    locators.push({ kind: "css", value: `${tag}[name="${escapeCssAttrLocal(name)}"]` });
  } else if (el.parentElement) {
    const siblings = childrenOf(el.parentElement).filter((s) => tagOf(s) === tag);
    const idx = siblings.indexOf(el);
    locators.push({
      kind: "css",
      value: siblings.length > 1 && idx >= 0 ? `${tag}:nth-of-type(${idx + 1})` : tag,
    });
  } else if (locators.length === 0) {
    locators.push({ kind: "css", value: tag });
  }
  return locators;
}

function getCellLocators(cell: HTMLElement): Locator[] {
  const base = getElementLocators(cell);
  if (base.some((loc) => loc.kind === "testid")) {
    return base;
  }
  const testIdChild = collectDescendants(cell, (child) => {
    const t = tagOf(child);
    if (t === "button") return false;
    return Boolean(
      attrOf(child, "data-testid") ||
        attrOf(child, "data-test-id") ||
        attrOf(child, "data-test")
    );
  })[0];
  if (!testIdChild) return base;
  const childLocs = getElementLocators(testIdChild).filter((loc) => loc.kind === "testid");
  return dedupeLocators([...childLocs, ...base]);
}

function getElementLabel(el: HTMLElement): string | undefined {
  const { target } = extractTarget(el);
  const raw =
    target?.label ||
    attrOf(el, "aria-label")?.trim() ||
    attrOf(el, "placeholder")?.trim() ||
    attrOf(el, "title")?.trim() ||
    attrOf(el, "name")?.trim();
  if (!raw) return undefined;
  return scrubCellText(raw, 80) || undefined;
}

function isTableOrListContainer(el: HTMLElement): boolean {
  const tag = tagOf(el);
  if (TABLE_OR_LIST_CONTAINER_TAGS.has(tag)) return true;
  const role = (attrOf(el, "role") || "").toLowerCase();
  return TABLE_OR_LIST_ROLES.has(role);
}

function fitSourceToBudget(summary: PageSummarySource, currentRowIdx: number): PageSummarySource {
  let candidate: PageSummarySource = summary;
  if (utf8ByteLength(JSON.stringify(candidate)) <= PAGE_SUMMARY_MAX_BYTES) {
    return candidate;
  }

  const keptContainer =
    summary.containerLocators && summary.containerLocators.length > 0
      ? { containerLocators: summary.containerLocators.slice(0, 1) }
      : {};

  for (const maxText of [80, 40, 20, 10]) {
    candidate = {
      ...keptContainer,
      rowTag: summary.rowTag,
      rows: summary.rows.map((row) => ({
        locators: row.locators.slice(0, 2),
        cells: row.cells.map((cell) => ({
          text:
            cell.text.length > maxText
              ? `${cell.text.slice(0, Math.max(0, maxText - 3)).trimEnd()}...`
              : cell.text,
          locators: cell.locators.slice(0, 2),
        })),
      })),
    };
    if (utf8ByteLength(JSON.stringify(candidate)) <= PAGE_SUMMARY_MAX_BYTES) {
      return candidate;
    }
  }

  candidate = {
    ...keptContainer,
    rowTag: candidate.rowTag,
    rows: candidate.rows.map((row) => ({
      locators: row.locators.slice(0, 1),
      cells: row.cells.map((cell) => ({
        text: cell.text,
        locators: cell.locators.slice(0, 1),
      })),
    })),
  };
  if (utf8ByteLength(JSON.stringify(candidate)) <= PAGE_SUMMARY_MAX_BYTES) {
    return candidate;
  }

  candidate = {
    rowTag: candidate.rowTag,
    rows: candidate.rows,
  };
  if (utf8ByteLength(JSON.stringify(candidate)) <= PAGE_SUMMARY_MAX_BYTES) {
    return candidate;
  }

  // Keep rows closest to currentRowIdx while staying under 4096 bytes
  const orderedIndices: number[] = [];
  const total = candidate.rows.length;
  const anchor = Math.max(0, Math.min(currentRowIdx, total - 1));
  orderedIndices.push(anchor);
  for (let offset = 1; offset < total; offset++) {
    if (anchor + offset < total) orderedIndices.push(anchor + offset);
    if (anchor - offset >= 0) orderedIndices.push(anchor - offset);
  }

  const kept: number[] = [];
  for (const idx of orderedIndices) {
    const nextKept = [...kept, idx].sort((a, b) => a - b);
    const attempt: PageSummarySource = {
      rowTag: candidate.rowTag,
      rows: nextKept.map((i) => candidate.rows[i]),
    };
    if (utf8ByteLength(JSON.stringify(attempt)) <= PAGE_SUMMARY_MAX_BYTES) {
      kept.splice(0, kept.length, ...nextKept);
    } else if (kept.length > 0) {
      break;
    }
  }

  if (kept.length > 0) {
    return {
      rowTag: candidate.rowTag,
      rows: kept.map((i) => candidate.rows[i]),
    };
  }

  // Absolute fallback: 1 row with truncated first cell
  const fallbackRow = candidate.rows[anchor];
  return {
    rowTag: candidate.rowTag,
    rows: fallbackRow
      ? [
          {
            locators: fallbackRow.locators.slice(0, 1),
            cells: fallbackRow.cells.slice(0, 2).map((c) => ({
              text: c.text.slice(0, 16),
              locators: c.locators.slice(0, 1),
            })),
          },
        ]
      : [],
  };
}

export function captureSourceSummary(
  el: HTMLElement | null,
  root?: ParentNode | null
): PageSummarySource | undefined {
  if (!el || !isElementLike(el)) return undefined;

  const currentRow = findClosest(el, isRowElement);
  if (!currentRow) return undefined;

  const container =
    (currentRow.parentElement as HTMLElement | null) ??
    findClosest(currentRow.parentElement as HTMLElement | null, isTableOrListContainer);

  let siblingRows: HTMLElement[] = [];
  if (container) {
    siblingRows = childrenOf(container).filter((child) => isSameRowGroup(child, currentRow));
  }
  if (siblingRows.length === 0 && root) {
    siblingRows = collectDescendants(root, (child) => isSameRowGroup(child, currentRow));
  }
  if (siblingRows.length === 0) {
    siblingRows = [currentRow];
  }

  const rows: PageSummarySourceRow[] = siblingRows.map((row) => {
    const rowLocators = getElementLocators(row);
    const rawCells = collectDescendants(row, isCellElement);
    const cells: PageSummarySourceCell[] =
      rawCells.length > 0
        ? rawCells.map((cell) => ({
            text: scrubCellText(readSafeText(cell)),
            locators: getCellLocators(cell),
          }))
        : [
            {
              text: scrubCellText(readSafeText(row)),
              locators: rowLocators,
            },
          ];

    return {
      locators: rowLocators,
      cells,
    };
  });

  const currentRowIdx = Math.max(0, siblingRows.indexOf(currentRow));
  const containerEl =
    container && isElementLike(container)
      ? container
      : root && isElementLike(root)
        ? root
        : null;

  const summary: PageSummarySource = {
    ...(containerEl ? { containerLocators: getElementLocators(containerEl).slice(0, 2) } : {}),
    rowTag: tagOf(currentRow) || "tr",
    rows,
  };

  return fitSourceToBudget(summary, currentRowIdx);
}

function isEmptyControl(el: HTMLElement): boolean {
  const tag = tagOf(el);
  if (tag === "input") {
    const inputType = (attrOf(el, "type") || "text").toLowerCase();
    if (IGNORED_INPUT_TYPES.has(inputType)) return false;
    if ((el as { disabled?: boolean }).disabled) return false;
    if (inputType === "checkbox" || inputType === "radio") {
      const checkedProp = (el as { checked?: boolean }).checked;
      if (typeof checkedProp === "boolean") return !checkedProp;
      return attrOf(el, "checked") === null;
    }
    const rawVal = (el as { value?: string }).value ?? attrOf(el, "value") ?? "";
    return String(rawVal).trim().length === 0;
  }

  if (tag === "textarea") {
    if ((el as { disabled?: boolean }).disabled) return false;
    const rawVal = (el as { value?: string }).value ?? el.textContent ?? "";
    return String(rawVal).trim().length === 0;
  }

  if (tag === "select") {
    if ((el as { disabled?: boolean }).disabled) return false;
    const rawVal = (el as { value?: string }).value ?? "";
    return String(rawVal).trim().length === 0;
  }

  return false;
}

function isExplicitSubmitControl(el: HTMLElement): boolean {
  const tag = tagOf(el);
  const typeAttr = (attrOf(el, "type") || "").toLowerCase();
  if (tag === "input") {
    return typeAttr === "submit";
  }
  if (tag === "button") {
    return typeAttr === "" || typeAttr === "submit";
  }
  return false;
}

function isFallbackActionButton(el: HTMLElement): boolean {
  const tag = tagOf(el);
  const typeAttr = (attrOf(el, "type") || "").toLowerCase();
  const role = (attrOf(el, "role") || "").toLowerCase();
  if (tag === "button") {
    return typeAttr !== "reset";
  }
  if (role === "button") {
    return true;
  }
  return false;
}

function findTargetContainer(el: HTMLElement, root?: ParentNode | null): HTMLElement | ParentNode | null {
  const formOrNamed = findClosest(el, (cand) => {
    const tag = tagOf(cand);
    const role = (attrOf(cand, "role") || "").toLowerCase();
    return CONTAINER_TAGS.has(tag) || role === "form" || role === "dialog";
  });
  if (formOrNamed) return formOrNamed;

  let curr = el.parentElement as HTMLElement | null;
  while (curr && isElementLike(curr)) {
    const tag = tagOf(curr);
    if (tag === "body" || tag === "html") break;
    const controls = collectDescendants(curr, (c) => CONTROL_TAGS.has(tagOf(c)));
    const buttons = collectDescendants(curr, (c) => tagOf(c) === "button" || attrOf(c, "role") === "button");
    if (controls.length >= 2 || (controls.length >= 1 && buttons.length >= 1)) {
      return curr;
    }
    curr = curr.parentElement as HTMLElement | null;
  }

  if (root) return root;
  return (el.parentElement as HTMLElement | null) ?? null;
}

function fitTargetToBudget(summary: PageSummaryTarget): PageSummaryTarget {
  let candidate: PageSummaryTarget = summary;
  if (utf8ByteLength(JSON.stringify(candidate)) <= PAGE_SUMMARY_MAX_BYTES) {
    return candidate;
  }

  candidate = {
    containerTag: candidate.containerTag,
    emptyControls: candidate.emptyControls,
    submitLocators: candidate.submitLocators,
  };
  if (utf8ByteLength(JSON.stringify(candidate)) <= PAGE_SUMMARY_MAX_BYTES) {
    return candidate;
  }

  candidate = {
    containerTag: candidate.containerTag,
    emptyControls: candidate.emptyControls.map((ctrl) => ({
      ...ctrl,
      ...(ctrl.label ? { label: ctrl.label.slice(0, 40) } : {}),
      locators: ctrl.locators.slice(0, 2),
    })),
    submitLocators: candidate.submitLocators.slice(0, 4),
  };
  if (utf8ByteLength(JSON.stringify(candidate)) <= PAGE_SUMMARY_MAX_BYTES) {
    return candidate;
  }

  candidate = {
    containerTag: candidate.containerTag,
    emptyControls: candidate.emptyControls.map((ctrl) => ({
      tag: ctrl.tag,
      ...(ctrl.type ? { type: ctrl.type } : {}),
      ...(ctrl.name ? { name: ctrl.name } : {}),
      locators: ctrl.locators.slice(0, 1),
    })),
    submitLocators: candidate.submitLocators.slice(0, 2),
  };
  while (
    candidate.emptyControls.length > 0 &&
    utf8ByteLength(JSON.stringify(candidate)) > PAGE_SUMMARY_MAX_BYTES
  ) {
    candidate = {
      ...candidate,
      emptyControls: candidate.emptyControls.slice(0, -1),
    };
  }
  return candidate;
}

export function captureTargetSummary(
  el: HTMLElement | null,
  root?: ParentNode | null
): PageSummaryTarget | undefined {
  if (!el || !isElementLike(el)) return undefined;

  const container = findTargetContainer(el, root);
  if (!container) return undefined;

  const controls = collectDescendants(container, (cand) => CONTROL_TAGS.has(tagOf(cand)));
  const emptyControls: PageSummaryControl[] = controls
    .filter(isEmptyControl)
    .map((ctrl) => {
      const tag = tagOf(ctrl);
      const type = tag === "input" ? (attrOf(ctrl, "type") || "text").toLowerCase() : undefined;
      const name = attrOf(ctrl, "name")?.trim() || undefined;
      const label = getElementLabel(ctrl);
      return {
        tag,
        ...(type ? { type } : {}),
        ...(name ? { name } : {}),
        ...(label ? { label } : {}),
        locators: getElementLocators(ctrl),
      };
    });

  const explicitSubmits = collectDescendants(container, isExplicitSubmitControl);
  const submitEls =
    explicitSubmits.length > 0
      ? explicitSubmits
      : collectDescendants(container, isFallbackActionButton);
  const submitLocators = dedupeLocators(submitEls.flatMap((btn) => getElementLocators(btn)));

  if (emptyControls.length === 0 && submitLocators.length === 0) {
    return undefined;
  }

  const containerEl = isElementLike(container) ? container : null;
  const summary: PageSummaryTarget = {
    containerTag: containerEl ? tagOf(containerEl) || "div" : "root",
    ...(containerEl ? { containerLocators: getElementLocators(containerEl).slice(0, 2) } : {}),
    emptyControls,
    submitLocators,
  };

  return fitTargetToBudget(summary);
}
