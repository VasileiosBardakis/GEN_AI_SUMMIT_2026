import { describe, expect, it } from "vitest";
import type { Event } from "@gen/shared";
import type { GeminiClient, ZodLikeSchema } from "../src/llm/gemini.ts";
import {
  buildFlowTipPrompt,
  FlowTipSchema,
  suggestFlowTip,
} from "../src/tips.ts";

function makeEvent(
  id: string,
  ts: number,
  type: Event["type"],
  meta?: Event["meta"],
): Event {
  return {
    v: 1,
    id,
    ts,
    session: "s1",
    source: "browser",
    app: "docs.example.com",
    type,
    ...(meta ? { meta } : {}),
  };
}

function rightClickCopyPaste(cycles: number): Event[] {
  const events: Event[] = [];
  let ts = 1_000;
  for (let i = 0; i < cycles; i++) {
    events.push(
      makeEvent(`cm${i}`, (ts += 1_000), "contextmenu", {
        menu: { trigger: "right_click" },
      }),
    );
    events.push(makeEvent(`copy${i}`, (ts += 1_000), "copy"));
    events.push(makeEvent(`click${i}`, (ts += 1_000), "click"));
    events.push(makeEvent(`paste${i}`, (ts += 1_000), "paste"));
  }
  return events;
}

function makeClient(response: unknown): {
  client: GeminiClient;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      async generateText() {
        throw new Error("unexpected generateText call");
      },
      async generateJson<T>(_prompt: string, schema: ZodLikeSchema<T>): Promise<T> {
        calls += 1;
        const parsed = schema.safeParse(response);
        if (!parsed.success) throw new Error("schema validation failed");
        return parsed.data as T;
      },
    },
  };
}

describe("flow tips", () => {
  it("includes right-click menu context without raw values", () => {
    const prompt = buildFlowTipPrompt(rightClickCopyPaste(3));
    expect(prompt).toContain('"trigger": "right_click"');
    expect(prompt).toContain("Use tip: null and keys: null");
    expect(prompt).not.toContain("text/plain");
  });

  it("returns a validated shortcut tip for right-click copy/paste", async () => {
    const { client, calls } = makeClient({
      tip: "Select the text and press Ctrl+C, then Ctrl+V instead of using the right-click menu.",
      keys: ["Ctrl+C", "Ctrl+V"],
      why: "Right-click copy/paste repeated three times.",
    });
    const result = await suggestFlowTip(rightClickCopyPaste(3), { client });
    expect(calls()).toBe(1);
    expect(result).toEqual({
      tip: expect.stringContaining("Ctrl+C"),
      keys: ["Ctrl+C", "Ctrl+V"],
      why: expect.stringContaining("repeated"),
    });
  });

  it("rejects malformed model output", () => {
    const parsed = FlowTipSchema.safeParse({ tip: "", keys: "Ctrl+C", why: "" });
    expect(parsed.success).toBe(false);
  });
});
