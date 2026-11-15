export type Locator = {
  kind: "testid" | "aria" | "css" | "text" | "xpath";
  value: string;
};

export type DomStep =
  | {
      action: "click";
      target: Locator | Locator[];
      within?: Locator | Locator[];
      optional?: boolean;
    }
  | {
      action: "fill";
      target: Locator | Locator[];
      within?: Locator | Locator[];
      value: string;
      optional?: boolean;
    }
  | {
      action: "insertText";
      target?: Locator | Locator[];
      within?: Locator | Locator[];
      value: string;
      optional?: boolean;
    }
  | {
      action: "select";
      target: Locator | Locator[];
      within?: Locator | Locator[];
      value: string;
      optional?: boolean;
    }
  | {
      action: "pressKey";
      key: "Enter" | "Tab" | "Escape";
      target?: Locator | Locator[];
      within?: Locator | Locator[];
      optional?: boolean;
    }
  | {
      action: "waitFor";
      target: Locator | Locator[];
      within?: Locator | Locator[];
      timeoutMs?: number;
      optional?: boolean;
    }
  | {
      action: "readText";
      target: Locator | Locator[];
      within?: Locator | Locator[];
      bind: string;
      optional?: boolean;
    }
  | {
      action: "readValue";
      target: Locator | Locator[];
      within?: Locator | Locator[];
      bind: string;
      optional?: boolean;
    }
  | {
      action: "extractList";
      target: Locator | Locator[];
      within?: Locator | Locator[];
      bind: string;
      fields?: Record<string, Locator>;
      optional?: boolean;
    };

export type Step =
  | DomStep
  | { action: "navigate"; url: string; optional?: boolean }
  | { action: "wait"; ms: number; optional?: boolean }
  | { action: "switchTab"; host: string; url?: string; optional?: boolean }
  | {
      action: "forEach";
      items: Record<string, string>[] | string;
      steps: Step[];
      optional?: boolean;
    };

export type ActionScript = {
  name?: string;
  steps: Step[];
  pauseBeforeSubmit?: boolean;
  runMode?: "run_remaining" | "save_only";
};

export type BindingValue = string | Record<string, string>[];

export type StepResult = {
  ok: boolean;
  url?: string;
  tab?: string;
  value?: string;
  items?: Record<string, string>[];
  error?: string;
};
