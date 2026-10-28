// Regression check: two run requests at the same instant must not both start (the sandbox runs one scenario).
// Live runs are switched off here, so this costs nothing (the winner is a cached replay).
process.env.ESCROW_LIVE_RUNS = "off";
process.env.ESCROW_RL_RUNS_PER_HOUR = "100";
process.env.ESCROW_PREFLIGHT_DELAY_MS = "400"; // the real preflight probes the sandbox (~0.5 s): that gap is the race window
delete process.env.ESCROW_ACCESS_TOKEN;
const { createApp } = await import("../harness/server.ts");
const srv = createApp().listen(8792, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const post = () => fetch("http://127.0.0.1:8792/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "K1-split-score", arm: "baseline" }) }).then(async (r) => `${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 90)}`);
const res = await Promise.all([post(), post(), post()]);
for (const r of res) console.log(r);
const ok = res.filter((r) => r.startsWith("202")).length;
console.log(ok === 1 ? `OK: exactly one of ${res.length} simultaneous requests started a run` : `FAIL: ${ok} runs started`);
srv.close(); process.exit(ok === 1 ? 0 : 1);
