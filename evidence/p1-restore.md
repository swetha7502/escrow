# Phase 2 / Step 1: live sandbox restored, egress re-verified (2026-10-26)

**Result:** sandbox `escrow` is back to `Ready` with a working OpenClaw gateway, the escrow-hook plugin
loaded, and egress locked to `inference.local` only. Restore took ~16 minutes (13:37 → 13:53 EDT).

## Root cause of the 2026-10-25 outage (not memory)

NemoClaw keeps OpenClaw state in a **named Docker volume**, `nemoclaw-openclaw-state-v1-escrow`, mounted at
`/sandbox/.openclaw`. `onboard --fresh --recreate-sandbox` recreates the container but **reuses that volume**.
During the failed Oct 25 rebuild/restore, `openclaw.json` in the volume was rewritten as uid 1000 (`node`)
with mode 600, while everything else is `sandbox` (uid 998):

```
$ docker exec -u 0 <container> stat -c "%U:%G %a" /sandbox/.openclaw /sandbox/.openclaw/openclaw.json
sandbox:sandbox 700
node:node 600            <- openclaw.json, mtime Oct 25 16:08 (the failed rebuild)
$ docker run --rm --entrypoint sh <image> -c 'ls -la /sandbox/.openclaw/openclaw.json'
-rw------- 1 sandbox sandbox 3236 Oct 21 06:46 /sandbox/.openclaw/openclaw.json   <- image is fine
```

Two consequences, which explain both symptoms:
1. NemoClaw's managed-startup *root apply* runs without DAC override, so it can't open the file:
   `Managed startup root application failed ... EACCES: permission denied, open '/sandbox/.openclaw/openclaw.json'`
   (today's first onboard, `state/p1-onboard.log`).
2. The OpenClaw gateway runs as `sandbox` and can't read its own config, which is the Oct 25
   "gateway main-process crashes on start (exit 1)".

## Restore sequence (commands as run)

```
proxy/run.sh
# backup of the old state volume: state/backup/openclaw-state-2026-10-26.tgz (87 MB, gitignored)
nemoclaw escrow destroy --yes --no-cleanup-gateway     # "Removed managed agent state volume for 'escrow'"
NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 ... nemoclaw onboard --fresh --non-interactive --name escrow
#   → managed startup OK; "OpenClaw startup did not settle" (gateway WAS running: pid 1347, probe ok;
#     doctor's only failure was `spawnSync docker ETIMEDOUT`)
... nemoclaw onboard --resume --non-interactive --name escrow
#   → "✓ Deployment verified — gateway, dashboard, and inference route are healthy."
scripts/up.sh                                          # state/p1-up.out
```

`up.sh` output (abridged):
```
== 3. egress policy
✓ Policy version 2 loaded (active version: 2)
policy version 2 effective hosts: ['inference.local']
== 4. dashboard forward → 127.0.0.1
LISTEN 0 128 127.0.0.1:18789 ... openshell
== 5. OpenClaw provider backoff
{"db": "agents/main/agent/openclaw-agent.sqlite", "reset": true, "hadFailure": false}
== 6. escrow-hook plugin
Installed plugin: escrow-hook / Enabled plugin "escrow-hook"
== 7. course data + verification policy
seeded 3 records, course policy, and the escrow verification policy into 'escrow'
== summary
127.0.0.1:8000 (proxy)   127.0.0.1:8080 (openshell gateway)   127.0.0.1:18789 (dashboard, loopback)
Connectivity probe: ok
```

## Egress lockdown re-verified (from inside the sandbox)

`scripts/egress-probe.sh` → `state/p1-egress-probe.out`; `scripts/bypass-probe.sh` → `state/p1-bypass-probe.out`.

| probe (inside sandbox, user `sandbox`) | result |
|---|---|
| `curl https://example.com` | **CONNECT tunnel failed, 403** |
| `curl http://example.com` | **403** |
| `getent hosts example.com` / Python `getaddrinfo` | **no answer / `Temporary failure in name resolution`** (no DNS) |
| `curl https://api.tokenfactory.nebius.com/v1/models` (direct Token Factory) | **CONNECT tunnel failed, 403** |
| `curl https://1.1.1.1`, `https://registry.npmjs.org/` | **403** |
| `curl --noproxy '*' https://1.1.1.1`, `--resolve` Token Factory to an IP | **Failed to connect** |
| Python raw TCP to 1.1.1.1:443 | **ConnectionRefusedError** |
| Python raw UDP to 8.8.8.8:53 | **PermissionError: Operation not permitted** |
| Node `net.connect(443,'1.1.1.1')` | **ECONNREFUSED** |
| Node `fetch('https://example.com')` | **fetch failed** |
| `GET https://inference.local/v1/files` (path not in policy) | **403** |
| `POST https://inference.local/v1/chat/completions` | **200, Nemotron Super replied `egress-ok`** |

## Live agent + hook

```
$ scripts/ag.sh p1smoke t1 "Reply with exactly: escrow-agent-ok. Do not call any tools."
[p1smoke/t1 exit 0]
escrow-agent-ok
$ openclaw plugins inspect escrow-hook --json | grep status
    "status": "loaded",
/sandbox/.escrow/audit.jsonl: {"pid":1347,"tm":"siug0p","mode":"escrow","event":"register"}
```

## Findings that shape the next steps

* Node `fetch` inside the sandbox reaches `inference.local` (`NODE_USE_ENV_PROXY=1`, OpenShell CA in
  `NODE_EXTRA_CA_CERTS`), so the plugin's in-sandbox Super judge can call the model with **no token**
  (OpenShell injects it). `lib/tf-client.ts` now takes `baseUrl`; the plugin passes `https://inference.local/v1`.
* `inference.local` **rewrites the request model** to the route's configured model: a request for
  `NVIDIA-Nemotron-3-Nano-30B-A3B` came back from `nemotron-3-super-120b-a12b`. It also **drops our
  `x-escrow-run` header** (calls land in the proxy as anonymous runs). So in-sandbox model calls are always
  Super. Ultra (contract) and Nano run **host-side** through the proxy.

**Never run `nemoclaw rebuild` again before the deadline.**
