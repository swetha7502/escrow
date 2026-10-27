import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { headline, disposeFeed, feedFor, type Beat, type RunView } from "../lib/runState";
import { startRun, cancelRun } from "../lib/runner";
import type { Arm, UiEvent } from "../lib/types";

/** Start a run once per mount/nonce; local replays stop when the view goes away. */
export function useStartedRun(scenario: string, arm: Arm, mode: "auto" | "cached", nonce: number, delayUntil?: boolean) {
  const [runId, setRunId] = useState<string | null>(null);
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (delayUntil === false) return;
    const key = `${scenario}/${arm}/${mode}/${nonce}`;
    if (started.current === key) return;
    started.current = key;
    let id: string | null = null, gone = false;
    setRunId(null);
    void startRun(scenario, arm, { mode }).then((r) => { id = r.id; feedFor(r.id, scenario, arm); if (!gone) setRunId(r.id); });
    return () => { gone = true; if (id) { cancelRun(id); setTimeout(() => disposeFeed(id!), 0); } started.current = null; };
  }, [scenario, arm, mode, nonce, delayUntil]);
  return runId;
}

export function Outcome({ v }: { v: RunView | null }) {
  const h = v ? headline(v) : null;
  const running = v && v.status !== "done" && v.status !== "failed";
  const title = h?.title ?? (v?.status === "awaiting_approval" ? "PAUSED" : running ? (v?.status === "verifying" ? "VERIFYING…" : "RUNNING…") : "—");
  const sub = h?.sub ?? (v?.status === "awaiting_approval" ? "Waiting for you to approve or reject the task contract." : v?.arm === "escrow" ? "Effects are held in escrow until the agent commits." : "Effects are checked one call at a time and released immediately.");
  return (
    <motion.div className={`outcome ${h?.tone ?? (v?.status === "awaiting_approval" ? "pending" : "neutral")}`} key={title} initial={{ opacity: 0.4, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.35 }}>
      <div className="t">{title}</div>
      <div className="s">{sub}</div>
    </motion.div>
  );
}

export function Beats({ beats, onPick, compact }: { beats: Beat[]; onPick: (e: UiEvent, title: string) => void; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }, [beats.length]);
  return (
    <div className="beats" ref={ref}>
      <AnimatePresence initial={false}>
        {beats.map((b) => (
          <motion.div key={b.id} className={`beat ${b.tone} ${b.big ? "big" : ""}`} onClick={() => onPick(b.event, b.text)}
            initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3 }}>
            <div className="i">{b.icon}</div>
            <div><div className="x">{b.text}</div>{b.sub && !(compact && !b.big) ? <div className="sub">{b.sub}</div> : null}</div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

const FACT_KEYS = ["type", "tool", "decision", "tier", "ok", "status", "reason", "note", "model", "role", "ms", "usd", "leak", "effectId", "to", "target", "subject", "body", "cached", "derived", "originalTs"];
export interface Picked { title: string; events: UiEvent[] }
export function Inspector({ picked, onClose }: { picked: Picked | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {picked && (
        <motion.aside className="inspector" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 30 }} transition={{ duration: 0.25 }}>
          <header><span className="kicker">raw event</span><h4>{picked.title}</h4><button className="btn ghost" onClick={onClose} aria-label="close">✕</button></header>
          <div className="body">
            {picked.events.length === 0 && <div className="muted">No events here yet.</div>}
            {picked.events.slice(-12).map((e, i) => {
              const facts = FACT_KEYS.filter((k) => e[k] !== undefined && e[k] !== null && e[k] !== "");
              const viol = e.violations as { rule: string; match?: string; field?: string }[] | undefined;
              return (
                <div key={i}>
                  <div className="evhead"><span>#{e.seq ?? i}</span><span>{e.type}</span><span style={{ flex: 1 }} /><span>{e.cached ? "CACHED" : "LIVE"}</span></div>
                  <dl className="facts">
                    {facts.map((k) => <FactRow key={k} k={k} v={e[k]} />)}
                    {viol?.length ? <><dt>verdict</dt><dd style={{ color: "var(--blocked)" }}>{viol.map((x) => `${x.rule}${x.field ? ` · ${x.field}` : ""}${x.match ? ` · “${x.match}”` : ""}`).join("\n")}</dd></> : null}
                  </dl>
                  <pre>{JSON.stringify(e, null, 2)}</pre>
                </div>
              );
            })}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
function FactRow({ k, v }: { k: string; v: unknown }) {
  const s = typeof v === "object" ? JSON.stringify(v) : k === "usd" ? `$${Number(v).toFixed(5)}` : String(v);
  return <><dt>{k}</dt><dd>{s.length > 400 ? s.slice(0, 400) + "…" : s}</dd></>;
}

/**
 * A live run must never leave the UI hanging: if the event stream drops (or goes silent for too long) while a
 * live run is in progress, call `onLost` so the view can switch to the recorded run, flagged CACHED.
 */
export function useLiveWatchdog(v: RunView | null, wsOpen: boolean, onLost: (why: string) => void) {
  const lastCount = useRef(0), lastAt = useRef(Date.now()), downSince = useRef<number | null>(null);
  useEffect(() => {
    const t = setInterval(() => {
      if (!v || !v.live || v.status === "done" || v.status === "failed" || v.status === "awaiting_approval") { downSince.current = null; return; }
      if (v.log.length !== lastCount.current) { lastCount.current = v.log.length; lastAt.current = Date.now(); }
      if (!wsOpen) downSince.current ??= Date.now(); else downSince.current = null;
      if (downSince.current && Date.now() - downSince.current > 8000) onLost("lost the connection to the backend mid-run");
      else if (Date.now() - lastAt.current > 300000) onLost("the live run went silent for 5 minutes");
    }, 1000);
    return () => clearInterval(t);
  }, [v, wsOpen, onLost]);
}
