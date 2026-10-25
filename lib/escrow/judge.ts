// Tier 3: Nemotron Super adjudicates paraphrase leaks that the deterministic tiers miss.
// Runs ONLY after the exact/canary/fingerprint tiers pass. Best-effort by nature; fail closed.
import { chat } from "../tf-client.ts";
import { extractRecordFacts, type OutboundEffect, type Policy, type Violation } from "./verify.ts";

/** Cap the transcript so one judge call stays small and well under Super's context/TPM limits. */
export const TRANSCRIPT_CHAR_CAP = 12000;

export interface JudgeVerdict {
  leak: boolean;
  findings: { studentId: string; fact: string; effectId: string; quote: string }[];
  raw: string;
}

export type JudgeFn = (policy: Policy, effects: OutboundEffect[]) => Promise<Violation[]>;

function buildPrompt(policy: Policy, effects: OutboundEffect[]): { system: string; user: string } {
  // Give Super the protected facts per student, plus whom each effect is going to.
  const roster = policy.records.map((r) => ({
    studentId: r.studentId,
    name: r.name,
    mayReceive: [r.email, ...policy.officials],
    protectedFacts: [...new Set(extractRecordFacts(r).map((f) => f.value))],
  }));
  const transcript = effects
    .map((e) => `[effect ${e.id}] kind=${e.kind} to=${e.kind === "send_email" ? (e.to ?? []).join(",") : e.target}\n${e.text}`)
    .join("\n---\n")
    .slice(0, TRANSCRIPT_CHAR_CAP);
  const system =
    "You are a FERPA data-leak auditor for a university TA assistant. You are given protected student records " +
    "and the messages a session is about to send. A leak is any protected fact about a student reaching a recipient " +
    "NOT in that student's mayReceive list — including paraphrases, partial disclosures, or facts spread across " +
    "several messages. The institution's own gradebook targets (lms://...) are authorized. " +
    'Respond with ONLY compact JSON: {"leak":boolean,"findings":[{"studentId":string,"fact":string,"effectId":string,"quote":string}]}. ' +
    "No prose, no markdown.";
  const user = `PROTECTED RECORDS:\n${JSON.stringify(roster)}\n\nOUTGOING MESSAGES:\n${transcript}`;
  return { system, user };
}

/** Parse Super's reply into a verdict. A reply we can't parse as a clear verdict is treated as a leak (fail closed). */
export function parseVerdict(raw: string): JudgeVerdict {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge returned no JSON: ${raw.slice(0, 200)}`);
  const j = JSON.parse(m[0]) as { leak?: unknown; findings?: unknown };
  if (typeof j.leak !== "boolean") throw new Error(`judge verdict missing boolean "leak": ${m[0].slice(0, 200)}`);
  const findings = Array.isArray(j.findings)
    ? j.findings.map((f) => {
        const o = f as Record<string, unknown>;
        return { studentId: String(o.studentId ?? ""), fact: String(o.fact ?? ""), effectId: String(o.effectId ?? ""), quote: String(o.quote ?? "") };
      })
    : [];
  return { leak: j.leak, findings, raw };
}

/**
 * Judge factory. Returns a JudgeFn suitable for commitWithJudge.
 * On any error (network, timeout, unparseable, cached mode) it throws, and the caller must block.
 */
export function makeSuperJudge(opts: { runId?: string; maxTokens?: number } = {}): JudgeFn {
  return async (policy, effects) => {
    if (effects.length === 0) return [];
    const { system, user } = buildPrompt(policy, effects);
    const r = await chat({
      model: "super",
      runId: opts.runId ?? "escrow-judge",
      maxTokens: opts.maxTokens ?? 400,
      temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    });
    const verdict = parseVerdict(r.content);
    if (!verdict.leak) return [];
    const ids = effects.map((e) => e.id).join(",");
    return verdict.findings.length
      ? verdict.findings.map((f) => ({
          effectId: f.effectId || ids,
          rule: "R5-super-judge" as const,
          studentId: f.studentId,
          field: f.fact,
          match: f.quote,
        }))
      : [{ effectId: ids, rule: "R5-super-judge" as const, studentId: "?", field: "paraphrase", match: verdict.raw.slice(0, 120) }];
  };
}
