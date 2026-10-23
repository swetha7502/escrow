#!/usr/bin/env bash
# Start or restart the spend proxy in the background. Logs go to state/proxy.out.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f state/proxy.pid ]] && kill -0 "$(cat state/proxy.pid)" 2>/dev/null; then kill "$(cat state/proxy.pid)"; sleep 0.5; fi
nohup node proxy/server.ts >> state/proxy.out 2>&1 &
echo $! > state/proxy.pid
sleep 1.5
tail -2 state/proxy.out
