# Exposing the live demo backend (not started)

The UI is a static build: host `ui/dist/` anywhere and it works fully on its own, replaying recorded runs. This tunnel is only for **live** runs from a hosted UI.

## 1. Server settings (`.env` or the shell; the token never goes into the UI build)

```bash
ESCROW_ACCESS_TOKEN=<long random string>     # shared token; the presenter types it once into the UI ("UNLOCK LIVE")
ESCROW_UI_ORIGINS=https://<where-the-ui-is-hosted>
ESCROW_TRUST_CF=1                            # rate-limit by CF-Connecting-IP (the tunnel connects from loopback)
ESCROW_LIVE_RUNS=on                          # or "off": everything becomes cached replays, Ultra drafts refused
# optional limits (defaults): ESCROW_RL_API_PER_MIN=120 ESCROW_RL_RUNS_PER_HOUR=12 ESCROW_RL_DRAFTS_PER_HOUR=12 ESCROW_RL_WS_PER_MIN=20
# optional: ESCROW_APPROVAL_TIMEOUT_MS=300000 (an undecided contract is auto-rejected, freeing the single run slot)
node harness/server.ts
```

Turn live runs off without a restart with `touch state/live-runs-disabled`; `rm` it to turn them back on. Only one run is ever in flight (the sandbox runs one scenario at a time); others get 409, and the UI falls back to the recording. The proxy's hard spend cap still applies to everything.

## 2. The tunnel (one-time setup needs a browser login, so run these yourself)

```bash
# install cloudflared (not on this machine yet): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel login                         # interactive: opens a browser to pick the Cloudflare zone
cloudflared tunnel create escrow-api             # prints the tunnel id and writes ~/.cloudflared/<id>.json
cloudflared tunnel route dns escrow-api escrow-api.<your-domain>
# edit infra/cloudflared/config.yml: <TUNNEL_ID> and the hostname
cloudflared tunnel --config infra/cloudflared/config.yml run escrow-api
```

## 3. The UI build

```bash
cd ui && VITE_API_BASE=https://escrow-api.<your-domain> npm run build   # dist/ → any static host
```

## What's still exposed

- **Without the token:** `GET /api/health` returns 401 with `{authRequired, liveRuns}` and nothing else. Every other route and the WebSocket refuse.
- **With the token, a viewer can:**
  - start one run at a time (rate-limited);
  - approve or reject contracts;
  - read recorded runs, which contain synthetic data only.
- **Spend.** Each live run costs about $0.04–0.08 of Token Factory credit, inside the proxy's hard cap. Turn live runs off when not presenting.
