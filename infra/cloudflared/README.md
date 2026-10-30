# Exposing the live demo backend

## Quick tunnel (what the demo uses): one command

```bash
scripts/live-tunnel.sh            # (re)start: preflight → API with token → quick tunnel → end-to-end check → publish URL to the site
scripts/live-tunnel.sh stop       # stop the tunnel and publish {"apiBase": null}: the site is cached-only
scripts/live-tunnel.sh --no-deploy
```
- A quick tunnel needs no Cloudflare account and gets a random `https://*.trycloudflare.com` URL on every start.
- The Vercel site reads that URL at runtime from `live.json`, so the script republishes only that file. There's no rebuild.
- If `live.json` is null or the tunnel is unreachable, the site shows cached replays.
- A quick tunnel has no ingress rules: it forwards every path. The launcher therefore checks that the API itself answers 404 to everything except `/api/*` and `/events`.
- If any check through the public URL fails, the script stops the tunnel and publishes nothing.

The named-tunnel setup below is the alternative if you have a domain on Cloudflare.


The UI is a static build: host `ui/dist/` anywhere and it works fully on its own, replaying recorded runs. This tunnel is only for **live** runs from a hosted UI.

## 1. Install cloudflared and log in (you run these; the login needs your browser)

From Cloudflare's package repository (pkg.cloudflare.com, `any` = any Debian/Ubuntu release):
```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
cloudflared --version
cloudflared tunnel login        # prints a URL: open it in the Windows browser, pick the zone (a domain on your Cloudflare account)
```
`tunnel login` writes `~/.cloudflared/cert.pem`. A named tunnel needs a domain on your Cloudflare account.

## 2. Create the tunnel and fill in the config

```bash
cloudflared tunnel create escrow-api                               # prints the tunnel id, writes ~/.cloudflared/<id>.json
cloudflared tunnel route dns escrow-api escrow-api.<your-domain>   # CNAME in your zone
```
Then replace `<TUNNEL_ID>` (twice) and `<your-domain>` in `config.yml`. The ingress rule passes only `/api/*` and `/events` to `127.0.0.1:8790`. Everything else on that hostname, including `/`, gets a 404. The dashboard (18789) and the spend proxy (8000) are never referenced.

## 3. Start it: only through the launcher

```bash
# state/public.env (gitignored, mode 600) is created on first run with a fresh 64-hex access token.
# Put the hosted UI's origin in it: ESCROW_UI_ORIGINS=https://<your-ui>.vercel.app
infra/cloudflared/serve-public.sh --check    # preflight only
infra/cloudflared/serve-public.sh            # preflight, start the API if needed, run the tunnel
```
The launcher **refuses to expose anything** unless all of these hold:
- the token is set (≥ 32 chars) and the settings file is mode 600;
- every UI origin is `https://`, and `ESCROW_TRUST_CF=1`;
- the config is filled in and `cloudflared ingress validate` passes; `/api/health` and `/events` route to the API, while `/`, `/healthz` and `/v1/chat/completions` get a 404;
- the **running** API answers 401 without the token, 200 with it, and 403 from a foreign origin;
- `scripts/assert-loopback.sh` passes, and the spend proxy is up (it prints spend against the cap).

Other settings (rate limits, approval timeout, `ESCROW_LIVE_RUNS`) can go in `state/public.env` too, as listed below. The token is printed nowhere; read it with `grep TOKEN state/public.env` and type it into the UI's **UNLOCK LIVE** prompt.

Server settings it uses:
```bash
ESCROW_ACCESS_TOKEN=<generated>              # shared token; the presenter types it once into the UI ("UNLOCK LIVE")
ESCROW_UI_ORIGINS=https://<where-the-ui-is-hosted>
ESCROW_TRUST_CF=1                            # rate-limit by CF-Connecting-IP (the tunnel connects from loopback)
ESCROW_LIVE_RUNS=on                          # or "off": everything becomes cached replays, Ultra drafts refused
# optional limits (defaults): ESCROW_RL_API_PER_MIN=120 ESCROW_RL_RUNS_PER_HOUR=12 ESCROW_RL_DRAFTS_PER_HOUR=12 ESCROW_RL_WS_PER_MIN=20
# optional: ESCROW_APPROVAL_TIMEOUT_MS=300000 (an undecided contract is auto-rejected, freeing the single run slot)
```
Turn live runs off without a restart with `touch state/live-runs-disabled`; `rm` it to turn them back on. Only one run is ever in flight (the sandbox runs one scenario at a time); others get 409, and the UI falls back to the recording. The proxy's hard spend cap still applies to everything.

## 4. The UI build

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
