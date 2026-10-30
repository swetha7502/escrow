import { useState } from "react";
import { createPortal } from "react-dom";
import { useBackend, useRoute } from "./lib/hooks";
import { getToken, setToken } from "./lib/backend";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ScenarioPage } from "./views/ScenarioPage";
import { RunPage } from "./views/RunPage";
import { SplitView } from "./views/SplitView";
import { ApprovePage } from "./views/ApprovePage";
import { ModelHud } from "./components/ModelHud";

function TokenPrompt({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState("");
  // Portal: the header's backdrop-filter would otherwise trap a fixed-position overlay inside it
  return createPortal(
    <div className="modal-veil" style={{ position: "fixed", zIndex: 70 }} onClick={onDone}>
      <form className="contract" style={{ padding: 22, maxWidth: 440 }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); setToken(v || null); onDone(); }}>
        <div className="kicker">Live backend access</div>
        <h3 style={{ margin: "8px 0 6px" }}>Enter the demo access token</h3>
        <p className="muted" style={{ margin: "0 0 14px", lineHeight: 1.5, fontSize: 13 }}>Kept in this browser only. Without it, every run is a recorded replay (CACHED).</p>
        <input autoFocus type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="access token" style={{ width: "100%", height: 42, borderRadius: 10, border: "1px solid var(--line-hi)", background: "rgba(255,255,255,0.04)", color: "var(--text)", padding: "0 12px", font: "inherit" }} />
        <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "flex-end" }}>
          {getToken() && <button type="button" className="btn ghost" onClick={() => { setToken(null); onDone(); }}>Forget token</button>}
          <button type="submit" className="btn escrow">Save</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function Topbar({ route }: { route: string[] }) {
  const b = useBackend();
  const [asking, setAsking] = useState(false);
  const status = !b.checked ? { cls: "", text: "CHECKING BACKEND" }
    : b.locked ? { cls: "", text: "LIVE LOCKED · CACHED REPLAYS" }
    : b.online && b.health?.liveRuns === "off" ? { cls: "", text: "LIVE RUNS OFF · CACHED REPLAYS" }
    : b.online && b.liveReady ? { cls: "safe", text: `LIVE · SANDBOX ${b.health?.sandbox.phase.toUpperCase()}` }
    : b.online ? { cls: "", text: `BACKEND UP · ${b.reason?.toUpperCase() ?? "LIVE UNAVAILABLE"} → CACHED` }
    : { cls: "", text: "OFFLINE · CACHED REPLAYS" };
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        <span className="brand-mark"><i /><b /><b /></span>
        <span>
          <div className="brand-name">ESCROW</div>
          <div className="brand-sub">verified-exit safety layer · NemoClaw TA agent</div>
        </span>
      </a>
      <nav className="nav">
        <a href="#/" className={!route[0] ? "on" : ""}>Scenarios</a>
        <a href="#/approve" className={route[0] === "approve" ? "on" : ""}>Approvals</a>
      </nav>
      <div className="spacer" />
      <div className="chips">
        <span className="chip hide-sm" title="OpenShell network policy: the sandbox's only egress is inference.local → Nebius Token Factory"><span className="dot" style={{ background: "#76b900", boxShadow: "0 0 8px #76b900" }} />EGRESS · TOKEN FACTORY ONLY</span>
        <span className={`chip ${status.cls}`} title={b.reason ?? ""}><span className="dot" />{status.text}</span>
        {/* live access only when a backend answers; the static (Vercel) site with no tunnel is cached-only */}
        {(b.locked || (b.online && getToken())) && <button className="chip" onClick={() => setAsking(true)} title="Shared access token for the live backend (kept in this browser only)">{b.locked ? "UNLOCK LIVE" : "TOKEN ✓"}</button>}
      </div>
      {asking && <TokenPrompt onDone={() => setAsking(false)} />}
    </header>
  );
}

export function App() {
  const route = useRoute();
  let view;
  if (route[0] === "run" && route[1] && (route[2] === "baseline" || route[2] === "escrow")) view = <RunPage key={route.join("/") + location.hash} scenario={route[1]} arm={route[2]} />;
  else if (route[0] === "split" && route[1]) view = <SplitView key={route.join("/") + location.hash} scenario={route[1]} />;
  else if (route[0] === "approve") view = <ApprovePage key={route[1] ?? ""} id={route[1]} />;
  else view = <ScenarioPage />;
  return (
    <div className="app">
      <div className="backdrop" />
      <Topbar route={route} />
      <ErrorBoundary key={route.join("/")} label={route[0] ?? "scenarios"}>{view}</ErrorBoundary>
      {route[0] !== "approve" && <ErrorBoundary label="model HUD"><ModelHud docked={route[0] === "run" || route[0] === "split"} startMin={route[0] === "split"} /></ErrorBoundary>}
      <div className="scanlines" />
    </div>
  );
}
