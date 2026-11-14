export type Locator = {
  kind: "testid" | "aria" | "css" | "text" | "xpath";
  value: string;
};

export type DomStep =
  | { action: "click"; target: Locator; optional?: boolean }
  | { action: "fill"; target: Locator; value: string; optional?: boolean }
  | { action: "insertText"; target?: Locator; value: string; optional?: boolean }
  | { action: "select"; target: Locator; value: string; optional?: boolean }
  | { action: "waitFor"; target: Locator; timeoutMs?: number; optional?: boolean }
  | { action: "readText"; target: Locator; bind: string; optional?: boolean }
  | { action: "readValue"; target: Locator; bind: string; optional?: boolean }
  | {
      action: "extractList";
      target: Locator;
      bind: string;
      fields?: Record<string, Locator>;
      optional?: boolean;
    };

export type Step =
  | DomStep
  | { action: "navigate"; url: string; optional?: boolean }
  | { action: "wait"; ms: number; optional?: boolean }
  | { action: "switchTab"; host: string; optional?: boolean }
  | {
      action: "forEach";
      items: Record<string, string>[] | string;
      steps: Step[];
      optional?: boolean;
    };

export type ActionScript = {
  name?: string;
  steps: Step[];
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
