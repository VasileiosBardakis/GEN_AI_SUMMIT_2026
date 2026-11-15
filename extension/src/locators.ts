import type { EventMeta, Locator } from "@gen/shared";

const TEST_ID_ATTRS = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"];

const TAG_ROLES: Record<string, string> = {
  button: "button",
  a: "link",
  select: "combobox",
  textarea: "textbox",
  td: "gridcell",
};

const INPUT_TYPE_ROLES: Record<string, string> = {
  checkbox: "checkbox",
  radio: "radio",
  search: "searchbox",
  button: "button",
  submit: "button",
  reset: "button",
};

const TEXT_LOCATOR_ROLES = new Set(["button", "link", "menuitem", "tab", "option", "treeitem"]);

function cssEscapeIdent(val: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(val);
  }
  return val.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~ ])/g, "\\$1");
}

function escapeCssAttr(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function cleanLabelText(labelEl: HTMLElement): string {
  const clone = labelEl.cloneNode(true) as HTMLElement;
  for (const nested of Array.from(
    clone.querySelectorAll("input, select, textarea, button, datalist, script, style")
  )) {
    nested.remove();
  }
  return (clone.textContent || "").replace(/\s+/g, " ").trim();
}

function getReadableLabel(el: HTMLElement): string | undefined {
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy && typeof document !== "undefined") {
    const labelText = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() || "")
      .filter(Boolean)
      .join(" ");
    if (labelText) return labelText;
  }

  if (
    (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement) ||
    (typeof HTMLSelectElement !== "undefined" && el instanceof HTMLSelectElement)
  ) {
    if (el.labels && el.labels.length > 0) {
      const text = Array.from(el.labels)
        .map((l) => cleanLabelText(l))
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    if (
      typeof HTMLInputElement !== "undefined" &&
      el instanceof HTMLInputElement &&
      /^(submit|button|reset)$/i.test(el.getAttribute("type") || "") &&
      el.value.trim()
    ) {
      return el.value.trim();
    }
    const placeholder = el.getAttribute("placeholder")?.trim();
    if (placeholder) return placeholder;
  }

  const title = el.getAttribute("title")?.trim();
  if (title) return title;

  if (typeof HTMLSelectElement === "undefined" || !(el instanceof HTMLSelectElement)) {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (text && text.length <= 80) return text;
  }

  return undefined;
}

function getStableHrefAttr(el: HTMLElement): string | null {
  if (el.tagName.toLowerCase() !== "a") return null;
  const href = el.getAttribute("href")?.trim();
  if (!href || href === "#" || /^javascript:/i.test(href) || href.length > 160) return null;
  if (/[0-9a-f]{8,}/i.test(href)) return null;
  return href;
}

function isUniqueCssSelector(selector: string): boolean {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
    return true;
  }
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function buildCssSelector(el: HTMLElement): { selector: string; unique: boolean } {
  const tag = el.tagName.toLowerCase();
  if (el.id && !/^\d/.test(el.id) && !/[0-9a-f]{8,}/i.test(el.id)) {
    const idSel = `#${cssEscapeIdent(el.id)}`;
    if (isUniqueCssSelector(idSel)) {
      return { selector: idSel, unique: true };
    }
    const tagIdSel = `${tag}${idSel}`;
    if (isUniqueCssSelector(tagIdSel)) {
      return { selector: tagIdSel, unique: true };
    }
  }

  const name = el.getAttribute("name");
  if (name) {
    const nameSel = `${tag}[name="${escapeCssAttr(name)}"]`;
    if (isUniqueCssSelector(nameSel)) {
      return { selector: nameSel, unique: true };
    }
  }

  const dataCell = el.getAttribute("data-cell");
  if (dataCell) {
    const cellSel = `${tag}[data-cell="${escapeCssAttr(dataCell)}"]`;
    if (isUniqueCssSelector(cellSel)) {
      return { selector: cellSel, unique: true };
    }
  }

  const stableHref = getStableHrefAttr(el);
  if (stableHref) {
    const hrefSel = `a[href="${escapeCssAttr(stableHref)}"]`;
    if (isUniqueCssSelector(hrefSel)) {
      return { selector: hrefSel, unique: true };
    }
  }

  const parts: string[] = [];
  let curr: HTMLElement | null = el;
  let depth = 0;
  const startedInsideRow =
    typeof el.closest === "function" &&
    Boolean(el.closest('tr, li, [role="row"], [role="listitem"]'));
  let passedRowBoundary = !startedInsideRow;

  while (curr && curr.nodeType === 1 && depth < 10) {
    const cTag = curr.tagName.toLowerCase();
    const cRole = (curr.getAttribute("role") || "").toLowerCase();
    if (cTag === "tr" || cTag === "li" || cRole === "row" || cRole === "listitem") {
      passedRowBoundary = true;
    }
    if (curr.id && !/^\d/.test(curr.id) && !/[0-9a-f]{8,}/i.test(curr.id)) {
      const ancId = `#${cssEscapeIdent(curr.id)}`;
      if (isUniqueCssSelector(ancId)) {
        parts.unshift(ancId);
        const path = parts.join(" > ");
        if (isUniqueCssSelector(path)) {
          return { selector: path, unique: true };
        }
        break;
      }
    }
    let part = cTag;
    const classes = Array.from(curr.classList)
      .filter(
        (c) =>
          c &&
          !/^(js-|css-|sc-)|(?:^|[-_])(active|focus|focused|hover|selected|open)(?:$|[-_])/i.test(c) &&
          c.length < 32
      )
      .slice(0, 2);
    if (classes.length > 0) {
      part += "." + classes.map(cssEscapeIdent).join(".");
    }
    const currHref = depth === 0 ? getStableHrefAttr(curr) : null;
    if (currHref) {
      part += `[href="${escapeCssAttr(currHref)}"]`;
      if (isUniqueCssSelector(part)) {
        return { selector: part, unique: true };
      }
    }
    if (curr.parentElement) {
      const siblings = Array.from(curr.parentElement.children).filter(
        (s) => s.tagName === curr!.tagName
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(curr) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    const candidate = parts.join(" > ");
    if (depth >= 1 && passedRowBoundary && isUniqueCssSelector(candidate)) {
      return { selector: candidate, unique: true };
    }
    if (cTag === "body" || cTag === "html") break;
    curr = curr.parentElement;
    depth++;
  }

  const finalPath = parts.join(" > ");
  return { selector: finalPath, unique: isUniqueCssSelector(finalPath) };
}

export function extractTarget(rawEl: EventTarget | null): {
  element: HTMLElement | null;
  target?: {
    locators: Locator[];
    tag?: string;
    label?: string;
    role?: string;
  };
} {
  const el =
    typeof HTMLElement !== "undefined" && rawEl instanceof HTMLElement
      ? rawEl
      : typeof Node !== "undefined" && rawEl instanceof Node
        ? rawEl.parentElement
        : null;
  if (!el || (typeof HTMLElement !== "undefined" && !(el instanceof HTMLElement))) {
    return { element: null, target: undefined };
  }

  const interactive =
    el.closest<HTMLElement>(
      'button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"], [role="gridcell"], [role="textbox"], [role="searchbox"], [role="combobox"], [data-testid], [data-cell], td, th, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    ) || el;

  const locators: Locator[] = [];
  const tag = interactive.tagName.toLowerCase();
  const inputType = (interactive.getAttribute("type") || "text").toLowerCase();
  const role =
    interactive.getAttribute("role") ||
    (tag === "input"
      ? (INPUT_TYPE_ROLES[inputType] ?? "textbox")
      : (TAG_ROLES[tag] ?? (interactive.isContentEditable ? "textbox" : undefined)));

  for (const attr of TEST_ID_ATTRS) {
    const val = interactive.getAttribute(attr);
    if (val) {
      locators.push({ kind: "testid", value: val });
      break;
    }
  }

  const label = getReadableLabel(interactive);
  if (role && label && label.length <= 60) {
    locators.push({ kind: "aria", value: `${role}[name="${escapeCssAttr(label)}"]` });
  } else if (interactive.getAttribute("aria-label")) {
    locators.push({
      kind: "aria",
      value: `[aria-label="${escapeCssAttr(interactive.getAttribute("aria-label")!)}"]`,
    });
  }

  const cssRes = buildCssSelector(interactive);
  if (cssRes.unique || locators.length === 0) {
    locators.push({ kind: "css", value: cssRes.selector });
  }

  const innerText = (interactive.innerText || interactive.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  if (innerText && innerText.length <= 50 && role && TEXT_LOCATOR_ROLES.has(role)) {
    locators.push({ kind: "text", value: innerText });
  }

  return {
    element: interactive,
    target: {
      locators,
      tag,
      label,
      role,
    },
  };
}

function colIndexToLetter(colIdx1Based: number): string {
  let n = colIdx1Based;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters || "A";
}

export function extractGridContext(
  el: HTMLElement | null,
  currentValue?: string
): EventMeta["grid"] | undefined {
  if (!el || typeof document === "undefined") return undefined;

  const cellEl = el.closest<HTMLElement>('[data-cell], [role="gridcell"], td, th');
  let cellRef =
    cellEl?.getAttribute("data-cell") || el.getAttribute("data-cell") || undefined;
  let rowIndex: number | undefined;
  let colIndex: number | undefined;

  if (cellEl) {
    const rAttr =
      cellEl.getAttribute("data-row") ||
      cellEl.getAttribute("aria-rowindex") ||
      cellEl.parentElement?.getAttribute("aria-rowindex");
    const cAttr = cellEl.getAttribute("data-col") || cellEl.getAttribute("aria-colindex");

    if (rAttr) rowIndex = parseInt(rAttr, 10);
    if (cAttr) colIndex = parseInt(cAttr, 10);

    if (cellEl instanceof HTMLTableCellElement) {
      if (colIndex === undefined) colIndex = cellEl.cellIndex + 1;
      const tr = cellEl.parentElement;
      if (rowIndex === undefined && tr instanceof HTMLTableRowElement) {
        rowIndex = tr.rowIndex + 1;
      }
    }

    if (!cellRef && rowIndex !== undefined && colIndex !== undefined) {
      cellRef = `${colIndexToLetter(colIndex)}${rowIndex}`;
    }
  }

  const isGridSurface = Boolean(
    cellEl ||
      el.closest(
        '[role="grid"], table, canvas, #waffle-grid-container, .grid-scrollable-wrapper, .grid-container, [class*="cell-input"]'
      )
  );

  if (!cellRef && isGridSurface) {
    const nameBox = document.querySelector<HTMLInputElement>(
      '#t-name-box, input.waffle-name-box, input[aria-label*="Name box" i], input[data-testid="name-box"]'
    );
    if (
      nameBox?.value &&
      /^[A-Z]{1,3}\d{1,6}(:[A-Z]{1,3}\d{1,6})?$/i.test(nameBox.value.trim())
    ) {
      cellRef = nameBox.value.trim().toUpperCase();
    }
  }

  if (!cellRef && rowIndex === undefined && colIndex === undefined) {
    return undefined;
  }

  const sheetTab = document.querySelector<HTMLElement>(
    '.docs-sheet-active-tab .docs-sheet-tab-name, [role="tab"][aria-selected="true"], [data-testid="active-sheet-tab"]'
  );
  const sheetName = sheetTab?.textContent?.trim() || undefined;

  const val = currentValue?.trim() || "";
  const isFormula = val.startsWith("=");
  const formulaMatch = isFormula ? val.match(/^=\s*([A-Z0-9_]+)\s*\(/i) : null;
  const formulaFunc = formulaMatch ? formulaMatch[1].toUpperCase() : undefined;

  return {
    cellRef,
    rowIndex,
    colIndex,
    sheetName,
    isFormula: isFormula || undefined,
    formulaFunc,
  };
}

export function extractMenuContext(el: HTMLElement | null): EventMeta["menu"] | undefined {
  if (!el) return undefined;
  const menuItem = el.closest<HTMLElement>(
    '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [data-menu-item], .goog-menuitem, .context-menu-item'
  );
  if (!menuItem) return undefined;

  const explicitShortcut =
    menuItem.getAttribute("data-shortcut") ||
    menuItem.getAttribute("aria-keyshortcuts") ||
    menuItem
      .querySelector<HTMLElement>(".goog-menuitem-accel, .shortcut, kbd, [data-shortcut]")
      ?.textContent?.trim();

  const rawText = (menuItem.innerText || menuItem.textContent || "")
    .replace(/\s+/g, " ")
    .trim();

  let displayedShortcut = explicitShortcut || undefined;
  let menuItemText = rawText;

  if (!displayedShortcut) {
    const shortcutMatch = rawText.match(
      /\b((?:Ctrl|Cmd|Alt|Shift|⌘|⌥|⇧)(?:\s*\+\s*[A-Za-z0-9F]+)+|F\d{1,2})\s*$/i
    );
    if (shortcutMatch) {
      displayedShortcut = shortcutMatch[1].trim();
      menuItemText = rawText.slice(0, shortcutMatch.index).trim();
    }
  } else if (menuItemText.endsWith(displayedShortcut)) {
    menuItemText = menuItemText.slice(0, -displayedShortcut.length).trim();
  }

  const inContextMenu = Boolean(
    menuItem.closest(
      '[data-context-menu], .context-menu, [role="menu"][data-trigger="contextmenu"]'
    )
  );

  return {
    trigger: inContextMenu ? "right_click" : "menu_bar",
    menuItemText: menuItemText.slice(0, 60),
    displayedShortcut,
  };
}
