// OpenAI-compatible metering proxy. Forwards only to Token Factory, and is the only code that holds TF_API_KEY.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SpendGuard, type Decision, type Prices, type Usage } from "../lib/spend-guard/index.ts";

export const ALLOWED_UPSTREAM_HOST = "api.tokenfactory.nebius.com";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_TOKENS = 8192;
export const MAX_TOKENS_CEILING = 16384;
/** Prompt-token upper bound = request bytes + this slack (chat template tokens). */
const PROMPT_SLACK_TOKENS = 256;

export interface ProxyConfig {
  upstreamBase: string;   // e.g. https://api.tokenfactory.nebius.com/v1
  upstreamKey: string;
  proxyToken: string;
  guard: SpendGuard;
  prices: Prices;
  logPath?: string;
  fetchImpl?: typeof fetch;
  /** IPv4 CIDRs allowed to connect. Loopback is always allowed. */
  allowedCidrs?: string[];
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function sourceAllowed(remote: string | undefined, cidrs: string[]): boolean {
  if (!remote) return false;
  if (remote === "::1") return true;
  const ip = ipv4ToInt(remote);
  if (ip === null) return false;
  for (const c of ["127.0.0.0/8", ...cidrs]) {
    const [base, bitsS] = c.split("/");
    const b = ipv4ToInt(base);
    const bits = Number(bitsS);
    if (b === null || !(bits >= 0 && bits <= 32)) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((ip & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

/** Fails unless the URL is https://api.tokenfactory.nebius.com/... */
export function assertTokenFactoryUrl(u: string): string {
  const url = new URL(u);
  if (url.protocol !== "https:" || url.hostname !== ALLOWED_UPSTREAM_HOST || url.port !== "") {
    throw new Error(`TF_BASE_URL must be https://${ALLOWED_UPSTREAM_HOST}/..., got ${url.origin}`);
  }
  return url.toString().replace(/\/+$/, "");
}

function sha(s: string) { return createHash("sha256").update(s).digest(); }

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function stopped(res: ServerResponse, d: Decision & { ok: false }) {
  send(res, 402, { error: { type: "spend_guard_stopped", code: "cached_mode", reason_code: d.code, message: `Escrow spend guard: live inference stopped (${d.reason}). Use cached mode.` } },
    { "x-escrow-mode": "cached", "x-escrow-stop-reason": d.code });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function usageOf(x: unknown): Usage | null {
  const u = (x as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  if (!u || typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") return null;
  return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens };
}

export function createProxy(cfg: ProxyConfig): Server {
  const doFetch = cfg.fetchImpl ?? fetch;
  const tokenHash = sha(cfg.proxyToken);
  const log = (o: Record<string, unknown>) => {
    if (!cfg.logPath) return;
    try {
      mkdirSync(dirname(cfg.logPath), { recursive: true });
      appendFileSync(cfg.logPath, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
    } catch { /* logging must never break metering */ }
  };

  const authed = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/.exec(h);
    return !!m && timingSafeEqual(sha(m[1].trim()), tokenHash);
  };

  return createServer(async (req, res) => {
    if (!sourceAllowed(req.socket.remoteAddress, cfg.allowedCidrs ?? [])) {
      log({ event: "rejected_source", remote: req.socket.remoteAddress });
      req.socket.destroy();
      return;
    }
    const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "");
    try {
      if (req.method === "GET" && path === "/healthz") {
        const st = cfg.guard.status();
        if (!st.ok) return send(res, 200, { mode: "cached", reason_code: st.code });
        const atCap = st.state.totalUsd >= st.capUsd;
        return send(res, 200, { mode: atCap ? "cached" : "live", ...(atCap ? { reason_code: "cap_reached" } : {}), totalUsd: st.state.totalUsd, capUsd: st.capUsd });
      }
      if (!authed(req)) {
        log({ event: "unauthorized", method: req.method, path });
        return send(res, 401, { error: { type: "unauthorized", message: "missing or bad proxy token" } });
      }

      if (req.method === "GET" && path === "/v1/models") {
        const st = cfg.guard.status();
        if (!st.ok) return stopped(res, st);
        return send(res, 200, { object: "list", data: Object.keys(cfg.prices).map((id) => ({ id, object: "model", owned_by: "tokenfactory" })) });
      }
      if (req.method !== "POST" || path !== "/v1/chat/completions") {
        log({ event: "not_proxied", method: req.method, path });
        return send(res, 404, { error: { type: "not_found", message: `${req.method} ${path} is not proxied` } });
      }

      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      } catch {
        return send(res, 400, { error: { type: "invalid_request", message: "body must be a JSON object" } });
      }
      const model = body.model;
      if (typeof model !== "string") return send(res, 400, { error: { type: "invalid_request", message: "model is required" } });

      // Clamp completion length so the reservation is a real upper bound
      const tokKey = body.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
      const asked = typeof body[tokKey] === "number" ? (body[tokKey] as number) : DEFAULT_MAX_TOKENS;
      const maxTokens = Math.max(1, Math.min(Math.floor(asked), MAX_TOKENS_CEILING));
      body[tokKey] = maxTokens;
      const stream = body.stream === true;
      if (stream) body.stream_options = { ...(body.stream_options as object ?? {}), include_usage: true };

      const runHeader = req.headers["x-escrow-run"];
      const runId = typeof runHeader === "string" && /^[\w.:-]{1,128}$/.test(runHeader) ? runHeader : undefined;
      const fwd = Buffer.from(JSON.stringify(body));
      const d = cfg.guard.check({ model, runId, maxUsage: { promptTokens: fwd.length + PROMPT_SLACK_TOKENS, completionTokens: maxTokens } });
      if (!d.ok) {
        log({ event: "blocked", model, runId, code: d.code, reason: d.reason });
        return stopped(res, d);
      }
      const r = d.reservation;

      const ac = new AbortController();
      res.on("close", () => { if (!res.writableEnded) ac.abort(); });
      let upstream: Response;
      try {
        upstream = await doFetch(`${cfg.upstreamBase}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", authorization: `Bearer ${cfg.upstreamKey}` },
          body: fwd,
          signal: ac.signal,
        });
      } catch (e) {
        // Unknown whether upstream processed it, so charge the worst case
        const c = cfg.guard.commit(r, null);
        log({ event: "upstream_error", model, runId: r.runId, usd: c.usd, totalUsd: c.totalUsd, error: (e as Error).message });
        return send(res, 502, { error: { type: "upstream_error", message: "Token Factory unreachable" } });
      }

      if (!stream || !upstream.ok || !upstream.body) {
        const text = await upstream.text();
        let usage: Usage | null = null;
        try { usage = usageOf(JSON.parse(text)); } catch { /* non-JSON */ }
        // A 4xx without usage was rejected before inference. Anything else without usage is charged the worst case.
        const charge = usage ?? (upstream.status >= 400 && upstream.status < 500 ? { promptTokens: 0, completionTokens: 0 } : null);
        const c = cfg.guard.commit(r, charge);
        log({ event: "call", model, runId: r.runId, status: upstream.status, usage, usd: c.usd, totalUsd: c.totalUsd });
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        return res.end(text);
      }

      // Streaming: pass bytes through and pick up usage from the final chunk
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" });
      let usage: Usage | null = null;
      let buf = "";
      const dec = new TextDecoder();
      try {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try { usage = usageOf(JSON.parse(data)) ?? usage; } catch { /* partial or non-JSON */ }
          }
        }
      } catch { /* client gone or upstream cut. Usage may be unknown, so the reservation is charged */ }
      const c = cfg.guard.commit(r, usage);
      log({ event: "call", model, runId: r.runId, status: upstream.status, stream: true, usage, usd: c.usd, totalUsd: c.totalUsd });
      res.end();
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      log({ event: "error", error: (e as Error).message });
      if (!res.headersSent) send(res, status, { error: { type: "proxy_error", message: (e as Error).message } });
      else res.end();
    }
  });
}
