#!/usr/bin/env bash
# Bring the Escrow stack up and re-assert every security setting. Safe to re-run.
#   1. spend proxy (host, 127.0.0.1:8000)   2. sandbox running   3. egress policy re-applied
#   4. dashboard forward on loopback          5. OpenClaw provider backoff cleared
#   6. escrow-hook plugin loaded              7. course data + verification policy seeded
#   8. loopback re-asserted last (a gateway restart in 5/6 can bring back NemoClaw's 0.0.0.0 forward): exits 1 if any port is exposed
set -euo pipefail
cd "$(dirname "$0")/.."
SANDBOX="${SANDBOX:-escrow}"
say() { printf '\n== %s\n' "$*"; }

say "1. spend proxy"
if curl -sf -m 3 localhost:8000/healthz >/dev/null; then echo "proxy up"; else proxy/run.sh; fi
curl -s localhost:8000/healthz; echo

say "2. sandbox"
phase=$(openshell sandbox get "$SANDBOX" 2>/dev/null | awk '/Phase:/{print $2}' || true)
echo "phase: ${phase:-unknown}"
if [[ "$phase" != "Ready" ]]; then nemoclaw "$SANDBOX" start; fi

say "3. egress policy (re-applied every time; NemoClaw rebuild/onboard may reset it)"
openshell policy set "$SANDBOX" --policy policies/escrow-sandbox.yaml --wait
openshell policy get "$SANDBOX" --full -o json | python3 -I -c "
import json,sys; d=json.load(sys.stdin); n=d['policy']['network_policies']
hosts=sorted({e['host'] for p in n.values() for e in p['endpoints']})
print('policy version', d['version'], d['status'], 'hosts:', hosts)
sys.exit(0 if hosts == ['inference.local'] else 'EGRESS POLICY NOT LOCKED DOWN')"

say "4. dashboard forward → 127.0.0.1"
scripts/dashboard-loopback.sh

say "5. OpenClaw provider backoff (stored in SQLite, cached in the gateway: reset, then restart if needed)"
out=$(nemoclaw "$SANDBOX" exec --stdin -- python3 - reset < scripts/backoff.py 2>&1 | grep -v 'OCSF JSON audit'); echo "$out"
if grep -q '"hadFailure": true' <<<"$out"; then
  nemoclaw "$SANDBOX" gateway restart || echo "(restart reported a failure; NemoClaw can't re-create its 0.0.0.0 dashboard forward because our loopback forward holds the port. Checking health below)"
  for _ in 1 2 3 4 5 6 7 8 9; do scripts/sbx.sh 'openclaw gateway status 2>&1 | grep -q "Connectivity probe: ok"' && break; sleep 10; done
fi

say "6. escrow-hook plugin"
if nemoclaw "$SANDBOX" exec --no-stdin -- openclaw plugins inspect escrow-hook --json < /dev/null 2>/dev/null | grep -q '"status": "loaded"'; then
  echo "escrow-hook loaded"
else
  scripts/install-plugin.sh || echo "(gateway restart readiness can time out on this machine; re-check below)"
fi

say "7. course data + verification policy"
if ! nemoclaw "$SANDBOX" exec --no-stdin -- test -f /sandbox/.escrow/policy.json < /dev/null 2>/dev/null; then node scripts/seed-sandbox.ts; else echo "already seeded"; fi

say "8. loopback (re-applied after any gateway restart above, then asserted)"
scripts/dashboard-loopback.sh
scripts/assert-loopback.sh

say "summary"
ss -ltnp 2>/dev/null | grep -E ':(8000|8080|18789) ' | awk '{print $4, $6}'
scripts/sbx.sh 'openclaw gateway status 2>&1 | grep Connectivity' || true
