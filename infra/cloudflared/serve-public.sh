#!/usr/bin/env bash
# Start the public live-demo backend: control API (harness/server.ts) + Cloudflare Tunnel, but only after every
# protection is verified on the RUNNING server. Any failed check → nothing is exposed, exit 1.
#   infra/cloudflared/serve-public.sh --check   preflight only (starts nothing)
#   infra/cloudflared/serve-public.sh           preflight, start the API if it isn't running, then run the tunnel
# Settings live in state/public.env (gitignored, mode 600; never in the UI build):
#   ESCROW_ACCESS_TOKEN=<generated on first run>   ESCROW_UI_ORIGINS=https://<ui host>   ESCROW_TRUST_CF=1
# Deliberately NOT sourced from .env: the API process doesn't need TF_API_KEY (only the proxy holds it).
set -uo pipefail
cd "$(dirname "$0")/../.."
CHECK_ONLY=0; [[ "${1:-}" == "--check" ]] && CHECK_ONLY=1
CONF=infra/cloudflared/config.yml
PUB="${ESCROW_PUBLIC_ENV:-state/public.env}"
PORT="${ESCROW_API_PORT:-8790}"
fails=0
ok()   { echo "ok   $*"; }
fail() { echo "FAIL $*" >&2; fails=$((fails + 1)); }

# 1. settings (generate the token once; the presenter types it into the UI's UNLOCK LIVE prompt)
mkdir -p state
if [[ ! -f "$PUB" ]]; then
  umask 077
  printf 'ESCROW_ACCESS_TOKEN=%s\nESCROW_UI_ORIGINS=\nESCROW_TRUST_CF=1\n' "$(openssl rand -hex 32)" > "$PUB"
  echo "created $PUB with a new access token; set ESCROW_UI_ORIGINS in it (the hosted UI's https origin)"
fi
set -a; . "$PUB"; set +a
[[ "$(stat -c %a "$PUB")" == "600" ]] && ok "$PUB is mode 600" || fail "$PUB must be mode 600 (chmod 600 $PUB)"
(( ${#ESCROW_ACCESS_TOKEN} >= 32 )) && ok "access token set (${#ESCROW_ACCESS_TOKEN} chars)" || fail "ESCROW_ACCESS_TOKEN missing or shorter than 32 chars"
if [[ -z "${ESCROW_UI_ORIGINS:-}" ]]; then fail "ESCROW_UI_ORIGINS empty in $PUB (the hosted UI's origin, e.g. https://escrow-ui.vercel.app)"
else
  for o in ${ESCROW_UI_ORIGINS//,/ }; do [[ "$o" == https://* ]] && ok "UI origin $o" || fail "UI origin $o must be https://"; done
fi
[[ "${ESCROW_TRUST_CF:-}" == "1" ]] && ok "ESCROW_TRUST_CF=1 (rate limits key on CF-Connecting-IP)" || fail "ESCROW_TRUST_CF must be 1 behind the tunnel, or every visitor shares one rate-limit bucket"

# 2. tunnel config: filled in, valid, and routing only /api/* and /events to the API
if ! command -v cloudflared >/dev/null; then fail "cloudflared not installed (see infra/cloudflared/README.md)"
elif grep -q '<' "$CONF"; then fail "$CONF still has <placeholders> (tunnel id / hostname)"
else
  cloudflared tunnel --config "$CONF" ingress validate >/dev/null 2>&1 && ok "ingress validate" || fail "cloudflared ingress validate failed"
  host=$(awk '/hostname:/{print $NF; exit}' "$CONF")
  for p in /api/health /events; do
    cloudflared tunnel --config "$CONF" ingress rule "https://$host$p" 2>&1 | grep -q "127.0.0.1:$PORT" && ok "https://$host$p → API" || fail "https://$host$p does not route to the API"
  done
  for p in / /index.html /v1/chat/completions /healthz; do
    cloudflared tunnel --config "$CONF" ingress rule "https://$host$p" 2>&1 | grep -q "http_status:404" && ok "https://$host$p → 404" || fail "https://$host$p is routed somewhere (must be 404)"
  done
fi
grep -qE ':(8000|18789)\b' "$CONF" && fail "$CONF references the proxy (8000) or the dashboard (18789)" || ok "config doesn't reference the proxy or the dashboard"

# 3. the API itself: running copy must enforce THIS token (a server started without it would be public)
probe() { curl -s -m 5 -o /dev/null -w '%{http_code}' "$@" "http://127.0.0.1:$PORT/api/health"; }
if [[ -z "$(ss -Hltn "sport = :$PORT")" ]]; then
  if (( CHECK_ONLY )); then echo "info nothing on :$PORT (would start harness/server.ts with $PUB)"
  elif (( fails == 0 )); then
    nohup node harness/server.ts >> state/server-public.log 2>&1 &
    for _ in $(seq 1 20); do [[ -n "$(ss -Hltn "sport = :$PORT")" ]] && break; sleep 0.5; done
    echo "started harness/server.ts (pid $!, log state/server-public.log)"
  fi
fi
if [[ -n "$(ss -Hltn "sport = :$PORT")" ]]; then
  c=$(probe); [[ "$c" == "401" ]] && ok "API without token → 401" || fail "API without token → $c (a server is running WITHOUT the access token: stop it, then re-run this script)"
  c=$(probe -H "Authorization: Bearer $ESCROW_ACCESS_TOKEN"); [[ "$c" == "200" ]] && ok "API with token → 200" || fail "API with this token → $c (running server has a different token: stop it and re-run)"
  c=$(probe -H "Origin: https://not-allowed.example" -H "Authorization: Bearer $ESCROW_ACCESS_TOKEN"); [[ "$c" == "403" ]] && ok "API from a foreign origin → 403" || fail "foreign origin → $c (expected 403)"
fi

# 4. nothing on the host beyond loopback, and the spend cap still in force
scripts/assert-loopback.sh >/dev/null 2>&1 && ok "loopback (18789/8000/8790 on 127.0.0.1)" || fail "loopback assertion failed (run scripts/assert-loopback.sh)"
cap=$(curl -s -m 3 http://127.0.0.1:8000/healthz | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("$%.2f of $%s cap" % (d["totalUsd"], d["capUsd"]))' 2>/dev/null) && ok "spend proxy: $cap" || fail "spend proxy not reachable on 127.0.0.1:8000"

if (( fails )); then echo "!! $fails check(s) failed: NOT exposing anything." >&2; exit 1; fi
(( CHECK_ONLY )) && { echo "preflight passed (check only; nothing started)"; exit 0; }
echo "preflight passed: starting the tunnel (Ctrl-C stops it; 'touch state/live-runs-disabled' makes runs cached-only)"
exec cloudflared tunnel --config "$CONF" run
