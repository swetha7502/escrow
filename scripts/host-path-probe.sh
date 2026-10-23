#!/bin/sh
# Runs INSIDE the sandbox. Tries to reach the host (proxy, gateway, sender) any way except the outbox.
run() { echo "\$ $*"; out=$(sh -c "$*" 2>&1); rc=$?; printf "%s\n" "$out" | tail -c 300; echo "[exit=$rc]"; echo; }
run "getent hosts host.openshell.internal host.docker.internal || echo 'no answer'"
run "curl -sS -m 8 -o /dev/null -w '%{http_code}' http://host.openshell.internal:8000/healthz"
run "curl -sS -m 8 -o /dev/null -w '%{http_code}' http://host.docker.internal:8000/healthz"
run "curl -sS -m 8 --noproxy '*' -o /dev/null -w '%{http_code}' http://10.200.0.1:8000/healthz"
run "curl -sS -m 8 --noproxy '*' -o /dev/null -w '%{http_code}' https://10.200.0.1:8080/"
run "curl -sS -m 8 -o /dev/null -w '%{http_code}' http://10.200.0.1:3128/"
run "python3 -c \"import socket; socket.create_connection(('10.200.0.1',8000),timeout=5); print('CONNECTED')\""
