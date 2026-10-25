import { SpendGuard } from "../lib/spend-guard/index.ts";
import { createProxy, assertTokenFactoryUrl, parseStopStatus } from "./proxy.ts";
import { proxySettings } from "./config.ts";

const { env, statePath, logPath, prices } = proxySettings();
const need = (k: string) => {
  const v = env[k];
  if (!v) { console.error(`proxy: ${k} is not set`); process.exit(1); }
  return v;
};
const upstreamBase = assertTokenFactoryUrl(need("TF_BASE_URL"));
const upstreamKey = need("TF_API_KEY");
const proxyToken = need("PROXY_TOKEN");
if (proxyToken.length < 32) { console.error("proxy: PROXY_TOKEN must be at least 32 chars"); process.exit(1); }
const host = env.PROXY_HOST ?? "127.0.0.1";
const port = Number(env.PROXY_PORT ?? 8000);
const stopStatus = parseStopStatus(env.PROXY_STOP_STATUS);
const retryAfterSec = Number(env.PROXY_RETRY_AFTER_SEC ?? 60);
const allowedCidrs = (env.PROXY_ALLOWED_CIDRS ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const guard = new SpendGuard({ statePath, prices, creditExpiry: env.CREDIT_EXPIRY });
const st = guard.status();
console.log(`proxy: upstream ${upstreamBase}; state ${statePath}; mode ${st.ok ? `live ($${st.state.totalUsd.toFixed(6)} of $${st.capUsd})` : `CACHED (${st.code})`}`);
createProxy({ upstreamBase, upstreamKey, proxyToken, guard, prices, logPath, allowedCidrs, stopStatus, retryAfterSec }).listen(port, host, () => {
  console.log(`proxy: listening on http://${host}:${port}; stop status ${stopStatus}; sources: loopback${allowedCidrs.length ? ", " + allowedCidrs.join(", ") : " only"}`);
});
