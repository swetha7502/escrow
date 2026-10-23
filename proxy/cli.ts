import { initState, readState, setCap, SpendGuard } from "../lib/spend-guard/index.ts";
import { proxySettings } from "./config.ts";

const { env, statePath, prices } = proxySettings();
const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "init":
    console.log(JSON.stringify(initState(statePath), null, 2));
    break;
  case "set-cap":
    console.log(JSON.stringify(setCap(statePath, Number(arg)), null, 2));
    break;
  case "show": {
    const st = new SpendGuard({ statePath, prices, creditExpiry: env.CREDIT_EXPIRY }).status();
    console.log(st.ok ? `mode: live  spent $${st.state.totalUsd.toFixed(6)} / cap $${st.capUsd}` : `mode: CACHED  (${st.code}: ${st.reason})`);
    try { console.log(JSON.stringify(readState(statePath), null, 2)); } catch (e) { console.log((e as Error).message); }
    break;
  }
  default:
    console.error("usage: cli.ts init | show | set-cap <usd>");
    process.exit(2);
}
