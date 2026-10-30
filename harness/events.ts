// Pipeline event stream for the UI. One schema, three live sources:
//   sandbox audit log (hook + plugin: tool calls, shadow FS, queue, tier verdicts, judge calls, commit/abort)
//   spend proxy log   (every model call: model, latency, tokens, cost — agent, judge, and Ultra alike)
//   host sender log   (outbox sends / host-side rejections)
// plus run lifecycle and contract events from the run manager. Cached replays carry `cached: true`.
import { EventEmitter } from "node:events";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";

export type EventType =
  | "run_started" | "run_phase" | "run_finished" | "run_failed"
  | "contract_drafted" | "contract_decided"
  | "tool_call" | "shadow_write" | "shadow_read"
  | "effect_queued" | "baseline_release"
  | "tier_verdict" | "judge_call" | "commit" | "abort"
  | "outbox_send" | "model_call" | "read_label" | "labels_used";

export interface EscrowEvent {
  seq: number;
  ts: string;
  type: EventType;
  runId?: string;
  sessionId?: string;
  /** true when this event is a replay of a saved run, not live */
  cached?: boolean;
  [k: string]: unknown;
}
export type EventBody = Omit<EscrowEvent, "seq" | "ts"> & { ts?: string };

/** Prices from docs/models.md, USD per token, for events that carry tokens but no cost */
export const PRICES: Record<string, { prompt: number; completion: number }> = {
  "nvidia/nemotron-3-super-120b-a12b": { prompt: 0.0000003, completion: 0.0000009 },
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { prompt: 0.00000006, completion: 0.00000024 },
  "nvidia/Nemotron-3-Ultra-550b-a55b": { prompt: 0.000001, completion: 0.000003 },
};
export const costOf = (model: string, p = 0, c = 0) => { const pr = PRICES[model]; return pr ? p * pr.prompt + c * pr.completion : undefined; };

const sessionOf = (e: Record<string, unknown>): string | undefined => {
  const k = (e.sessionId ?? e.session ?? e.sessionKey) as string | undefined;
  return typeof k === "string" ? k.split(":").pop()!.toLowerCase() : undefined;
};

/** Map one sandbox audit-log line to stream events. Pure, so it's unit-tested and reused for cached replay. */
export function fromAudit(e: Record<string, unknown>): EventBody[] {
  const ts = String(e.ts ?? new Date().toISOString());
  const sessionId = sessionOf(e);
  const base = { ts, sessionId };
  if (e.hook === "before_tool_call") {
    const out: EventBody[] = [{ ...base, type: "tool_call", tool: e.tool, decision: e.decision, class: e.class, params: e.params, reason: e.reason, note: e.note }];
    const rew = e.rewritten as Record<string, unknown> | undefined;
    const p = (e.params ?? {}) as Record<string, unknown>;
    if (rew && e.class === "shadow") out.push({ ...base, type: "shadow_write", tool: e.tool, path: p.path ?? p.file_path, shadowPath: rew.path ?? rew.file_path });
    if (rew && e.class === "read") out.push({ ...base, type: "shadow_read", path: p.path ?? p.file_path, shadowPath: rew.path ?? rew.file_path });
    return out;
  }
  switch (e.event) {
    case "enqueue": return [{ ...base, type: "effect_queued", effectId: e.id, kind: e.kind, to: e.to, target: e.target }];
    case "baseline_released":
    case "baseline_blocked": return [{ ...base, type: "baseline_release", effectId: e.id, kind: e.kind, to: e.to, target: e.target, released: e.event === "baseline_released", violations: e.violations }];
    case "verify_tier": return [{ ...base, type: "tier_verdict", tier: e.tier, ok: e.ok, ms: e.ms, violations: e.violations, skipped: e.skipped, error: e.error, ...(e.derived ? { derived: true } : {}) }];
    case "judge_call": return [{ ...base, type: "judge_call", model: e.model, ms: e.ms, promptTokens: e.promptTokens, completionTokens: e.completionTokens, usd: costOf(String(e.model), Number(e.promptTokens ?? 0), Number(e.completionTokens ?? 0)), leak: e.leak, vote: e.vote, error: e.error }];
    case "commit":
    case "commit_blocked": return [{ ...base, type: "commit", ok: e.event === "commit", judged: e.judged, effects: e.effects, files: e.files, violations: e.violations }];
    case "commit_refused": return [{ ...base, type: "commit", ok: false, failClosed: true, error: e.error }];
    case "abort": return [{ ...base, type: "abort" }];
    case "labels_used": return [{ ...base, type: "labels_used", want: e.want, labels: e.labels }];
    default: return []; // register and other housekeeping lines
  }
}

/**
 * Map one spend-proxy log line. In-sandbox calls arrive without a run id (inference.local drops our header),
 * so the role is inferred: Ultra → contract; a small Super prompt → the judge; otherwise the agent.
 */
export function fromProxy(e: Record<string, unknown>): EventBody[] {
  if (e.event !== "call") return [];
  const u = (e.usage ?? {}) as { promptTokens?: number; completionTokens?: number };
  const model = String(e.model);
  const run = String(e.runId ?? "");
  const role = model.includes("Ultra") ? "contract" : model.includes("Nano") ? "labeler" : run.startsWith("p3-judge") || run.startsWith("scn-") || (u.promptTokens ?? 0) < 6000 ? "judge" : "agent";
  return [{ ts: String(e.ts), type: "model_call", model, role, ms: e.ms, status: e.status, promptTokens: u.promptTokens, completionTokens: u.completionTokens, usd: e.usd, totalUsd: e.totalUsd }];
}

/** Map one host-sender log line. */
export function fromSender(e: Record<string, unknown>): EventBody[] {
  if (e.event !== "sent" && e.event !== "rejected") return [];
  const p = (e.payload ?? {}) as Record<string, unknown>;
  return [{ ts: String(e.ts), type: "outbox_send", sessionId: typeof e.sessionId === "string" ? sessionOf(e) : undefined, effectId: e.id, kind: e.kind, status: e.event, to: p.to, target: p.target, subject: p.subject, reason: e.reason }];
}

export class EventBus extends EventEmitter {
  private seq = 0;
  readonly backlog: EscrowEvent[] = [];
  private keep: number;
  constructor(keep = 2000) { super(); this.keep = keep; }
  publish(b: EventBody): EscrowEvent {
    const ev = { ...b, ts: b.ts ?? new Date().toISOString(), seq: ++this.seq } as EscrowEvent;
    this.backlog.push(ev);
    if (this.backlog.length > this.keep) this.backlog.splice(0, this.backlog.length - this.keep);
    this.emit("event", ev);
    return ev;
  }
}

/** Follow a host file by polling (new complete JSON lines only). Starts at the current end. */
export class FileTail {
  private pos: number;
  private buf = "";
  private timer: NodeJS.Timeout;
  private path: string;
  constructor(path: string, onLine: (o: Record<string, unknown>) => void, intervalMs = 250) {
    this.path = path;
    this.pos = existsSync(path) ? statSync(path).size : 0;
    this.timer = setInterval(() => {
      if (!existsSync(this.path)) return;
      const size = statSync(this.path).size;
      if (size < this.pos) this.pos = 0; // truncated or rotated
      if (size === this.pos) return;
      const fd = openSync(this.path, "r");
      const b = Buffer.alloc(size - this.pos);
      readSync(fd, b, 0, b.length, this.pos);
      closeSync(fd);
      this.pos = size;
      this.buf += b.toString("utf8");
      const lines = this.buf.split("\n");
      this.buf = lines.pop()!;
      for (const l of lines) { try { onLine(JSON.parse(l)); } catch { /* partial or non-JSON */ } }
    }, intervalMs);
  }
  stop() { clearInterval(this.timer); }
}

const TIERS = ["C1-contract", "R0-R3-exact-canary", "R4-fingerprint", "R5-super-judge"] as const;
const TIER_OF_RULE: Record<string, (typeof TIERS)[number]> = {
  "C1-contract": "C1-contract", "R0-canary": "R0-R3-exact-canary", "R0-canary-fuzzy": "R0-R3-exact-canary", "R0-canary-fragments": "R0-R3-exact-canary", "R0-verifier-tamper": "R0-R3-exact-canary",
  "R3-unauthorized-recipient": "R0-R3-exact-canary", "R4-fingerprint": "R4-fingerprint", "R5-super-judge": "R5-super-judge",
};

/**
 * Transcripts recorded before the plugin logged per-tier verdicts carry only the commit record. Rebuild the tier
 * verdicts from it (which rules fired, whether the judge ran) for replay, marked `derived: true` and with no timing.
 * Every deterministic tier always runs; the judge runs only if they all pass.
 */
export function deriveTierVerdicts(audit: Record<string, unknown>[]): Record<string, unknown>[] {
  if (audit.some((e) => e.event === "verify_tier")) return [];
  return audit.filter((e) => e.event === "commit" || e.event === "commit_blocked").flatMap((c) => {
    const violations = (c.violations as { rule: string }[] | undefined) ?? [];
    const failed = new Set(violations.map((v) => TIER_OF_RULE[v.rule]));
    const deterministicFailed = [...failed].some((t) => t !== "R5-super-judge");
    return TIERS.map((tier) => ({
      // 1 ms before the commit so replays show the verdicts ahead of it
      ts: typeof c.ts === "string" ? new Date(Date.parse(c.ts) - 1).toISOString() : c.ts, session: c.session, event: "verify_tier", tier, derived: true, ms: null,
      ok: !failed.has(tier),
      violations: violations.filter((v) => TIER_OF_RULE[v.rule] === tier),
      ...(tier === "R5-super-judge" && !c.judged ? { skipped: deterministicFailed ? "a deterministic tier already blocked" : "judge did not run" } : {}),
    }));
  });
}

/** Minimal transcript shape needed for replay (harness/live.ts Transcript satisfies it). */
export interface ReplayableTranscript {
  sessionId: string; startedAt: string; durationMs: number;
  contract: { decidedAt?: string } | null; contractCall?: unknown;
  events: Record<string, unknown>[]; modelCalls: Record<string, unknown>[];
  sender: { sent: string[]; rejected: { id: string; reason: string }[] };
  deliveredEffects?: Record<string, unknown>[];
  labels?: object[];
}

/** A Nano read label as a stream event */
export const labelEvent = (sessionId: string, l: Record<string, unknown>): EventBody =>
  ({ ts: typeof l.ts === "string" ? l.ts : undefined, type: "read_label", sessionId, path: l.path, recordType: l.recordType, sensitivity: l.sensitivity, studentIds: l.studentIds, sensitiveFields: l.sensitiveFields, source: l.source, cache: l.cache, model: l.model, ms: l.ms, error: l.error });

/**
 * A saved run as the stream events it produced, in order: contract, hook/plugin audit (with derived tier verdicts
 * for older transcripts), model calls, then the host sender's sends (with payloads). Used by the server's cached
 * replay and bundled into the UI as its offline fallback, so both replay exactly the same thing.
 */
export function transcriptToEvents(t: ReplayableTranscript): EventBody[] {
  const calls = t.modelCalls.flatMap(fromProxy);
  // The draft exists once Ultra has returned it: the proxy logs that call when it completes, after startedAt. Stamp
  // the draft just after it, so a replay (which pauses at the draft) has already shown Ultra's call in the HUD.
  const ultra = calls.find((c) => c.role === "contract");
  const draftTs = ultra?.ts && String(ultra.ts) > t.startedAt ? new Date(Date.parse(String(ultra.ts)) + 1).toISOString() : t.startedAt;
  const evs: EventBody[] = [
    ...(t.contract ? [{ ts: draftTs, type: "contract_drafted" as const, contract: { ...t.contract, status: "pending" }, call: t.contractCall },
      { ts: t.contract.decidedAt && t.contract.decidedAt > draftTs ? t.contract.decidedAt : draftTs, type: "contract_decided" as const, contract: t.contract }] : []),
    ...[...t.events, ...deriveTierVerdicts(t.events)].flatMap(fromAudit),
    ...calls,
    ...(t.labels ?? []).map((l) => labelEvent(t.sessionId, l as Record<string, unknown>)),
  ].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const end = new Date(Date.parse(t.startedAt) + t.durationMs).toISOString();
  const payload = new Map((t.deliveredEffects ?? []).map((d) => [String(d.id), d]));
  for (const id of t.sender.sent) {
    const p = payload.get(id) ?? {};
    evs.push({ ts: end, type: "outbox_send", sessionId: t.sessionId, effectId: id, kind: p.kind, status: "sent", to: p.to, target: p.target, subject: p.subject, body: p.body ?? p.content });
  }
  for (const r of t.sender.rejected) evs.push({ ts: end, type: "outbox_send", sessionId: t.sessionId, effectId: r.id, status: "rejected", reason: r.reason });
  return evs;
}
