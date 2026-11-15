# Developer Guide

Configuration, npm scripts, verification commands, and troubleshooting for local development.
See the [README](../README.md) for quick start and [ARCHITECTURE.md](./ARCHITECTURE.md) for the v2 pipeline design.

## Verify

```bash
curl -s http://localhost:8787/health
curl -s http://localhost:8787/report
cat traces/<session>.jsonl
```

## Scripts

| Command               | Purpose                         |
| --------------------- | ------------------------------- |
| `pnpm dev`            | Full local stack                |
| `pnpm server`         | Backend only                    |
| `pnpm dev:build`      | Build extension                 |
| `pnpm dev:watch`      | Rebuild extension on change     |
| `pnpm dev:browser`    | Chrome + extension              |
| `pnpm dev:demo`       | Serve `apps/demo`               |
| `pnpm dev:tail`       | Tail captured events            |
| `pnpm probe`          | Headless capture benchmark      |
| `pnpm clean`          | Remove build output/dev profile |
| `pnpm clean --traces` | Also delete `traces/*.jsonl`    |
| `pnpm run check`      | Lint, typecheck, tests, smoke   |

## Config

`PORT=8787` · `DEV_APP_PORT=5173` · `DEV_APP_URL=http://127.0.0.1:5173/` ·
`V2_COMPILE_MODEL=gemini-3.1-flash-lite` · `V2_COMPILE_TIMEOUT_MS=5000` ·
`CHROME_BIN`/`CHROME_PATH` auto-detected.

Extension endpoint is hardcoded to `http://localhost:8787` in
`extension/src/background.ts` and `extension/src/content.ts`.
Capture mode defaults to `all_throttled` in `extension/src/content.ts`.

## Issues

- `extension/dist is missing` → `pnpm dev:build`
- Chrome not found → install Playwright Chromium or set `CHROME_BIN`
- No events → check backend, reload extension, reload tab; `http(s)` pages only
- Port 8787 busy → stop old process
- No window on headless Linux → `--no-browser` or `--headless`
