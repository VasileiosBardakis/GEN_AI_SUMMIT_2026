import type { Report } from "@gen/shared";

export function buildReport(session: string): Report {
  return {
    generatedAt: Date.now(),
    session,
    findings: [
      {
        id: "finding-supplier-snippet",
        workflowId: "wf-supplier-reply",
        verdict: "rung1",
        title: "Reply to supplier emails with a saved snippet",
        why: "Supplier status replies repeat the same greeting and order-status structure across multiple sessions.",
        whyNotNext: "Replies still need a quick human check of order dates before sending, so a text snippet beats a full script.",
        stats: {
          repetitions: 8,
          minutesPerWeek: 24,
          stability: 0.92,
        },
      },
    ],
  };
}
