# Phase 4 step 6: hosting hardening for the live demo (2026-10-27)

## What was built
- **`harness/access.ts`** (unit-tested in `harness/access.test.ts`) and its wiring in `harness/server.ts`:
  - **Shared access token** `ESCROW_ACCESS_TOKEN`. The comparison is constant-time.
    - HTTP takes `Authorization: Bearer`. The WebSocket takes a subprotocol `escrow-token.<token>`, because browsers can't set headers; the server only ever echoes `escrow`.
    - Without the token, `/api/health` answers 401 with `{authRequired, liveRuns}` only, and every other route plus the WebSocket refuse.
  - **Per-IP rate limits** (fixed windows): API 120/min, runs 12/h, Ultra drafts 12/h, WS connects 20/min. They're configurable. Behind the tunnel the IP comes from `CF-Connecting-IP`, trusted only with `ESCROW_TRUST_CF=1`.
  - **Max one concurrent run** (already true: 409). New: an undecided contract is auto-rejected after `ESCROW_APPROVAL_TIMEOUT_MS` (5 min), so a visitor can't hold the run slot.
  - **Live-runs switch:** `ESCROW_LIVE_RUNS=off`, or `touch state/live-runs-disabled` with no restart. Runs then become cached replays, and Ultra contract drafts are refused (503), so the demo costs nothing.
  - The **origin allowlist** (`ESCROW_UI_ORIGINS`) is unchanged and still applies.
- **UI (`ui/src/lib/backend.ts`, `App.tsx`):**
  - **No token:** a 401 from the backend shows **LIVE LOCKED · CACHED REPLAYS** plus an **UNLOCK LIVE** button. The presenter types the token once; it stays in that browser's localStorage and is sent as the bearer header and WS subprotocol.
  - **Never bundled:** `grep` over `ui/dist` finds only the storage key name `escrow.accessToken`, never a token.
  - **Live off:** shows **LIVE RUNS OFF · CACHED REPLAYS**.
  - **No backend at all:** the static build is unchanged and fully works offline (phase 3 step 6).
- **Cloudflare Tunnel:** `infra/cloudflared/config.yml` (API + WS → 127.0.0.1:8790, everything else 404) and `infra/cloudflared/README.md`. **Not started.** `cloudflared` isn't installed here, and `cloudflared tunnel login` needs your browser.

## Check (`ESCROW_ACCESS_TOKEN=… node scripts/check-hardening.ts`: in-process API on :8791, runs/hour limit 3, live off)
```
GET /api/health, no token                      → 401 { "error": "access token required", "authRequired": true, "liveRuns": "off" }
GET /api/health, wrong token                   → 401 { "error": "access token required", "authRequired": true, "liveRuns": "off" }
GET /api/health, token                         → 200 { "proxy": { "mode": "live", "totalUsd": 5.181256240000004, "capUsd": 11 }, "sandbox": { "name": "escrow", "phase": "Ready" }, "activeRun": null,
GET /api/scenarios, no token                   → 401 { "error": "access token required", "authRequired": true }
GET /api/health, foreign Origin                → 403 { "error": "origin https://evil.example not allowed (set ESCROW_UI_ORIGINS)" }
WS /events, no token                           → refused 401
WS /events, token subprotocol                  → open, first message type=hello
POST /api/runs #1 mode=live (live off)         → 503 { "error": "live run unavailable: live runs disabled by the operator (ESCROW_LIVE_RUNS=off)" }
POST /api/runs #2 (live off → cached)          → 202 { "id": "run-13dc4aa3", "scenario": "K1-split-score", "arm": "escrow", "live": false, "cachedReason": "live runs disabled by the operator (ESCR
POST /api/runs #3 (one run at a time)          → 409 { "error": "run run-13dc4aa3 is in progress (the sandbox runs one scenario at a time)" }
POST /api/runs #4 (runs/hour limit = 3)        → 429 { "error": "rate limit (run); retry in 3600s" }
POST /api/contracts (Ultra draft, live off)    → 503 { "error": "live runs disabled by the operator (ESCROW_LIVE_RUNS=off)" }
```
A bug found by this check and fixed: on a rate-limited POST the handler sent the 429 and then carried on, writing the response twice (`ERR_HTTP_HEADERS_SENT` crashed the server). `limited()` now returns a boolean.

## UI screenshots (`evidence/ui/08-*`), taken against a token-protected API with live runs off
- `08-locked-landing.png`: LIVE LOCKED · CACHED REPLAYS and UNLOCK LIVE; the page still works.
- `08-token-prompt.png`: the one-time token prompt. It's rendered through a portal; the first version was trapped inside the header's backdrop-filter, which was fixed.
- `08-unlocked-live-off.png`: after unlocking, the chip shows LIVE RUNS OFF and the run is a CACHED replay with the reason "live runs disabled by the operator".

## 2026-10-28: tunnel prep, with a launcher that refuses to expose anything unverified
- `infra/cloudflared/config.yml`: the ingress now passes only `path: ^/(api/|events$)` to `127.0.0.1:8790`. Everything else on the hostname returns 404, and the dashboard and proxy are never referenced.
- `infra/cloudflared/serve-public.sh [--check]` verifies everything on the **running** API before starting `cloudflared`. Settings live in `state/public.env` (gitignored, mode 600, token generated on first run). They're deliberately not read from `.env`, so the API process never gets `TF_API_KEY`.
- `cloudflared` isn't installed yet (it needs the owner's sudo and browser login), so the routing checks (`ingress validate`, `ingress rule`) haven't run yet.

**It caught a real problem.** The control server left running on 8790 since 09:03 had been started **without** the access token:
```
$ infra/cloudflared/serve-public.sh --check
ok   state/public.env is mode 600
ok   access token set (64 chars)
FAIL ESCROW_UI_ORIGINS empty in state/public.env (the hosted UI's origin, e.g. https://escrow-ui.vercel.app)
ok   ESCROW_TRUST_CF=1 (rate limits key on CF-Connecting-IP)
FAIL cloudflared not installed (see infra/cloudflared/README.md)
ok   config doesn't reference the proxy or the dashboard
FAIL API without token → 200 (a server is running WITHOUT the access token: stop it, then re-run this script)
...
!! 4 check(s) failed: NOT exposing anything.
exit 1
```
(The 4th failure was a quoting bug in the launcher's own spend-proxy check. It's fixed, and the run below exercises it.)

Against an API started with the token (spare loopback port 8793, test settings file):
```
ok   … is mode 600
ok   access token set (64 chars)
ok   UI origin https://escrow-ui.example
ok   ESCROW_TRUST_CF=1 (rate limits key on CF-Connecting-IP)
FAIL cloudflared not installed (see infra/cloudflared/README.md)
ok   config doesn't reference the proxy or the dashboard
ok   API without token → 401
ok   API with token → 200
ok   API from a foreign origin → 403
ok   loopback (18789/8000/8790 on 127.0.0.1)
ok   spend proxy: $8.54 of $12 cap
!! 1 check(s) failed: NOT exposing anything.
```
`scripts/check-hardening.ts` re-run on 2026-10-28 with the same results as above (401 / 403 / 409 one run at a time / 429 run rate limit / live-off 503).
