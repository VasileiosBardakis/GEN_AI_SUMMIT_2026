# AGENTS.md

## Repo Layout
- `shared/` — Shared TypeScript contract (`@gen/shared`, `shared/contract.ts`) and contract tests.
- `server/` — Backend server, trace analysis, report generation, and automation verifier (`@gen/server`).
- `extension/` — Browser extension for capturing user workflow events (`@gen/extension`).
- `apps/` — Demo target applications and UI (`@gen/apps`).
- `e2e/` — Playwright end-to-end smoke tests.
- `traces/` — Captured workflow event trace fixtures.

## Gates
- Package manager: pnpm. Run `pnpm install` once, then `pnpm run check` (lint + typecheck + vitest + playwright smoke) before finishing; it must pass.

## Rules
- Work on branch `agent/GEN-NN-short-name` (or your assigned branch); never push to `main`.
- Keep diffs small and scoped to your task.
- Add no new dependencies without a team yes.
- Never commit secrets; `.env` is gitignored.
- Gemini uses ADC only (`GOOGLE_GENAI_USE_VERTEXAI=true GOOGLE_CLOUD_PROJECT=genaihack26ath-52 GOOGLE_CLOUD_LOCATION=global`), no API keys.
- Changing `shared/contract.ts` requires a Linear issue and review by both sides.
