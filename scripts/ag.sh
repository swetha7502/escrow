#!/usr/bin/env bash
# One agent turn in the sandbox: scripts/ag.sh <session-id> <tag> <message>. Writes state/<sid>-<tag>.json and prints the reply.
cd "$(dirname "$0")/.."
sid=$1 tag=$2 msg=$3
timeout 320 nemoclaw escrow exec --no-stdin --timeout 300 -- openclaw agent --session-id "$sid" --timeout 280 --json -m "$msg" > "state/$sid-$tag.json" 2> "state/$sid-$tag.err" < /dev/null
echo "[$sid/$tag exit $?]"
python3 -I -c "
import json,sys;d=json.load(open(sys.argv[1]));print(((d.get('result') or {}).get('payloads') or [{}])[0].get('text', d.get('error')))" "state/$sid-$tag.json" 2>&1 | head -c 900; echo
