import json, pathlib, re, subprocess
R = pathlib.Path(__file__).resolve().parent.parent
rd = lambda p: (R / p).read_text()
F = "```"
dump_re = re.compile(r"/tmp/claude-[^ ]*/sandbox-dump2")
agent = json.loads(rd("state/cap-agent.json") or "{}")
agent_err = [l for l in rd("state/cap-agent.err").splitlines() if "Reason:" in l]
proxy_log = rd("state/proxy.log").splitlines()
blocked_cap = [l for l in proxy_log if '"blocked"' in l and "cap_reached" in l][:2]
tests = subprocess.run(["npm", "test", "--silent"], cwd=R, capture_output=True, text=True).stdout
test_lines = [l for l in tests.splitlines() if l.startswith(("✔", "✖", "ℹ pass", "ℹ fail"))]
spend_tests = [l for l in test_lines if any(k in l for k in ("cap", "fail closed", "spend", "402", "EXPIRY", "expiry", "daily run", "unknown model", "upstream URL", "proxy token", "source allowlist", "worst case", "latches", "streaming", "clamps", "pass", "fail "))]
md = f"""# Spend cap: proof that live inference can't exceed $15 or outlive the credits

**Claim:** Every Token Factory call, whether from the NemoClaw agent or from Escrow's own Nemotron calls, goes through one host-side proxy (`proxy/`). That proxy is the only holder of `TF_API_KEY`. It meters tokens and cost per model into `state/spend.json` using the prices in `docs/models.md`. It returns **HTTP 402 (cached mode)** at $15 total, after `CREDIT_EXPIRY`, after 20 live runs per UTC day, for any model not in the price table, and whenever `spend.json` is missing or corrupt (fail closed). The sandbox has no other route to Token Factory.

## Architecture

{F}
sandbox (OpenClaw agent) ──https──▶ inference.local ──▶ OpenShell gateway (host process)
                                                              │  injects PROXY_TOKEN (held in OpenShell provider state)
Escrow host code (lib/tf-client.ts) ──────────────────────────┤
                                                              ▼
                                          Escrow spend proxy 127.0.0.1:8000  (proxy/)
                                          · auth: PROXY_TOKEN   · loopback-only
                                          · reserve worst-case → forward → meter actual
                                          · 402 when stopped    · fail closed
                                                              │  Authorization: Bearer TF_API_KEY
                                                              ▼
                                               https://api.tokenfactory.nebius.com/v1
{F}

How the hard stop works:

* **Before** forwarding, the proxy reserves a worst-case cost: prompt tokens ≤ request bytes + 256, completion = `max_tokens` clamped to ≤ 16,384. It refuses the call if `spent + in-flight reservations + this call > cap`, so concurrent calls can't overshoot.
* **After** the call, it charges the real `usage` (streaming forces `stream_options.include_usage`). If usage is missing on a 2xx or 5xx, or the connection drops, it charges the full worst case.
* The cap is `min(spend.json capUsd, 15)`. `HARD_CAP_USD = 15` is a code constant, so editing `spend.json` can only lower it.
* `spend.json` must validate, including `totalUsd == Σ byModel.usd`, so hand-lowering the total is detected as corruption. If writing usage fails after a call, the guard latches closed until restart.
* Upstream is pinned: the proxy refuses to start unless `TF_BASE_URL` is `https://api.tokenfactory.nebius.com/...`. It only exposes `POST /v1/chat/completions` and `GET /v1/models` (served locally, no upstream call).

## 1. Proxy, the only place `TF_API_KEY` is used

See `proxy/proxy.ts`, `proxy/server.ts`, and `lib/spend-guard/index.ts`. `lib/env.ts` strips `TF_API_KEY` for every caller that doesn't pass `allowSecrets`, and only `proxy/config.ts` passes it.

## 2. Agent and Escrow both point at the proxy

* **NemoClaw/OpenShell:** onboarded with `NEMOCLAW_PROVIDER=custom NEMOCLAW_ENDPOINT_URL=http://localhost:8000/v1 COMPATIBLE_API_KEY=<PROXY_TOKEN>`. Inside the sandbox, OpenClaw's provider config is:
{F}
{dump_re.sub('<dump>', [l for l in rd('state/grep-sandbox.out').splitlines() if l.startswith('inference ')][0])}
{F}
* **Escrow:** `lib/tf-client.ts` → `PROXY_URL` (default `http://127.0.0.1:8000/v1`) with `PROXY_TOKEN`.
* **Egress:** the sandbox policy allows only `inference.local` (see `evidence/egress.md`).

## 3. Nothing else contains `TF_API_KEY`

Host repo and host NemoClaw/OpenShell state:

{F}
{rd('state/grep-host.out').strip()}
{F}

The only references to the *name* are the proxy (which reads it) and `lib/env.ts` (which strips it). The *value* appears nowhere except `.env`, which is gitignored (`git check-ignore -v .env` → `.gitignore:1:.env`).

Sandbox (state and env streamed out to the host and searched there, so no part of the key is ever sent into the sandbox):

{F}
{dump_re.sub('<dump>', rd('state/grep-sandbox.out')).strip()}
{F}

The sandbox doesn't even hold the proxy token. OpenShell supplies it on the host side.

## 4a. Cap set to $0.001: agent call and Escrow call both get 402

{F}
$ npm run spend:set-cap 0.001        # totalUsd was already $0.008049
$ curl localhost:8000/healthz
{{"mode":"cached","reason_code":"cap_reached","totalUsd":0.008049299999999999,"capUsd":0.001}}

$ nemoclaw escrow exec --no-stdin -- openclaw agent --session-id cap-proof --json -m "Say hi"
exit 1
{agent_err[0].strip() if agent_err else '(see state/cap-agent.err)'}

$ node scripts/escrow-call.ts nano
{{"outcome":"cached_mode","http":402,"reasonCode":"cap_reached","message":"Escrow spend guard: live inference stopped (spend $0.008049 + reserved $0.000000 + this call (max $0.000073) would exceed cap $0.001). Use cached mode."}}
exit 3
{F}

Proxy log. The first line is the agent's call (Super, via `inference.local`). The second is Escrow's (Nano, run id `spend-cap-proof`). Neither was forwarded upstream:

{F}
{chr(10).join(blocked_cap)}
{F}

OpenClaw turns the proxy's 402 into "billing error … run out of credits". The agent stops, which is the intended cached-mode behavior.

## 4b. Direct call from inside the sandbox to Token Factory fails

{F}
{rd('state/cap-direct.out').strip()}
{F}

More bypass attempts (raw TCP or UDP, `--noproxy`, pinned IPs, Node sockets) are in `evidence/egress.md`. All of them fail.

## 4c. Cap restored to $15: live again; spend.json

{F}
$ npm run spend:set-cap 15
$ curl localhost:8000/healthz
{{"mode":"live","totalUsd":0.008049299999999999,"capUsd":15}}
$ node scripts/escrow-call.ts nano
{{"outcome":"live","content":"escrow-call-ok",...}}
$ npm run spend:show
{rd('state/spend-final.out').strip()}
{F}

## 5. Fail closed: missing or corrupt spend.json → every call refused

{F}
{rd('state/failclosed.out').strip()}
{F}

The proxy never creates `spend.json` itself. Creating it takes an explicit `npm run spend:init`, which refuses to overwrite an existing file.

## Unit tests (`npm test`)

{F}
{chr(10).join(test_lines)}
{F}

## Limits (honest)

* The proxy meters only traffic that goes through it. Usage of the same key from somewhere else, such as the Token Factory console playground or another machine, is invisible to it. **Recommended manual step:** if Nebius offers an account-level spend limit or alert, set it at or below the promo credit amount as a second layer.
* Cost uses the list prices in `docs/models.md` (fetched 2026-10-23). If Nebius changes prices, update that table. Cached-input discounts are ignored, so metering errs high.
* The worst-case prompt bound (bytes + 256) is a heuristic upper bound. Real usage is still charged afterward, so the cap can be exceeded by at most one call's underestimate. In practice prompt tokens are far below byte counts.
* `CREDIT_EXPIRY=2026-12-15` is interpreted as **2026-12-15T00:00:00Z** (stop at the start of that day, conservatively).
"""
(R / "evidence/spend-cap.md").write_text(md)
print("wrote evidence/spend-cap.md", len(md.splitlines()), "lines")
