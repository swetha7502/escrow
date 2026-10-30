#!/usr/bin/env bash
# One command for the live demo: (re)start the quick tunnel to the control API, verify it end to end through the
# public URL, and publish that URL to the Vercel site's live.json. Only live.json changes, no rebuild; the site
# reads it at runtime and falls back to cached replays when it's null or the tunnel is unreachable.
#   scripts/live-tunnel.sh              start or restart the tunnel, check it, publish its URL
#   scripts/live-tunnel.sh stop         stop the tunnel, publish {"apiBase": null} (site → cached only)
#   scripts/live-tunnel.sh --no-deploy  everything except the Vercel publish
# Needs: `npx -y vercel@64.0.2 login` once, and the site's https origin in state/public.env (ESCROW_UI_ORIGINS).
set -euo pipefail
cd "$(dirname "$0")/.."
SITE=state/escrow-ui                       # what gets deployed (Vercel links this folder: state/escrow-ui/.vercel)
LOG=state/quick-tunnel.log
PORT=8790
VERCEL=(npx -y vercel@64.0.2)
DEPLOY=1; MODE=start
for a in "$@"; do case "$a" in stop) MODE=stop ;; --no-deploy) DEPLOY=0 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done

publish() {   # $1: JSON value for apiBase
  if ! grep -qs "live.json" ui/dist/assets/index-*.js; then (cd ui && npm run build >/dev/null); fi
  mkdir -p "$SITE"
  find "$SITE" -mindepth 1 -maxdepth 1 ! -name .vercel -exec rm -rf {} +
  cp -r ui/dist/. "$SITE/"
  printf '{ "apiBase": %s, "updatedAt": "%s" }\n' "$1" "$(date -u +%FT%TZ)" > "$SITE/live.json"
  echo "live.json: $(cat "$SITE/live.json")"
  if (( DEPLOY )); then "${VERCEL[@]}" deploy "$SITE" --prod --yes 2>&1 | grep -E "https://|Error|error" | tail -4; fi
}
stop_tunnel() { pkill -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT" 2>/dev/null || true; sleep 1; }

if [[ "$MODE" == stop ]]; then stop_tunnel; echo "tunnel stopped"; publish null; exit 0; fi

echo "== 1. preflight + control API (token, origins, 404s, loopback, spend cap)"
infra/cloudflared/serve-public.sh --quick --prepare

echo "== 2. quick tunnel"
stop_tunnel
: > "$LOG"
nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> "$LOG" 2>&1 &
URL=""
for _ in $(seq 1 60); do URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true); [[ -n "$URL" ]] && break; sleep 1; done
[[ -n "$URL" ]] || { echo "!! no tunnel URL after 60 s; see $LOG" >&2; exit 1; }
echo "tunnel: $URL (cloudflared pid $(pgrep -f "cloudflared tunnel --no-autoupdate --url" | head -1), log $LOG)"
for _ in $(seq 1 45); do [[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$URL/api/health")" == 401 ]] && break; sleep 2; done

echo "== 3. end to end through the public URL"
node scripts/check-tunnel.ts "$URL" || { echo "!! tunnel check failed: stopping the tunnel, NOT publishing" >&2; stop_tunnel; exit 1; }

echo "== 4. publish the URL to the site"
publish "\"$URL\""
echo "done. Presenter: open the site, UNLOCK LIVE with the token (grep TOKEN state/public.env)."
