#!/usr/bin/env bash
# Compare proxy stop statuses (402 / 429 / 503) for how OpenClaw backs off after a cap hit.
set -uo pipefail
cd "$(dirname "$0")/.."
gw_restart() {
  nemoclaw escrow gateway restart >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9; do scripts/sbx.sh 'openclaw gateway status 2>&1 | grep -q "Connectivity probe: ok"' && return; sleep 10; done
}
bo() { nemoclaw escrow exec --stdin -- python3 - "$1" < scripts/backoff.py 2>&1 | grep -E '"entry"|"reset"' || echo '{"entry":"none"}'; }
for S in ${STATUSES:-402 429 503}; do
  echo "################ stop status $S"
  PROXY_STOP_STATUS=$S PROXY_RETRY_AFTER_SEC=15 proxy/run.sh | tail -1
  if bo reset | grep -q '"hadFailure": true'; then gw_restart; fi
  npm run -s spend:set-cap 0.001 >/dev/null
  L=$(wc -l < state/proxy.log); t0=$(date +%s)
  scripts/ag.sh "bo-$S" refused "Say hi in three words." | tail -2
  echo "refused turn took $(( $(date +%s) - t0 ))s; proxy saw $(tail -n +$((L+1)) state/proxy.log | grep -c '"blocked"') blocked attempt(s), $(tail -n +$((L+1)) state/proxy.log | grep -c '"event":"call"') forwarded"
  echo "backoff state after refusal: $(bo show)"
  sleep 20  # wait past Retry-After (15s) and the shortest 30s cooldown starts counting
  npm run -s spend:set-cap 15 >/dev/null
  L=$(wc -l < state/proxy.log)
  scripts/ag.sh "bo-$S" after-restore "Say hi in three words." | tail -2
  echo "after restore: proxy forwarded $(tail -n +$((L+1)) state/proxy.log | grep -c '"event":"call"') call(s)"
  echo
done
bo reset >/dev/null
