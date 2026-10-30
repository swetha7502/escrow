// End-to-end check of the public control API through the tunnel: auth, CORS for the hosted UI, 404s, and the
// /events WebSocket (token subprotocol). Prints one line per check; exit 1 on any failure.
//   node scripts/check-tunnel.ts https://<x>.trycloudflare.com      (token + UI origin from state/public.env)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https:\/\//.test(base)) { console.error("usage: check-tunnel.ts https://<public url>"); process.exit(2); }
const pub = Object.fromEntries(readFileSync(resolve(import.meta.dirname, "../state/public.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const token = pub.ESCROW_ACCESS_TOKEN;
const origin = (pub.ESCROW_UI_ORIGINS ?? "").split(",")[0].trim();
let fails = 0;
const line = (ok: boolean, what: string, got: string) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${what.padEnd(46)} → ${got}`); };

const get = async (path: string, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { headers, signal: AbortSignal.timeout(15000) });
  return { status: r.status, acao: r.headers.get("access-control-allow-origin"), body: (await r.text()).slice(0, 80).replace(/\s+/g, " ") };
};
let r = await get("/api/health");
line(r.status === 401, "GET /api/health, no token", `${r.status} ${r.body}`);
r = await get("/api/health", { authorization: `Bearer ${token}` });
line(r.status === 200, "GET /api/health, token", `${r.status} ${r.body}`);
r = await get("/api/scenarios", { authorization: `Bearer ${token}`, origin });
line(r.status === 200 && r.acao === origin, `GET /api/scenarios from ${origin}`, `${r.status}, access-control-allow-origin: ${r.acao}`);
r = await get("/api/health", { authorization: `Bearer ${token}`, origin: "https://evil.example" });
line(r.status === 403, "GET /api/health from https://evil.example", `${r.status}`);
for (const p of ["/", "/v1/chat/completions", "/healthz"]) { r = await get(p, { authorization: `Bearer ${token}` }); line(r.status === 404, `GET ${p}`, `${r.status}`); }

const wsOnce = (protocols: string[]) => new Promise<string>((done) => {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/events", protocols, { headers: { origin } });
  const t = setTimeout(() => { ws.terminate(); done("timeout"); }, 15000);
  ws.on("message", (m) => { clearTimeout(t); const type = JSON.parse(String(m)).type; ws.close(); done(`open, first message type=${type}`); });
  ws.on("unexpected-response", (_q, res) => { clearTimeout(t); done(`refused ${res.statusCode}`); });
  ws.on("error", (e) => { clearTimeout(t); done(`error ${e.message || (e as NodeJS.ErrnoException).code || e.name}`); });
});
// A brand-new quick tunnel can drop the first upgrades for a few seconds after HTTP already works: retry
// transport errors (never a 401/refusal, which is the answer)
const wsTry = async (protocols: string[]) => {
  let r = "";
  for (let i = 0; i < 5; i++) { r = await wsOnce(protocols); if (!r.startsWith("error") && r !== "timeout") return r; await new Promise((ok) => setTimeout(ok, 3000)); }
  return r;
};
let w = await wsTry(["escrow"]);
line(w.startsWith("refused 401"), "WS /events, no token", w);
w = await wsTry(["escrow", `escrow-token.${token}`]);
line(w.includes("type=hello"), "WS /events, token subprotocol", w);
console.log(fails ? `${fails} check(s) failed` : "tunnel OK");
process.exit(fails ? 1 : 0);
