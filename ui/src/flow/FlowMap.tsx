// The centerpiece: agent → hook/tools → shadow FS → ESCROW WALL → outbox → host sender → recipients, with
// Nebius Token Factory as the only inference exit. Canvas particles stream along the edges per event.
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ReactFlow, ReactFlowProvider, Handle, Position, useReactFlow, useViewport, type Node, type Edge, type EdgeProps, type NodeProps } from "@xyflow/react";
import { AnimatePresence, motion } from "framer-motion";
import { BOX, BARRIER_X, RCPT, WALL_IN, edges as edgeGeo, mapBounds, pathD, rcptBox, samplePath, type EdgeGeo, type Pt } from "./geometry";

/** Below this zoom node text is unreadable: narrower panes pan (and follow the run) instead of shrinking */
const READABLE_ZOOM = 0.6;
import { ParticleField } from "./particles";
import { feedFor, effectDest, TIER_DEFS, type Effect, type RunView } from "../lib/runState";
import { OFFICIALS, ROSTER, scenarioMeta } from "../lib/data";
import type { UiEvent } from "../lib/types";
import { modelName } from "../lib/models";

const C = { white: "#e8eef7", safe: "#2ff5c4", blocked: "#ff3b6b", tf: "#a6dc3c" };

interface Ctx {
  v: RunView;
  pick: (title: string, events: UiEvent[]) => void;
  burstScreen: (x: number, y: number) => void;
  flashes: Record<string, { tone: "safe" | "blocked"; n: number }>;
}
const MapCtx = createContext<Ctx | null>(null);
const useMap = () => useContext(MapCtx)!;

// ---- nodes --------------------------------------------------------------------------------------------

const Handles = () => (<>
  <Handle type="target" position={Position.Left} id="t" style={{ opacity: 0 }} isConnectable={false} />
  <Handle type="source" position={Position.Right} id="s" style={{ opacity: 0 }} isConnectable={false} />
</>);

function Flash({ id }: { id: string }) {
  const f = useMap().flashes[id];
  if (!f) return null;
  return <div key={f.n} className={`station flash-${f.tone}`} style={{ position: "absolute", inset: -1, background: "transparent", pointerEvents: "none", borderColor: "transparent" }} />;
}

const NODE_EVENTS: Record<string, (e: UiEvent) => boolean> = {
  agent: (e) => (e.type === "model_call" && e.role === "agent") || e.type === "tool_call" || e.type === "run_phase",
  hook: (e) => e.type === "tool_call",
  records: (e) => (e.type === "tool_call" && e.tool === "read") || e.type === "read_label",
  shadow: (e) => e.type === "shadow_write" || e.type === "effect_queued" || (e.type === "tool_call" && e.class === "shadow"),
  wall: (e) => ["tier_verdict", "commit", "judge_call", "baseline_release", "abort"].includes(e.type),
  outbox: (e) => e.type === "commit" || e.type === "baseline_release" || e.type === "outbox_send",
  sender: (e) => e.type === "outbox_send",
  tf: (e) => e.type === "model_call" || e.type === "judge_call",
  contract: (e) => e.type.startsWith("contract_"),
};

interface StationData { id: string; [k: string]: unknown }
const Station = memo(function Station({ data }: NodeProps<Node<StationData>>) {
  const { v, pick } = useMap();
  const id = data.id;
  const fx = v.effectOrder.map((x) => v.effects[x]);
  const models = v.log.filter((e) => e.type === "model_call");
  let k = "", t = "", s: ReactNode = "", n: ReactNode = null, cls = "", ico = "";
  switch (id) {
    case "agent": {
      const agentCalls = models.filter((m) => m.role === "agent").length;
      k = "Assistant"; t = "TA assistant"; ico = "◆";
      s = v.status === "awaiting_approval" ? "Waiting for the task contract…" : v.status === "done" ? "Turn finished" : v.status === "starting" ? "Starting…" : "Super · in the sandbox";
      n = <><span><b>{v.toolCalls}</b> tool calls</span><span><b>{agentCalls}</b> turns</span></>;
      cls = v.status === "awaiting_approval" ? "paused" : v.status === "running" || v.status === "verifying" ? "hot" : "";
      break;
    }
    case "hook": {
      const blocked = v.log.filter((e) => e.type === "tool_call" && e.decision === "blocked").length;
      k = "before_tool_call"; t = "Escrow hook"; ico = "⌁";
      s = v.arm === "escrow" ? "Routes writes to shadow, effects to escrow" : "Baseline: checks each effect alone";
      n = <><span><b>{v.toolCalls}</b> seen</span>{blocked ? <span style={{ color: "var(--blocked)" }}><b style={{ color: "inherit" }}>{blocked}</b> blocked</span> : null}</>;
      cls = blocked ? "danger" : "";
      break;
    }
    case "records": {
      const high = v.labels.filter((l) => l.sensitivity === "high").length;
      k = "read-only · Nano-labeled"; t = "Student records"; ico = "◎"; s = v.labels.length ? `Nano: ${v.labels.length} labeled · ${high} high` : "Synthetic, FERPA-protected";
      n = <span><b>{v.reads}</b> reads</span>; cls = high ? "hot" : ""; break;
    }
    case "shadow":
      k = "shadow FS"; t = "Staged writes"; ico = "▤"; s = "Nothing touches the real workspace before commit";
      n = <><span><b>{v.shadowWrites}</b> files</span><span><b>{fx.filter((x) => x.kind).length}</b> effects</span></>; break;
    case "outbox": {
      const q = fx.filter((x) => x.status === "in_outbox").length;
      k = "sandbox outbox"; t = "Outbox"; ico = "⇥"; s = v.arm === "escrow" ? "Only committed effects land here" : "Released per call";
      n = <><span><b>{q}</b> queued</span></>;
      cls = q ? (fx.some((x) => x.status === "in_outbox" && x.leak) ? "danger" : "hot") : "";
      break;
    }
    case "sender": {
      const sent = fx.filter((x) => x.status === "sent").length, rej = fx.filter((x) => x.status === "rejected").length;
      k = "host side · outside sandbox"; t = "Host sender"; ico = "✉"; s = "Re-verifies, then delivers";
      n = <><span><b>{sent}</b> sent</span>{rej ? <span><b>{rej}</b> rejected</span> : null}</>; break;
    }
    case "tf": {
      const last = models[models.length - 1];
      k = "Only exit"; t = "Inference"; ico = "⬢";
      s = last ? `${modelName(last.model)} · ${last.ms ?? "?"} ms` : "Ultra · Super · Nano";
      n = <span><b>{models.length}</b> model calls</span>; cls = "tf"; break;
    }
    case "contract": {
      const c = v.contract;
      k = "Ultra"; t = "Task contract"; ico = "✎";
      s = !c ? "No contract for this run" : c.status === "pending" ? "Awaiting your approval" : c.status === "approved" ? `${c.allowedRecipients.length} recipient(s) · ${c.allowedActions.length} action(s)` : "Rejected";
      cls = !c ? "dimmed" : c.status === "pending" ? "paused" : c.status === "approved" ? "hot" : "danger";
      break;
    }
  }
  return (
    <div className={`station ${cls}`} onClick={() => pick(t, v.log.filter(NODE_EVENTS[id] ?? (() => false)))}>
      <Handles />
      <Flash id={id} />
      {id === "agent" && v.status === "awaiting_approval" && <span className="paused-tag">PAUSED</span>}
      <div className="st-k">{ico && <span className="ico">{ico}</span>}{k}</div>
      <div className="st-t">{t}</div>
      <div className="st-s">{s}</div>
      {n && <div className="st-n">{n}</div>}
    </div>
  );
});

function recipientKind(r: string): string {
  if (r.startsWith("lms://")) return "institution gradebook";
  if (OFFICIALS.includes(r.toLowerCase())) return "course staff";
  if (ROSTER.some((s) => s.email === r.toLowerCase())) return "student";
  return "outside";
}

const Recipient = memo(function Recipient({ data }: NodeProps<Node<StationData>>) {
  const { v, pick } = useMap();
  const r = String(data.r);
  const mine = v.effectOrder.map((x) => v.effects[x]).filter((x) => x.to.includes(r) || x.target === r);
  const got = mine.filter((x) => x.status === "sent");
  const leaked = got.some((x) => x.leak);
  const kind = recipientKind(r);
  return (
    <div className={`station recipient ${leaked ? "leaked" : got.length ? "got" : ""}`} onClick={() => pick(r, mine.flatMap((x) => x.events))}>
      <Handles />
      <Flash id={`r:${r}`} />
      <div className="st-k" style={{ justifyContent: "space-between" }}><span>{kind}</span>{leaked ? <span className="badge-sm leak">LEAKED</span> : got.length ? <span className="badge-sm ok">DELIVERED</span> : null}</div>
      <div className="st-t">{r}</div>
      <div className="st-n"><span><b>{got.length}</b> received</span>{mine.some((x) => x.status.startsWith("blocked")) ? <span style={{ color: "var(--blocked)" }}>{mine.filter((x) => x.status.startsWith("blocked")).length} stopped</span> : null}</div>
    </div>
  );
});

function Chip({ x, onGone }: { x: Effect; onGone: (id: string) => void }) {
  const { burstScreen } = useMap();
  const ref = useRef<HTMLDivElement>(null);
  const blocked = x.status === "blocked";
  useEffect(() => {
    if (!blocked) return;
    const t = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) burstScreen(r.left + r.width / 2, r.top + r.height / 2);
      onGone(x.id);
    }, 1100);
    return () => clearTimeout(t);
  }, [blocked]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <motion.div ref={ref} layout className={`fx-chip ${blocked ? "blocked" : ""}`}
      initial={{ opacity: 0, x: -30, scale: 0.9 }}
      animate={blocked ? { opacity: 1, x: [0, -5, 5, -4, 4, 0], scale: 1 } : { opacity: 1, x: 0, scale: 1 }}
      exit={blocked ? { opacity: 0, scale: 1.35, filter: "blur(8px)", transition: { duration: 0.3 } } : { opacity: 0, x: 90, transition: { duration: 0.45 } }}
      transition={{ duration: blocked ? 0.5 : 0.35 }}>
      <div className="to">{x.kind === "send_email" ? "✉" : "⇪"} {effectDest(x)}</div>
      <div className="bd">{x.body || x.subject || "…"}</div>
    </motion.div>
  );
}

const Wall = memo(function Wall() {
  const { v, pick } = useMap();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const fx = v.effectOrder.map((x) => v.effects[x]);
  const visible = fx.filter((x) => x.status === "held" || (x.status === "blocked" && !gone.has(x.id)));
  const baseline = v.arm === "baseline";
  const lastAttempt = v.attempts[v.attempts.length - 1];
  const blocked = !baseline && v.status !== "verifying" && lastAttempt?.ok === false && !fx.some((x) => x.status === "held" && x.attempt > lastAttempt.n);
  const shown = visible.slice(-5);
  return (
    <div className={`wall ${baseline ? "baseline" : ""} ${blocked ? "blocked" : ""}`} onClick={() => pick(baseline ? "Per-call filter" : "Escrow wall", v.log.filter(NODE_EVENTS.wall))}>
      <Handles />
      <div className="bay">
        <div className="st-k">{baseline ? "NO ESCROW" : `HELD IN ESCROW · ${fx.filter((x) => x.status === "held").length}`}</div>
        {visible.length > shown.length && <div className="bay-more">+{visible.length - shown.length} more</div>}
        <AnimatePresence mode="popLayout">
          {shown.map((x) => <Chip key={x.id} x={x} onGone={(id) => setGone((g) => new Set(g).add(id))} />)}
        </AnimatePresence>
        {!visible.length && <div className="bay-empty">{baseline ? "Each effect is checked\nalone and released\nimmediately." : "Effects wait here\nuntil the session\nis verified."}</div>}
      </div>
      <div className="barrier">
        {TIER_DEFS.map((d, i) => <div key={d.id} className={`seg ${baseline ? "" : v.tiers[i].state}`} />)}
      </div>
      <div className="labels">
        <div className="wt">{baseline ? "PER-CALL FILTER" : blocked ? "BLOCKED" : "ESCROW WALL"}</div>
        {TIER_DEFS.map((d, i) => {
          const t = v.tiers[i];
          const st = baseline ? "" : t.state;
          const label = baseline ? (i === 1 ? "exact match, per call" : "—") : st === "idle" ? "" : st === "scanning" ? "checking…" : st === "skip" ? "skipped" : st === "pass" ? `pass${t.ms != null ? ` · ${Number(t.ms).toFixed(t.ms < 10 ? 1 : 0)} ms` : ""}` : (t.detail ?? "LEAK");
          return (
            <div key={d.id} className={`tl ${st}`} onClick={(e) => { if (t.event) { e.stopPropagation(); pick(`${d.label}`, [t.event]); } }}>
              <b>{d.short}</b><span>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

const nodeTypes = { station: Station, wall: Wall, recipient: Recipient };

// ---- edges --------------------------------------------------------------------------------------------

function GlowEdge({ data }: EdgeProps<Edge<{ geo: EdgeGeo }>>) {
  const g = data!.geo, d = pathD(g);
  const color = g.kind === "inference" ? "rgba(166,220,60,0.45)" : g.kind === "control" ? "rgba(232,238,247,0.25)" : "rgba(150,175,210,0.28)";
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth={g.kind === "main" ? 6 : 4} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} strokeDasharray={g.kind === "main" ? undefined : "5 6"} />
    </g>
  );
}
const edgeTypes = { glow: GlowEdge };

// ---- the map ------------------------------------------------------------------------------------------

/** Where the camera should look for an event (narrow panes only) */
function cameraStation(e: UiEvent): string | null {
  switch (e.type) {
    case "contract_drafted": case "contract_decided": return "contract";
    case "tool_call": return e.tool === "escrow_commit" ? "wall" : e.tool === "read" || e.decision === "blocked" ? "hook" : "shadow";
    case "effect_queued": case "tier_verdict": case "commit": case "judge_call": return "wall";
    case "baseline_release": return e.released ? "outbox" : "wall";
    case "outbox_send": return "sender";
    default: return null;
  }
}

function Inner({ runId, v, onPick }: { runId: string; v: RunView; onPick: (title: string, events: UiEvent[]) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const field = useRef<ParticleField | null>(null);
  const rf = useReactFlow();
  const vp = useViewport();
  const [flashes, setFlashes] = useState<Ctx["flashes"]>({});
  const [banner, setBanner] = useState<{ tone: "safe" | "blocked"; title: string; sub: string; n: number } | null>(null);
  const nR = Math.max(1, v.recipients.length);
  const geo = useMemo(() => edgeGeo(nR), [nR]);
  const recipientsKey = v.recipients.join("|");

  if (field.current) field.current.vp = vp;

  /** Fit the known layout into the pane ourselves: no dependence on React Flow having measured new nodes.
   *  A pane too narrow to show the whole map at a readable zoom (laptop rail layout, phones) keeps that zoom instead,
   *  becomes draggable, and the camera follows the run from station to station. */
  const nRef = useRef(nR); nRef.current = nR;
  const cam = useRef({ pan: false, focusX: BOX.hook.x + BOX.hook.w / 2 });
  const [panMode, setPanMode] = useState(false);
  const fit = (animate: boolean) => {
    const el = wrap.current; if (!el) return;
    const W = el.clientWidth, H = el.clientHeight; if (!W || !H) return;
    const bnd = mapBounds(nRef.current);
    const fitZoom = Math.min(W / bnd.w, H / bnd.h, 1.6);
    const pan = fitZoom < READABLE_ZOOM && H / bnd.h > fitZoom * 1.15;
    cam.current.pan = pan;
    setPanMode(pan);
    if (!pan) {
      void rf.setViewport({ x: (W - bnd.w * fitZoom) / 2 - bnd.x * fitZoom, y: (H - bnd.h * fitZoom) / 2 - bnd.y * fitZoom, zoom: fitZoom }, { duration: animate ? 250 : 0 });
      return;
    }
    const zoom = Math.min(READABLE_ZOOM, H / bnd.h);
    const x = Math.min(-bnd.x * zoom, Math.max(W - (bnd.x + bnd.w) * zoom, W / 2 - cam.current.focusX * zoom));
    void rf.setViewport({ x, y: (H - bnd.h * zoom) / 2 - bnd.y * zoom, zoom }, { duration: animate ? 650 : 0 });
  };
  /** Camera: center on a station (or flow x) when panning; no-op when the whole map fits */
  const focus = (target: string | number) => {
    const x = typeof target === "number" ? target : target.startsWith("r:") ? RCPT.x : BOX[target] ? BOX[target].x + BOX[target].w / 2 : null;
    if (x === null || Math.abs(x - cam.current.focusX) < 1) return;
    cam.current.focusX = x;
    if (cam.current.pan) fit(true);
  };
  const focusRef = useRef(focus); focusRef.current = focus;

  const nodes: Node[] = useMemo(() => {
    const st = (id: string): Node => ({ id, type: "station", position: { x: BOX[id].x, y: BOX[id].y }, data: { id }, style: { width: BOX[id].w, height: BOX[id].h }, draggable: false, selectable: false });
    const rs = v.recipients.length ? v.recipients : [];
    return [
      st("contract"), st("tf"), st("agent"), st("hook"), st("records"), st("shadow"),
      { id: "wall", type: "wall", position: { x: BOX.wall.x, y: BOX.wall.y }, data: { id: "wall" }, style: { width: BOX.wall.w, height: BOX.wall.h }, draggable: false, selectable: false },
      st("outbox"), st("sender"),
      ...rs.map((r, i) => { const b = rcptBox(i, rs.length); return { id: `r:${r}`, type: "recipient", position: { x: b.x, y: b.y }, data: { id: `r:${r}`, r }, style: { width: b.w, height: b.h }, draggable: false, selectable: false } as Node; }),
    ];
  }, [recipientsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const edges: Edge[] = useMemo(() => geo.filter((g) => !g.id.startsWith("sender-r") || v.recipients.length).map((g) => {
    const [source, target] = g.id === "shadow-wall" ? ["shadow", "wall"] : g.id === "wall-outbox" ? ["wall", "outbox"] : g.id.startsWith("sender-r") ? ["sender", `r:${v.recipients[Number(g.id.slice(8))]}`] : g.id.split("-");
    return { id: g.id, source, target, sourceHandle: "s", targetHandle: "t", type: "glow", data: { geo: g }, selectable: false, focusable: false };
  }), [geo, recipientsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // particle field lifecycle + fit on resize
  useEffect(() => {
    const f = new ParticleField(canvas.current!);
    field.current = f;
    const ro = new ResizeObserver(() => { f.resize(); fit(false); });
    ro.observe(wrap.current!);
    return () => { ro.disconnect(); f.destroy(); field.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fit(true); }, [recipientsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ambient = geo.filter((g) => g.kind === "main").map((g) => samplePath(g));
    field.current?.setAmbient(ambient);
  }, [geo]);

  // events → particles
  const vRef = useRef(v); vRef.current = v;
  useEffect(() => {
    const flash = (id: string, tone: "safe" | "blocked") => setFlashes((f) => ({ ...f, [id]: { tone, n: (f[id]?.n ?? 0) + 1 } }));
    const byId = () => new Map(edgeGeo(Math.max(1, vRef.current.recipients.length)).map((g) => [g.id, g]));
    const route = (...ids: string[]): Pt[] => { const m = byId(); return ids.flatMap((id) => { const rev = id.startsWith("~"); const g = m.get(rev ? id.slice(1) : id); return g ? samplePath(g, rev) : []; }); };
    const center = (id: string): Pt => ({ x: BOX[id].x + BOX[id].w / 2, y: BOX[id].y + BOX[id].h / 2 });
    const go = (pts: Pt[], color: string, e: UiEvent, o: { size?: number; speed?: number; delay?: number; label?: string; onArrive?: () => void } = {}) => field.current?.travel(pts, { color, event: e, ...o });
    const banner_ = (tone: "safe" | "blocked", title: string, sub: string) => setBanner((b) => ({ tone, title, sub, n: (b?.n ?? 0) + 1 }));

    return feedFor(runId).subscribe((e, view, prev) => {
      const f = field.current; if (!f) return;
      const station = cameraStation(e);
      if (station) focusRef.current(station);
      switch (e.type) {
        case "model_call": {
          const role = e.role;
          if (role === "judge") go(route("tf-wall"), C.tf, e, { size: 3.5, speed: 1.1 });
          else if (role === "contract") go(route("tf-contract"), C.tf, e, { size: 4, onArrive: () => flash("contract", "safe") });
          else if (role === "labeler") go(route("tf-agent", "agent-hook", "hook-records"), C.tf, e, { size: 3.5, speed: 1.4, onArrive: () => flash("records", "safe") });
          else { go(route("~tf-agent"), C.tf, e, { size: 2.6, speed: 1.3 }); go(route("tf-agent"), C.tf, e, { size: 3.5, speed: 1.1, delay: 380 }); }
          break;
        }
        case "read_label": flash("records", "safe"); break;
        case "contract_decided": {
          const ok = (e.contract as { status: string }).status === "approved";
          if (ok) go(route("contract-hook"), C.safe, e, { size: 5, onArrive: () => flash("hook", "safe") });
          else f.burst(center("contract"), C.blocked);
          break;
        }
        case "tool_call": {
          const blocked = e.decision === "blocked";
          if (blocked) { go(route("agent-hook"), C.white, e, { onArrive: () => { f.burst(center("hook"), C.blocked, { n: 30 }); flash("hook", "blocked"); } }); break; }
          if (e.tool === "read") go(route("agent-hook", "hook-records"), C.white, e, { size: 3.5, onArrive: () => go(route("~hook-records", "~agent-hook"), "rgba(200,215,240,0.9)", e, { size: 2.5, speed: 1.2 }) });
          else if (e.tool === "escrow_commit") go(route("agent-hook", "hook-shadow", "shadow-wall"), C.white, e, { size: 6, speed: 1.15, onArrive: () => f.ring(WALL_IN, C.white) });
          else if (e.tool === "escrow_send_email" || e.tool === "escrow_write_external" || e.class === "shadow") go(route("agent-hook", "hook-shadow"), C.white, e, { size: 4 });
          break;
        }
        case "effect_queued": go(route("shadow-wall"), C.white, e, { size: 4.5, label: "held" }); break;
        case "baseline_release": {
          const x = view.effects[String(e.effectId)];
          if (e.released) go(route("shadow-wall", "wall-outbox"), x?.leak ? C.blocked : C.safe, e, { size: 5, onArrive: () => flash("outbox", x?.leak ? "blocked" : "safe") });
          else go(route("shadow-wall"), C.white, e, { size: 5, onArrive: () => { f.burst({ x: BARRIER_X, y: WALL_IN.y }, C.blocked, { n: 34 }); flash("hook", "blocked"); } });
          break;
        }
        case "commit": {
          const a = view.attempts[view.attempts.length - 1];
          if (e.ok) {
            a?.effectIds.forEach((id, i) => go(route("wall-outbox"), C.safe, e, { size: 5, delay: 250 + i * 220, onArrive: () => flash("outbox", "safe") }));
            if (a?.afterBlock) banner_("safe", `${(scenarioMeta(view.scenario).retryLabel ?? "safe reply").toUpperCase()} RELEASED`, "The assistant's new reply passed every tier and was released.");
            else banner_("safe", "COMMITTED", `${a?.effectIds.length ?? 0} effect(s) verified — released to the outbox`);
          } else {
            f.ring({ x: BARRIER_X, y: WALL_IN.y }, C.blocked);
            const why = view.tiers.find((t) => t.state === "fail");
            banner_("blocked", view.leaks ? "LEAK BLOCKED AT COMMIT" : "BLOCKED AT COMMIT", `${why ? `${TIER_DEFS.find((d) => d.id === why.id)?.label} → ${why.detail}` : "fail closed"} — ${a?.effectIds.length ?? 0} held effect(s) destroyed`);
          }
          break;
        }
        case "outbox_send": {
          const x = view.effects[String(e.effectId)];
          const r = x ? (x.to[0] ?? x.target) : undefined;
          const i = r ? view.recipients.indexOf(r) : -1;
          if (e.status === "sent" && i >= 0) {
            const leak = !!x?.leak;
            go(route("outbox-sender", `sender-r${i}`), leak ? C.blocked : C.safe, e, { size: 5.5, onArrive: () => { flash(`r:${r}`, leak ? "blocked" : "safe"); if (leak) { f.burst({ x: rcptBox(i, view.recipients.length).x + 20, y: rcptBox(i, view.recipients.length).y + 39 }, C.blocked, { n: 18, power: 0.6 }); banner_("blocked", "LEAKED", `Record data delivered to ${r}`); } } });
          } else if (e.status === "rejected") go(route("outbox-sender"), C.white, e, { onArrive: () => f.burst(center("sender"), C.blocked) });
          break;
        }
      }
      void prev;
    });
  }, [runId]);

  useEffect(() => { if (!banner) return; const t = setTimeout(() => setBanner(null), 3200); return () => clearTimeout(t); }, [banner?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx: Ctx = {
    v, pick: onPick, flashes,
    burstScreen: (x, y) => { const r = wrap.current?.getBoundingClientRect(); if (r) field.current?.burst({ x: x - r.left, y: y - r.top }, C.blocked, { screen: true, n: 42, power: 1.3 }); },
  };

  return (
    <MapCtx.Provider value={ctx}>
      <div className="flow" ref={wrap} onClickCapture={(ev) => {
        const r = wrap.current!.getBoundingClientRect();
        const t = field.current?.hit(ev.clientX - r.left, ev.clientY - r.top);
        if (t?.event) { ev.stopPropagation(); onPick(`Particle · ${t.event.type}${t.event.tool ? ` · ${t.event.tool}` : ""}`, [t.event]); }
      }}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={() => fit(false)}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} zoomOnDoubleClick={false} panOnDrag={panMode}
          preventScrolling={false} onNodeClick={() => { /* nodes handle their own clicks; this keeps them clickable */ }} minZoom={0.2} maxZoom={1.6} proOptions={{ hideAttribution: true }} />
        <canvas ref={canvas} className="particles" style={{ width: "100%", height: "100%" }} />
        {panMode && <div className="pan-hint">⇆ drag to explore · camera follows the run</div>}
        <AnimatePresence>
          {banner && (
            <motion.div key={banner.n} className={`banner ${banner.tone}`} initial={{ opacity: 0, y: -16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.35 }}>
              <div className="bt">{banner.title}</div><div className="bs">{banner.sub}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MapCtx.Provider>
  );
}

export function FlowMap(p: { runId: string; v: RunView; onPick: (title: string, events: UiEvent[]) => void }) {
  return <ReactFlowProvider><Inner key={p.runId} {...p} /></ReactFlowProvider>;
}
