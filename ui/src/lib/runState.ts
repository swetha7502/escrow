// One run's view state, built from its event stream. Events are released to the view at a readable pace
// (tier verdicts one by one, then the commit), the same way for live and cached runs.
import { hub } from "./backend";
import { scenarioMeta, studentName } from "./data";
import type { Arm, Contract, UiEvent } from "./types";

export type EffectStatus = "held" | "released" | "in_outbox" | "blocked" | "blocked_hook" | "blocked_filter" | "discarded" | "sent" | "rejected";
export interface Effect {
  id: string; kind: string; to: string[]; target?: string; subject?: string; body?: string;
  status: EffectStatus; attempt: number; leak: boolean; reason?: string; rule?: string; events: UiEvent[];
}
export type TierState = "idle" | "scanning" | "pass" | "fail" | "skip";
export interface Tier { id: string; label: string; state: TierState; ms?: number | null; detail?: string; event?: UiEvent }
export interface Attempt { n: number; ok: boolean | null; failClosed?: boolean; effectIds: string[]; rule?: string; event?: UiEvent; afterBlock: boolean }
export type Tone = "neutral" | "safe" | "blocked" | "leak" | "info" | "pending";
export interface Beat { id: number; tone: Tone; icon: string; text: string; sub?: string; event: UiEvent; big?: boolean }

export interface RunView {
  runId: string; scenario: string; arm: Arm; leaks: boolean; desc: string;
  live: boolean | null; cached: boolean; cachedReason?: string; recordedAt?: string;
  status: "starting" | "awaiting_approval" | "running" | "verifying" | "done" | "failed";
  error?: string;
  contract: Contract | null; contractCall?: Record<string, unknown>;
  effects: Record<string, Effect>; effectOrder: string[];
  tiers: Tier[]; attempts: Attempt[];
  reads: number; shadowWrites: number; toolCalls: number;
  /** Nano read labels seen for this run */
  labels: UiEvent[];
  recipients: string[];
  beats: Beat[];
  log: UiEvent[];
  finished?: UiEvent;
  /** Reviewed: which effects of this (recorded) run actually carried record data. Live runs: unknown → scenario label */
  leakedIds?: string[];
  /** the escrow tool call whose effect event is next */
  pendingCall?: UiEvent;
}

export const TIER_DEFS: { id: string; label: string; short: string }[] = [
  { id: "C1-contract", label: "Task contract", short: "Contract" },
  { id: "R0-R3-exact-canary", label: "Exact match · canary", short: "Exact / canary" },
  { id: "R4-fingerprint", label: "Fingerprints", short: "Fingerprint" },
  { id: "R5-super-judge", label: "Nemotron Super judge", short: "Super judge" },
];
const RULE_LABEL: Record<string, string> = {
  "C1-contract": "task contract", "R0-canary": "canary", "R0-canary-fuzzy": "canary (fuzzy)", "R3-unauthorized-recipient": "exact record data → unauthorized recipient",
  "R4-fingerprint": "fingerprint (split leak)", "R5-super-judge": "Super judge (paraphrase)",
};
export const ruleLabel = (r?: string) => (r ? RULE_LABEL[r] ?? r : "");
/** What a failing tier found, short (the tier's own name is shown beside it) */
const FAIL_SHORT: Record<string, string> = {
  "C1-contract": "out of contract", "R0-canary": "canary tripped", "R0-canary-fuzzy": "canary tripped", "R3-unauthorized-recipient": "record → wrong recipient",
  "R4-fingerprint": "split leak", "R5-super-judge": "LEAK (paraphrase)",
};
const failShort = (v: { rule: string; field?: string } | undefined) => !v ? undefined : v.rule === "R4-fingerprint" && /labeled/.test(v.field ?? "") ? "score + name (Nano-labeled read)" : FAIL_SHORT[v.rule];
const freshTiers = (): Tier[] => TIER_DEFS.map((t) => ({ id: t.id, label: t.short, state: "idle" }));

export function emptyRun(runId: string, scenario = "", arm: Arm = "escrow"): RunView {
  return { runId, scenario, arm, leaks: false, desc: "", live: null, cached: false, status: "starting", contract: null, effects: {}, effectOrder: [], tiers: freshTiers(), attempts: [], labels: [], reads: 0, shadowWrites: 0, toolCalls: 0, recipients: [], beats: [], log: [] };
}

const short = (s: unknown, n = 70) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const base = (p: unknown) => String(p ?? "").split("/").pop();
const arr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : x ? [String(x)] : []);
export const effectDest = (e: Pick<Effect, "to" | "target">) => (e.to.length ? e.to.join(", ") : e.target ?? "?");

let beatId = 0;
/** Pure reducer: one event → next view. */
export function apply(v: RunView, e: UiEvent): RunView {
  const s: RunView = { ...v, log: [...v.log, e], effects: { ...v.effects } };
  const beat = (tone: Tone, icon: string, text: string, sub?: string, big?: boolean) => { s.beats = [...s.beats, { id: ++beatId, tone, icon, text, sub, event: e, big }]; };
  const addRecipient = (r: string[]) => { for (const x of r) if (x && !s.recipients.includes(x)) s.recipients = [...s.recipients, x]; };
  const effect = (id: string) => s.effects[id];
  const putEffect = (x: Effect) => { s.effects[x.id] = x; if (!s.effectOrder.includes(x.id)) s.effectOrder = [...s.effectOrder, x.id]; };
  const attemptNo = () => s.attempts.length + 1;
  const afterBlock = () => s.attempts.some((a) => a.ok === false);

  switch (e.type) {
    case "run_started": {
      s.scenario = String(e.scenario ?? s.scenario); s.arm = (e.arm as Arm) ?? s.arm; s.leaks = !!e.leaks; s.desc = String(e.desc ?? "");
      s.leakedIds = Array.isArray(e.leakedEffectIds) ? (e.leakedEffectIds as string[]) : undefined;
      s.live = !!e.live; s.cached = !e.live; s.cachedReason = e.cachedReason as string | undefined; s.recordedAt = e.recordedAt as string | undefined;
      s.status = "running";
      beat("info", "▶", `${e.live ? "Live" : "Cached"} run started`, e.live ? "real OpenClaw agent in the NemoClaw sandbox" : `replaying a recorded live run${e.cachedReason ? ` · ${e.cachedReason}` : ""}`);
      break;
    }
    case "run_phase":
      if (e.phase === "agent_start") { s.status = "running"; beat("info", "◆", "Agent started", `session ${short(e.sessionId, 40)}`); }
      break;
    case "contract_drafted": {
      s.contract = e.contract as Contract; s.contractCall = e.call as Record<string, unknown> | undefined; s.status = "awaiting_approval";
      beat("pending", "✎", "Nemotron Ultra drafted a task contract", "run paused — waiting for your approval", true);
      break;
    }
    case "contract_decided": {
      s.contract = e.contract as Contract;
      const ok = s.contract.status === "approved";
      s.status = ok ? "running" : "done";
      beat(ok ? "safe" : "blocked", ok ? "✓" : "✕", ok ? "Contract approved — run resumes" : "Contract rejected — agent never starts", undefined, true);
      break;
    }
    case "tool_call": {
      s.toolCalls++;
      const p = (e.params ?? {}) as Record<string, unknown>;
      const blocked = e.decision === "blocked";
      if (e.tool === "read") {
        s.reads++;
        const sid = /records\/(PSU-\d+)\.json$/.exec(String(p.path ?? ""))?.[1];
        if (blocked) beat("blocked", "✕", `Read blocked: ${base(p.path)}`, short(e.reason, 90));
        else beat("neutral", "◎", sid ? `Read record ${sid}` : `Read ${base(p.path)}`, sid ? studentName(sid) : undefined);
      } else if (e.tool === "write" || e.tool === "edit") {
        if (blocked) beat("blocked", "✕", `Write blocked: ${base(p.path ?? p.file_path)}`, short(e.reason, 90));
        else if (e.class === "shadow") { s.shadowWrites++; beat("neutral", "▤", `Wrote ${base(p.path ?? p.file_path)} → shadow FS`, "held until commit"); }
      } else if (e.tool === "escrow_send_email" || e.tool === "escrow_write_external") {
        if (blocked) {
          const id = `hook-${e.seq ?? Math.random().toString(36).slice(2)}`;
          const to = arr(p.to);
          addRecipient(to.length ? to : arr(p.target));
          putEffect({ id, kind: e.tool === "escrow_send_email" ? "send_email" : "write_external", to, target: p.target as string, subject: p.subject as string, body: String(p.body ?? p.content ?? ""), status: "blocked_hook", attempt: attemptNo(), leak: false, reason: String(e.reason ?? e.note ?? "blocked by the hook"), rule: String(e.note ?? "").startsWith("contract") || /contract/i.test(String(e.reason)) ? "C1-contract" : undefined, events: [e] });
          beat("blocked", "✕", `Contract blocked ${e.tool === "escrow_send_email" ? "email" : "write"} to ${to.join(", ") || p.target}`, short(e.reason, 110), true);
        } else s.pendingCall = e;
      } else if (e.tool === "escrow_commit") {
        if (s.arm === "escrow") {
          s.status = "verifying";
          s.tiers = freshTiers().map((t) => ({ ...t, state: "scanning" }));
          beat("info", "⟳", "Agent called commit", "verifying the whole session…");
        }
      } else if (e.tool === "escrow_abort") {
        beat("neutral", "↺", "Agent aborted the transaction");
      }
      break;
    }
    case "effect_queued":
    case "baseline_release": {
      const call = s.pendingCall as UiEvent | undefined; s.pendingCall = undefined;
      const p = (call?.params ?? {}) as Record<string, unknown>;
      const to = arr(e.to ?? p.to);
      const target = (e.target ?? p.target) as string | undefined;
      addRecipient(to.length ? to : target ? [target] : []);
      const isBaseline = e.type === "baseline_release";
      const released = isBaseline && !!e.released;
      const viol = (e.violations as { rule: string }[] | undefined) ?? [];
      const leak = isBaseline && released && (s.leakedIds ? s.leakedIds.includes(String(e.effectId)) : s.leaks && !afterBlock());
      const x: Effect = { id: String(e.effectId), kind: String(e.kind ?? (call?.tool === "escrow_write_external" ? "write_external" : "send_email")), to, target, subject: p.subject as string, body: String(p.body ?? p.content ?? ""),
        status: isBaseline ? (released ? "in_outbox" : "blocked_filter") : "held", attempt: attemptNo(), leak, rule: viol[0]?.rule, reason: viol[0] ? ruleLabel(viol[0].rule) : undefined, events: [...(call ? [call] : []), e] };
      putEffect(x);
      const what = `${x.kind === "send_email" ? "Email" : "Write"} to ${effectDest(x)}`;
      if (!isBaseline) beat("pending", "◷", `${what} — held in escrow`, `“${short(x.body, 80)}”`);
      else if (released) beat(leak ? "leak" : "safe", "→", `${what} — released immediately`, `“${short(x.body, 80)}”`, leak);
      else beat("blocked", "✕", `${what} — per-call filter blocked`, ruleLabel(x.rule));
      break;
    }
    case "tier_verdict": {
      s.tiers = s.tiers.map((t) => t.id !== e.tier ? t : { ...t, state: e.skipped ? "skip" : e.ok ? "pass" : "fail", ms: e.ms as number | null, detail: e.skipped ? String(e.skipped) : e.ok ? (e.tier === "R4-fingerprint" && e.labels ? `pass · labels ${e.labels}` : "pass") : failShort(((e.violations as { rule: string; field?: string }[]) ?? [])[0]) ?? (e.error ? "error → fail closed" : "fail"), event: e });
      break;
    }
    case "read_label": {
      s.labels = [...s.labels.filter((l) => l.path !== e.path), e];
      const who = ((e.studentIds as string[]) ?? []).map((id) => studentName(id) ?? id);
      beat(e.sensitivity === "high" ? "pending" : "neutral", "◈", `Nano labeled ${base(e.path)}: ${String(e.recordType).replace("_", " ")} · ${e.sensitivity}`,
        `${who.length && e.recordType === "student_record" ? `${who.join(", ")} · ` : ""}${((e.sensitiveFields as string[]) ?? []).join(", ") || "no sensitive fields"}${e.source === "path-fallback" ? " · path fallback (Nano unavailable)" : e.cache === "hit" ? " · cached Nano label" : ""}`);
      break;
    }
    case "judge_call":
      beat(e.leak ? "blocked" : "safe", "⚖", `Super judge: ${e.error ? "error (fail closed)" : e.leak ? "LEAK" : "no leak"}`, `${e.ms ?? "?"} ms`);
      break;
    case "commit": {
      const ab = afterBlock();
      const held = s.effectOrder.map(effect).filter((x) => x.status === "held");
      const viol = (e.violations as { rule: string; effectId?: string }[] | undefined) ?? [];
      const rule = viol[0]?.rule;
      // tiers that never reported (older or fail-closed) settle here
      s.tiers = s.tiers.map((t) => t.state === "scanning" ? { ...t, state: e.ok ? "pass" : "skip" } : t);
      if (e.ok) {
        for (const x of held) putEffect({ ...x, status: "in_outbox", events: [...x.events, e] });
        s.attempts = [...s.attempts, { n: attemptNo(), ok: true, effectIds: held.map((x) => x.id), event: e, afterBlock: ab }];
        const label = ab ? (scenarioMeta(s.scenario).retryLabel ?? "safe reply") : "";
        beat("safe", "✓", ab ? `Agent sent a ${label} — verified clean` : `COMMITTED — ${held.length} effect${held.length === 1 ? "" : "s"} released`, ab ? `“${short(held[0]?.body, 90)}”` : "every tier passed → outbox", true);
      } else {
        for (const x of held) {
          const own = viol.find((w) => w.effectId === x.id);
          putEffect({ ...x, status: "blocked", rule: own?.rule ?? rule, reason: own ? ruleLabel(own.rule) : "held in the same session (all-or-nothing)", events: [...x.events, e] });
        }
        s.attempts = [...s.attempts, { n: attemptNo(), ok: false, failClosed: !!e.failClosed, effectIds: held.map((x) => x.id), rule, event: e, afterBlock: ab }];
        beat("blocked", "✕", `${s.leaks ? "LEAK BLOCKED" : "BLOCKED"} at commit${e.failClosed ? " (fail closed)" : ` · ${ruleLabel(rule)}`}`, `${held.length} held effect${held.length === 1 ? "" : "s"} destroyed — nothing left the sandbox`, true);
      }
      s.status = "running";
      break;
    }
    case "abort": {
      for (const x of s.effectOrder.map(effect)) if (x.status === "held") putEffect({ ...x, status: "discarded" });
      break;
    }
    case "outbox_send": {
      const id = String(e.effectId);
      let x = effect(id);
      if (!x) { x = { id, kind: String(e.kind ?? "send_email"), to: arr(e.to), target: e.target as string, subject: e.subject as string, body: e.body as string, status: "in_outbox", attempt: attemptNo(), leak: false, events: [] }; addRecipient(x.to.length ? x.to : x.target ? [x.target] : []); }
      const sent = e.status === "sent";
      putEffect({ ...x, status: sent ? "sent" : "rejected", body: x.body || (e.body as string), reason: sent ? x.reason : String(e.reason ?? "host sender rejected"), events: [...x.events, e] });
      if (sent) beat(x.leak ? "leak" : "safe", x.leak ? "⚠" : "✉", `${x.leak ? "LEAKED — delivered" : "Delivered"} to ${effectDest(x)}`, `host sender · “${short(x.body, 70)}”`, x.leak);
      else beat("blocked", "✕", `Host sender rejected ${effectDest(x)}`, short(e.reason, 90));
      break;
    }
    case "run_finished":
      s.finished = e; s.status = "done";
      if (e.live === false && s.live === null) { s.live = false; s.cached = true; }
      break;
    case "run_failed":
      if (e.fallback === "cached") { beat("info", "↯", "Live run failed — falling back to the cached run", short(e.error, 100)); break; }
      s.status = "failed"; s.error = String(e.error ?? "run failed");
      beat("blocked", "↯", "Run failed", short(e.error, 100));
      break;
  }
  return s;
}

// ---- feed: pacing + subscribers -----------------------------------------------------------------------

/** Minimum gap before an event is shown, so the commit reads as a sequence: tiers one by one, then the verdict. */
const gapFor = (e: UiEvent, prev?: UiEvent) => {
  if (e.type === "tier_verdict") return prev?.type === "tier_verdict" ? 650 : 900;
  if (e.type === "commit") return 750;
  if (e.type === "outbox_send") return 500;
  if (e.type === "model_call") return 0;
  return 120;
};

export type FeedListener = (e: UiEvent, v: RunView, prev: RunView) => void;
export class RunFeed {
  view: RunView;
  private queue: UiEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last?: UiEvent;
  private lastAt = 0;
  private listeners = new Set<FeedListener>();
  private unsub: () => void;
  constructor(runId: string, scenario?: string, arm?: Arm) {
    this.view = emptyRun(runId, scenario, arm);
    this.unsub = hub.on((e) => { if (e.runId === runId) this.push(e); }, (e) => e.runId === runId);
  }
  private push(e: UiEvent) { this.queue.push(e); this.pump(); }
  private pump() {
    if (this.timer || !this.queue.length) return;
    const e = this.queue[0];
    const wait = Math.max(0, this.lastAt + gapFor(e, this.last) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const ev = this.queue.shift()!;
      const prev = this.view;
      try { this.view = apply(prev, ev); } catch (err) { console.error("event skipped", ev, err); }
      this.last = ev; this.lastAt = Date.now();
      this.listeners.forEach((l) => { try { l(ev, this.view, prev); } catch (err) { console.error(err); } });
      this.pump();
    }, wait);
  }
  subscribe(l: FeedListener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  dispose() { this.unsub(); if (this.timer) clearTimeout(this.timer); this.listeners.clear(); }
}

const feeds = new Map<string, RunFeed>();
export function feedFor(runId: string, scenario?: string, arm?: Arm): RunFeed {
  let f = feeds.get(runId);
  if (!f) { f = new RunFeed(runId, scenario, arm); feeds.set(runId, f); }
  return f;
}
export function disposeFeed(runId: string) { feeds.get(runId)?.dispose(); feeds.delete(runId); }

/** Headline for a finished (or in-progress) run */
export function headline(v: RunView): { tone: Tone; title: string; sub: string } | null {
  if (v.status === "failed") return { tone: "blocked", title: "RUN FAILED", sub: v.error ?? "" };
  if (v.contract?.status === "rejected") return { tone: "blocked", title: "CONTRACT REJECTED", sub: "The agent was never started." };
  const fx = v.effectOrder.map((id) => v.effects[id]);
  const leaked = fx.filter((x) => x.leak && x.status === "sent").length;
  const delivered = fx.filter((x) => x.status === "sent").length;
  if (v.arm === "baseline") {
    if (!v.finished && !fx.length) return null;
    if (leaked) return { tone: "leak", title: `LEAKED · ${leaked} effect${leaked === 1 ? "" : "s"}`, sub: "Each call looked harmless alone, so the per-call filter released it." };
    const released = fx.filter((x) => ["in_outbox", "sent"].includes(x.status)).length;
    if (v.leaks && released && !v.finished) return { tone: "leak", title: "LEAKING", sub: `${released} effect${released === 1 ? "" : "s"} already past the filter` };
    const blocked = fx.filter((x) => x.status.startsWith("blocked")).length;
    if (blocked && !delivered) return { tone: "safe", title: "BLOCKED PER CALL", sub: "Exact record data — the per-call filter catches this one." };
    if (v.finished) return { tone: "safe", title: delivered ? `DELIVERED · ${delivered}` : "NO EFFECTS", sub: v.leaks ? "" : "Clean task." };
    return null;
  }
  const first = v.attempts[0];
  if (!first) return v.finished ? { tone: "neutral", title: "NO COMMIT", sub: "The agent never committed; nothing left the sandbox." } : null;
  if (first.ok === false) {
    const retry = v.attempts.find((a) => a.ok && a.afterBlock);
    return { tone: "safe", title: v.leaks ? "LEAK STOPPED" : "BLOCKED AT COMMIT", sub: `${ruleLabel(first.rule) || "verification"} — nothing left the sandbox${retry ? `; then a ${scenarioMeta(v.scenario).retryLabel ?? "safe reply"} was verified and delivered` : ""}.` };
  }
  return { tone: "safe", title: `VERIFIED · ${first.effectIds.length} released`, sub: delivered ? `${delivered} delivered by the host sender.` : "Released to the outbox." };
}
