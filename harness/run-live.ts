// node harness/run-live.ts [ids...] [--arms baseline,escrow]
// Runs each scenario live under each arm, saves evidence/runs/<id>-<arm>.json, prints a table.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LIVE_SPECS, runLive, type Arm } from "./live.ts";

const args = process.argv.slice(2);
const ai = args.indexOf("--arms");
const arms = (ai >= 0 ? args.splice(ai, 2)[1] : "baseline,escrow").split(",") as Arm[];
// --no-contract: run contract specs without a contract (the control). Unattended runs auto-approve.
const ni = args.indexOf("--no-contract");
const contract = ni >= 0 ? (args.splice(ni, 1), "off" as const) : "auto-approve" as const;
const specs = args.length ? LIVE_SPECS.filter((s) => args.some((a) => s.id === a || s.id.startsWith(a))) : LIVE_SPECS;
const dir = resolve(import.meta.dirname, "../evidence/runs");
mkdirSync(dir, { recursive: true });

const rows: string[] = [];
for (const spec of specs) {
  for (const arm of arms) {
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
