# DESIGN.md — Eyes Design & Brand System

This document defines the visual language, color tokens, typography, and component craft for **Eyes**. All UI surfaces (in-page overlays, the extension side panel, and product views) must adhere to these rules.

**Reference Baseline**
- **Braun / Teenage Engineering / Things 3**: tactile hardware-inspired layering (warm stone shells, recessed graph canvases, keycap targets, clear optical geometry).
- **Notion / Anthropic / Linear**: warm neutral palette (off-white alabaster, stone gray, warm charcoal, sandstone brown), `4px` grid, `400 / 500 / 600` weights, calm restraint.

---

## 1. Brand Voice & Anti-Patterns

1. **No AI theater ("AI whistleblows")**
   - Never render sparkle/magic-wand icons, `"AI"` pill badges, glowing cyan/violet gradients, or first-person assistant copy (`"I can..."`, `"AI Suggestion"`).
   - Identify the product with the geometric **Eyes optical aperture mark** paired with the **`Eyes`** wordmark.
   - Avoid noisy status pills (`3× pattern`, `Verified`) that add zero user value.
2. **Avoid bare "Markdown document" flatness**
   - Do not build cards that read like unstyled Markdown (`border-bottom` `<hr>` stacks, `>` `border-left` blockquotes, inline `<code>` tags).
   - Use intentional **tactile surface layering**: warm-stone header shell (`#F1EDE4`), alabaster body (`#FAF8F4`), keycap/snippet preview surfaces, a dark cinema frame (`#171614`) for sandbox video playback, and a recessed dot-grid canvas (`#F3EFE7`) for DAG workflow graphs.
3. **Neutrality with purpose**
   - Warm gray, charcoal/black, and sandstone/light brown carry the entire UI. Color appears only to distinguish the automated `Eyes` step (`#8A5A2B` / `#F4E8D8`) and verified completion (`#2E6B43`).

---

## 2. Color Tokens

| Token | Hex | Role |
| :--- | :--- | :--- |
| `--shell` | `#F1EDE4` | Warm stone chrome — top header bar, snippet container |
| `--canvas` | `#FAF8F4` | Primary alabaster card / panel background |
| `--surface-node` | `#FCFBF8` | Crisp ivory — DAG step cards, keycap targets, secondary button |
| `--surface-graph` | `#F3EFE7` | Recessed warm stone dot-grid canvas (`#D8D1C5` dots, `11px` pitch) |
| `--surface-eyes` | `#F4E8D8` | Warm sandstone tint — proposed `Eyes` step node |
| `--surface-cinema` | `#171614` | Deep warm charcoal — Playwright sandbox video frame |
| `--ink` | `#1A1917` | Warm near-black — wordmark, headings, primary button fill |
| `--ink-2` | `#57524B` | Warm dark gray — body copy, flow headers, secondary labels |
| `--ink-muted` | `#7B756D` | Warm medium gray — metadata, micro-captions, dismiss icon |
| `--brown` | `#8A5A2B` | Sandstone brown — `Eyes flow` header, automated node accent, status dot |
| `--brown-border` | `#CCB08D` | Soft light-brown stroke on automated DAG nodes |
| `--line` | `#E2DCD0` | Primary hairline & graph divider |
| `--line-strong` | `#D0C8B9` | Tactile borders on nodes, keycaps, and secondary buttons |
| `--ok` | `#2E6B43` | Muted forest green — verified / done terminal node |
| `--danger` | `#B42318` | Muted crimson — PII redaction / error states |

---

## 3. Typography

- **UI Sans**: `system-ui, -apple-system, "Segoe UI", sans-serif`
- **Monospace**: `ui-monospace, "SFMono-Regular", Menlo, monospace` (reserved for keycap targets, trace selectors, and keyboard shortcuts)
- **Weights**:
  - `400` — body text, node labels
  - `500` — buttons, pattern count tags, sub-labels
  - `600` — `Eyes` wordmark, card headlines, tracked DAG section headers (never `700+`)
- **Scale**:
  - Headline: `15px`, `letter-spacing: -0.015em`
  - Wordmark (`Eyes`): `13px`, `font-weight: 600`
  - Body Copy: `12.5px–13px`
  - DAG Node Title / Label: `9.5px` header / `10.5px` label
  - Metadata / Captions: `11px`, `font-variant-numeric: tabular-nums`

---

## 4. Component Craft

- **Header**: Warm-stone `--shell` bar with the geometric Eyes optical mark + `Eyes` wordmark on the left, and the close control on the right.
- **Target / Snippet Preview**:
  - Clickable actions render as a tactile **keycap chip** (`1px solid --line-strong`, subtle `1px` bottom lip).
  - Text snippets render inside a compact `--shell` recessed snippet box.
- **Automation Replay**: Shown only for non-text automations when an `.mp4` is available. Housed in a `--surface-cinema` (`#171614`) frame with a clean `Automation replay` caption underneath — no technical jargon or status badges.
- **DAG Flow Canvas**: Always shown (`Your flow` above `Eyes flow`) inside a single recessed `--surface-graph` dot-grid canvas:
  - Connected horizontal mini-cards with micro-icons and SVG directional arrows.
  - `Your flow` includes a curved dashed SVG **loop-back arc** illustrating the repeated manual cycle.
  - `Eyes flow` highlights the collapsed automated step in warm sandstone (`--surface-eyes` / `--brown-border`) and ends cleanly at `Done`.
- **Footer Actions**: Metadata on the left; tactile secondary (`Not now`) and solid warm-black primary (`Trial it live`) on the right.
