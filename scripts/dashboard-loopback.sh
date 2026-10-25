#!/usr/bin/env bash
# NemoClaw binds the OpenClaw dashboard forward to 0.0.0.0 on WSL (hardcoded in
# src/lib/dashboard/contract.ts; NEMOCLAW_DASHBOARD_BIND only accepts 0.0.0.0).
# Replace it with the same forward bound to 127.0.0.1. WSL localhost forwarding still
# lets the Windows browser reach http://127.0.0.1:18789.
set -euo pipefail
cd "$(dirname "$0")/.."
SANDBOX="${SANDBOX:-escrow}" PORT="${DASHBOARD_PORT:-18789}"
for pid in $(pgrep -f "forward service $SANDBOX --target-port $PORT" || true); do
  args=$(ps -o args= -p "$pid" || true)
  [[ "$args" == *"--local 127.0.0.1:$PORT"* ]] && { echo "dashboard forward already on 127.0.0.1:$PORT (pid $pid)"; exit 0; }
  kill "$pid"; echo "stopped forward pid $pid ($args)"
done
sleep 0.5
mkdir -p state
nohup openshell --gateway nemoclaw --gateway-endpoint https://127.0.0.1:8080 --workspace default \
  forward service "$SANDBOX" --target-port "$PORT" --target-host 127.0.0.1 --local "127.0.0.1:$PORT" >> state/dashboard-forward.log 2>&1 &
sleep 2
ss -ltnp | grep ":$PORT " || { echo "forward did not start; see state/dashboard-forward.log"; exit 1; }
