import { useEffect, useState, useSyncExternalStore } from "react";
import { modelStore } from "../lib/modelStore";
import { MODELS, usd } from "../lib/models";
import { useBackend, useTick } from "../lib/hooks";

/** Small persistent panel: which model is active, latency, cost per call, running spend. */
export function ModelHud({ docked, startMin }: { docked?: boolean; startMin?: boolean }) {
  useSyncExternalStore(modelStore.subscribe, modelStore.version);
  useTick(500);
  const b = useBackend();
  const small = () => matchMedia("(max-width: 640px), (max-height: 900px)").matches;
  // Collapsed by default (it floats over page content); expanded only if this viewer opened it before
  const [min, setMin] = useState(true);
  useEffect(() => { if (startMin || small()) { setMin(true); return; } try { setMin(localStorage.getItem("escrow.hud.min") !== "0"); } catch { /* storage unavailable */ } }, [startMin]);
  const toggle = () => { setMin((m) => { try { localStorage.setItem("escrow.hud.min", m ? "0" : "1"); } catch { /* ignore */ } return !m; }); };
  const calls = modelStore.calls();
  const now = Date.now();
  const runUsd = calls.reduce((a, c) => a + (c.usd ?? 0), 0);
  const cached = calls.length > 0 && calls.every((c) => c.cached);
  const total = b.online && b.health?.proxy ? { usd: b.health.proxy.totalUsd, cached: false, cap: b.health.proxy.capUsd } : modelStore.lastTotal();
  const active = calls.length && now - calls[calls.length - 1].at < 1800 ? calls[calls.length - 1].key : null;
  return (
    <div className={`hud ${min ? "min" : ""} ${docked ? "docked" : ""}`} aria-label="Model HUD">
      <header onClick={toggle} style={{ cursor: "pointer" }}>
        <span style={{ color: active ? "var(--safe)" : undefined }}>● </span>
        <span>MODELS</span>
        <span className="spacer" />
        {cached && <span className="badge-sm">RECORDED</span>}
        <span>{min ? "▴" : "▾"}</span>
      </header>
      {MODELS.map((m) => {
        const mine = calls.filter((c) => c.key === m.key);
        const last = mine[mine.length - 1];
        const on = !!last && now - last.at < 1800;
        return (
          <div key={m.key} className={`row ${on ? "active" : ""}`} style={{ opacity: mine.length ? 1 : 0.5 }}>
            <span className="led" />
            <span><span className="name">{m.name}</span> <span className="role">{last?.role && last.role !== "undefined" ? last.role : m.role}</span></span>
            <span className="num">{last?.ms != null ? `${(last.ms / 1000).toFixed(2)}s` : "—"}<br /><small>latency</small></span>
            <span className="num">{last ? usd(last.usd) : "—"}<br /><small>{mine.length} call{mine.length === 1 ? "" : "s"}</small></span>
          </div>
        );
      })}
      <footer>
        <div><span>{cached ? "RUN SPEND (REC.)" : "RUN SPEND"}</span><b>{usd(runUsd)}</b></div>
        <div><span>{total ? (total.cached ? "PROXY TOTAL (REC.)" : "PROXY TOTAL") : "PROXY TOTAL"}</span><b>{total ? `$${total.usd.toFixed(2)}` : "—"}{total && "cap" in total && total.cap ? <small style={{ color: "var(--muted)", fontSize: 10 }}> / ${total.cap}</small> : null}</b></div>
      </footer>
    </div>
  );
}
