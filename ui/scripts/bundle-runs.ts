// Bundle the saved live runs (evidence/runs/*.json) into the UI as static data: the offline / cached-run
// fallback. Each transcript becomes the exact event stream the API server would replay (harness/events.ts
// transcriptToEvents), so a cached run in the browser and a cached run from the server look the same.
//   node ui/scripts/bundle-runs.ts   → ui/src/data/cached-runs.json
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { transcriptToEvents } from "../../harness/events.ts";
import { LIVE_SPECS, type Transcript } from "../../harness/live.ts";
import { RECORDS, POLICY } from "../../lib/escrow/fixtures/records.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const dir = resolve(ROOT, "evidence/runs");

const runs: Record<string, unknown>[] = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const t = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as Transcript;
  const variant = f.includes("-nocontract") ? "nocontract" : "default";
  const start = Date.parse(t.startedAt);
  runs.push({
    key: `${t.scenario}/${t.arm}${variant === "default" ? "" : `/${variant}`}`,
    scenario: t.scenario, arm: t.arm, variant, file: `evidence/runs/${f}`,
    recordedAt: t.startedAt, durationMs: t.durationMs, outcome: t.outcome, reply: t.reply,
    delivered: t.deliveredEffects ?? [],
    // Relative times so the browser can pace the replay the way the server does
    events: transcriptToEvents(t).map((e) => ({ ...e, t: Math.max(0, Date.parse(String(e.ts)) - start) })),
  });
}

const scenarios = LIVE_SPECS.map((s) => ({ id: s.id, desc: s.desc, leaks: s.leaks, contractRequest: s.contractRequest ?? null, prompt: s.prompt }));
const roster = RECORDS.map((r) => ({ studentId: r.studentId, name: r.name, email: r.email })); // synthetic
const out = { generatedAt: new Date().toISOString(), scenarios, roster, officials: POLICY.officials, runs };
mkdirSync(resolve(ROOT, "ui/src/data"), { recursive: true });
writeFileSync(resolve(ROOT, "ui/src/data/cached-runs.json"), JSON.stringify(out));
console.log(`bundled ${runs.length} runs, ${scenarios.length} scenarios → ui/src/data/cached-runs.json`);
