// node harness/run-live.ts [ids...] [--arms baseline,escrow]
// Runs each scenario live under each arm, saves evidence/runs/<id>-<arm>.json, prints a table.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LIVE_SPECS, runLive, type Arm } from "./live.ts";
import { createLabeler, prewarm } from "./labeler.ts";
import { tailSandboxAudit } from "./sandbox.ts";

const args = process.argv.slice(2);
const ai = args.indexOf("--arms");
const arms = (ai >= 0 ? args.splice(ai, 2)[1] : "baseline,escrow").split(",") as Arm[];
// --no-contract: run contract specs without a contract (the control). Unattended runs auto-approve.
const ni = args.indexOf("--no-contract");
const contract = ni >= 0 ? (args.splice(ni, 1), "off" as const) : "auto-approve" as const;
// --stop-at <usd>: don't start another run once the proxy's total spend reaches this (budget guard)
const si = args.indexOf("--stop-at");
const stopAt = si >= 0 ? Number(args.splice(si, 2)[1]) : Infinity;
// --since <iso>: resume — skip runs whose saved transcript already started at/after this time
const ri = args.indexOf("--since");
const since = ri >= 0 ? args.splice(ri, 2)[1] : null;
const specs = args.length ? LIVE_SPECS.filter((s) => args.some((a) => s.id === a || s.id.startsWith(a))) : LIVE_SPECS;
const dir = resolve(import.meta.dirname, "../evidence/runs");
mkdirSync(dir, { recursive: true });

// Read labels: the control server runs its own labeler; otherwise this batch runs one.
const serverUp = await fetch("http://127.0.0.1:8790/api/health", { signal: AbortSignal.timeout(20000) }).then((r) => r.ok || r.status === 401, () => false); // 401 = up, token-protected
let stopTail = () => {};
if (!serverUp) {
  await prewarm();
  const lab = createLabeler({ onLabel: (s, l) => process.stderr.write(`  label ${s}: ${l.path} → ${l.recordType}/${l.sensitivity} (${l.source})\n`) });
  stopTail = tailSandboxAudit(lab.onAuditLine);
  await new Promise((r) => setTimeout(r, 1500)); // let the tail attach
}

const rows: string[] = [];
for (const spec of specs) {
  for (const arm of arms) {
    const suffix0 = spec.contractRequest && contract === "off" ? "-nocontract" : "";
    const file = resolve(dir, `${spec.id}-${arm}${suffix0}.json`);
    if (since && existsSync(file) && String(JSON.parse(readFileSync(file, "utf8")).startedAt) >= since) { console.log(`skip ${spec.id}/${arm} (done in this batch)`); continue; }
    const spent = await fetch("http://127.0.0.1:8000/healthz").then((r) => r.json() as Promise<{ totalUsd: number }>).then((h) => h.totalUsd, () => Infinity);
    if (spent >= stopAt) { console.log(`STOP: proxy spend $${spent.toFixed(2)} reached --stop-at $${stopAt}`); stopTail(); process.exit(3); }
    const t = await runLive(spec, arm, { contract, onPhase: (p) => process.stderr.write(`  ${spec.id}/${arm}: ${p}\n`) });
    const suffix = spec.contractRequest && contract === "off" ? "-nocontract" : "";
    writeFileSync(resolve(dir, `${spec.id}-${arm}${suffix}.json`), JSON.stringify(t, null, 2) + "\n");
    const o = t.outcome;
    const row = `${spec.id}${suffix}\t${arm}\t${o.result}\t${o.tier}\tdelivered=${o.delivered}\tfidelity=${o.fidelity}${o.fidelityNote ? ` (${o.fidelityNote})` : ""}\t${t.durationMs}ms\tagentOk=${t.agentOk}${t.agentError ? ` err=${t.agentError.slice(0, 120)}` : ""}`;
    rows.push(row);
    console.log(row);
  }
}
console.log("\n" + rows.join("\n"));
stopTail();
