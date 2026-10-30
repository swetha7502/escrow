import type { RunView } from "../lib/runState";

type S = "done" | "now" | "todo" | "skip" | "bad";
const OUT = new Set(["sent", "released", "in_outbox"]);
const BLOCKED = new Set(["blocked", "blocked_hook", "blocked_filter", "discarded", "rejected"]);

/** One request, top to bottom: request → contract → approval → the assistant works → held → verified → outcome.
 *  Every step's state comes from the run's own events. */
export function StoryStrip({ v }: { v: RunView | null }) {
  if (!v) return null;
  const escrow = v.arm === "escrow";
  const effects = v.effectOrder.map((id) => v.effects[id]).filter(Boolean);
  const out = effects.filter((e) => OUT.has(e.status)).length;
  const blocked = effects.filter((e) => BLOCKED.has(e.status)).length;
  const ended = v.status === "done" || v.status === "failed";
  const started = v.status !== "starting";
  const c = v.contract;
  const working = v.status === "running" || v.status === "verifying" || ended;

  const steps: { label: string; s: S }[] = [
    { label: "Request", s: "done" },
    { label: c ? "Contract proposed" : "No contract", s: c ? "done" : started ? "skip" : "todo" },
    c?.status === "rejected" ? { label: "Rejected", s: "bad" }
      : { label: c ? "You approve" : "No approval needed", s: !c ? "skip" : c.status === "approved" ? "done" : v.status === "awaiting_approval" ? "now" : "todo" },
    { label: "Assistant works", s: v.status === "running" ? "now" : working ? "done" : "todo" },
    escrow
      ? { label: effects.length ? `Held · ${effects.length}` : "Held", s: effects.length ? (ended || v.status === "verifying" ? "done" : "now") : "todo" }
      : { label: "Not held", s: started ? "skip" : "todo" },
    escrow
      ? { label: "Session verified", s: v.status === "verifying" ? "now" : ended && v.attempts.length ? "done" : "todo" }
      : { label: "Checked one by one", s: effects.length ? "done" : "todo" },
    !ended ? { label: escrow ? "Released or blocked" : "Sent", s: "todo" }
      : !escrow ? { label: v.leakedIds?.length || (v.leaks && out) ? `Leaked · ${out}` : `Sent · ${out}`, s: v.leakedIds?.length || (v.leaks && out) ? "bad" : "done" }
      : blocked && out ? { label: `Blocked, then ${out} released`, s: "done" }
      : blocked ? { label: "Blocked", s: "done" }
      : { label: `Released · ${out}`, s: "done" },
  ];
  const request = c?.request ?? v.desc;
  return (
    <div className="story">
      {request && <div className="story-req"><span className="kicker">Request</span><span className="txt">{request}</span></div>}
      <ol className="story-steps">
        {steps.map((st, i) => (
          <li key={i} className={st.s}><span className="n">{i + 1}</span>{st.label}</li>
        ))}
      </ol>
    </div>
  );
}
