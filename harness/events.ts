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
  | "outbox_send" | "model_call";

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
    case "verify_tier": return [{ ...base, type: "tier_verdict", tier: e.tier, ok: e.ok, ms: e.ms, violations: e.violations, skipped: e.skipped, error: e.error }];
    case "judge_call": return [{ ...base, type: "judge_call", model: e.model, ms: e.ms, promptTokens: e.promptTokens, completionTokens: e.completionTokens, usd: costOf(String(e.model), Number(e.promptTokens ?? 0), Number(e.completionTokens ?? 0)), leak: e.leak, vote: e.vote, error: e.error }];
    case "commit":
    case "commit_blocked": return [{ ...base, type: "commit", ok: e.event === "commit", judged: e.judged, effects: e.effects, files: e.files, violations: e.violations }];
    case "commit_refused": return [{ ...base, type: "commit", ok: false, failClosed: true, error: e.error }];
    case "abort": return [{ ...base, type: "abort" }];
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
  const role = model.includes("Ultra") ? "contract" : run.startsWith("p3-judge") || run.startsWith("scn-") || (u.promptTokens ?? 0) < 6000 ? "judge" : "agent";
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
