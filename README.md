<p align="center">
  <img src="extension/assets/aiz-logo.webp" alt="AIz (Eyes) logo" width="260" />
</p>

# AIz (Eyes)

An adaptive assistant that observes repetitive workflows as you work and automates them on the fly. Powered by Gemini and Oumi Iris, it supervises the user while they work, and suggests improved workflows.

## What it is

AIz (Eyes) is a Chrome extension paired with a local backend AI. The extension watches how you work across tabs, forms, spreadsheets, and internal tools, while the backend detects repeated routines and turns them into reusable automations.

Instead of writing scripts or setting up integrations ahead of time, you just work normally. When Eyes sees you repeating a workflow, it offers to finish the remaining items or save it as a one-click skill, pausing before major actions like submitting a form.

## How it works

1. You perform a task in Chrome. The extension captures clicks, typing, navigation, and page context and streams it to the backend.
2. On the first action of a task, the backend checks your saved skills to see if you have already automated a similar flow.
3. As you repeat the sequence, the backend groups the activity into steps and runs two models in parallel:
   - **Gemini** turns the repeated steps and changing inputs into a clean, reusable workflow.
   - **Oumi Iris** runs alongside it as a fast judge to decide if the pattern is worth automating and whether replay should pause before a final submit.
4. Once verified against the open page, Eyes shows a suggestion card in Chrome. Accepting saves the skill to your Side Panel and replays it step by step on screen, with a Stop button whenever you want to take over.

## Architecture

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'lineColor': '#64748b', 'textColor': '#f1f5f9', 'edgeLabelBackground': '#1e293b'}, 'flowchart': {'curve': 'basis', 'nodeSpacing': 30, 'rankSpacing': 52}}}%%
flowchart LR
    classDef eyes fill:#0c192c,stroke:#38bdf8,stroke-width:1.5px,color:#f8fafc
    classDef brain fill:#141830,stroke:#818cf8,stroke-width:1.5px,color:#f8fafc
    classDef gemini fill:#1c1917,stroke:#fbbf24,stroke-width:1.5px,color:#fef3c7
    classDef iris fill:#0f2424,stroke:#2dd4bf,stroke-width:1.5px,color:#ccfbf1
    classDef hands fill:#0d211b,stroke:#34d399,stroke-width:1.5px,color:#d1fae5

    subgraph S1["Eyes — Browser Sensor"]
        E(["Capture browser actions<br/>& page context"]):::eyes
    end

    subgraph S2["Brain — Local Backend AI"]
        B1("Session trace & recall"):::brain
        B2("Pattern detection &<br/>validation"):::brain
        M1(["Gemini · Workflow compiler"]):::gemini
        M2(["Oumi Iris · Safety & recall judge"]):::iris
        B1 --> B2
        B2 <--> M1
        B2 <--> M2
    end

    subgraph S3["Hands — Replay & Library"]
        H(["Side Panel library &<br/>live step-by-step replay"]):::hands
    end

    E -->|Event stream| B1
    B2 -->|Skill prompt| H
    H -->|Replay in tab| E

    style S1 fill:#0b1120,stroke:#1e3a5f,stroke-width:1.5px,color:#bae6fd
    style S2 fill:#0b1120,stroke:#312e81,stroke-width:1.5px,color:#c7d2fe
    style S3 fill:#0b1120,stroke:#14532d,stroke-width:1.5px,color:#a7f3d0
```

- **Eyes (Browser Sensor):** Runs inside Chrome as an extension. It observes clicks, navigation, and form inputs across tabs and reads the surrounding page structure.
- **Brain (Backend AI):** Runs locally in Node.js. It stitches activity across tabs, detects repeated patterns, recalls saved skills, and coordinates **Gemini** (workflow compiler) and **Oumi Iris** (fast worthiness & safety judge).
- **Hands (Skill Library & Replay):** Saves approved workflows to the Chrome Side Panel and replays them live on the page, highlighting each step and pausing before risky clicks.

## Tech Stack

- **Chrome Extension:** Manifest V3, TypeScript, Chrome Side Panel API
- **Backend:** Node.js, TypeScript, pnpm workspaces
- **AI Models:** Google Gemini (Vertex AI), Oumi Iris
- **Testing & Tooling:** Playwright, Vitest, ESLint

## Getting Started

```bash
pnpm install
pnpm dev
```

This starts the local backend, builds and loads the Chrome extension, and opens Chrome with the demo apps.

For manual setup, CLI flags, environment config, scripts, and troubleshooting, see [`docs/DEV.md`](docs/DEV.md).

## Documentation

- [`docs/DEV.md`](docs/DEV.md) — full setup, manual Chrome loading, scripts, config, and troubleshooting
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — detailed pipeline architecture and engineering rules
