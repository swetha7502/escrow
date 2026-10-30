# M4: Host-side sender drains the sandbox outbox. The sandbox has no other network path.

**Design: pull, not push.** The sandbox writes effect records to `/sandbox/escrow/outbox/<id>.json`, which is a plain directory inside the sandbox. The host-side sender (`sender/`) runs **outside** the sandbox and *pulls* records over the OpenShell exec channel (`nemoclaw escrow exec -- find|cat|mv`, argv-only via `execFile`, no host shell). It delivers each one, logging `sent` to `state/sent.log` for the demo, and moves the record to `outbox/drained/`. The sender opens **no listening port**, so the sandbox gets no new network route. The egress policy from M3 still allows only `inference.local`.

The sender also enforces exactly-once delivery (`state/sender-seen.json`), rejects malformed or uncommitted records or records whose id doesn't match, and runs a **host-side verifier** before every send. That verifier is wired to the canary/exact-match tier in M8, so a compromised sandbox can't release an effect just by labeling it `committed`.

## Proof: the sandbox writes to the outbox, the host drains it and logs `sent`

```
$ (inside sandbox, as user "sandbox") node writes a committed effect to /sandbox/escrow/outbox
wrote eff-m4-demo-001 as uid 998
total 12
drwxr-xr-x 2 sandbox sandbox 4096 Oct 23 21:08 .
drwxr-xr-x 3 sandbox sandbox 4096 Oct 23 21:07 ..
-rw-r--r-- 1 sandbox sandbox  237 Oct 23 21:08 eff-m4-demo-001.json

$ (host) node sender/main.ts --once
{"ts":"2026-10-23T21:08:25.866Z","sent":["eff-m4-demo-001"],"rejected":[],"skipped":[]}

$ (host) cat state/sent.log
{"ts":"2026-10-23T21:08:23.066Z","event":"sent","id":"eff-m4-demo-001","sessionId":"m4-demo","kind":"send_email","payload":{"to":["prof.lin@example.edu"],"subject":"Regrade queue","body":"3 regrade requests are waiting."}}

$ (host) node sender/main.ts --once   # second drain: nothing left, exactly-once
{"ts":"2026-10-23T21:08:29.270Z","sent":[],"rejected":[],"skipped":[]}

$ (inside sandbox) ls /sandbox/escrow/outbox /sandbox/escrow/outbox/drained
drained
drained/:
eff-m4-demo-001.json
```

## Proof: the sandbox has no other path to the host or the internet

```
$ (inside sandbox) sh scripts/host-path-probe.sh
$ getent hosts host.openshell.internal host.docker.internal || echo 'no answer'
fdc4:f303:9324::254 host.openshell.internal
fdc4:f303:9324::254 host.docker.internal
[exit=0]

$ curl -sS -m 8 -o /dev/null -w '%{http_code}' http://host.openshell.internal:8000/healthz
403
[exit=0]

$ curl -sS -m 8 -o /dev/null -w '%{http_code}' http://host.docker.internal:8000/healthz
403
[exit=0]

$ curl -sS -m 8 --noproxy '*' -o /dev/null -w '%{http_code}' http://10.200.0.1:8000/healthz
curl: (7) Failed to connect to 10.200.0.1 port 8000 after 18 ms: Could not connect to server
000
[exit=7]

$ curl -sS -m 8 --noproxy '*' -o /dev/null -w '%{http_code}' https://10.200.0.1:8080/
curl: (7) Failed to connect to 10.200.0.1 port 8080 after 0 ms: Could not connect to server
000
[exit=7]

$ curl -sS -m 8 -o /dev/null -w '%{http_code}' http://10.200.0.1:3128/
400
[exit=0]

$ python3 -c "import socket; socket.create_connection(('10.200.0.1',8000),timeout=5); print('CONNECTED')"
~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.13/socket.py", line 864, in create_connection
    raise exceptions[0]
  File "/usr/lib/python3.13/socket.py", line 849, in create_connection
    sock.connect(sa)
    ~~~~~~~~~~~~^^^^
ConnectionRefusedError: [Errno 111] Connection refused
[exit=1]

$ (host) ss -ltnp   # listening sockets: the sender has none; the proxy is loopback-only
127.0.0.1:8080 users:(("openshell-gatew",pid=15217,fd=14))
127.0.0.1:8000 users:(("MainThread",pid=31414,fd=21))
0.0.0.0:18789 users:(("openshell",pid=23263,fd=10))

$ (host) pgrep -af "sender/main.ts" (not running: pull model, invoked on demand or polling via exec)
(no process)
```

| Attempt from inside the sandbox | Result |
|---|---|
| `http://host.openshell.internal:8000` (the spend proxy's port) via the sandbox HTTP proxy | **403** (OpenShell policy) |
| `http://host.docker.internal:8000` | **403** |
| `10.200.0.1:8000` / `:8080` direct (`--noproxy`, raw TCP) | **connection refused** |
| `10.200.0.1:3128` | the sandbox's own egress proxy (the enforcement point). It answers 400 to a non-proxy request and forwards nothing. |

Combined with `evidence/egress.md` (example.com, DNS, Token Factory direct, raw TCP and UDP all fail), the sandbox's exits are: (1) `inference.local` → spend proxy → Token Factory, and (2) outbox files that only the host-side sender can pull, verify, and release.

Host listeners: the spend proxy is `127.0.0.1:8000` (loopback only) and the OpenShell gateway is `127.0.0.1:8080`. **Finding:** NemoClaw's OpenClaw dashboard forward listens on `0.0.0.0:18789` on the host. That's an *inbound* path to the OpenClaw UI, protected by the gateway token, not a sandbox exit. It's still worth restricting to loopback for the demo machine; `scripts/assert-loopback.sh` now checks it.

## Tests

`sender/sender.test.ts`: sends committed effects; the host verifier can veto; malformed, uncommitted, mismatched-id, and wrong-kind records are rejected; exactly-once on re-listing.
