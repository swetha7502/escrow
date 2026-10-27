// Exercise the hosting hardening against an in-process API on a spare port (no audit/proxy tails, no sandbox).
//   ESCROW_ACCESS_TOKEN=... node scripts/check-hardening.ts
process.env.ESCROW_ACCESS_TOKEN ??= "test-token-123";
process.env.ESCROW_RL_RUNS_PER_HOUR = "3";
process.env.ESCROW_LIVE_RUNS = "off";
const { createApp } = await import("../harness/server.ts");
const { WebSocket } = await import("ws");
const PORT = 8791, B = `http://127.0.0.1:${PORT}`, TOK = process.env.ESCROW_ACCESS_TOKEN;
const srv = createApp().listen(PORT, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const call = async (label: string, path: string, init: RequestInit = {}, tok: string | null = TOK) => {
  const r = await fetch(B + path, { ...init, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(init.headers ?? {}) } });
  const body = await r.text();
  console.log(`${label.padEnd(46)} → ${r.status} ${body.replace(/\s+/g, " ").slice(0, 150)}`);
  return r.status;
};
const ws = (label: string, protocols: string[]) => new Promise<void>((res) => {
  const w = new WebSocket(`ws://127.0.0.1:${PORT}/events`, protocols);
  w.on("message", (m) => { console.log(`${label.padEnd(46)} → open, first message type=${JSON.parse(String(m)).type}`); w.close(); res(); });
  w.on("unexpected-response", (_q, r) => { console.log(`${label.padEnd(46)} → refused ${r.statusCode}`); res(); });
  w.on("error", () => res());
});
await call("GET /api/health, no token", "/api/health", {}, null);
await call("GET /api/health, wrong token", "/api/health", {}, "nope");
await call("GET /api/health, token", "/api/health");
await call("GET /api/scenarios, no token", "/api/scenarios", {}, null);
await call("GET /api/health, foreign Origin", "/api/health", { headers: { origin: "https://evil.example" } });
await ws("WS /events, no token", ["escrow"]);
await ws("WS /events, token subprotocol", ["escrow", `escrow-token.${TOK}`]);
await call("POST /api/runs #1 mode=live (live off)", "/api/runs", { method: "POST", body: JSON.stringify({ scenario: "K1-split-score", arm: "escrow", mode: "live" }) });
await call("POST /api/runs #2 (live off → cached)", "/api/runs", { method: "POST", body: JSON.stringify({ scenario: "K1-split-score", arm: "escrow" }) });
await call("POST /api/runs #3 (one run at a time)", "/api/runs", { method: "POST", body: JSON.stringify({ scenario: "K2-paraphrase-accommodation", arm: "escrow" }) });
await call("POST /api/runs #4 (runs/hour limit = 3)", "/api/runs", { method: "POST", body: JSON.stringify({ scenario: "K1-split-score", arm: "baseline" }) });
await call("POST /api/contracts (Ultra draft, live off)", "/api/contracts", { method: "POST", body: JSON.stringify({ request: "x" }) });
srv.close(); process.exit(0);
