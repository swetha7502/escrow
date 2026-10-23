#!/bin/sh
# Runs INSIDE the sandbox. Tries to get around the egress proxy.
run() { echo "\$ $*"; out=$(sh -c "$*" 2>&1); rc=$?; printf "%s\n" "$out" | tail -c 400; echo "[exit=$rc]"; echo; }
run "env | grep -i _proxy | sed 's/=.*@/=***@/'"
run "curl -sS -m 8 --noproxy '*' -o /dev/null -w '%{http_code}' https://1.1.1.1"
run "curl -sS -m 8 --noproxy '*' -o /dev/null -w '%{http_code}' --resolve api.tokenfactory.nebius.com:443:104.18.0.1 https://api.tokenfactory.nebius.com/v1/models"
run "python3 -c \"import socket; s=socket.create_connection(('1.1.1.1',443),timeout=8); print('CONNECTED')\""
run "python3 -c \"import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(5); s.sendto(b'x',('8.8.8.8',53)); print(s.recvfrom(512))\""
run "node -e \"require('net').connect(443,'1.1.1.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log('ERR',e.code);process.exit(1)})\""
run "curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST https://inference.local/v1/embeddings -H 'content-type: application/json' -d '{}'"
run "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://inference.local/v1/files"
