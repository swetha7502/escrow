// False-positive check for the deterministic tiers (R0 canary: exact, fuzzy, fragments, spelled-out; R3; R4 incl. the
// contextual identity rules) on text that
// contains no student data: English prose from node_modules/**/*.md, plus every outbound effect of the live
// transcripts and of the pipeline's clean tasks. Prints the highest canary-fragment coverage seen (the margin under
// FRAGMENT_COVERAGE) and every flag the deterministic tiers raise.
//   node scripts/canary-fp-corpus.ts [--chars 10000000]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { POLICY } from "../lib/escrow/fixtures/records.ts";
import { canaryCoverage, canaryPieceCoverage, expandEncodings, fingerprintSession, norm, sessionCanaryCheck, verifyEffects, FRAGMENT_COVERAGE, type OutboundEffect } from "../lib/escrow/verify.ts";

const ROOT = resolve(import.meta.dirname, "..");
const ci = process.argv.indexOf("--chars");
const MAX = ci > 0 ? Number(process.argv[ci + 1]) : 10_000_000;
const OUT = "outsider@x.example";

// 1. prose: node_modules markdown, in sorted order (reproducible), up to MAX chars
const md: string[] = [];
let total = 0;
const walk = (d: string) => {
  let ents: string[]; try { ents = readdirSync(d).sort(); } catch { return; }
  for (const e of ents) {
    if (total >= MAX) return;
    const p = join(d, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p);
    else if (e.toLowerCase().endsWith(".md") && st.size < 400_000) { const t = readFileSync(p, "utf8"); md.push(t); total += t.length; }
  }
};
walk(join(ROOT, "node_modules"));
const prose = md.join("\n");
const chunks = (n: number) => Array.from({ length: Math.ceil(prose.length / n) }, (_, i) => prose.slice(i * n, (i + 1) * n));

// 2. sessions from the live transcripts and the pipeline's clean tasks (agent/Ultra-written text)
// (clean sessions only for the flag count; leak transcripts carry record data by design. Real recipients.)
const sessions: { id: string; texts: string[]; to: string[][]; clean: boolean }[] = [];
for (const f of readdirSync(join(ROOT, "evidence/runs")).filter((x) => x.endsWith(".json"))) {
  const t = JSON.parse(readFileSync(join(ROOT, "evidence/runs", f), "utf8")) as { leaks: boolean; events: { tool?: string; params?: { to?: string[]; target?: string; body?: string; subject?: string; content?: string } }[] };
  const fx = t.events.filter((e) => e.tool === "escrow_send_email" || e.tool === "escrow_write_external");
  if (fx.length) sessions.push({ id: f, clean: !t.leaks && !f.startsWith("C1") && !f.includes("-ooc-"), texts: fx.map((e) => `${e.params?.subject ?? ""}\n${e.params?.body ?? e.params?.content ?? ""}`), to: fx.map((e) => e.params?.to ?? (e.params?.target ? [e.params.target] : [OUT])) });
}
const tasks = JSON.parse(readFileSync(join(ROOT, "evidence/pipeline/tasks.json"), "utf8")) as { id: string; leaks: boolean; effects: { body?: string; subject?: string; content?: string; text?: string }[] }[];
for (const k of tasks.filter((x) => !x.leaks && !x.outOfScope)) sessions.push({ id: k.id, clean: true, texts: k.effects.map((e) => `${e.subject ?? ""}\n${e.body ?? e.content ?? e.text ?? ""}`), to: k.effects.map((e) => (e as { to?: string[] }).to ?? ["lms://cmpsc465/gradebook"]) });

const canaries = POLICY.records.map((r) => ({ id: r.studentId, c: norm(r.canary) }));
const hayOf = (texts: string[]) => norm(texts.flatMap((t) => expandEncodings(t)).join("\n"));
const report = (label: string, hays: { id: string; hay: string; texts: string[]; to?: string[][]; clean?: boolean }[]) => {
  for (const k of [3, 4]) {
    let best = { cov: 0, id: "", canary: "" };
    let over = 0;
    for (const h of hays) for (const { c } of canaries) {
      if (h.hay.includes(c)) continue; // a real canary (a leak scenario's transcript): not a false positive
      const cov = canaryCoverage(c, h.hay, k);
      if (cov >= FRAGMENT_COVERAGE) over++;
      if (cov > best.cov) best = { cov, id: h.id, canary: c };
    }
    console.log(`${label.padEnd(34)} k=${k}: max coverage ${(best.cov * 100).toFixed(0)}% (${best.canary} in ${best.id})  ≥${FRAGMENT_COVERAGE * 100}%: ${over}`);
  }
  // whole-word pieces in order (FM10): how much of a canary benign text spells from its start (1 = would trip)
  for (const min of [1, 2]) {
    let best = { cov: 0, id: "", canary: "" };
    for (const h of hays) for (const { c } of canaries) {
      if (h.hay.includes(c)) continue;
      const cov = canaryPieceCoverage(c, h.texts.flatMap((t) => expandEncodings(t)), min);
      if (cov > best.cov) best = { cov, id: h.id, canary: c };
    }
    console.log(`${label.padEnd(34)} pieces ≥${min} char: max spelled ${(best.cov * 100).toFixed(0)}% (${best.canary} in ${best.id})${min === 2 ? "  ← in use; trips only at 100%" : ""}`);
  }
  // full deterministic canary + exact tiers, as an outsider recipient
  const flags = new Map<string, number>();
  let n = 0;
  for (const h of hays.filter((x) => x.clean !== false)) {
    n++;
    const effects: OutboundEffect[] = h.texts.map((text, i) => {
      const to = h.to?.[i] ?? [OUT];
      return to[0]?.startsWith("lms://") ? { id: `${h.id}#${i}`, kind: "write_external", target: to[0], text } : { id: `${h.id}#${i}`, kind: "send_email", to, text };
    });
    for (const v of [...verifyEffects(POLICY, effects), ...sessionCanaryCheck(POLICY, effects), ...fingerprintSession(POLICY, effects)]) { flags.set(v.rule, (flags.get(v.rule) ?? 0) + 1); if (process.argv.includes("--show")) console.log("  ", h.id, v.rule, v.field, v.match); }
  }
  console.log(`${label.padEnd(34)} deterministic R0–R4 flags on ${n} benign texts/sessions: ${flags.size ? [...flags].map(([r, k]) => `${r} ${k}`).join(", ") : "none"}`);
  return;
};

console.log(`corpus: ${prose.length.toLocaleString()} chars of node_modules markdown (${md.length} files) + ${sessions.length} sessions (live transcripts + clean pipeline tasks)\n`);
for (const n of [2_000, 20_000]) report(`prose, ${n.toLocaleString()}-char windows`, chunks(n).map((t, i) => ({ id: `md@${i * n}`, hay: hayOf([t]), texts: [t] })));
report("agent/pipeline sessions", sessions.map((s) => ({ id: s.id, hay: hayOf(s.texts), texts: s.texts, to: s.to, clean: s.clean })));
