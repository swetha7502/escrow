# Friction log (Nebius / NVIDIA / NemoClaw / OpenShell)

## 2026-10-20 — Token Factory API key pending approval
- **What happened:** Couldn't get a Nebius Token Factory API key yet; the request is waiting on approval.
- **Workaround:** Temporarily using NVIDIA's hosted API (build.nvidia.com, `NVIDIA_API_KEY`) as the inference provider. The sandbox egress policy is written so moving the allowlisted host to `api.tokenfactory.nebius.com` takes a one-line change. The M3 egress proof will be re-run against Token Factory once `TF_API_KEY` arrives. The final evidence will show Token Factory.

## 2026-10-23 — Token Factory key arrived; NVIDIA-hosted fallback dropped
- **What happened:** Got `TF_API_KEY`. The project moved to Nebius Token Factory directly. The NVIDIA build.nvidia.com workaround above is retired.
- **Friction:** The `.env` I'd pasted from the console had CRLF line endings and leading spaces on each line, and naive `source .env` / `cut` broke on the `\r`.
- **Workaround:** `lib/env.ts` trims whitespace and `\r`. Shell snippets use `tr -d '\r '`.

## 2026-10-23 — Token Factory /v1/models pricing is per-token strings
- **What happened:** `GET /v1/models?verbose=true` returns `pricing.prompt`/`pricing.completion` as decimal strings in USD per token, e.g. `"0.0000003"`. This is handy, but undocumented in the OpenAI-compat shape. Nemotron IDs are inconsistent in casing (`nvidia/nemotron-3-super-120b-a12b` vs `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` vs `nvidia/Nemotron-3-Ultra-550b-a55b`).
- **Workaround:** Copied exact IDs and prices into `docs/models.md`. The proxy refuses any model not in that table.

## 2026-10-23 — GitHub clone stalled during NemoClaw prep
- **What happened:** `git clone --depth 1 --branch lkg https://github.com/NVIDIA/NemoClaw.git` hung with no progress for over 2 minutes, and codeload ran at ~14 KB/s. npm was fast (7.8 MB/s) at the same time. Ten minutes later the same tarball came down at 12 MB/s.
- **Workaround:** Waited and retried. The installer clones from GitHub, so a GitHub slowdown blocks install entirely. There's no mirror or tarball fallback.

## 2026-10-23 — NemoClaw non-interactive onboard: "OpenClaw startup did not settle"
- **What happened:** `nemoclaw.sh` with `NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_PROVIDER=custom` built the sandbox (~13 min image build on WSL2 + Docker Desktop at 7.6 GiB) and verified inference through `inference.local`. Then it failed at [8/8] with `OpenClaw startup did not settle for 'escrow'` and installer exit 1. Right after, `nemoclaw escrow doctor` reported `Docker daemon: spawnSync docker ETIMEDOUT`, but a manual `docker ps` returned in 0.3s.
- **Also:** The preflight warning text is self-contradictory: "detected 12 vCPU / 7.6 GiB; recommended 4 vCPU / 8 GiB". The real shortfall is only memory.
- **Workaround:** Waited for the sandbox to finish starting. `nemoclaw escrow status` then showed it healthy. Ran `nemoclaw onboard --resume --non-interactive` with the same env.

## 2026-10-23 — Custom endpoint docs vs. actual topology
- **What happened:** The custom-endpoint docs talk about `host.openshell.internal` rewriting and bridge reachability. On this install (OpenShell 0.0.116, Docker driver), the OpenShell gateway runs as a native host process (`openshell-gateway` on 127.0.0.1:8080) and calls the custom endpoint from host loopback. The sandbox uses `inference.local`. The docs don't say clearly which topology you'll get.
- **Workaround:** Kept the Escrow spend proxy bound to 127.0.0.1 only. Confirmed with `ss -ltnp`.

## 2026-10-23 — `openshell sandbox exec -- openclaw agent` hangs, `nemoclaw <name> exec` works
- **What happened:** `openshell sandbox exec -n escrow --no-tty -- openclaw agent -m ...` hung until timeout (300s, then 180s). It wrote nothing to the OpenClaw log and made no inference call. `nemoclaw escrow exec --no-stdin -- openclaw agent ...` returned in ~9s. Simple commands like `openclaw gateway status` worked under both.
- **Also:** `nemoclaw escrow logs` and `doctor` intermittently report "Docker daemon is not reachable" because `docker info` takes ~5s on Docker Desktop/WSL2, while `docker ps` takes 0.3s. `openshell logs escrow` works as a fallback.
- **Workaround:** Use `nemoclaw escrow exec --no-stdin` for agent turns, and `openshell logs` for logs.

## 2026-10-23 — inference.local L7 rules don't restrict recognized inference paths
- **What happened:** The policy for `inference.local:443` allowed only `GET /v1/models` and `POST /v1/chat/completions`. From the sandbox, `GET /v1/files` was denied (403, OPA), but `POST /v1/embeddings` was forwarded to the configured provider endpoint. Our proxy logged it and returned 404. The managed inference router seems to handle known inference routes before the L7 rules apply. This isn't documented.
- **Workaround:** The host-side Escrow proxy enforces the real path allowlist (chat completions only).

## 2026-10-23 — Installing a local TypeScript OpenClaw plugin in the sandbox
- **What happened:** `openclaw plugins install /sandbox/escrow-hook --force` refused a TS entry: "package install requires compiled runtime output for TypeScript entry ./index.ts". The docs' quick-start uses `./index.ts` with `--link`. The next attempt failed with `Plugin "escrow-hook" requires capability consent`, even though the plugin is hook-only and declares no capabilities (`capabilityCount: 0`).
- **Also:** `openshell sandbox upload <dir> /sandbox/escrow-hook` nests the dir (`/sandbox/escrow-hook/escrow-hook`). `openshell sandbox download` refuses paths outside `/sandbox`, such as `/tmp`.
- **Workaround:** Compile to `dist/` with `tsc` and point `openclaw.extensions` at `./dist/index.js`. Pass `--accept-capabilities`. See `scripts/install-plugin.sh`.

## 2026-10-23 — 402 from the spend proxy puts OpenClaw into a long billing backoff
- **What happened:** After the proxy returned 402 (cap reached), OpenClaw kept rejecting agent turns with "Inline API key for provider "inference" is temporarily disabled after a provider auth/billing failure. Retry after about 1 minute". That held for ~12 minutes, across a gateway restart, even after the cap was raised. Source: billing backoff is 10 min doubling to 24 h. The "about 1 minute" message is misleading.
- **Workaround:** Wait it out. Document that cached mode pauses the agent for at least the backoff window.

## 2026-10-23 — Plugin `api.resolvePath` not usable for tool paths; gateway restart readiness timeout
- **What happened:** In `before_tool_call`, `api.resolvePath("course/notes/x.md")` didn't return a usable absolute path (NemoClaw's own plugin has a comment about the same thing). The `write` tool sends `{path, content, workdir}`, and relative paths resolve against `workdir`.
- **Also:** `nemoclaw escrow gateway restart` failed twice with "readiness did not pass … timeout", but the gateway was up and serving the reloaded plugin seconds later (confirmed from the gateway log). There's no flag to lengthen the readiness wait.
- **Workaround:** Resolve against `params.workdir` (else `/sandbox/.openclaw/workspace`). After a restart "failure", check the gateway log for the plugin's load line.

## 2026-10-23 — OpenClaw calls a plugin's register() once per agent run
- **What happened:** In the sandbox gateway (single pid), `register(api)` for our plugin ran again at the start of each `openclaw agent` run. Any state created in `register()` (our per-session transaction manager) was silently replaced, so a multi-turn session lost its open transaction. The hooks docs say "Keep register(api) synchronous and register handlers there", but don't say it can be called repeatedly in one process.
- **Workaround:** Keep long-lived plugin state in a module/`globalThis` singleton, not in `register()` closures.

## 2026-10-25 — Rebuild/onboard repeatedly wedged the sandbox into Error phase on WSL
- **What happened:** `nemoclaw escrow rebuild --yes` failed three ways in a row: (1) preflight refused because our loopback dashboard forward held port 18789 ("Dashboard port 18789 is held by a forward not owned by sandbox"); (2) with the forward stopped, "Failed to back up sandbox state"; the sandbox was left in **Error** phase. From Error, `nemoclaw recover`, `doctor --fix`, `openshell sandbox stop/start`, a gateway-service restart, and a `docker restart` of the container all failed to clear the phase, even though the container stayed "Up (healthy)" and served inference. OpenShell gates `exec`/`agent` on phase=Ready, so the sandbox was unusable.
- **Recovery:** `nemoclaw onboard --fresh --recreate-sandbox` — but it first refused ("changed during backup failure; recreate journal needs recovery"), then needed `NEMOCLAW_RECREATE_WITHOUT_BACKUP=1`, then failed preflight on a transient `docker info` ETIMEDOUT (5s preflight timeout vs ~1.4–2.5s `docker info` latency), then resumed successfully once Docker was warm.
- **Takeaway:** On WSL/Docker Desktop, a rebuild is fragile and can strand the sandbox in Error with no non-destructive way out. Prefer `onboard --fresh` recovery, and run `up.sh` after. The dashboard-loopback forward must be stopped before any rebuild/onboard (it owns 18789). Warm `docker info` before onboarding.

## 2026-10-26 — `onboard --fresh --recreate-sandbox` reuses a poisoned state volume (root cause of the 10-25 outage)
- **What happened:** NemoClaw keeps OpenClaw state in a named Docker volume (`nemoclaw-openclaw-state-v1-<name>`). `onboard --fresh --recreate-sandbox` recreates the container but keeps the volume. The failed 10-25 rebuild had left `openclaw.json` in it owned by uid 1000 (`node`), mode 600. Managed startup then failed with `Managed startup root application failed ... EACCES: permission denied, open '/sandbox/.openclaw/openclaw.json'` (root-apply lacks DAC override), and the gateway (running as `sandbox`) couldn't read its config, so it crashed on start. We had misattributed this to low memory.
- **Workaround:** Back up the volume, `nemoclaw <name> destroy --yes --no-cleanup-gateway` (this removes the state volume), `onboard --fresh`, then `onboard --resume` when "OpenClaw startup did not settle" (the gateway was actually up; the settle check tripped on `spawnSync docker ETIMEDOUT`). Suggest: `--fresh` should either wipe or ownership-check the state volume, and the EACCES should name the owner it found.
- **Also:** after a failed onboard, NemoClaw blocks every further onboard ("identity-bound recovery record is unresolved") until `destroy` runs, which is right but means `--fresh` alone can't recover.

## 2026-10-26 — `inference.local` rewrites the model and drops custom headers
- **What happened:** From inside the sandbox, a chat request for `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` to `https://inference.local/v1/chat/completions` was answered by `nvidia/nemotron-3-super-120b-a12b` (the route's configured model). Our `x-escrow-run` header didn't reach the host proxy.
- **Workaround:** In-sandbox model calls (the Super judge) are fine with this. Multi-model roles (Ultra contract, Nano labels) run host-side through the spend proxy. Spend accounting groups in-sandbox calls as anonymous runs.

## 2026-10-26 — `nemoclaw exec` holds a global host lock for the whole command
- **What happened:** While `nemoclaw escrow exec -- openclaw agent …` ran a ~30 s agent turn, every other `nemoclaw … exec` (our host sender, an audit-log read) waited, then failed with `Failed to acquire lock on ~/.nemoclaw-portable-host.lock after 120 retries`. That rules out streaming sandbox state while the agent works.
- **Workaround:** `openshell sandbox exec -n <name> --no-tty -- …` goes straight to OpenShell's gRPC exec. It takes no NemoClaw lock, runs as the `sandbox` user, and returns in ~0.1 s (vs ~2 s). Gotcha: it forwards stdin, so a caller that leaves stdin open (Node `execFile`) hangs until timeout. Close stdin.

## 2026-10-26 — OpenClaw agent quirks seen under Escrow
- `openclaw agent --session-id P2-K1-…` lowercases the session key (`agent:main:explicit:p2-k1-…`) in plugin tool contexts. We match ids case-insensitively.
- The `read` tool can't list a directory, and with `exec` blocked the agent had no way to discover record filenames. It guessed names, then called `ask_user`, which in a non-interactive `openclaw agent` turn just fails ("⚠️ Ask User failed"). A seeded roster file fixed it.
- After an `escrow_commit` returned BLOCKED, the agent sometimes retried within the same turn with a different (clean) message and committed again. Fine for safety (each commit is verified on its own), but harnesses must report every commit, not just the last.

## 2026-10-27 — Token Factory Nemotron Nano latency: 36–117 s per tiny call (Super: 0.6 s)
- **What happened:** Around 19:38–19:45 UTC, every `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` chat completion through our proxy took 36–117 s, even "Say OK" (18 prompt tokens, 35 completion): 116.9 s, then three parallel probes at 43.9 / 74.8 / 76.1 s, then 36–65 s for 5 file labels. `nemotron-3-super-120b-a12b` answered the same probe in 0.59 s. Responses were correct (HTTP 200); it looks like queueing or a cold start. An hour later the same Nano calls took 4.0–5.9 s.
- **Impact:** Nano was meant to label each file the agent reads before commit. At 1–2 min per label that can't sit on the commit path of a ~30 s agent turn.
- **Workaround:** Nano labels are cached by file content (sha256). Course files are labeled with real Nano calls when the labeler starts. A read of a known file gets its Nano label at once, and a fresh Nano call re-labels it in the background. Commit waits at most 6 s for labels; without one, the fingerprint tier runs without the labeled tightening (labels can only add catches). Suggest: publish expected latency / cold-start behaviour per model, or offer a warm option for small models.
