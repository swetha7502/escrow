// In-memory, per-session transaction manager with no WAL. Holds every side effect in escrow:
// shadow file writes and outbound effects are released only when verification passes at commit.
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ShadowFS } from "./shadow-fs.ts";
import { verifyEffects, fingerprintSession, type Policy, type OutboundEffect, type Violation } from "./verify.ts";
import { randomUUID as _uuid } from "node:crypto";

export type TxnState = "open" | "committed" | "aborted";

/** Thrown when the judge tier can't produce a verdict; the caller must treat the commit as blocked. */
export class JudgeUnavailableError extends Error {}

export interface PendingEffect extends OutboundEffect {
  payload: Record<string, unknown>;
}

export interface CommitResult {
  ok: boolean;
  state: TxnState;
  violations: Violation[];
  filesCommitted: string[];
  effectsReleased: string[];
}

export function buildEmailEffect(to: string[], subject: string, body: string): PendingEffect {
  return { id: `eff-${_uuid()}`, kind: "send_email", to, text: `${subject}\n${body}`, payload: { to, subject, body } };
}
export function buildExternalEffect(target: string, content: string): PendingEffect {
  return { id: `eff-${_uuid()}`, kind: "write_external", target, text: `${target}\n${content}`, payload: { target, content } };
}

export class Txn {
  readonly sessionId: string;
  state: TxnState = "open";
  readonly fs: ShadowFS;
  readonly effects: PendingEffect[] = [];

  constructor(sessionId: string, fs: ShadowFS) {
    this.sessionId = sessionId;
    this.fs = fs;
  }

  private assertOpen() {
    if (this.state !== "open") throw new Error(`transaction ${this.sessionId} is ${this.state}`);
  }

  writeFile(path: string, content: string): string {
    this.assertOpen();
    return this.fs.write(path, content);
  }

  sendEmail(to: string[], subject: string, body: string): string {
    this.assertOpen();
    const e = buildEmailEffect(to, subject, body);
    this.effects.push(e);
    return e.id;
  }

  writeExternal(target: string, content: string): string {
    this.assertOpen();
    const e = buildExternalEffect(target, content);
    this.effects.push(e);
    return e.id;
  }
}

export class TransactionManager {
  private txns = new Map<string, Txn>();
  private workspace: string;
  private shadowBase: string;
  private outboxDir: string;
  private getPolicy: () => Policy;

  /** `policy` may be a getter. If it throws, commit is refused (fail closed). */
  constructor(opts: { workspace: string; shadowBase: string; outboxDir: string; policy: Policy | (() => Policy) }) {
    this.workspace = opts.workspace;
    this.shadowBase = opts.shadowBase;
    this.outboxDir = opts.outboxDir;
    const p = opts.policy;
    this.getPolicy = typeof p === "function" ? p : () => p;
  }

  begin(sessionId: string): Txn {
    const existing = this.txns.get(sessionId);
    if (existing?.state === "open") return existing;
    const t = new Txn(sessionId, new ShadowFS(this.workspace, join(this.shadowBase, sessionId.replace(/[^\w-]/g, "_"))));
    this.txns.set(sessionId, t);
    return t;
  }

  get(sessionId: string): Txn | undefined {
    return this.txns.get(sessionId);
  }

  /** Verify everything that would leave, then release all of it or none of it. */
  commit(sessionId: string): CommitResult {
    const t = this.txns.get(sessionId);
    if (!t || t.state !== "open") throw new Error(`no open transaction for ${sessionId}`);
    const policy = this.getPolicy();
    const violations = [...verifyEffects(policy, t.effects), ...fingerprintSession(policy, t.effects)];
    if (violations.length) {
      this.abort(sessionId);
      return { ok: false, state: "aborted", violations, filesCommitted: [], effectsReleased: [] };
    }
    // Effects go to the outbox first, then files are applied
    for (const e of t.effects) this.writeOutbox(sessionId, e);
    const filesCommitted = t.fs.commit();
    t.state = "committed";
    return { ok: true, state: "committed", violations: [], filesCommitted, effectsReleased: t.effects.map((e) => e.id) };
  }

  /** One outbox record (tmp + rename), the same format in both modes. */
  private writeOutbox(sessionId: string, e: PendingEffect): void {
    mkdirSync(this.outboxDir, { recursive: true });
    const rec = { id: e.id, sessionId, kind: e.kind, payload: e.payload, status: "committed", committedAt: new Date().toISOString() };
    const tmp = join(this.outboxDir, `.${e.id}.tmp`);
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, join(this.outboxDir, `${e.id}.json`));
  }

  /**
   * Baseline arm: check this one effect alone and release it right away if clean.
   * No session context and no commit gate. This is the comparison point for Escrow.
   */
  releaseNow(sessionId: string, e: PendingEffect): Violation[] {
    const v = verifyEffects(this.getPolicy(), [e]);
    if (!v.length) this.writeOutbox(sessionId, e);
    return v;
  }

  /**
   * Async commit: deterministic tiers first (exact/canary/fingerprint); only if they pass does the
   * optional judge run. Any judge error blocks (fail closed). All-or-nothing, like commit().
   */
  async commitWithJudge(sessionId: string, judge?: (policy: Policy, effects: OutboundEffect[]) => Promise<Violation[]>): Promise<CommitResult & { judged: boolean }> {
    const t = this.txns.get(sessionId);
    if (!t || t.state !== "open") throw new Error(`no open transaction for ${sessionId}`);
    const policy = this.getPolicy();
    const deterministic = [...verifyEffects(policy, t.effects), ...fingerprintSession(policy, t.effects)];
    if (deterministic.length) {
      this.abort(sessionId);
      return { ok: false, state: "aborted", violations: deterministic, filesCommitted: [], effectsReleased: [], judged: false };
    }
    let judged = false;
    if (judge && t.effects.length) {
      let jv: Violation[];
      try {
        jv = await judge(policy, t.effects);
        judged = true;
      } catch (e) {
        this.abort(sessionId);
        throw new JudgeUnavailableError((e as Error).message);
      }
      if (jv.length) {
        this.abort(sessionId);
        return { ok: false, state: "aborted", violations: jv, filesCommitted: [], effectsReleased: [], judged: true };
      }
    }
    for (const e of t.effects) this.writeOutbox(sessionId, e);
    const filesCommitted = t.fs.commit();
    t.state = "committed";
    return { ok: true, state: "committed", violations: [], filesCommitted, effectsReleased: t.effects.map((e) => e.id), judged };
  }

  abort(sessionId: string): void {
    const t = this.txns.get(sessionId);
    if (!t || t.state !== "open") return;
    t.fs.discard();
    t.effects.length = 0;
    t.state = "aborted";
  }
}
