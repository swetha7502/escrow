// Comparison arms. "baseline" is a per-call filter: each effect is checked alone, with no session
// context, and released immediately if clean. "escrow" holds every effect and verifies the whole
// session at commit.
import { readFileSync } from "node:fs";
import { verifyEffects, type OutboundEffect, type Policy, type Violation } from "./verify.ts";

export type Mode = "baseline" | "escrow";

/** Mode file contents, written by the host. Anything unreadable or unknown means "escrow" (the stricter arm). */
export function readMode(path: string): Mode {
  try {
    return readFileSync(path, "utf8").trim() === "baseline" ? "baseline" : "escrow";
  } catch {
    return "escrow";
  }
}

/** Baseline check: the same deterministic checks, applied to one effect in isolation. */
export function baselineCheck(policy: Policy, effect: OutboundEffect): Violation[] {
  return verifyEffects(policy, [effect]);
}
