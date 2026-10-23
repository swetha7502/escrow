#!/usr/bin/env bash
# Run a shell snippet inside the sandbox as the sandbox user: scripts/sbx.sh '<cmd>'
timeout 90 nemoclaw "${SANDBOX:-escrow}" exec --no-stdin -- sh -c "$1" < /dev/null 2>&1 | grep -v 'OCSF JSON audit'
