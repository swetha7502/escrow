// Spend guard: every Token Factory call is checked and metered here.
// It fails closed. A missing or corrupt state file, a missing or invalid expiry, an
// unknown model, a failed write, or reaching the cap all stop live calls.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Absolute ceiling. spend.json may lower the cap, never raise it above this. */
export const HARD_CAP_USD = 25;
export const MAX_RUNS_PER_UTC_DAY = 20;
/** Calls with no run id join the previous anonymous run if they arrive within this gap. */
export const ANON_RUN_IDLE_MS = 10 * 60 * 1000;

export type Prices = Record<string, { prompt: number; completion: number }>;

export interface ModelTotals { calls: number; promptTokens: number; completionTokens: number; usd: number }

export interface SpendState {
  version: 1;
  capUsd: number;
  totalUsd: number;
  byModel: Record<string, ModelTotals>;
  /** UTC date (YYYY-MM-DD) → run ids started that day */
  runs: Record<string, string[]>;
  lastAnon?: { id: string; at: string };
  updatedAt: string;
}

export type Decision =
  | { ok: true; reservation: Reservation }
  | { ok: false; mode: "cached"; code: StopCode; reason: string };

export type StopCode =
  | "state_missing" | "state_corrupt" | "state_write_failed"
  | "expiry_invalid" | "credit_expired"
  | "cap_reached" | "daily_run_limit" | "unknown_model";

export interface Reservation { id: number; model: string; maxUsd: number; runId: string }

export interface Usage { promptTokens: number; completionTokens: number }

export class StateError extends Error {
  code: "state_missing" | "state_corrupt";
  constructor(code: "state_missing" | "state_corrupt", msg: string) { super(msg); this.code = code; }
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

export function validateState(x: unknown): SpendState {
  const bad = (why: string): never => { throw new StateError("state_corrupt", `spend.json corrupt: ${why}`); };
  if (!x || typeof x !== "object" || Array.isArray(x)) bad("not an object");
  const s = x as Record<string, unknown>;
  if (s.version !== 1) bad("version");
  if (!isNum(s.capUsd)) bad("capUsd");
  if (!isNum(s.totalUsd)) bad("totalUsd");
  if (!s.byModel || typeof s.byModel !== "object" || Array.isArray(s.byModel)) bad("byModel");
  let sum = 0;
  for (const [m, t] of Object.entries(s.byModel as Record<string, unknown>)) {
    const v = t as Record<string, unknown>;
    if (!v || !isNum(v.calls) || !isNum(v.promptTokens) || !isNum(v.completionTokens) || !isNum(v.usd)) bad(`byModel.${m}`);
    sum += v.usd as number;
  }
  // totalUsd must agree with the per-model sum, so that hand-edits lowering the total are caught
  if (Math.abs(sum - (s.totalUsd as number)) > 1e-9) bad("totalUsd does not match sum of byModel");
  if (!s.runs || typeof s.runs !== "object" || Array.isArray(s.runs)) bad("runs");
  for (const [d, ids] of Object.entries(s.runs as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Array.isArray(ids) || !ids.every((i) => typeof i === "string")) bad(`runs.${d}`);
  }
  if (typeof s.updatedAt !== "string") bad("updatedAt");
  return s as unknown as SpendState;
}

export function readState(path: string): SpendState {
  if (!existsSync(path)) throw new StateError("state_missing", `spend.json missing at ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new StateError("state_corrupt", `spend.json unreadable: ${(e as Error).message}`);
  }
  return validateState(parsed);
}

function writeStateAtomic(path: string, s: SpendState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Create a fresh state file. Refuses to overwrite an existing one. */
export function initState(path: string, capUsd = HARD_CAP_USD, now = new Date()): SpendState {
  if (existsSync(path)) throw new Error(`refusing to overwrite existing ${path}`);
  const s: SpendState = { version: 1, capUsd: Math.min(capUsd, HARD_CAP_USD), totalUsd: 0, byModel: {}, runs: {}, updatedAt: now.toISOString() };
  writeStateAtomic(path, s);
  return s;
}

export function setCap(path: string, capUsd: number, now = new Date()): SpendState {
  if (!isNum(capUsd)) throw new Error("cap must be a non-negative number");
  const s = readState(path);
  s.capUsd = Math.min(capUsd, HARD_CAP_USD);
  s.updatedAt = now.toISOString();
  writeStateAtomic(path, s);
  return s;
}

/** Credit expiry "YYYY-MM-DD" means stop at 00:00 UTC on that date. A full ISO timestamp is used as given. */
export function parseExpiry(v: string | undefined): Date | null {
  if (!v) return null;
  const s = v.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function costUsd(prices: Prices, model: string, u: Usage): number {
  const p = prices[model];
  if (!p) throw new Error(`no price for ${model}`);
  return u.promptTokens * p.prompt + u.completionTokens * p.completion;
}

export interface GuardOptions {
  statePath: string;
  prices: Prices;
  creditExpiry: string | undefined;
  now?: () => Date;
}

export class SpendGuard {
  private opts: GuardOptions;
  private now: () => Date;
  private reserved = new Map<number, Reservation>();
  private nextId = 1;
  /** Set when a commit fails after upstream spent money. Live calls stay stopped until the process restarts. */
  private latched: string | null = null;

  constructor(opts: GuardOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  private stop(code: StopCode, reason: string): Decision {
    return { ok: false, mode: "cached", code, reason };
  }

  /** Current state plus effective cap, or a stop decision. Re-reads the file each time, so outside edits apply immediately. */
  status(): { ok: true; state: SpendState; capUsd: number; reservedUsd: number } | (Decision & { ok: false }) {
    if (this.latched) return this.stop("state_write_failed", this.latched) as Decision & { ok: false };
    let state: SpendState;
    try {
      state = readState(this.opts.statePath);
    } catch (e) {
      if (e instanceof StateError) return this.stop(e.code, e.message) as Decision & { ok: false };
      throw e;
    }
    const expiry = parseExpiry(this.opts.creditExpiry);
    if (!expiry) return this.stop("expiry_invalid", "CREDIT_EXPIRY missing or invalid") as Decision & { ok: false };
    if (this.now() >= expiry) return this.stop("credit_expired", `credits expired at ${expiry.toISOString()}`) as Decision & { ok: false };
    const reservedUsd = [...this.reserved.values()].reduce((a, r) => a + r.maxUsd, 0);
    return { ok: true, state, capUsd: Math.min(state.capUsd, HARD_CAP_USD), reservedUsd };
  }

  /**
   * Reserve worst-case cost for one call before it's sent.
   * `maxUsage` must be an upper bound (prompt bytes, clamped max_tokens).
   */
  check(req: { model: string; maxUsage: Usage; runId?: string }): Decision {
    const st = this.status();
    if (!st.ok) return st;
    const { state, capUsd, reservedUsd } = st;
    if (!this.opts.prices[req.model]) return this.stop("unknown_model", `model ${req.model} has no price in docs/models.md`);

    const maxUsd = costUsd(this.opts.prices, req.model, req.maxUsage);
    if (state.totalUsd + reservedUsd + maxUsd > capUsd) {
      return this.stop("cap_reached", `spend $${state.totalUsd.toFixed(6)} + reserved $${reservedUsd.toFixed(6)} + this call (max $${maxUsd.toFixed(6)}) would exceed cap $${capUsd}`);
    }

    // Count runs against the daily limit
    const now = this.now();
    const day = now.toISOString().slice(0, 10);
    let runId = req.runId;
    let anonUpdate: SpendState["lastAnon"] | undefined;
    if (!runId) {
      const last = state.lastAnon;
      if (last && now.getTime() - Date.parse(last.at) < ANON_RUN_IDLE_MS && last.at.slice(0, 10) === day) runId = last.id;
      else runId = `anon-${now.toISOString()}`;
      anonUpdate = { id: runId, at: now.toISOString() };
    }
    const today = state.runs[day] ?? [];
    const isNew = !today.includes(runId);
    if (isNew && today.length >= MAX_RUNS_PER_UTC_DAY) {
      return this.stop("daily_run_limit", `${MAX_RUNS_PER_UTC_DAY} live runs already started on ${day} (UTC)`);
    }
    if (isNew || anonUpdate) {
      if (isNew) state.runs = { ...state.runs, [day]: [...today, runId] };
      if (anonUpdate) state.lastAnon = anonUpdate;
      state.updatedAt = now.toISOString();
      try {
        writeStateAtomic(this.opts.statePath, state);
      } catch (e) {
        return this.stop("state_write_failed", `could not persist run: ${(e as Error).message}`);
      }
    }

    const reservation: Reservation = { id: this.nextId++, model: req.model, maxUsd, runId };
    this.reserved.set(reservation.id, reservation);
    return { ok: true, reservation };
  }

  /**
   * Record actual usage and release the reservation. If usage is unknown (null),
   * the full worst-case reservation is charged.
   */
  commit(r: Reservation, usage: Usage | null): { usd: number; totalUsd: number } {
    try {
      return this.commitInner(r, usage);
    } catch (e) {
      this.latched = `failed to record spend for ${r.model} (max $${r.maxUsd}): ${(e as Error).message}`;
      throw e;
    } finally {
      this.reserved.delete(r.id);
    }
  }

  private commitInner(r: Reservation, usage: Usage | null): { usd: number; totalUsd: number } {
    const state = readState(this.opts.statePath); // throws if the file went bad mid-call; the caller treats that as a stop
    const usd = usage ? costUsd(this.opts.prices, r.model, usage) : r.maxUsd;
    const t = state.byModel[r.model] ?? { calls: 0, promptTokens: 0, completionTokens: 0, usd: 0 };
    t.calls += 1;
    t.promptTokens += usage?.promptTokens ?? 0;
    t.completionTokens += usage?.completionTokens ?? 0;
    t.usd += usd;
    state.byModel[r.model] = t;
    state.totalUsd = Object.values(state.byModel).reduce((a, m) => a + m.usd, 0);
    state.updatedAt = this.now().toISOString();
    writeStateAtomic(this.opts.statePath, state);
    return { usd, totalUsd: state.totalUsd };
  }

  /** Release a reservation without charging. Only for calls that never reached upstream. */
  release(r: Reservation): void {
    this.reserved.delete(r.id);
  }
}

/** Parse the ```json prices block out of docs/models.md. */
export function loadPricesFromMarkdown(md: string): Prices {
  const m = /```json prices\n([\s\S]*?)```/.exec(md);
  if (!m) throw new Error("no ```json prices block in models.md");
  const raw = JSON.parse(m[1]) as Record<string, { prompt: unknown; completion: unknown }>;
  const out: Prices = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isNum(v.prompt) || !isNum(v.completion) || v.prompt === 0 || v.completion === 0) throw new Error(`bad price for ${k}`);
    out[k] = { prompt: v.prompt, completion: v.completion };
  }
  return out;
}
