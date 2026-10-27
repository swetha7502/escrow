import type { RunView } from "../lib/runState";

/** LIVE RUN vs CACHED RUN, driven only by the run's cached flag from the event stream. */
export function RunBadge({ v }: { v: RunView | null }) {
  if (!v || v.live === null) return <span className="runbadge pending">CONNECTING…</span>;
  if (v.live) return <span className="runbadge live" title="Real OpenClaw agent in the NemoClaw sandbox, events streaming now"><span className="dot" />LIVE RUN</span>;
  const when = v.recordedAt ? new Date(v.recordedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  return <span className="runbadge cached" title={`Replay of a recorded live run${v.cachedReason ? ` — ${v.cachedReason}` : ""}`}><span className="dot" />CACHED RUN{when ? <span style={{ fontWeight: 400, letterSpacing: "0.04em", opacity: 0.7 }}>· rec. {when}</span> : null}</span>;
}
