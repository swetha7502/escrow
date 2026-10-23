import json, re, pathlib
R = pathlib.Path(__file__).resolve().parent.parent
rd = lambda p: (R / p).read_text()
pol = json.loads(rd("state/policy-locked.json"))
pol_lines = [f"version {pol['version']} status {pol['status']}"] + [
    f"{n} {[(e['host'], e['port'], [r['allow'] for r in e.get('rules', [])]) for e in p['endpoints']]}"
    for n, p in pol["policy"]["network_policies"].items()]
probe = re.sub(r'"reasoning":.*', '... (truncated)', rd("state/egress-probe.out"))
bypass = rd("state/bypass-probe.out")
ocsf = rd("state/egress-ocsf.out")
fence = "```"
md = f"""# M3: Egress lockdown (OpenShell policy)

**Claim:** From inside the `escrow` sandbox, the only network exit is the OpenShell managed inference route `inference.local`. The host-side OpenShell gateway forwards it to the Escrow spend proxy (`127.0.0.1:8000`), which forwards only to `api.tokenfactory.nebius.com`. Everything else is denied, including direct calls to Token Factory.

Guarantee level: **deterministic**. It's enforced by OpenShell, outside the agent process.

## Policy applied

`policies/escrow-sandbox.yaml` (only `managed_inference` → `inference.local:443`):

{fence}
$ openshell policy set escrow --policy policies/escrow-sandbox.yaml --wait
✓ Policy version 2 submitted (hash: 0e5f82701ad1)
✓ Policy version 2 loaded (active version: 2)
{fence}

Before lockdown, the NemoClaw-generated policy also allowed `clawhub.ai`, `registry.npmjs.org`, `integrate.api.nvidia.com`, `openclaw.ai`, `catalog.openclaw.ai`, and `docs.openclaw.ai`. After:

{fence}
$ openshell policy get escrow --full -o json   # network_policies only
{chr(10).join(pol_lines)}
{fence}

## Probes from inside the sandbox (`scripts/egress-probe.sh`)

Run with `nemoclaw escrow exec --no-stdin -- sh -c "$(cat scripts/egress-probe.sh)"`.

{fence}
{probe.strip()}
{fence}

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

{fence}
{bypass.strip()}
{fence}

| Attempt | Result |
|---|---|
| curl `--noproxy '*'` to 1.1.1.1, and to Token Factory with a pinned IP | **connect refused (exit 7)** |
| Python raw TCP to 1.1.1.1:443 | **ECONNREFUSED** |
| Python raw UDP to 8.8.8.8:53 (DNS bypass) | **EPERM (Operation not permitted)** |
| Node `net.connect(443, "1.1.1.1")` | **ECONNREFUSED** |
| `GET https://inference.local/v1/files` (path not in policy) | **403 (OpenShell L7 rule)** |
| `POST https://inference.local/v1/embeddings` | **404 from the Escrow proxy**. See the note below. |

**Note (honest finding):** `POST /v1/embeddings` isn't in the policy's L7 rules, but it still reached the host-side proxy. OpenShell's managed inference router seems to forward recognized inference API paths before the L7 rules apply, while unrecognized paths like `/v1/files` hit the L7 rule and get 403. That doesn't open an exit: the Escrow proxy forwards only `POST /v1/chat/completions` and logs everything else. Proxy log line for that request:

{fence}
{{"ts":"2026-10-23T20:48:52.864Z","event":"not_proxied","method":"POST","path":"/v1/embeddings"}}
{fence}

## OpenShell's own audit log (OCSF), same window

{fence}
{ocsf.strip()}
{fence}

## Reproduce

{fence}
openshell policy set escrow --policy policies/escrow-sandbox.yaml --wait
nemoclaw escrow exec --no-stdin -- sh -c "$(cat scripts/egress-probe.sh)"
nemoclaw escrow exec --no-stdin -- sh -c "$(cat scripts/bypass-probe.sh)"
openshell logs escrow --since 5m | grep -E 'DENIED|ALLOWED'
{fence}
"""
(R / "evidence/egress.md").write_text(md)
print("wrote evidence/egress.md", len(md.splitlines()), "lines")
