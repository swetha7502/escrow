// Re-derive outcomes for saved live transcripts (evidence/runs/*.json) and compare the scripted scenarios with
// the pipeline-only run (the step-5 table in evidence/step5-scenarios.md). Prints a markdown table.
//   node harness/report-live.ts [--write]   (--write saves the re-derived outcome back into each transcript)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LIVE_SPECS, classifyOutcome, deliveredPayloads, type Transcript } from "./live.ts";

const ROOT = resolve(import.meta.dirname, "..");
const dir = resolve(ROOT, "evidence/runs");
const write = process.argv.includes("--write");

// Pipeline-only results: | id | leaks | desc | BASELINE | ESCROW | tier | judge | ms |
const pipeline = new Map<string, { baseline: string; escrow: string; tier: string }>();
for (const l of readFileSync(resolve(ROOT, "evidence/step5-scenarios.md"), "utf8").split("\n")) {
  const c = l.split("|").map((x) => x.trim());
  if (/^\d\d-/.test(c[1] ?? "")) pipeline.set(c[1], { baseline: c[4], escrow: c[5], tier: c[6] });
}

const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const rows: string[] = [];
let mismatches = 0;
for (const f of files) {
  const t = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as Transcript;
  const spec = LIVE_SPECS.find((s) => s.id === t.scenario);
  if (!spec) continue;
  t.outcome = classifyOutcome(spec, t.arm, t.events, t.sender, t.contract ?? null);
  t.deliveredEffects ??= deliveredPayloads(t.sender.sent);
  if (write) writeFileSync(resolve(dir, f), JSON.stringify(t, null, 2) + "\n");
  const p = pipeline.get(t.scenario);
  const want = p ? (t.arm === "baseline" ? p.baseline : p.escrow) : undefined;
  // Compare the verdict word and, for blocks, the tier
  const same = !p ? "n/a" : t.outcome.result.split(" (")[0] === want && (t.arm === "baseline" || t.outcome.tier === p.tier || (want?.startsWith("SENT") && t.outcome.tier === "-")) ? "✅ same" : "❌ differs";
  if (same.startsWith("❌")) mismatches++;
  const judge = t.events.filter((e) => e.event === "judge_call" || (e.event === "commit_blocked" && e.judged) || (e.event === "commit" && e.judged)).length ? "yes" : "";
  const usd = t.modelCalls.reduce((a, m) => a + Number(m.usd ?? 0), 0);
  rows.push(`| ${t.scenario}${f.includes("-nocontract") ? " (no contract)" : ""} | ${t.arm} | ${t.leaks ? "yes" : "no"} | ${t.outcome.result} | ${t.outcome.tier} | ${t.outcome.delivered} | ${t.outcome.leaked ? "**LEAKED**" : "no"} | ${want ?? "—"} | ${same} | ${t.outcome.fidelity} | ${judge} | ${(t.durationMs / 1000).toFixed(1)} s | $${usd.toFixed(3)} |`);
}
console.log("| scenario | arm | leaks? | live result | tier | delivered | leaked | pipeline-only | match | agent fidelity | judge ran | wall | model $ |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
console.log(rows.join("\n"));
console.log(`\n${files.length} transcripts, ${mismatches} mismatches vs pipeline-only`);
