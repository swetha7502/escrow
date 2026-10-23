// Host-side re-verification. The host's own copy of the policy (lib/escrow/fixtures) is used,
// never the sandbox's, so a sandbox that forges a "committed" record still can't release a leak.
import { verifyEffects, type Policy, type OutboundEffect } from "../lib/escrow/verify.ts";
import type { Effect, Verifier } from "./sender.ts";

export function toOutbound(e: Effect): OutboundEffect {
  const p = e.payload as Record<string, unknown>;
  if (e.kind === "send_email") {
    const to = Array.isArray(p.to) ? p.to.map(String) : [];
    return { id: e.id, kind: e.kind, to, text: `${String(p.subject ?? "")}\n${String(p.body ?? "")}` };
  }
  return { id: e.id, kind: e.kind, target: String(p.target ?? ""), text: `${String(p.target ?? "")}\n${String(p.content ?? "")}` };
}

export function hostVerifier(policy: Policy): Verifier {
  return (e) => {
    const out = toOutbound(e);
    if (e.kind === "send_email" && out.to!.length === 0) return { ok: false, reason: "email has no recipients" };
    const v = verifyEffects(policy, [out]);
    return v.length ? { ok: false, reason: v.map((x) => `${x.rule}:${x.field}:${x.studentId}${x.recipient ? `→${x.recipient}` : ""}`).join(", ") } : { ok: true };
  };
}
