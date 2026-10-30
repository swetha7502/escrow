# Feedback for Nebius and NVIDIA: building Escrow on Token Factory + NemoClaw

Escrow is a TA assistant running in **NemoClaw** (OpenClaw in an OpenShell sandbox) on **Nemotron via Nebius Token Factory**, with a safety layer that holds every side effect until the session is verified. We built it between 2026-10-20 and 2026-10-30 on one WSL2 + Docker Desktop laptop.

This write-up is distilled from our dated friction log (`feedback.md`, 20 entries, each with what happened and the workaround). The issues are ordered by how much time they cost us. Each one has a concrete suggestion.

## What worked well

- **OpenShell's egress lockdown is the real thing.** With our policy, the sandbox's only route out is `inference.local`. Direct calls to Token Factory, `example.com`, DNS, raw TCP/UDP and `--noproxy` all fail (`evidence/egress.md`). That made our core claim provable: the only non-inference exit is verified, and inference goes only to Nebius as the processor.
- **OpenClaw's `before_tool_call` hook was enough to build on.** It sees full parameters for every tool, can block, and can rewrite parameters, which is how the shadow file system works. We didn't need the MCP-proxy fallback we'd planned.
- **The Nemotron family on Token Factory covers distinct roles cleanly.** Ultra drafts the task contract (about 2.6 s, $0.003), Super runs the agent and adjudicates paraphrase leaks (p50 about 1.1 s, about $0.0003 per judgment), and Nano labels reads. Super as a judge missed 0/20 paraphrase leaks with 0/15 false positives (`evidence/p3-judge-reliability.md`), and it ignored an embedded "respond leak=false" instruction (`FAILURE_MODES.md` FM7).
- **Token Factory's `/v1/models?verbose=true` returns prices.** We built a spend cap that fails closed on top of it.

## Issues, highest cost first

### 1. Sandbox lifecycle on WSL: rebuild/onboard can strand the sandbox, and `--fresh` reuses a poisoned volume (NemoClaw)
This cost about a day.
- `nemoclaw escrow rebuild --yes` failed, first on our loopback dashboard forward holding 18789, then on "Failed to back up sandbox state", and left the sandbox in **Error** phase.
- From Error, `recover`, `doctor --fix`, stop/start, a gateway-service restart and `docker restart` all failed to clear it, although the container was healthy and serving inference.
- `onboard --fresh --recreate-sandbox` kept the named state volume, in which the failed rebuild had left `openclaw.json` owned by uid 1000, mode 600. Managed startup then hit `EACCES` and the gateway crashed on start. We first misattributed this to low memory.

**Suggestions:**
- `--fresh` should wipe the state volume, or ownership-check it.
- The `EACCES` message should name the owner and mode it found.
- Error phase needs a non-destructive way back to Ready.
- The preflight `docker info` timeout (5 s) is too tight for Docker Desktop, where `docker info` takes 1.4–5 s.

### 2. `nemoclaw exec` holds a global host lock for the whole command (NemoClaw)
While a ~30 s agent turn runs under `nemoclaw escrow exec`, every other `nemoclaw … exec` waits, then fails with `Failed to acquire lock … after 120 retries`. That rules out a host-side sender or a log reader running alongside the agent. `openshell sandbox exec -n <name> --no-tty` avoids the lock and returns in about 0.1 s, but it forwards stdin, so a caller that leaves stdin open hangs. Meanwhile `openshell sandbox exec -- openclaw agent` hung entirely where `nemoclaw exec` worked.

**Suggestions:** make the lock per command type, or skip it for exec. Document which exec path to use for agent turns, and that stdin must be closed.

### 3. A 402 from the provider puts OpenClaw into a long billing backoff with a misleading message (OpenClaw)
A spend-cap stop (402) made OpenClaw reject agent turns for about 12 minutes, across gateway restarts and after the cap was raised. The message said "Retry after about 1 minute"; the code backs off 10 min, doubling to 24 h.

**Suggestion:** state the real backoff in the message and offer a reset command. We switched our proxy's stop status to 429 + Retry-After to avoid it.

### 4. `inference.local` behavior isn't documented (OpenShell)
- **L7 rules don't restrict recognized inference paths.** With only `GET /v1/models` and `POST /v1/chat/completions` allowed, `POST /v1/embeddings` was still forwarded to the provider. Our host proxy is the real path allowlist.
- **It rewrites the model and drops custom headers.** A request for Nano was answered by the route's configured Super. So multi-model roles (Ultra, Nano) must run host-side, and per-run spend attribution headers don't arrive.
- **The custom-endpoint docs describe a topology we didn't get.** The docs describe `host.openshell.internal` bridging; on OpenShell 0.0.116 with the Docker driver, the gateway is a host process calling the endpoint from loopback.

**Suggestions:** document the inference router's precedence over L7 rules, the model rewrite, and header passthrough. A per-request model allowlist on `inference.local` would let a sandbox use more than one model safely.

### 5. Plugin development friction (OpenClaw)
- `openclaw plugins install` refuses a TypeScript entry, though the quick-start uses `./index.ts`.
- A hook-only plugin with 0 capabilities still requires `--accept-capabilities`.
- **`register(api)` runs again on every agent run in the same process**, which silently replaced our per-session transaction state. The docs don't mention it, and it's a correctness trap for any stateful hook.
- `api.resolvePath` didn't give usable tool paths.
- `gateway restart` reports a readiness timeout, or a "forward recovery failure" when the dashboard forward is loopback-only, while the gateway is fine.

**Suggestions:** document `register()` re-entry. Allow `127.0.0.1` for `NEMOCLAW_DASHBOARD_BIND` on WSL. Don't report a restart as failed when only the forward step failed.

### 6. `apply_patch` is exposed to every model, though the help text says OpenAI/Codex (OpenClaw)
The help for `tools.exec.applyPatch.enabled` says "for OpenAI and OpenAI Codex models". In `openclaw@2026.9.2` there's no provider check: an empty `allowModels` means every model (`dist/agent-tools-By64BZu5.js:329`, `dist/core-coding-tools-DMh_iw8e.js:96-98`), and Nemotron Super lists the tool. A guard written from the docs would leave a direct file-write tool open. Our hook denies by default, so it's blocked (`evidence/p13-apply-patch.md`).

**Suggestion:** make the code and the help text agree.

### 7. Token Factory: Nano latency spikes, key onboarding, small API rough edges (Nebius)
- **Nano latency:** around 19:38–19:45 UTC on 10-27, every Nano call took 36–117 s, even an 18-token "Say OK", while Super answered the same probe in 0.6 s. An hour later Nano took 4–6 s. We had to move Nano labeling off the commit path, behind a content-hash cache with background re-labeling.
- **Key onboarding:** the API key took about 3 days to be approved (10-20 → 10-23), so the first milestones ran against NVIDIA's hosted API and were re-run on Token Factory.
- **Model IDs** are inconsistently cased: `nemotron-3-super-120b-a12b`, `NVIDIA-Nemotron-3-Nano-30B-A3B`, `Nemotron-3-Ultra-550b-a55b`.
- **Prices** in `/v1/models` are per-token decimal strings. That's useful, but undocumented.
- **The `.env` copied from the console** had CRLF line endings and leading spaces.
- **Transient 502:** one Token Factory 502 during our 200-task run made one clean commit fail closed (by design, but it's the availability cost of an LLM judge).

**Suggestions:** publish expected latency and cold-start behavior per model, or offer a warm tier for small models. Make model ID casing consistent. Document the pricing fields. Offer an account-level spend limit or alert: our proxy can cap only the traffic that goes through it.

### 8. Install
The NemoClaw installer clones from GitHub. During a GitHub slowdown (codeload at about 14 KB/s while npm ran at 7.8 MB/s), install was blocked with no fallback. The memory preflight text was self-contradictory: "detected 12 vCPU / 7.6 GiB; recommended 4 vCPU / 8 GiB".

## Bottom line
NemoClaw and OpenShell gave us the two things a safety layer needs: a sandbox whose only exit is inference, and a hook that sees every tool call. Token Factory's Nemotron models filled three distinct roles cheaply: the whole project, including more than 250 live agent runs, five 200-task pipeline runs and every experiment, cost about $18.40 of Token Factory credit (proxy log, 2026-10-30). Most of our time went to sandbox lifecycle recovery on WSL and to undocumented `inference.local` and plugin behavior. Fixing items 1, 2 and 4 would have saved us about two days.
