import { useCallback, useEffect, useState } from "react";
import { modelStore } from "../lib/modelStore";
import { useBackend, useRunView, query, go } from "../lib/hooks";
import { backend, backendReady } from "../lib/backend";
import { scenarioMeta } from "../lib/data";
import { RunBadge } from "../components/RunBadge";
import { Beats, Inspector, Outcome, useLiveWatchdog, useStartedRun, type Picked } from "../components/RunParts";
import { FlowMap } from "../flow/FlowMap";
import type { Arm } from "../lib/types";
import type { RunView } from "../lib/runState";

function Pane({ arm, runId, v, waiting }: { arm: Arm; runId: string | null; v: RunView | null; waiting?: string }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  return (
    <div className="pane">
      <div style={{ position: "relative", minHeight: 0 }}>
        {runId && v ? <FlowMap runId={runId} v={v} onPick={(title, events) => setPicked({ title, events })} /> : null}
        {waiting && <div className="pane-wait"><div className="kicker">waiting</div><div>{waiting}</div></div>}
        <Inspector picked={picked} onClose={() => setPicked(null)} />
      </div>
      <div className="pane-rail">
        <div className="pane-top">
          <span className={`arm-label ${arm}`} style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", padding: "5px 10px", borderRadius: 6 }}>{arm}</span>
          {waiting ? <span className="runbadge pending">QUEUED</span> : <RunBadge v={v} />}
        </div>
        <Outcome v={v} />
        <Beats compact beats={v?.beats ?? []} onPick={(e, title) => setPicked({ title, events: [e] })} />
      </div>
    </div>
  );
}

export function SplitView({ scenario }: { scenario: string }) {
  const b = useBackend();
  const forced = query("mode") === "cached";
  const mode = forced ? "cached" : "auto";
  // One live scenario at a time in the sandbox: live runs go baseline, then escrow. Cached replays run in lockstep.
  // Decide only after the first health check: deciding earlier (backend "not online" yet) fired both live runs at once
  const [sequential, setSequential] = useState<boolean | null>(forced ? false : null);
  useEffect(() => { if (forced) return; let gone = false; void backendReady().then(() => { if (!gone) { const s = backend.get(); setSequential(s.online && s.liveReady); } }); return () => { gone = true; }; }, [forced]);
  const [layout, setLayout] = useState<"rows" | "cols">(() => (query("layout") === "cols" ? "cols" : "rows"));
  const [nonce, setNonce] = useState(0);
  const baseId = useStartedRun(scenario, "baseline", mode, nonce, sequential !== null);
  const base = useRunView(baseId);
  const baseDone = base?.status === "done" || base?.status === "failed";
  const escId = useStartedRun(scenario, "escrow", mode, nonce, sequential === null ? false : sequential ? baseDone : true);
  const esc = useRunView(escId);
  useEffect(() => { modelStore.setFocus([baseId, escId]); return () => modelStore.setFocus([]); }, [baseId, escId]);
  const onLost = useCallback((why: string) => { sessionStorage.setItem("escrow.fallback", why); go(`/split/${scenario}?mode=cached&from=live`); }, [scenario]);
  useLiveWatchdog(base, b.ws === "open", onLost);
  useLiveWatchdog(esc, b.ws === "open", onLost);
  const meta = scenarioMeta(scenario);
  const done = baseDone && (esc?.status === "done" || esc?.status === "failed");
  return (
    <>
      <div className="runhead">
        <button className="btn ghost" onClick={() => go("/")}>←</button>
        <span className="kicker" style={{ color: "var(--text)" }}>Side by side</span>
        <h2>{meta.title}</h2>
        <span className="muted" style={{ fontSize: 13 }}>{sequential ? "Live: baseline runs first, then escrow (one sandbox)." : "Same recorded scenario, both arms in lockstep."}</span>
        <div className="spacer" />
        <button className="btn" onClick={() => setLayout(layout === "rows" ? "cols" : "rows")}>{layout === "rows" ? "Columns ▥" : "Rows ▤"}</button>
        {!forced && b.online && <button className="btn" onClick={() => go(`/split/${scenario}?mode=cached`)}>Cached lockstep</button>}
        <button className="btn escrow" disabled={!done} onClick={() => setNonce((n) => n + 1)}>Run again</button>
      </div>
      <div className={`split ${layout}`}>
        <Pane arm="baseline" runId={baseId} v={base} />
        <Pane arm="escrow" runId={escId} v={esc} waiting={sequential && !baseDone ? "The sandbox runs one live scenario at a time — escrow starts when baseline finishes." : undefined} />
      </div>
    </>
  );
}
