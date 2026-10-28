// Write reviewed leak verdicts into the live transcripts (evidence/runs): outcome.leaked + outcome.leakedEffectIds.
// Agent-composed scenarios: from evidence/live-review.json (every delivered effect read by hand). Scripted
// scenarios: by construction, every delivered effect of a leak scenario is a leak.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const review = JSON.parse(readFileSync(resolve(ROOT, "evidence/live-review.json"), "utf8")) as Record<string, Record<string, { leaked: string[]; note: string }>>;
const dir = resolve(ROOT, "evidence/runs");
let n = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const p = resolve(dir, f);
  const t = JSON.parse(readFileSync(p, "utf8"));
  const r = f.includes("-nocontract") ? undefined : review[t.scenario]?.[t.arm];
  if (r) Object.assign(t.outcome, { leaked: r.leaked.length > 0, leakedEffectIds: r.leaked, review: r.note });
  else t.outcome.leakedEffectIds = t.leaks && t.outcome.leaked ? t.sender.sent : [];
  writeFileSync(p, JSON.stringify(t, null, 2) + "\n"); n++;
}
console.log(`applied review to ${n} transcripts`);
