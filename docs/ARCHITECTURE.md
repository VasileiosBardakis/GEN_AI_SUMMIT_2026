# Architecture Guide (BRAIN_PIPELINE=v2)

Goal: automate workflows a user or judge invents live in Chrome, with zero per-case rules.

## Target Flow

1. **Eyes** (`extension/src/content.ts`, `extension/src/privacy.ts`, `extension/src/locators.ts`, `extension/src/page-summary.ts (planned)`, `extension/src/background.ts`): Capture DOM actions, candidate `Locator[]`, and a scrubbed `<=4 KB` `pageSummary`, flushing immediately on commits to `POST /events`.
2. **Ingest & Move-1 Recall** (`server/src/app.ts`, `server/src/validate.ts`, `server/src/scrub.ts`, `server/src/trace.ts`, `server/src/hands/library.ts`, `server/src/hands/recall.ts`): Append to JSONL trace and match `data/library.json` `startSignature` on move 1 (non-blocking Oumi Iris on 1-signal matches).
3. **Steps, PII Map & Pattern Counter** (`server/src/merge-sessions.ts`, `server/src/v2/steps.ts (planned)`, `server/src/v2/tries.ts (planned)`, `server/src/detect/snippet.ts`): Merge into a single timeline, collapse events to steps once, maintain a local `__PII_*__ -> realValue` map, split episodes on `>=30 s` idle gaps (`tab_switch`/`nav` are steps), and run a session-wide `minRepeats = 3` counter without selector/value equality.
4. **Parallel Models** (`server/src/v2/compiler.ts (planned)`, `server/src/llm/gemini.ts`, `server/src/llm/iris.ts`): At Rep 2, background-precompile and log (`offerAt2` only when obvious). Gemini (1 call, Vertex ADC, `thinkingBudget: 0`, `responseSchema`) returns `{ suggest, offerAt2, kind, name, reason, risk, runMode, steps }` referencing step/`pageSummary` IDs and `{{parameters}}`. Oumi Iris runs in parallel (`~0.4 s`, `1.5 s` timeout, errors ignored) to judge worthiness, `pauseBeforeSubmit`, and borderline recall.
5. **Validate, Precheck & Card** (`server/src/v2/validate.ts (planned)`, `server/src/propose.ts`, `extension/src/content.ts`): Attach `Locator[]`, restore local PII, compute `stats` (`manual - replay`), check `matchCount === 1` on open-page steps, enforce `1` popup/site/`5 min`, and show the card.
6. **Skill Save & Watch-Mode Replay** (`server/src/hands/library.ts`, `extension/src/panel.ts`, `extension/src/background.ts`, `extension/src/hands/execute.ts`): Accept saves fixed steps, `{{parameters}}`, and `startSignature` to `data/library.json` (`GET /library` feeds the Side Panel); runs immediately only on `run_remaining` or snippets. Replay opens the start URL, highlights each step with **Stop**, tries `Locator[]` in order, fails closed on ambiguity, and pauses before risky final clicks.

## Hard Rules for Agents

- **No per-case rules**: Zero regex heuristics, risk wordlists, stopword lists, or demo/fixture names in logic.
- **Model never writes selectors**: Code builds `Locator[]`; the model only references step/`pageSummary` IDs.
- **Private data stays local**: Send `__PII_*__` tokens to models, restore locally from the PII map, and never type `"<email>"` or `"[REDACTED:...]"` literals.
- **Contract stability**: Editing `shared/contract.ts` or `shared/schema.ts` requires its own reviewed issue.
