import { SpendGuard } from "../lib/spend-guard/index.ts";
import { createProxy, assertTokenFactoryUrl } from "./proxy.ts";
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
const port = Number(env.PROXY_PORT ?? 8787);

const guard = new SpendGuard({ statePath, prices, creditExpiry: env.CREDIT_EXPIRY });
const st = guard.status();
console.log(`proxy: upstream ${upstreamBase}; state ${statePath}; mode ${st.ok ? `live ($${st.state.totalUsd.toFixed(6)} of $${st.capUsd})` : `CACHED (${st.code})`}`);
createProxy({ upstreamBase, upstreamKey, proxyToken, guard, prices, logPath }).listen(port, host, () => {
  console.log(`proxy: listening on http://${host}:${port}`);
});
