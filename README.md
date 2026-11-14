# Eyes — Dev Runbook

## Setup

```bash
pnpm install
pnpm exec playwright install chromium   # only if no Chrome/Chromium is installed
```

## Start

```bash
pnpm dev
```

Backend `:8787`, demo `:5173`, extension built and loaded in Chrome
(`.dev/chrome-profile`), auto-rebuild, live trace tail. `Ctrl+C` stops.

```bash
pnpm dev --no-browser   # backend + demo + watcher + tail
pnpm dev --no-watch     # no rebuild
pnpm dev --no-tail      # no trace output
pnpm dev --headless     # headless browser
pnpm dev --port=8787    # backend port
pnpm dev --app-port=5173
pnpm dev --url=http://localhost:3000
```

## Manual

```bash
pnpm server        # backend :8787
pnpm dev:build     # build extension/dist
pnpm dev:demo      # demo app :5173
pnpm dev:tail      # follow traces/*.jsonl
```

Load: `chrome://extensions` → Developer mode → Load unpacked → select `extension/`.
After `pnpm dev:build`, reload the extension and the target tab.

```bash
pnpm dev:browser -- --url=http://127.0.0.1:5173/
```

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
