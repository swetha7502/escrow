# Housekeeping (step 0): dashboard bind, up.sh, egress-reset test, 402 backoff

## 0a. Dashboard forward bound to 127.0.0.1

NemoClaw binds the OpenClaw dashboard forward to `0.0.0.0:18789` on WSL. The bind is hardcoded in
`openclaw` NemoClaw source (`src/lib/dashboard/contract.ts`: `isWsl || remoteBindOptIn ? 0.0.0.0 : 127.0.0.1`),
and `NEMOCLAW_DASHBOARD_BIND` only accepts `""` or `0.0.0.0` — there is no supported "loopback on WSL" setting.

`scripts/dashboard-loopback.sh` stops NemoClaw's `0.0.0.0` forward and re-creates the same forward bound to
`127.0.0.1`. WSL still forwards Windows' `localhost` into the VM, so the Windows browser reaches
`http://127.0.0.1:18789`.

```
$ scripts/dashboard-loopback.sh
stopped forward pid ... (--local 0.0.0.0:18789)
LISTEN 127.0.0.1:18789 ... openshell
dashboard via 127.0.0.1: 200
dashboard via 172.17.38.108 (WSL eth0): 000  (refused — good)
```

`up.sh` runs this every time, so the bind is re-asserted after any NemoClaw action that recreates the forward.

## 0b. up.sh + does a rebuild/onboard reset the egress policy?

`scripts/up.sh` brings the whole stack up idempotently and **re-applies the egress policy every run**
(`openshell policy set escrow --policy policies/escrow-sandbox.yaml --wait`), then asserts the only
allowed host is `inference.local` or aborts.

**Answer — rebuild vs onboard differ:**

* **`nemoclaw <name> rebuild`: preserves the live policy.** The rebuild backup phase calls
  `captureRecordedSandboxBasePolicy(sandboxName, "capture the live policy before sandbox replacement")`
  (`src/lib/actions/sandbox/rebuild-backup-phase.ts`) and hands that document to the replacement sandbox.
  So a rebuild carries the *current* locked-down policy (v2, inference.local only) forward — it does **not**
  reset to the tier default. Confirmed in source; a live rebuild on this machine couldn't complete (Docker/WSL
  backup failures, see feedback.md) and the policy stayed `v2 ['inference.local']` throughout.
* **`nemoclaw onboard` (fresh/recreate): applies the tier preset.** A fresh onboard builds the sandbox from the
  `restricted` tier preset, which is broader than our lockdown (this is exactly how M1 produced a policy allowing
  clawhub/npm/nvidia/openclaw hosts that we then had to lock down). So onboard **does** reset the egress policy.

**Either way, `up.sh` re-asserts the lockdown**, so running it after any rebuild/onboard restores
`inference.local`-only egress. Operators must run `up.sh` (or the `openshell policy set` line) after onboarding.

## 0c. The 402 billing backoff, and a safer stop status

**Where the backoff lives:** OpenClaw stores per-provider failure state in the in-sandbox SQLite DB
`/sandbox/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite`, table `auth_profile_state`,
JSON column `state_json.usageStats["inline-api-key:inference"]`. A 402 sets `disabledUntil`/`disabledReason:"billing"`
with a backoff of **10 min, doubling to 24 h** (`billingBackoffMs: 6e5`, `billingMaxMs: 864e5` in
`openclaw/dist/usage-*.js`). The running gateway also caches it in memory.

`scripts/backoff.py` (run in-sandbox) shows or clears this state; `up.sh` resets it on every run and restarts the
gateway when it actually cleared a failure (the cache).

**Safer stop status — tested live.** The proxy's refusal status is configurable (`PROXY_STOP_STATUS`). With the
cap at $0.001 I made one agent turn under each status and read the recorded backoff:

```
################ stop status 402
proxy: listening on http://127.0.0.1:8000; stop status 402; sources: loopback only
{'type': 'cli_error', 'message': '⚠️ inference (nvidia/nemotron-3-super-120b-a12b) returned a billing error — your API key has run out of credits or has an insufficient balance. Check your inference billing dashboard and top up or switch to a different API key.'}

refused turn took 8s; proxy saw 1 blocked attempt(s), 0 forwarded
backoff state after refusal: {"db": "agents/main/agent/openclaw-agent.sqlite", "entry": "inline-api-key:inference", "reason": "billing", "errorCount": 1, "unusableForSec": 596}
{'type': 'cli_error', 'message': 'Inline API key for provider "inference" is temporarily disabled after a provider auth/billing failure. Retry after about 10 minutes, or switch to a different auth profile/API key.'}

after restore: proxy forwarded 0 call(s)

################ stop status 429
proxy: listening on http://127.0.0.1:8000; stop status 429; sources: loopback only
{'type': 'cli_error', 'message': '⚠️ API rate limit reached. Please try again later.'}

refused turn took 18s; proxy saw 4 blocked attempt(s), 0 forwarded
backoff state after refusal: {"db": "agents/main/agent/openclaw-agent.sqlite", "entry": "inline-api-key:inference", "reason": null, "errorCount": null, "unusableForSec": 0}
Hi there friend!

after restore: proxy forwarded 1 call(s)

################ stop status 503
proxy: listening on http://127.0.0.1:8000; stop status 503; sources: loopback only
{'type': 'cli_error', 'message': '⚠️ inference/nvidia/nemotron-3-super-120b-a12b request failed (provider internal error, HTTP 503). This is usually temporary — try again shortly.'}

refused turn took 17s; proxy saw 4 blocked attempt(s), 0 forwarded
backoff state after refusal: {"db": "agents/main/agent/openclaw-agent.sqlite", "entry": "inline-api-key:inference", "reason": null, "errorCount": null, "unusableForSec": 0}
Hi there!

after restore: proxy forwarded 1 call(s)
```

| Proxy stop status | OpenClaw classifies as | Backoff recorded | Agent usable after cap restored? |
|---|---|---|---|
| **402** | billing | **disabledUntil, ~10 min** (grows to 24 h) | **No** — stays locked ~10 min+ |
| **429** + Retry-After | rate_limit | none persisted | **Yes** — next turn works |
| **503** + Retry-After | server/overloaded | none persisted | **Yes** — next turn works |

Both 429 and 503 refuse the call without tripping the billing lockout, but **429 is the better fit**: it means
"try again later" (which is exactly what cached mode means), and the proxy sends a `Retry-After`. The proxy now
**defaults to 429** (`PROXY_STOP_STATUS`, `v ?? 429`), still with `x-escrow-mode: cached` so Escrow's own client
and the demo recognize it. The spend cap still refuses the call — upstream is never touched.

The refusal message is also worded to avoid the phrases OpenClaw's classifier maps to "billing"/"overloaded"
(`openclaw/dist/message-patterns-*.js`), so the HTTP status alone decides the backoff.

**Proof the cap still refuses (default 429), then restores to live:**
```
$ npm run spend:set-cap 0.001
$ curl -si .../v1/chat/completions (proxy token, Nano)
HTTP/1.1 429 Too Many Requests
x-escrow-mode: cached
x-escrow-stop-reason: cap_reached
retry-after: 60
{"error":{"type":"spend_guard_stopped","code":"cached_mode","reason_code":"cap_reached","message":"Escrow spend guard: live inference paused (spend $1.192940 + reserved $0.000000 + this call (max $0.000027) would exceed cap $0.001). Use cached mode."}}
$ node scripts/escrow-call.ts nano
{"outcome":"cached_mode","http":429,"reasonCode":"cap_reached","message":"Escrow spend guard: live inference paused (spend $1.192940 + reserved $0.000000 + this call (max $0.000073) would exceed cap $0.001). Use cached mode."}
exit 3
$ npm run spend:set-cap 15
{"mode":"live","totalUsd":1.192940400000001,"capUsd":15}
$ node scripts/escrow-call.ts nano
{"outcome":"live","content":"escrow-call-ok","usage":{"completion_tokens":59,"prompt_tokens":24,"total_tokens":83,"completion_tokens_details":null,"prompt_tokens_details":null}}
```

Unit tests: `proxy/proxy.test.ts` ("stop status is configurable: 503 + Retry-After, still cached mode, upstream
never called"; message avoids billing/overloaded phrases). `npm test`.
