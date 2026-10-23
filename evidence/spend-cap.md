# Spend cap: proof that live inference can't exceed $15 or outlive the credits

**Claim:** Every Token Factory call, whether from the NemoClaw agent or from Escrow's own Nemotron calls, goes through one host-side proxy (`proxy/`). That proxy is the only holder of `TF_API_KEY`. It meters tokens and cost per model into `state/spend.json` using the prices in `docs/models.md`. It returns **HTTP 402 (cached mode)** at $15 total, after `CREDIT_EXPIRY`, after 20 live runs per UTC day, for any model not in the price table, and whenever `spend.json` is missing or corrupt (fail closed). The sandbox has no other route to Token Factory.

## Architecture

```
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
```

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
```
inference {"baseUrl": "https://inference.local/v1", "api": "openai-completions", "apiKey": "unused"}
```
* **Escrow:** `lib/tf-client.ts` → `PROXY_URL` (default `http://127.0.0.1:8000/v1`) with `PROXY_TOKEN`.
* **Egress:** the sandbox policy allows only `inference.local` (see `evidence/egress.md`).

## 3. Nothing else contains `TF_API_KEY`

Host repo and host NemoClaw/OpenShell state:

```
$ git grep -n "TF_API_KEY" -- . ":!*.md"   # tracked files, variable name
lib/env.ts:5:const SECRET_KEYS = new Set(["TF_API_KEY"]);
proxy/proxy.ts:1:// OpenAI-compatible metering proxy. Forwards only to Token Factory, and is the only code that holds TF_API_KEY.
proxy/server.ts:12:const upstreamKey = need("TF_API_KEY");

$ grep -rn "TF_API_KEY" --exclude-dir=node_modules --exclude-dir=.git --exclude=.env --exclude="*.md" .   # working tree incl. untracked
proxy/proxy.ts:1:// OpenAI-compatible metering proxy. Forwards only to Token Factory, and is the only code that holds TF_API_KEY.
lib/env.ts:5:const SECRET_KEYS = new Set(["TF_API_KEY"]);
proxy/server.ts:12:const upstreamKey = need("TF_API_KEY");

$ grep -rlF -f <(key value) . (excluding .env)   # the actual key value, anywhere in the repo incl. node_modules, .git, state/
(no matches)

$ grep -rlF -f <(key value) ~/.nemoclaw ~/.config/openshell ~/.local/share/openshell ~/.openshell   # host NemoClaw/OpenShell state
(no matches)

$ grep -rlF "TF_API_KEY" ~/.nemoclaw ~/.config/openshell ~/.local/share/openshell ~/.openshell   # variable name in host state
(no matches)
```

The only references to the *name* are the proxy (which reads it) and `lib/env.ts` (which strips it). The *value* appears nowhere except `.env`, which is gitignored (`git check-ignore -v .env` → `.gitignore:1:.env`).

Sandbox (state and env streamed out to the host and searched there, so no part of the key is ever sent into the sandbox):

```
$ (inside sandbox) tar /sandbox/.openclaw + /sandbox/.nemoclaw (excluding node_modules, npm caches) + env of shell and openclaw-gateway → streamed to host
files scanned: 1448 state files + 135 env lines

$ grep -rlF -f <(TF_API_KEY value) <dump>
(no matches)

$ grep -rlF "TF_API_KEY" <dump>
(no matches)

$ grep -rli "tokenfactory" <dump>
(no matches)

$ grep -rlF -f <(PROXY_TOKEN value) <dump>   # even the proxy token is held by OpenShell, not the sandbox
(no matches)

$ provider config the agent sees (/sandbox/.openclaw/openclaw.json → models.providers)
inference {"baseUrl": "https://inference.local/v1", "api": "openai-completions", "apiKey": "unused"}
```

The sandbox doesn't even hold the proxy token. OpenShell supplies it on the host side.

## 4a. Cap set to $0.001: agent call and Escrow call both get 402

```
$ npm run spend:set-cap 0.001        # totalUsd was already $0.008049
$ curl localhost:8000/healthz
{"mode":"cached","reason_code":"cap_reached","totalUsd":0.008049299999999999,"capUsd":0.001}

$ nemoclaw escrow exec --no-stdin -- openclaw agent --session-id cap-proof --json -m "Say hi"
exit 1
[openclaw] Reason: ⚠️ inference (nvidia/nemotron-3-super-120b-a12b) returned a billing error — your API key has run out of credits or has an insufficient balance. Check your inference billing dashboard and top up or switch to a different API key.

$ node scripts/escrow-call.ts nano
{"outcome":"cached_mode","http":402,"reasonCode":"cap_reached","message":"Escrow spend guard: live inference stopped (spend $0.008049 + reserved $0.000000 + this call (max $0.000073) would exceed cap $0.001). Use cached mode."}
exit 3
```

Proxy log. The first line is the agent's call (Super, via `inference.local`). The second is Escrow's (Nano, run id `spend-cap-proof`). Neither was forwarded upstream:

```
{"ts":"2026-10-23T20:53:58.164Z","event":"blocked","model":"nvidia/nemotron-3-super-120b-a12b","code":"cap_reached","reason":"spend $0.008049 + reserved $0.000000 + this call (max $0.029605) would exceed cap $0.001"}
{"ts":"2026-10-23T20:54:03.942Z","event":"blocked","model":"nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B","runId":"spend-cap-proof","code":"cap_reached","reason":"spend $0.008049 + reserved $0.000000 + this call (max $0.000073) would exceed cap $0.001"}
```

OpenClaw turns the proxy's 402 into "billing error … run out of credits". The agent stops, which is the intended cached-mode behavior.

## 4b. Direct call from inside the sandbox to Token Factory fails

```
$ curl https://api.tokenfactory.nebius.com/v1/chat/completions (direct, via sandbox proxy)
curl: (56) CONNECT tunnel failed, response 403
000
[exit=56]
$ curl --noproxy * https://api.tokenfactory.nebius.com/v1/models (direct, bypassing sandbox proxy)
curl: (6) Could not resolve host: api.tokenfactory.nebius.com
000
[exit=6]
$ python3 raw TCP to api.tokenfactory.nebius.com:443
socket.gaierror: [Errno -3] Temporary failure in name resolution
[exit=0]
[1792788881.989] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(7324) -> api.tokenfactory.nebius.com:443 [policy:- engine:opa] [reason:endpoint api.tokenfactory.nebius.com:443 is not allowed by any policy]
```

More bypass attempts (raw TCP or UDP, `--noproxy`, pinned IPs, Node sockets) are in `evidence/egress.md`. All of them fail.

## 4c. Cap restored to $15: live again; spend.json

```
$ npm run spend:set-cap 15
$ curl localhost:8000/healthz
{"mode":"live","totalUsd":0.008049299999999999,"capUsd":15}
$ node scripts/escrow-call.ts nano
{"outcome":"live","content":"escrow-call-ok",...}
$ npm run spend:show
mode: live  spent $0.008065 / cap $15
{
  "version": 1,
  "capUsd": 15,
  "totalUsd": 0.0080649,
  "byModel": {
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": {
      "calls": 2,
      "promptTokens": 46,
      "completionTokens": 106,
      "usd": 0.000028199999999999998
    },
    "nvidia/nemotron-3-super-120b-a12b": {
      "calls": 8,
      "promptTokens": 25820,
      "completionTokens": 323,
      "usd": 0.008036699999999999
    }
  },
  "runs": {
    "2026-10-23": [
      "m0-smoke",
      "anon-2026-10-23T20:17:13.284Z",
      "anon-2026-10-23T20:30:40.359Z",
      "anon-2026-10-23T20:45:46.704Z",
      "spend-cap-proof"
    ]
  },
  "updatedAt": "2026-10-23T20:54:44.444Z",
  "lastAnon": {
    "id": "anon-2026-10-23T20:45:46.704Z",
    "at": "2026-10-23T20:47:55.680Z"
  }
}
```

## 5. Fail closed: missing or corrupt spend.json → every call refused

```
$ mv state/spend.json state/spend.json.moved
$ curl healthz
{"mode":"cached","reason_code":"state_missing"}
$ chat call
HTTP 402  x-escrow-stop-reason: state_missing
$ printf "{corrupt" > state/spend.json
$ curl healthz
{"mode":"cached","reason_code":"state_corrupt"}
$ chat call
HTTP 402  x-escrow-stop-reason: state_corrupt
$ edit totalUsd down to 0 without touching byModel (tamper)
$ chat call
HTTP 402  x-escrow-stop-reason: state_corrupt
$ restore real spend.json
{"mode":"cached","reason_code":"cap_reached","totalUsd":0.008049299999999999,"capUsd":0.001}
{"ts":"2026-10-23T20:54:28.346Z","event":"blocked","model":"nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B","code":"state_missing","reason":"spend.json missing at /home/swetha/escrow/state/spend.json"}
{"ts":"2026-10-23T20:54:28.374Z","event":"blocked","model":"nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B","code":"state_corrupt","reason":"spend.json unreadable: Expected property name or '}' in JSON at position 1 (line 1 column 2)"}
{"ts":"2026-10-23T20:54:28.424Z","event":"blocked","model":"nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B","code":"state_corrupt","reason":"spend.json corrupt: totalUsd does not match sum of byModel"}
```

The proxy never creates `spend.json` itself. Creating it takes an explicit `npm run spend:init`, which refuses to overwrite an existing file.

## Unit tests (`npm test`)

```
✔ shadow writes are invisible on disk until commit, visible to the session (5.325082ms)
✔ abort discards shadow writes and pending effects (3.205059ms)
✔ shadow FS rejects paths escaping the workspace (1.422536ms)
✔ sessions are isolated (1.529707ms)
✔ effects reach the outbox only after a clean commit (2.198847ms)
✔ canary 1: canary in an email to another student blocks commit (1.038576ms)
✔ canary 2: obfuscated canary (case, separators, base64, hex) is still caught (5.175221ms)
✔ canary 3: canary never leaves, even to an authorized official (R0 beats R2) (0.919374ms)
✔ canary 4: canary in an external file write blocks commit, and the shadow write is discarded (1.168245ms)
✔ canary 5: one leaking effect among clean ones aborts the whole session (all-or-nothing) (1.241358ms)
✔ R1: a student may receive their own record (0.618287ms)
✔ R2: an official with legitimate interest may receive records (0.367646ms)
✔ R3: another student may not receive a record value (exact match, normalized) (0.478012ms)
✔ R3: mixed recipients, so one unauthorized recipient blocks (0.314254ms)
✔ R3: external write of a record value is blocked (0.429236ms)
✔ short generic values don't trigger exact match (no false positives on 'B+') (0.408884ms)
✔ allows a call under the cap and records cost per model (10.231964ms)
✔ cached mode when the worst case would cross the cap (0.961657ms)
✔ in-flight reservations count toward the cap (0.909349ms)
✔ usage unknown → charges full reservation (1.058195ms)
✔ spend.json cap cannot exceed the hard cap (1.126932ms)
✔ fail closed: missing spend.json (0.648632ms)
✔ fail closed: corrupt spend.json (bad JSON, wrong shape, tampered total) (1.001468ms)
✔ stops at and after CREDIT_EXPIRY (00:00 UTC on that date) (1.119888ms)
✔ fail closed: missing or invalid CREDIT_EXPIRY (1.739789ms)
✔ unknown model is refused (0.898467ms)
✔ daily run limit: 20 per UTC day, resets the next day, same run id is free (3.010191ms)
✔ anonymous calls group into one run by idle gap (1.268439ms)
✔ commit failure latches the guard closed (1.80718ms)
✔ initState refuses to overwrite (1.414086ms)
✔ parseExpiry and price table parsing (3.568528ms)
✔ blocks exec and process, allows others (1.712637ms)
✔ log line carries tool name, full params, decision (2.253969ms)
✔ forwards with the real key, meters usage, clamps max_tokens (62.690801ms)
✔ rejects wrong or missing proxy token (and never forwards it) (14.995861ms)
✔ 402 cached mode at cap, upstream never called (22.394188ms)
✔ 402 fail-closed when spend.json missing or corrupt (25.706762ms)
✔ unknown model refused with 402 (8.503031ms)
✔ streaming: forces include_usage and meters the final usage chunk (13.040481ms)
✔ 2xx without usage is charged the worst case (10.805952ms)
✔ only chat/completions and models are exposed (8.925803ms)
✔ upstream URL must be Token Factory over https (1.356459ms)
✔ source allowlist: loopback always, listed CIDRs, nothing else (0.419028ms)
✔ sends committed effects and logs 'sent' (6.027729ms)
✔ host-side verification can veto an effect the sandbox called committed (1.240221ms)
✔ malformed, uncommitted, or mismatched entries are rejected (1.556525ms)
✔ exactly-once: a re-listed id is not re-sent (0.953957ms)
ℹ pass 47
ℹ fail 0
```

## Limits (honest)

* The proxy meters only traffic that goes through it. Usage of the same key from somewhere else, such as the Token Factory console playground or another machine, is invisible to it. **Recommended manual step:** if Nebius offers an account-level spend limit or alert, set it at or below the promo credit amount as a second layer.
* Cost uses the list prices in `docs/models.md` (fetched 2026-10-23). If Nebius changes prices, update that table. Cached-input discounts are ignored, so metering errs high.
* The worst-case prompt bound (bytes + 256) is a heuristic upper bound. Real usage is still charged afterward, so the cap can be exceeded by at most one call's underestimate. In practice prompt tokens are far below byte counts.
* `CREDIT_EXPIRY=2026-12-15` is interpreted as **2026-12-15T00:00:00Z** (stop at the start of that day, conservatively).
