// Host-side effect sender. Runs outside the sandbox and pulls the outbox through a transport,
// so the sandbox needs no network path to reach it. Sends only committed effects that pass
// host-side verification. The sandbox's own "committed" claim is never trusted alone.
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type EffectKind = "send_email" | "write_external";

export interface Effect {
  id: string;
  sessionId: string;
  kind: EffectKind;
  payload: Record<string, unknown>;
  status: "committed";
  committedAt: string;
}

/** Where the outbox lives. The sandbox transport goes through `openshell sandbox exec`. */
export interface OutboxTransport {
  list(): Promise<string[]>;             // effect ids ready to drain
  read(id: string): Promise<string>;     // raw JSON
  ack(id: string): Promise<void>;        // mark drained in the source
}

export type Verifier = (e: Effect) => { ok: true } | { ok: false; reason: string };

export interface DrainResult { sent: string[]; rejected: { id: string; reason: string }[]; skipped: string[] }

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function parseEffect(raw: string): Effect {
  const e = JSON.parse(raw) as Effect;
  if (!e || typeof e !== "object") throw new Error("not an object");
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) throw new Error("bad id");
  if (typeof e.sessionId !== "string") throw new Error("bad sessionId");
  if (e.kind !== "send_email" && e.kind !== "write_external") throw new Error(`bad kind ${String(e.kind)}`);
  if (e.status !== "committed") throw new Error("not committed");
  if (!e.payload || typeof e.payload !== "object") throw new Error("bad payload");
  return e;
}

export class Sender {
  private t: OutboxTransport;
  private verify: Verifier;
  private sentLog: string;
  private seenPath: string;
  private seen: Set<string>;

  constructor(opts: { transport: OutboxTransport; verify: Verifier; sentLog: string; seenPath: string }) {
    this.t = opts.transport;
    this.verify = opts.verify;
    this.sentLog = opts.sentLog;
    this.seenPath = opts.seenPath;
    this.seen = new Set(existsSync(this.seenPath) ? (JSON.parse(readFileSync(this.seenPath, "utf8")) as string[]) : []);
  }

  private record(o: Record<string, unknown>) {
    mkdirSync(dirname(this.sentLog), { recursive: true });
    appendFileSync(this.sentLog, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
  }

  private markSeen(id: string) {
    this.seen.add(id);
    mkdirSync(dirname(this.seenPath), { recursive: true });
    writeFileSync(this.seenPath, JSON.stringify([...this.seen]));
  }

  async drainOnce(): Promise<DrainResult> {
    const out: DrainResult = { sent: [], rejected: [], skipped: [] };
    for (const id of await this.t.list()) {
      if (!ID_RE.test(id)) { out.skipped.push(id); continue; }
      if (this.seen.has(id)) { out.skipped.push(id); await this.t.ack(id); continue; } // exactly-once
      let e: Effect;
      try {
        e = parseEffect(await this.t.read(id));
        if (e.id !== id) throw new Error("id mismatch");
      } catch (err) {
        const reason = `malformed: ${(err as Error).message}`;
        this.record({ event: "rejected", id, reason });
        out.rejected.push({ id, reason });
        this.markSeen(id);
        await this.t.ack(id);
        continue;
      }
      const v = this.verify(e);
      if (!v.ok) {
        this.record({ event: "rejected", id, sessionId: e.sessionId, kind: e.kind, reason: v.reason });
        out.rejected.push({ id, reason: v.reason });
      } else {
        // Demo delivery: log "sent". A real SMTP/API call would go here.
        this.record({ event: "sent", id, sessionId: e.sessionId, kind: e.kind, payload: e.payload });
        out.sent.push(id);
      }
      this.markSeen(id);
      await this.t.ack(id);
    }
    return out;
  }
}
