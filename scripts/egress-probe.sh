#!/bin/sh
# Runs INSIDE the sandbox. Each probe prints its command and the result.
run() { echo "\$ $*"; out=$(sh -c "$*" 2>&1); rc=$?; printf "%s\n" "$out" | head -c 600; echo "[exit=$rc]"; echo; }
echo "## whoami: $(id -un) on $(hostname)"
echo
run "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com"
run "curl -sS -m 10 -o /dev/null -w '%{http_code}' http://example.com"
run "getent hosts example.com || echo 'getent: no answer'"
run "python3 -c \"import socket; print(socket.getaddrinfo('example.com', 443))\""
run "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://api.tokenfactory.nebius.com/v1/models"
run "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://1.1.1.1"
run "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/"
run "curl -sS -m 60 https://inference.local/v1/chat/completions -H 'content-type: application/json' -d '{\"model\":\"nvidia/nemotron-3-super-120b-a12b\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: egress-ok\"}],\"max_tokens\":300}'"
