// Escrow control API + event stream for the UI. Loopback only.
//   node harness/server.ts            → http://127.0.0.1:8790  (WS: ws://127.0.0.1:8790/events)
//
// REST
//   GET  /api/health                          proxy mode/spend, sandbox phase, active run
//   GET  /api/scenarios                       live specs + which arms have a cached run
//   POST /api/runs {scenario, arm, mode?, contract?}
//        mode: "auto" (default: live, else cached fallback) | "live" | "cached"; contract: "await" (default) | "off"
//   GET  /api/runs, GET /api/runs/:id         status, outcome, transcript when done
//   GET  /api/contracts, GET /api/contracts/:id
//   POST /api/contracts {request, sessionId}  Ultra drafts a contract (pending)
//   POST /api/contracts/:id/approve | /reject the user's decision; a waiting run starts or ends
// WS /events: on connect, {type:"hello", backlog:[...]} then every event as it happens.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { EventBus, FileTail, fromAudit, fromProxy, fromSender, labelEvent, transcriptToEvents, type EventBody } from "./events.ts";
import { createLabeler, prewarm, cacheSize } from "./labeler.ts";
import { LIVE_SPECS, runLive, belongsTo, type Arm, type Transcript } from "./live.ts";
import { draftContract, decideContract, getContract, listContracts } from "./contracts.ts";
import { SANDBOX, tailSandboxAudit } from "./sandbox.ts";
import { accessConfig, bearer, clientIp, liveRunsDisabled, RateLimiter, tokenOk, wsToken } from "./access.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.ESCROW_API_PORT ?? 8790);
const CACHE_DIR = resolve(ROOT, "evidence/runs");
const RUNS_DIR = resolve(ROOT, "state/runs");
const run = promisify(execFile);

export const bus = new EventBus();

interface RunRec {
  id: string; scenario: string; arm: Arm; live: boolean; cachedReason?: string;
  status: "starting" | "awaiting_approval" | "running" | "done" | "failed";
  sessionId?: string; contractId?: string; startedAt: string; error?: string;
  outcome?: Transcript["outcome"]; transcript?: Transcript;
}
const runs = new Map<string, RunRec>();
let active: RunRec | null = null;

// ---- live sources ----------------------------------------------------------------------------------

/** Tag an event with the active run when it belongs to that run's session (or arrives during it). */
function publishSourced(b: EventBody, opts: { bySession: boolean }) {
  const a = active?.live && active.status !== "done" && active.status !== "failed" ? active : null;
  const mine = a && (opts.bySession ? !!a.sessionId && !!b.sessionId && belongsTo({ sessionId: b.sessionId }, a.sessionId) : true);
  bus.publish({ ...b, ...(mine ? { runId: a!.id } : {}) });
}

/** Stream the hook's audit log into the bus, and label every read with Nano (harness/labeler.ts). */
function tailAudit() {
  const labeler = createLabeler({ onLabel: (session, l) => publishSourced(labelEvent(session, l as unknown as Record<string, unknown>), { bySession: true }) });
  void prewarm().then((ls) => console.log(`labeler: ${ls.length} course files labeled (cache ${cacheSize()})`));
  return tailSandboxAudit((o) => {
    for (const b of fromAudit(o)) publishSourced(b, { bySession: true });
    labeler.onAuditLine(o);
  });
}

// ---- health / preflight ----------------------------------------------------------------------------

async function health() {
  const proxy = await fetch("http://127.0.0.1:8000/healthz").then((r) => r.json() as Promise<{ mode: string; totalUsd: number; capUsd: number }>).catch(() => null);
  let phase = "unknown";
  try {
    const { stdout } = await run("openshell", ["sandbox", "get", SANDBOX], { timeout: 15000 });
    phase = /Phase:\s*(\w+)/.exec(stdout.replace(/\x1b\[[\d;]*m/g, ""))?.[1] ?? "unknown"; // strip ANSI colour codes
  } catch { phase = "unreachable"; }
  return { proxy, sandbox: { name: SANDBOX, phase }, activeRun: active && !["done", "failed"].includes(active.status) ? active.id : null, liveRuns: liveRunsDisabled() ? "off" : "on", authRequired: !!ACCESS.token };
}

async function liveUnavailable(): Promise<string | null> {
  // test hook (scripts/check-run-race.ts): stand in for the slow sandbox health probe
  const delay = Number(process.env.ESCROW_PREFLIGHT_DELAY_MS ?? 0);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const off = liveRunsDisabled();
  if (off) return off;
  const h = await health();
  if (!h.proxy) return "spend proxy is down";
  if (h.proxy.mode !== "live") return `spend proxy is in ${h.proxy.mode} mode (cap or daily run limit reached)`;
  if (h.sandbox.phase !== "Ready") return `sandbox phase is ${h.sandbox.phase}`;
  return null;
}

// ---- cached replay ---------------------------------------------------------------------------------

const cachedPath = (scenario: string, arm: Arm) => resolve(CACHE_DIR, `${scenario}-${arm}.json`);
export const hasCached = (scenario: string, arm: Arm) => existsSync(cachedPath(scenario, arm));

/** Replay a saved transcript as events, keeping the original order and (compressed) pacing. Flagged cached. */
async function replay(rec: RunRec, speed = 1): Promise<Transcript> {
  const t = JSON.parse(readFileSync(cachedPath(rec.scenario, rec.arm), "utf8")) as Transcript;
  const tag = { runId: rec.id, cached: true, sessionId: t.sessionId };
  let prev = Date.parse(t.startedAt);
  for (const e of transcriptToEvents(t)) {
    const gap = Math.min(Math.max(Date.parse(String(e.ts)) - prev, 0), 1500) / speed;
    prev = Date.parse(String(e.ts));
    await new Promise((r) => setTimeout(r, gap));
    bus.publish({ ...e, ...tag, originalTs: e.ts, ts: undefined });
  }
  return t;
}

// ---- runs ------------------------------------------------------------------------------------------

async function startRun(scenario: string, arm: Arm, mode: "auto" | "live" | "cached", contract: "await" | "off"): Promise<RunRec> {
  const spec = LIVE_SPECS.find((s) => s.id === scenario);
  if (!spec) throw Object.assign(new Error(`unknown scenario ${scenario}`), { status: 404 });
  if (arm !== "baseline" && arm !== "escrow") throw Object.assign(new Error("arm must be baseline or escrow"), { status: 400 });
  if (active && !["done", "failed"].includes(active.status)) throw Object.assign(new Error(`run ${active.id} is in progress (the sandbox runs one scenario at a time)`), { status: 409 });
  // Claim the single run slot BEFORE any await: otherwise two requests can both pass the check above and drive the
  // one sandbox at once (seen live: the second run's mode switch flipped the first run into escrow mode).
  const rec: RunRec = { id: `run-${randomUUID().slice(0, 8)}`, scenario, arm, live: false, status: "starting", startedAt: new Date().toISOString() };
  active = rec;
  let reason: string | null;
  try {
    reason = mode === "cached" ? "cached run requested" : mode === "auto" ? await liveUnavailable() : null;
    if (mode === "live") { const why = await liveUnavailable(); if (why) throw Object.assign(new Error(`live run unavailable: ${why}`), { status: 503 }); }
    if (reason && !hasCached(scenario, arm)) throw Object.assign(new Error(`live run unavailable (${reason}) and no cached run for ${scenario}/${arm}`), { status: 503 });
  } catch (e) {
    if (active === rec) active = null; // release the slot
    throw e;
  }
  rec.live = !reason; rec.cachedReason = reason ?? undefined;
  runs.set(rec.id, rec);
  bus.publish({ type: "run_started", runId: rec.id, scenario, arm, live: rec.live, cached: !rec.live, cachedReason: rec.cachedReason, desc: spec.desc, leaks: spec.leaks });

  void (async () => {
    try {
      let t: Transcript;
      if (rec.live) {
        rec.sessionId = `ui-${spec.id.slice(0, 12)}-${arm}-${Date.now().toString(36)}`.toLowerCase();
        t = await runLive(spec, arm, {
          sessionId: rec.sessionId, contract,
          onPhase: (phase, data) => {
            if (phase === "contract_drafted") {
              const c = data as { id: string };
              rec.contractId = c.id; rec.status = "awaiting_approval";
              // An undecided contract would hold the sandbox's single run slot: auto-reject after the timeout
              setTimeout(() => { if (rec.status === "awaiting_approval") void decideContract(c.id, "rejected").catch(() => {}); }, APPROVAL_TIMEOUT_MS);
              bus.publish({ type: "contract_drafted", runId: rec.id, sessionId: rec.sessionId, contract: data });
            } else if (phase === "contract_decided") {
              rec.status = "running";
              bus.publish({ type: "contract_decided", runId: rec.id, sessionId: rec.sessionId, contract: data });
            } else {
              if (phase === "agent_start") rec.status = "running";
              bus.publish({ type: "run_phase", runId: rec.id, sessionId: rec.sessionId, phase, data });
            }
          },
        });
        // A live run that never reached the agent (sandbox/agent failure) falls back to the cached run in auto mode
        if (!t.agentOk && t.events.length === 0 && t.contract?.status !== "rejected" && mode === "auto" && hasCached(scenario, arm)) {
          bus.publish({ type: "run_failed", runId: rec.id, error: t.agentError ?? "agent failed", fallback: "cached" });
          rec.live = false; rec.cachedReason = `live run failed: ${(t.agentError ?? "").slice(0, 200)}`;
          bus.publish({ type: "run_started", runId: rec.id, scenario, arm, live: false, cached: true, cachedReason: rec.cachedReason, desc: spec.desc, leaks: spec.leaks });
          t = await replay(rec);
        } else {
          mkdirSync(RUNS_DIR, { recursive: true });
          writeFileSync(resolve(RUNS_DIR, `${rec.id}.json`), JSON.stringify(t, null, 2));
        }
      } else {
        rec.status = "running";
        t = await replay(rec);
      }
      rec.transcript = t; rec.outcome = t.outcome; rec.status = "done";
      const usd = t.modelCalls.reduce((a, m) => a + Number(m.usd ?? 0), 0);
      bus.publish({ type: "run_finished", runId: rec.id, live: rec.live, cached: !rec.live, outcome: t.outcome, durationMs: t.durationMs, scenario, arm,
        modelCalls: t.modelCalls.length, modelUsd: Math.round(usd * 1e6) / 1e6, delivered: t.deliveredEffects ?? [] });
    } catch (e) {
      rec.status = "failed"; rec.error = (e as Error).message;
      bus.publish({ type: "run_failed", runId: rec.id, error: rec.error });
    }
  })();
  return rec;
}

// ---- HTTP ------------------------------------------------------------------------------------------

// Browser origins allowed to call the API and read the stream (the UI's dev/preview servers by default). The API
// starts runs and approves contracts, so it is never open to arbitrary origins.
const UI_ORIGINS = (process.env.ESCROW_UI_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173").split(",").map((o) => o.trim()).filter(Boolean);
const originOk = (o: string | undefined) => !o || UI_ORIGINS.includes(o); // no Origin header = CLI / curl
const ACCESS = accessConfig();
const APPROVAL_TIMEOUT_MS = Number(process.env.ESCROW_APPROVAL_TIMEOUT_MS ?? 300_000);
const limiter = new RateLimiter(ACCESS);

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const o = res.req?.headers.origin;
  res.writeHead(status, { "content-type": "application/json", ...(o && originOk(o) ? { "access-control-allow-origin": o, vary: "Origin" } : {}), ...headers });
  res.end(JSON.stringify(body, null, 2));
};
const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};
const summary = (r: RunRec) => { const { transcript: _t, ...rest } = r; return rest; };

export function createApp() {
  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (!originOk(origin)) return send(res, 403, { error: `origin ${origin} not allowed (set ESCROW_UI_ORIGINS)` });
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}), "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "600" });
        return res.end();
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
      if (parts[0] !== "api") return send(res, 404, { error: "not found" });
      const [_, r1, id, action] = parts;
      const ip = clientIp(ACCESS, req);
      /** true (and a 429 sent) when this IP is over the limit */
      const limited = (kind: Parameters<RateLimiter["take"]>[0]): boolean => {
        const ra = limiter.take(kind, ip);
        if (ra) send(res, 429, { error: `rate limit (${kind}); retry in ${ra}s` }, { "retry-after": String(ra) });
        return ra > 0;
      };
      if (limited("api")) return;
      const authed = tokenOk(ACCESS, bearer(req));
      // Health is public but minimal without the token: enough for the UI to know it must ask for one
      if (req.method === "GET" && r1 === "health") return authed ? send(res, 200, await health()) : send(res, 401, { error: "access token required", authRequired: true, liveRuns: liveRunsDisabled() ? "off" : "on" });
      if (!authed) return send(res, 401, { error: "access token required", authRequired: true });
      if (req.method === "POST" && r1 === "runs" && !id && limited("run")) return;
      if (req.method === "POST" && r1 === "contracts" && !id) {
        if (liveRunsDisabled()) return send(res, 503, { error: liveRunsDisabled() });
        if (limited("draft")) return;
      }
      if (req.method === "GET" && r1 === "scenarios")
        return send(res, 200, LIVE_SPECS.map((s) => ({ id: s.id, desc: s.desc, leaks: s.leaks, contract: !!s.contractRequest, cached: { baseline: hasCached(s.id, "baseline"), escrow: hasCached(s.id, "escrow") } })));
      if (r1 === "runs") {
        if (req.method === "POST" && !id) {
          const b = await readJson(req);
          const rec = await startRun(String(b.scenario ?? b.scenario_id ?? ""), String(b.arm ?? "escrow") as Arm,
            (b.mode as "auto" | "live" | "cached") ?? "auto", (b.contract as "await" | "off") ?? "await");
          return send(res, 202, summary(rec));
        }
        if (req.method === "GET" && !id) return send(res, 200, [...runs.values()].map(summary));
        if (req.method === "GET" && id) { const r = runs.get(id); return r ? send(res, 200, r) : send(res, 404, { error: `no run ${id}` }); }
      }
      if (r1 === "contracts") {
        if (req.method === "GET" && !id) return send(res, 200, listContracts());
        if (req.method === "GET" && id) { const c = getContract(id); return c ? send(res, 200, c) : send(res, 404, { error: `no contract ${id}` }); }
        if (req.method === "POST" && !id) {
          const b = await readJson(req);
          if (typeof b.request !== "string" || !b.request.trim()) return send(res, 400, { error: "request (string) is required" });
          const c = await draftContract(b.request, String(b.sessionId ?? `adhoc-${Date.now().toString(36)}`));
          bus.publish({ type: "contract_drafted", contract: c });
          return send(res, 201, c);
        }
        if (req.method === "POST" && id && (action === "approve" || action === "reject")) {
          const c = await decideContract(id, action === "approve" ? "approved" : "rejected");
          return send(res, 200, c); // a run waiting on this contract publishes contract_decided itself
        }
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      const status = (e as { status?: number }).status ?? (/already|no contract/.test((e as Error).message) ? 409 : 500);
      return send(res, status, { error: (e as Error).message });
    }
  });

  const wss = new WebSocketServer({
    server, path: "/events",
    verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }, cb: (ok: boolean, code?: number, msg?: string) => void) => {
      if (!originOk(origin)) return cb(false, 403, "origin not allowed");
      if (limiter.take("ws", clientIp(ACCESS, req))) return cb(false, 429, "rate limit");
      if (!tokenOk(ACCESS, wsToken(req))) return cb(false, 401, "access token required");
      cb(true);
    },
    handleProtocols: (protocols: Set<string>) => (protocols.has("escrow") ? "escrow" : false), // never echo the token protocol
  });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", backlog: bus.backlog.slice(-500) }));
    const on = (ev: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev)); };
    bus.on("event", on);
    ws.on("close", () => bus.off("event", on));
  });
  return server;
}

if (import.meta.filename === process.argv[1]) {
  const stopAudit = tailAudit();
  const proxyTail = new FileTail(resolve(ROOT, "state/proxy.log"), (o) => { for (const b of fromProxy(o)) publishSourced(b, { bySession: false }); });
  const senderTail = new FileTail(resolve(ROOT, "state/sent.log"), (o) => { for (const b of fromSender(o)) publishSourced(b, { bySession: true }); });
  const server = createApp().listen(PORT, "127.0.0.1", () => console.log(`escrow api on http://127.0.0.1:${PORT}  (ws /events)`));
  const stop = () => { stopAudit(); proxyTail.stop(); senderTail.stop(); server.close(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}


