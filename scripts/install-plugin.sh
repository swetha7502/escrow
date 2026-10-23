#!/usr/bin/env bash
# Build plugins/escrow-hook, upload it into the sandbox, and (re)install it with OpenClaw's plugin CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
SANDBOX="${SANDBOX:-escrow}"
P=plugins/escrow-hook
rm -rf "$P/dist" && node_modules/.bin/tsc -p "$P/tsconfig.build.json"
STAGE=$(mktemp -d)/escrow-hook
mkdir -p "$STAGE" && cp -r "$P/package.json" "$P/openclaw.plugin.json" "$P/dist" "$STAGE/"
nemoclaw "$SANDBOX" exec --no-stdin -- rm -rf /sandbox/escrow-hook < /dev/null
openshell sandbox upload "$SANDBOX" "$STAGE" /sandbox/escrow-hook
nemoclaw "$SANDBOX" exec --no-stdin --timeout 170 -- sh -c '
  set -e
  openclaw plugins install /sandbox/escrow-hook/escrow-hook --force --accept-capabilities 2>&1 | grep -vE "^\[(proxy|config)\]"
  openclaw plugins enable escrow-hook --accept-capabilities 2>&1 | grep -vE "^\[(proxy|config)\]" || true
' < /dev/null
nemoclaw "$SANDBOX" gateway restart
nemoclaw "$SANDBOX" exec --no-stdin -- openclaw plugins inspect escrow-hook --runtime --json < /dev/null
