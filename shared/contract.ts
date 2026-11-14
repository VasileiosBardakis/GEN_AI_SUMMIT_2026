export type Locator = { kind: "testid" | "aria" | "css" | "text" | "uia"; value: string };

export type Event = {
  v: 1;
  id: string;            // uuid
  ts: number;            // ms since epoch
  session: string;       // one per capture session
  source: "browser" | "desktop" | "agent-log";
  app: string;           // hostname, exe name, or "claude-code"
  window?: string;       // tab or window title
  url?: string;
  type: "click" | "input" | "paste" | "copy" | "nav" | "submit" | "key" | "tool_call";
  target?: { locators: Locator[]; tag?: string; label?: string }; // locators best first
  value?: string;        // final field value. Password fields never captured.
  clipboard?: { fromApp?: string; toApp?: string; text?: string };
  meta?: Record<string, unknown>;
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
