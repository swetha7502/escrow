# M1: NemoClaw installed, agent replies from Nemotron via Token Factory (through the Escrow spend proxy)

Captured 2026-10-23T20:46:16Z.

## Versions
```
$ nemoclaw --version
nemoclaw v0.0.137
$ openshell --version
openshell 0.0.116
```

## Onboarding (non-interactive)
The installer ran with `NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_PROVIDER=custom NEMOCLAW_ENDPOINT_URL=http://localhost:8000/v1 NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b NEMOCLAW_POLICY_TIER=restricted NEMOCLAW_SANDBOX_NAME=escrow`, with `COMPATIBLE_API_KEY` set to the **proxy token**, not the Token Factory key.
The first run stopped at step 8/8 ("OpenClaw startup did not settle"). `nemoclaw onboard --resume --non-interactive` then completed (exit 0). See feedback.md.

## `nemoclaw escrow status`
```

  Sandbox-scoped status for 'escrow':
  Sandbox: escrow
    Model:    nvidia/nemotron-3-super-120b-a12b
    Provider: compatible-endpoint
    Reasoning effort: endpoint-default
    Inference: healthy (https://inference.local/v1/models)
    Inference (route reachability): reachable (https://inference.local/v1/models)
    Inference (upstream): not probed (Endpoint URL is not known; skipping reachability check.)
    Serving process (openclaw gateway): not checked
    Host GPU: no
    Sandbox GPU: disabled (auto)
    OpenShell: 0.0.116 (docker)
    Policies: none
    Harness:  OpenClaw (gateway)
    SSH sessions: none
```

## Agent turn inside the sandbox
```
$ nemoclaw escrow exec --no-stdin -- openclaw agent --session-id m1-proof-3 --json -m "Reply with exactly one line: escrow-m1-ok, then name the model you are."
{
  "status": "ok",
  "reply": "escrow-m1-ok inference/nvidia/nemotron-3-super-120b-a12b",
  "provider": "inference",
  "model": "nvidia/nemotron-3-super-120b-a12b",
  "usage": {
    "input": 25671,
    "output": 102,
    "reasoningTokens": 75
  }
}
```

## Matching line in the host-side spend proxy log (`state/proxy.log`)
The call went sandbox → `inference.local` → OpenShell gateway (host) → Escrow proxy `127.0.0.1:8000` → `api.tokenfactory.nebius.com`.
```
{"ts":"2026-10-23T20:45:49.467Z","event":"call","model":"nvidia/nemotron-3-super-120b-a12b","runId":"anon-2026-10-23T20:45:46.704Z","status":200,"stream":true,"usage":{"promptTokens":25671,"completionTokens":102},"usd":0.0077931,"totalUsd":0.0079425}
```
The 25,671 prompt tokens match OpenClaw's `usage.input` exactly. A later 19-token line comes from the `nemoclaw status` inference probe.
```
{"ts":"2026-10-23T20:46:14.063Z","event":"call","model":"nvidia/nemotron-3-super-120b-a12b","runId":"anon-2026-10-23T20:45:46.704Z","status":200,"usage":{"promptTokens":19,"completionTokens":11},"usd":0.0000156,"totalUsd":0.0079581}
```
