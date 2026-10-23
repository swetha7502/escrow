# M3: Egress lockdown (OpenShell policy)

**Claim:** From inside the `escrow` sandbox, the only network exit is the OpenShell managed inference route `inference.local`. The host-side OpenShell gateway forwards it to the Escrow spend proxy (`127.0.0.1:8000`), which forwards only to `api.tokenfactory.nebius.com`. Everything else is denied, including direct calls to Token Factory.

Guarantee level: **deterministic**. It's enforced by OpenShell, outside the agent process.

## Policy applied

`policies/escrow-sandbox.yaml` (only `managed_inference` → `inference.local:443`):

```
$ openshell policy set escrow --policy policies/escrow-sandbox.yaml --wait
✓ Policy version 2 submitted (hash: 0e5f82701ad1)
✓ Policy version 2 loaded (active version: 2)
```

Before lockdown, the NemoClaw-generated policy also allowed `clawhub.ai`, `registry.npmjs.org`, `integrate.api.nvidia.com`, `openclaw.ai`, `catalog.openclaw.ai`, and `docs.openclaw.ai`. After:

```
$ openshell policy get escrow --full -o json   # network_policies only
version 2 status effective
managed_inference [('inference.local', 443, [{'method': 'GET', 'path': '/v1/models'}, {'method': 'POST', 'path': '/v1/chat/completions'}])]
```

## Probes from inside the sandbox (`scripts/egress-probe.sh`)

Run with `nemoclaw escrow exec --no-stdin -- sh -c "$(cat scripts/egress-probe.sh)"`.

```
## whoami: sandbox on e79ed4dc27af

$ curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com
curl: (56) CONNECT tunnel failed, response 403
000
[exit=56]

$ curl -sS -m 10 -o /dev/null -w '%{http_code}' http://example.com
403
[exit=0]

$ getent hosts example.com || echo 'getent: no answer'
getent: no answer
[exit=0]

$ python3 -c "import socket; print(socket.getaddrinfo('example.com', 443))"
Traceback (most recent call last):
  File "<string>", line 1, in <module>
    import socket; print(socket.getaddrinfo('example.com', 443))
                         ~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.13/socket.py", line 977, in getaddrinfo
    for res in _socket.getaddrinfo(host, port, family, type, proto, flags):
               ~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
socket.gaierror: [Errno -3] Temporary failure in name resolution
[exit=1]

$ curl -sS -m 10 -o /dev/null -w '%{http_code}' https://api.tokenfactory.nebius.com/v1/models
curl: (56) CONNECT tunnel failed, response 403
000
[exit=56]

$ curl -sS -m 10 -o /dev/null -w '%{http_code}' https://1.1.1.1
curl: (56) CONNECT tunnel failed, response 403
000
[exit=56]

$ curl -sS -m 10 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/
curl: (56) CONNECT tunnel failed, response 403
000
[exit=56]

$ curl -sS -m 60 https://inference.local/v1/chat/completions -H 'content-type: application/json' -d '{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"Reply with exactly: egress-ok"}],"max_tokens":300}'
{"id":"chatcmpl-798074993fe652adb6daa277cbd8a6c5","choices":[{"finish_reason":"stop","index":0,"logprobs":null,"message":{"content":"\n\negress-ok","refusal":null,"role":"assistant","annotations":null,"audio":null,"function_call":null,"tool_calls":null,... (truncated)
```

| Probe | Expected | Result |
|---|---|---|
| `curl https://example.com` | blocked | **403 at CONNECT, curl exit 56** |
| `curl http://example.com` | blocked | **403** |
| DNS `example.com` (getent, getaddrinfo) | fails | **no answer / EAI_AGAIN**. The sandbox has no resolver for public names. |
| `curl https://api.tokenfactory.nebius.com` (direct) | blocked | **403, exit 56**. The proxy can't be bypassed. |
| `curl https://1.1.1.1`, `https://registry.npmjs.org` | blocked | **403, exit 56** |
| `curl https://inference.local/v1/chat/completions` | succeeds | **200, Nemotron replied `egress-ok`** |

## Bypass attempts (`scripts/bypass-probe.sh`)

The probes above go through the sandbox HTTP proxy (`HTTPS_PROXY=http://10.200.0.1:3128`). These try to get around it:

```
$ env | grep -i _proxy | sed 's/=.*@/=***@/'
HTTPS_PROXY=http://10.200.0.1:3128
no_proxy=localhost,127.0.0.1,::1,10.200.0.1
NO_PROXY=localhost,127.0.0.1,::1,10.200.0.1
https_proxy=http://10.200.0.1:3128
ALL_PROXY=http://10.200.0.1:3128
http_proxy=http://10.200.0.1:3128
grpc_proxy=http://10.200.0.1:3128
NODE_USE_ENV_PROXY=1
HTTP_PROXY=http://10.200.0.1:3128
[exit=0]

$ curl -sS -m 8 --noproxy '*' -o /dev/null -w '%{http_code}' https://1.1.1.1
curl: (7) Failed to connect to 1.1.1.1 port 443 after 16 ms: Could not connect to server
000
[exit=7]

$ curl -sS -m 8 --noproxy '*' -o /dev/null -w '%{http_code}' --resolve api.tokenfactory.nebius.com:443:104.18.0.1 https://api.tokenfactory.nebius.com/v1/models
curl: (7) Failed to connect to api.tokenfactory.nebius.com port 443 after 0 ms: Could not connect to server
000
[exit=7]

$ python3 -c "import socket; s=socket.create_connection(('1.1.1.1',443),timeout=8); print('CONNECTED')"
reate_connection(('1.1.1.1',443),timeout=8); print('CONNECTED')
                     ~~~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.13/socket.py", line 864, in create_connection
    raise exceptions[0]
  File "/usr/lib/python3.13/socket.py", line 849, in create_connection
    sock.connect(sa)
    ~~~~~~~~~~~~^^^^
ConnectionRefusedError: [Errno 111] Connection refused
[exit=1]

$ python3 -c "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(5); s.sendto(b'x',('8.8.8.8',53)); print(s.recvfrom(512))"
Traceback (most recent call last):
  File "<string>", line 1, in <module>
    import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(5); s.sendto(b'x',('8.8.8.8',53)); print(s.recvfrom(512))
                                                                                       ~~~~~~~~^^^^^^^^^^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted
[exit=1]

$ node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log('ERR',e.code);process.exit(1)})"
ERR ECONNREFUSED
[exit=1]

$ curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST https://inference.local/v1/embeddings -H 'content-type: application/json' -d '{}'
404
[exit=0]

$ curl -sS -m 10 -o /dev/null -w '%{http_code}' https://inference.local/v1/files
403
[exit=0]
```

| Attempt | Result |
|---|---|
| curl `--noproxy '*'` to 1.1.1.1, and to Token Factory with a pinned IP | **connect refused (exit 7)** |
| Python raw TCP to 1.1.1.1:443 | **ECONNREFUSED** |
| Python raw UDP to 8.8.8.8:53 (DNS bypass) | **EPERM (Operation not permitted)** |
| Node `net.connect(443, "1.1.1.1")` | **ECONNREFUSED** |
| `GET https://inference.local/v1/files` (path not in policy) | **403 (OpenShell L7 rule)** |
| `POST https://inference.local/v1/embeddings` | **404 from the Escrow proxy**. See the note below. |

**Note (honest finding):** `POST /v1/embeddings` isn't in the policy's L7 rules, but it still reached the host-side proxy. OpenShell's managed inference router seems to forward recognized inference API paths before the L7 rules apply, while unrecognized paths like `/v1/files` hit the L7 rule and get 403. That doesn't open an exit: the Escrow proxy forwards only `POST /v1/chat/completions` and logs everything else. Proxy log line for that request:

```
{"ts":"2026-10-23T20:48:52.864Z","event":"not_proxied","method":"POST","path":"/v1/embeddings"}
```

## OpenShell's own audit log (OCSF), same window

```
[1792788346.495] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED inference.local:443
[1792788372.717] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED inference.local:443
[1792788372.997] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED inference.local:443
[1792788458.055] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(5624) -> example.com:443 [policy:- engine:opa] [reason:endpoint example.com:443 is not allowed by any policy]
[1792788458.115] [sandbox] [OCSF ] [ocsf] HTTP:GET [MED] DENIED /usr/bin/curl(5627) -> GET http://example.com/ [policy:- engine:opa] [reason:endpoint example.com:80 is not allowed by any policy]
[1792788458.423] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(5636) -> api.tokenfactory.nebius.com:443 [policy:- engine:opa] [reason:endpoint api.tokenfactory.nebius.com:443 is not allowed by any policy]
[1792788458.458] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(5639) -> 1.1.1.1:443 [policy:- engine:opa] [reason:endpoint 1.1.1.1:443 is not allowed by any policy]
[1792788458.494] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(5642) -> registry.npmjs.org:443 [policy:- engine:opa] [reason:endpoint registry.npmjs.org:443 is not allowed by any policy]
[1792788458.557] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED inference.local:443
[1792788475.312] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(5718) -> example.com:443 [policy:- engine:opa] [reason:endpoint example.com:443 is not allowed by any policy]
[1792788475.347] [sandbox] [OCSF ] [ocsf] HTTP:GET [MED] DENIED /usr/bin/curl(5722) -> GET http://example.com/ [policy:- engine:opa] [reason:endpoint example.com:80 is not allowed by any policy]
[1792788475.520] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(5734) -> api.tokenfactory.nebius.com:443 [policy:- engine:opa] [reason:endpoint api.tokenfactory.nebius.com:443 is not allowed by any policy]
[1792788475.548] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(5738) -> 1.1.1.1:443 [policy:- engine:opa] [reason:endpoint 1.1.1.1:443 is not allowed by any policy]
[1792788475.581] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(5742) -> registry.npmjs.org:443 [policy:- engine:opa] [reason:endpoint registry.npmjs.org:443 is not allowed by any policy]
[1792788475.649] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED inference.local:443
```

## Reproduce

```
openshell policy set escrow --policy policies/escrow-sandbox.yaml --wait
nemoclaw escrow exec --no-stdin -- sh -c "$(cat scripts/egress-probe.sh)"
nemoclaw escrow exec --no-stdin -- sh -c "$(cat scripts/bypass-probe.sh)"
openshell logs escrow --since 5m | grep -E 'DENIED|ALLOWED'
```
