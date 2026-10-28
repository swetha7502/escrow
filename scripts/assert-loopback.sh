#!/usr/bin/env bash
# Fail loudly if any Escrow host port listens beyond loopback. 18789 = OpenClaw dashboard forward (NemoClaw binds it
# to 0.0.0.0 on WSL; scripts/dashboard-loopback.sh rebinds it), 8000 = spend proxy, 8790 = control API/WebSocket
# (reached from outside only through the Cloudflare Tunnel, which connects to 127.0.0.1). A port with no listener passes.
set -euo pipefail
PORTS="${ESCROW_LOOPBACK_PORTS:-18789 8000 8790}"
# Test hook: ESCROW_SS_FIXTURE=<file of `ss -Hltn` lines> checks a recorded listing instead of the live one
listeners() { if [[ -n "${ESCROW_SS_FIXTURE:-}" ]]; then awk -v p=":$1" '$4 ~ p"$"' "$ESCROW_SS_FIXTURE"; else ss -Hltn "sport = :$1"; fi; }
bad=0
for port in $PORTS; do
  addrs=$(listeners "$port" | awk '{print $4}')
  if [[ -z "$addrs" ]]; then echo "ok   :$port no listener"; continue; fi
  for a in $addrs; do
    host=${a%:*}
    case "$host" in
      127.0.0.1|\[::1\]) echo "ok   :$port bound to $a" ;;
      *) echo "FAIL :$port bound to $a (must be 127.0.0.1)" >&2; bad=1 ;;
    esac
  done
done
if (( bad )); then
  echo "!! LOOPBACK ASSERTION FAILED: a port above is reachable from the network. For 18789 run scripts/dashboard-loopback.sh." >&2
  exit 1
fi
