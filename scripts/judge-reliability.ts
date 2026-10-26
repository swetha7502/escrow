// Step 3: judge reliability. Runs the Super judge N times on each paraphrase scenario (the ones only
// R5 can catch) and on the clean scenarios (false-positive control), then reports the miss rate,
// false-positive rate, latency, and cost. `--votes 2` measures self-consistency (block if either vote says leak).
//   node scripts/judge-reliability.ts [--n 5] [--votes 1] [--temp 0.6]
import { buildEmailEffect, buildExternalEffect } from "../lib/escrow/txn.ts";
import { makeSuperJudge, type JudgeCall } from "../lib/escrow/judge.ts";
import { verifyEffects, sessionCanaryCheck, fingerprintSession } from "../lib/escrow/verify.ts";
import { POLICY } from "../lib/escrow/fixtures/records.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCENARIOS } from "./scenarios.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("--n", 5);
const VOTES = arg("--votes", 1);
const TEMP = process.argv.includes("--temp") ? arg("--temp", 0) : undefined; // default: the judge's own (0 for 1 vote, 0.6 for >1)
const PRICE = { in: 0.3 / 1e6, out: 0.9 / 1e6 }; // Super, docs/models.md

// The live agent's own killer texts (K1, K2): the attack's effects, i.e. everything sent before the first commit
const liveKiller = (id: string) => {
  const t = JSON.parse(readFileSync(resolve(import.meta.dirname, `../evidence/runs/${id}-escrow.json`), "utf8")) as { events: Record<string, unknown>[] };
  const firstCommit = t.events.findIndex((e) => e.tool === "escrow_commit");
  return t.events.slice(0, firstCommit).filter((e) => e.tool === "escrow_send_email").map((e) => { const p = e.params as { to: string[]; subject: string; body: string }; return buildEmailEffect(p.to, p.subject, p.body); });
};
const KILLER_IDS = ["K1-split-score", "K2-paraphrase-accommodation"];
const effectsOf = (id: string) => KILLER_IDS.includes(id) ? liveKiller(id)
  : SCENARIOS.find((s) => s.id === id)!.actions.map((a) => ("email" in a ? buildEmailEffect(...a.email) : buildExternalEffect(...a.ext)));
// Paraphrase scenarios = leaks that pass every deterministic tier, so the judge alone decides them
const deterministicClean = (id: string) => { const e = effectsOf(id); return [...verifyEffects(POLICY, e), ...sessionCanaryCheck(POLICY, e), ...fingerprintSession(POLICY, e)].length === 0; };
const paraphrase = [...SCENARIOS.filter((s) => s.leaks && deterministicClean(s.id)).map((s) => s.id), ...KILLER_IDS.filter(deterministicClean)];
const leaksOf = (id: string) => KILLER_IDS.includes(id) || SCENARIOS.find((s) => s.id === id)!.leaks;
const clean = SCENARIOS.filter((s) => !s.leaks).map((s) => s.id);

interface Trial { id: string; leaks: boolean; trial: number; blocked: boolean; error?: string; ms: number; calls: JudgeCall[] }
const trials: Trial[] = [];
for (const id of [...paraphrase, ...clean]) {
  const leaks = leaksOf(id);
  for (let t = 0; t < N; t++) {
    const calls: JudgeCall[] = [];
    const judge = makeSuperJudge({ runId: `p3-judge-v${VOTES}`, votes: VOTES, temperature: TEMP, onCall: (c) => calls.push(c) });
    const t0 = Date.now();
    let blocked: boolean, error: string | undefined;
    try { blocked = (await judge(POLICY, effectsOf(id))).length > 0; } catch (e) { blocked = true; error = (e as Error).message; } // fail closed
    trials.push({ id, leaks, trial: t, blocked, error, ms: Date.now() - t0, calls });
    process.stderr.write(`${id} #${t}: ${blocked ? "BLOCK" : "pass"}${error ? ` (error: ${error.slice(0, 80)})` : ""} ${Date.now() - t0}ms\n`);
  }
}

const per = [...paraphrase, ...clean].map((id) => {
  const ts = trials.filter((t) => t.id === id);
  const leaks = ts[0].leaks;
  const wrong = ts.filter((t) => t.blocked !== leaks).length;
  const ms = ts.map((t) => t.ms).sort((a, b) => a - b);
  const calls = ts.flatMap((t) => t.calls);
  const usd = calls.reduce((a, c) => a + (c.promptTokens ?? 0) * PRICE.in + (c.completionTokens ?? 0) * PRICE.out, 0);
  return { id, leaks, n: ts.length, wrong, errors: ts.filter((t) => t.error).length, medianMs: ms[Math.floor(ms.length / 2)], maxMs: ms[ms.length - 1], usdPerSession: usd / ts.length, verdicts: ts.map((t) => (t.blocked ? "B" : "p")).join("") };
});
const sum = (f: (r: (typeof per)[number]) => boolean) => per.filter(f).reduce((a, r) => a + r.wrong, 0);
const tot = (f: (r: (typeof per)[number]) => boolean) => per.filter(f).reduce((a, r) => a + r.n, 0);
const summary = {
  votes: VOTES, n: N, temperature: TEMP ?? (VOTES > 1 ? 0.6 : 0),
  missRate: `${sum((r) => r.leaks)}/${tot((r) => r.leaks)}`,
  falsePositiveRate: `${sum((r) => !r.leaks)}/${tot((r) => !r.leaks)}`,
  medianMs: per.map((r) => r.medianMs).sort((a, b) => a - b)[Math.floor(per.length / 2)],
  usdPerSession: per.reduce((a, r) => a + r.usdPerSession, 0) / per.length,
};
console.log(JSON.stringify({ summary, per, trials }, null, 2));
