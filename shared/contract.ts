export type Locator = {
  kind: "testid" | "aria" | "css" | "text" | "uia";
  value: string;
};

export const ALL_EVENT_TYPES = [
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "mousedown",
  "mouseup",
  "mousemove",
  "dragstart",
  "drop",
  "keydown",
  "keyup",
  "key",
  "beforeinput",
  "input",
  "change",
  "focus",
  "blur",
  "select",
  "selectionchange",
  "copy",
  "cut",
  "paste",
  "scroll",
  "wheel",
  "submit",
  "reset",
  "nav",
  "tab_switch",
  "visibilitychange",
  "window_focus",
  "window_blur",
  "ui_change",
  "dom_mutation",
  "auth_flow",
  "tool_call",
] as const;

export type EventType = (typeof ALL_EVENT_TYPES)[number];

export type EventMeta = {
  subType?: string;

  // 1. Spreadsheet / Grid context (Google Sheets, Excel Online, ERP tables)
  grid?: {
    cellRef?: string;          // e.g. "B4", "A1:C10"
    rowIndex?: number;
    colIndex?: number;
    sheetName?: string;
    isFormula?: boolean;       // value starts with "="
    formulaFunc?: string;      // e.g. "SUM", "AGGR", "VLOOKUP"
    prevValue?: string;
  };

  // 2. Typing vs Autofill / Snippet signals
  typing?: {
    inputType?: string;        // InputEvent.inputType: "insertText" | "insertReplacementText" | "insertFromPaste"
    data?: string;             // single char/chunk for raw beforeinput/input
    keystrokeCount?: number;   // number of manual keydowns while focused
    backspaceCount?: number;   // error/correction effort
    typingDurationMs?: number; // time from first keydown to blur/commit
    isAutofill?: boolean;      // true if browser autofill / autocomplete filled it
    autofillEligible?: boolean;// true if field has autocomplete attr or matches standard profile fields
    autocompleteAttr?: string; // e.g. "email", "organization", "street-address", "off"
    inputName?: string;
    inputTypeAttr?: string;
  };

  // 3. Layer-1 Privacy & Security Redaction
  privacy?: {
    redacted: boolean;
    reason?: "password_field" | "payment_field" | "secret_field" | "pii_pattern" | "url_token";
    piiTypes?: ("password" | "credit_card" | "iban" | "secret_token" | "ssn_tax_id" | "email" | "phone")[];
    valueHash?: string;        // deterministic salted hash so repetitive typing is still detectable without raw PII
    valueLength?: number;
  };

  // 4. Context Menu & Shortcut Discovery
  menu?: {
    trigger?: "right_click" | "menu_bar" | "context_key";
    menuItemText?: string;     // e.g. "Copy", "Rename", "Insert 1 row above"
    displayedShortcut?: string;// e.g. "Ctrl+C", "F2" if shown in the UI menu item
  };

  // 5. Authorization / OAuth Flow Detection
  auth?: {
    flowType: "oauth_authorize" | "sso_login" | "consent_dialog" | "popup_auth";
    provider?: string;
    clientId?: string;
    scopes?: string[];
    isPopup?: boolean;
  };

  // 6. Keyboard & Pointer details
  key?: string;
  code?: string;
  modifiers?: string[];        // ["Ctrl", "Shift", "Alt", "Meta"]
  repeat?: boolean;
  repeatCount?: number;
  button?: number;             // 0 = left, 1 = middle, 2 = right
  clientX?: number;
  clientY?: number;
  dwellMs?: number;            // focus or pointer dwell time in ms

  // 7. Scroll / Wheel / UI Mutation details
  scroll?: {
    scrollX?: number;
    scrollY?: number;
    deltaX: number;
    deltaY: number;
    durationMs?: number;
  };
  uiChange?: {
    kind: "dialog_open" | "context_menu_open" | "toast_alert" | "dom_mutation" | "title_change";
    addedCount?: number;
    removedCount?: number;
    summary: string;
  };

  [key: string]: unknown;
};

export type Event = {
  v: 1;
  id: string;            // uuid
  ts: number;            // ms since epoch
  session: string;       // one per capture session
  source: "browser" | "desktop" | "agent-log";
  app: string;           // hostname, exe name, or "claude-code"
  window?: string;       // tab or window title
  url?: string;
  type: EventType;
  target?: {
    locators: Locator[];
    tag?: string;
    label?: string;
    role?: string;
  };
  value?: string;        // field or selection value. Password fields never captured.
  clipboard?: {
    fromApp?: string;
    toApp?: string;
    fromUrl?: string;
    fromCell?: string;
    text?: string;
    textHash?: string;
    timeSinceCopyMs?: number;
  };
  meta?: EventMeta;
};

export type Step = {
  action: "click" | "fill" | "nav" | "paste" | "copy" | "submit";
  target?: Locator[];
  value?: string | { param: string };   // literal or bound parameter
};

export type Workflow = {
  id: string;
  name: string;
  sourceApp: string;
  destApp: string;
  steps: Step[];
  params: { name: string; example: string }[];
  instances: { startTs: number; endTs: number; bindings: Record<string, string> }[];
};

export type Verdict = "rung0" | "rung1" | "rung2" | "rung3" | "do_not_automate";

export type Finding = {
  id: string;
  workflowId?: string;
  verdict: Verdict;
  title: string;
  why: string;
  whyNotNext: string;
  stats: { repetitions: number; minutesPerWeek: number; stability: number }; // stability 0..1
  artifact?: { kind: "snippet" | "playwright" | "ahk" | "text"; path: string; verified: boolean };
  dryRun?: { passed: number; total: number };
  cost?: { scriptUsd: number; scriptSeconds: number; agentUsd: number; agentSeconds: number };
};

export type Report = { generatedAt: number; session: string; findings: Finding[] };
