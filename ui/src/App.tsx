import { useBackend, useRoute } from "./lib/hooks";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ScenarioPage } from "./views/ScenarioPage";
import { RunPage } from "./views/RunPage";
import { SplitView } from "./views/SplitView";
import { ApprovePage } from "./views/ApprovePage";
import { ModelHud } from "./components/ModelHud";

function Topbar({ route }: { route: string[] }) {
  const b = useBackend();
  const status = !b.checked ? { cls: "", text: "CHECKING BACKEND" }
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
      </div>
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
      {route[0] !== "approve" && <ErrorBoundary label="model HUD"><ModelHud docked={route[0] === "run" || route[0] === "split"} /></ErrorBoundary>}
      <div className="scanlines" />
    </div>
  );
}
