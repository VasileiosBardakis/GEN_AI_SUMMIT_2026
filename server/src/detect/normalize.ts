import type { Event, Step } from "@gen/shared";
import { formatTarget, maskPii, targetKey } from "../common/target.ts";

const INCLUDED_TYPES = new Set<Event["type"]>([
  "click",
  "input",
  "change",
  "paste",
  "copy",
  "nav",
  "submit",
  "key",
  "keydown",
]);

/**
 * Collapse a noisy browser event trace into a canonical sequence of steps.
 * Raw keystroke bursts collapse into a single `fill`, duplicate `change`
 * events are dropped, and PII is masked before the step is emitted.
 */
export function normalize(events: Event[]): Step[] {
  const steps: Step[] = [];
  let lastTargetKey = "";
  const lastFillByTarget = new Map<string, string>();

  for (const ev of events) {
    if (!INCLUDED_TYPES.has(ev.type)) continue;

    switch (ev.type) {
      case "input": {
        const masked = maskPii(ev.value ?? "");
        const target = formatTarget(ev.target);
        const key = targetKey(ev.target);
        const prev = steps[steps.length - 1];

        if (
          prev &&
          prev.action === "fill" &&
          lastTargetKey !== "" &&
          lastTargetKey === key
        ) {
          prev.value = masked;
        } else {
          steps.push({
            action: "fill",
            ...(target ? { target } : {}),
            value: masked,
          });
        }
        if (key !== "") {
          lastFillByTarget.set(key, masked);
        }
        lastTargetKey = key;
        break;
      }

      case "change": {
        const masked = maskPii(ev.value ?? "");
        const target = formatTarget(ev.target);
        const key = targetKey(ev.target);
        const prev = steps[steps.length - 1];

        if (
          prev &&
          prev.action === "fill" &&
          lastTargetKey !== "" &&
          lastTargetKey === key &&
          prev.value === masked
        ) {
          break;
        }

        if (key !== "" && lastFillByTarget.get(key) === masked) {
          break;
        }

        steps.push({
          action: "fill",
          ...(target ? { target } : {}),
          value: masked,
        });
        if (key !== "") {
          lastFillByTarget.set(key, masked);
        }
        lastTargetKey = key;
        break;
      }

      case "key":
      case "keydown": {
        if (ev.meta?.key !== "Enter") break;
        const target = formatTarget(ev.target);
        steps.push({
          action: "submit",
          ...(target ? { target } : {}),
          value: "Enter",
        });
        lastFillByTarget.clear();
        lastTargetKey = targetKey(ev.target);
        break;
      }

      case "click": {
        const target = formatTarget(ev.target);
        steps.push({
          action: "click",
          ...(target ? { target } : {}),
        });
        lastTargetKey = targetKey(ev.target);
        break;
      }

      case "submit": {
        const target = formatTarget(ev.target);
        const prev = steps.at(-1);
        if (prev?.action === "submit" && prev.value === "Enter") {
          if (target && (!prev.target || prev.target.length === 0)) {
            prev.target = target;
          }
          delete prev.value;
        } else {
          steps.push({
            action: "submit",
            ...(target ? { target } : {}),
          });
        }
        lastTargetKey = targetKey(ev.target);
        lastFillByTarget.clear();
        break;
      }

      case "paste":
      case "copy": {
        const target = formatTarget(ev.target);
        const rawVal = ev.value ?? ev.clipboard?.text;
        steps.push({
          action: ev.type,
          ...(target ? { target } : {}),
          ...(rawVal !== undefined ? { value: maskPii(rawVal) } : {}),
        });
        lastTargetKey = targetKey(ev.target);
        break;
      }

      case "nav": {
        steps.push({
          action: "nav",
          ...(ev.url ? { value: maskPii(ev.url) } : {}),
        });
        lastTargetKey = "";
        lastFillByTarget.clear();
        break;
      }

      default:
        break;
    }
  }

  return steps;
}
