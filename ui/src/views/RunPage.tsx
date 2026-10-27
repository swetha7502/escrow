import { useState } from "react";
import { useRunView, query, go } from "../lib/hooks";
import { scenarioMeta } from "../lib/data";
import { RunBadge } from "../components/RunBadge";
import { Beats, Inspector, Outcome, useStartedRun, type Picked } from "../components/RunParts";
import type { Arm } from "../lib/types";
import { FlowMap } from "../flow/FlowMap";
import { ContractPanel } from "../components/ContractPanel";
import { AnimatePresence, motion } from "framer-motion";

export function RunPage({ scenario, arm }: { scenario: string; arm: Arm }) {
  const mode = query("mode") === "cached" ? "cached" : "auto";
  const [nonce, setNonce] = useState(0);
  const runId = useStartedRun(scenario, arm, mode, nonce);
  const v = useRunView(runId);
  const [picked, setPicked] = useState<Picked | null>(null);
  const meta = scenarioMeta(scenario);
  const done = v?.status === "done" || v?.status === "failed";
  return (
    <div className="runpage">
      <div className="runmain">
        <div className="runhead">
          <button className="btn ghost" onClick={() => go("/")}>←</button>
          <span className={`arm-label ${arm}`}>{arm}</span>
          <h2>{meta.title}</h2>
          <RunBadge v={v} />
          <div className="spacer" />
          <button className="btn" onClick={() => go(`/run/${scenario}/${arm === "escrow" ? "baseline" : "escrow"}`)}>Switch to {arm === "escrow" ? "baseline" : "escrow"}</button>
          <button className="btn" onClick={() => go(`/split/${scenario}`)}>Side by side ⇆</button>
          <button className="btn escrow" disabled={!done} onClick={() => setNonce((n) => n + 1)}>Run again</button>
        </div>
        <div className="mapwrap">
          {runId && v ? <FlowMap runId={runId} v={v} onPick={(title, events) => setPicked({ title, events })} /> : null}
          <AnimatePresence>
            {v?.status === "awaiting_approval" && v.contract && (
              <motion.div className="modal-veil" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <ContractPanel c={v.contract} call={v.contractCall} />
              </motion.div>
            )}
          </AnimatePresence>
          <Inspector picked={picked} onClose={() => setPicked(null)} />
        </div>
      </div>
      <aside className="rail">
        <div className="rail-sec"><Outcome v={v} /></div>
        <Beats beats={v?.beats ?? []} onPick={(e, title) => setPicked({ title, events: [e] })} />
      </aside>
    </div>
  );
}
