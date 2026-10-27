// Hosting hardening for the control API (harness/server.ts):
//   - shared access token (ESCROW_ACCESS_TOKEN): every /api route but a minimal /api/health, and the WebSocket,
//     need it. HTTP: "Authorization: Bearer <token>". WebSocket (browsers can't set headers): the subprotocol
//     "escrow-token.<token>", alongside "escrow".
//   - per-IP rate limits (fixed windows); behind a Cloudflare Tunnel the client IP is CF-Connecting-IP, trusted only
//     when ESCROW_TRUST_CF=1 (the tunnel connects from loopback, so every request would otherwise share one IP).
//   - live-runs switch: ESCROW_LIVE_RUNS=off, or the file state/live-runs-disabled (toggle without a restart).
//     Off: runs fall back to cached replays and Ultra contract drafts are refused, so the demo costs nothing.
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
export const LIVE_SWITCH_FILE = resolve(ROOT, "state/live-runs-disabled");

export interface AccessConfig { token: string | null; trustCf: boolean; limits: Record<LimitKind, { max: number; windowMs: number }> }
export type LimitKind = "api" | "run" | "draft" | "ws";

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
export function accessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  return {
    token: env.ESCROW_ACCESS_TOKEN?.trim() || null,
    trustCf: env.ESCROW_TRUST_CF === "1",
    limits: {
      api: { max: num(env.ESCROW_RL_API_PER_MIN, 120), windowMs: 60_000 },
      run: { max: num(env.ESCROW_RL_RUNS_PER_HOUR, 12), windowMs: 3_600_000 },
      draft: { max: num(env.ESCROW_RL_DRAFTS_PER_HOUR, 12), windowMs: 3_600_000 },
      ws: { max: num(env.ESCROW_RL_WS_PER_MIN, 20), windowMs: 60_000 },
    },
  };
}

export const liveRunsDisabled = (env: NodeJS.ProcessEnv = process.env): string | null =>
  env.ESCROW_LIVE_RUNS === "off" ? "live runs disabled by the operator (ESCROW_LIVE_RUNS=off)"
    : existsSync(LIVE_SWITCH_FILE) ? "live runs disabled by the operator (state/live-runs-disabled)" : null;

/** Constant-time token check */
export function tokenOk(cfg: AccessConfig, presented: string | null | undefined): boolean {
  if (!cfg.token) return true;
  if (!presented) return false;
  const a = Buffer.from(presented), b = Buffer.from(cfg.token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const bearer = (req: IncomingMessage) => /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1]?.trim() ?? null;
/** Token offered as a WebSocket subprotocol "escrow-token.<token>" */
export const wsToken = (req: IncomingMessage) =>
  String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim()).find((p) => p.startsWith("escrow-token."))?.slice("escrow-token.".length) ?? null;

export function clientIp(cfg: AccessConfig, req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  if (cfg.trustCf && typeof cf === "string" && cf) return cf;
  return req.socket.remoteAddress ?? "?";
}

/** Fixed-window counters per (kind, ip). Returns retry-after seconds when over the limit, else 0. */
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  private cfg: AccessConfig;
  constructor(cfg: AccessConfig) { this.cfg = cfg; }
  take(kind: LimitKind, ip: string, now = Date.now()): number {
    const { max, windowMs } = this.cfg.limits[kind];
    const k = `${kind}:${ip}`;
    const h = this.hits.get(k);
    if (!h || now - h.start >= windowMs) { this.hits.set(k, { start: now, n: 1 }); return 0; }
    if (h.n >= max) return Math.ceil((h.start + windowMs - now) / 1000);
    h.n++;
    if (this.hits.size > 10_000) for (const [key, v] of this.hits) if (now - v.start >= windowMs) this.hits.delete(key);
    return 0;
  }
}
