/* global console, process, fetch */
const CANNED_SOLUTIONS = {
  "search-box": {
    name: "Search current page",
    solution: "Type 'quarterly report' into the search box on the current page.",
  },
  "email-field": {
    name: "Fill email field",
    solution: "Fill the email input on the current page with ops@acme.example.",
  },
  "reply-box": {
    name: "Insert reply snippet",
    solution: "Insert 'Thanks, your order ships Friday.' into the currently focused field.",
  },
};

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((v) => v.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  const serverUrl = arg("server") || "http://localhost:8787";
  const positional = process.argv.slice(2).find((v) => !v.startsWith("--"));
  const rawSolution = arg("solution") || positional;

  let name;
  let solution;
  if (rawSolution) {
    name = arg("name") || "Ad-hoc solution";
    solution = rawSolution;
  } else {
    const id = arg("id") || "search-box";
    const entry = CANNED_SOLUTIONS[id];
    if (!entry) {
      console.error(`Unknown --id="${id}". Available: ${Object.keys(CANNED_SOLUTIONS).join(", ")}`);
      process.exit(1);
    }
    name = entry.name;
    solution = entry.solution;
  }

  try {
    const health = await fetch(`${serverUrl}/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`[flow] server unreachable at ${serverUrl} (run "pnpm dev" or "pnpm server"): ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  console.log(`[planner] ${name}`);
  console.log(`[planner] solution: ${solution}`);

  const impl = await postJson(`${serverUrl}/implement`, { name, solution });
  if (!impl.ok || !impl.data.script) {
    console.error(`[implementor] failed (${impl.status}):`, impl.data.error ?? impl.data);
    process.exit(3);
  }

  console.log("[implementor] script:");
  console.log(JSON.stringify(impl.data.script, null, 2));

  if (flag("no-run")) return;

  if (!flag("no-decide")) {
    console.log("[decider] prompting user in browser extension...");
    const decide = await postJson(`${serverUrl}/decide`, {
      name,
      solution,
      script: impl.data.script,
    });
    if (!decide.ok) {
      console.error(`[decider] failed (${decide.status}):`, decide.data.error ?? decide.data);
      process.exit(4);
    }
    console.log(`[decider] response:`, decide.data);
    if (decide.data.decision !== "approved") {
      console.log(
        '[decider] dismissed — hands skipped. In the page popup click "Trial it live" to approve, or rerun with --no-decide to skip the prompt.'
      );
      return;
    }
    console.log("[decider] approved by user.");
  }

  console.log("[hands] sending script to already-open browser extension...");
  const run = await postJson(`${serverUrl}/hands/run`, { script: impl.data.script });
  if (!run.ok) {
    console.error(`[hands] failed (${run.status}):`, run.data.error ?? run.data);
    process.exit(5);
  }

  console.log("[hands] results:");
  console.log(JSON.stringify(run.data.results, null, 2));
}

main().catch((err) => {
  console.error("[flow] unexpected error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
