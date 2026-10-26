# Escrow: status (2026-10-26)

**Core claim:** *"The only non-inference exit is verified, and inference goes only to Nebius as the processor."* Proven end to end for the deterministic parts. See below.

Spend so far: **~$3.97 of the $15 cap** (phase 2 used ~$2.74; a live agent run is ~$0.04–0.08) (`npm run spend:show`). Each OpenClaw agent model call re-sends a ~25k-token system prompt, about $0.008 per call on Nemotron Super.

## Done and proven (evidence in `evidence/`)

| Milestone | What | Proof |
|---|---|---|
| M0 | Model IDs and prices from Token Factory; `lib/spend-guard` (cap $15, CREDIT_EXPIRY, 20 runs per UTC day, fail-closed, unit-tested) | `docs/models.md`, `npm test` |
| Spend-cap gate | `proxy/` on 127.0.0.1:8000 is the **only** holder of `TF_API_KEY`. Both the agent and Escrow go through it. 402 at the cap. Fail closed on missing, corrupt, or tampered `spend.json` | `evidence/spend-cap.md` (cap $0.001 → agent and Escrow both 402; direct Token Factory call from the sandbox fails; the key isn't in the repo, host state, or sandbox, and even the proxy token isn't in the sandbox) |
| M1 | NemoClaw v0.0.137 / OpenShell 0.0.116, sandbox `escrow`, Nemotron Super via the proxy. Non-interactive onboard | `evidence/m1-nemoclaw.md` |
| M2 | `plugins/escrow-hook`: `before_tool_call` loads **inside** the sandbox, logs full params, blocks `exec` | `evidence/m2-hook.md` |
| M3 | Egress lockdown: only `inference.local` (→ host gateway → proxy) | `evidence/egress.md` (example.com, DNS, direct Token Factory, raw TCP and UDP, `--noproxy` all fail; inference succeeds) |
| M4 | Host-side **pull** sender over the exec channel. No listening port, so no new route | `evidence/m4-sender.md` |
| M5 | **GO.** The hook sees full params for exec, write/edit, and message | `decision.md` |
| M6 | In-memory per-session transactions + shadow FS via hook param rewrite; commit/abort; default-deny tool policy; self-protection | `evidence/m6-txn.md` |
| M7 | `escrow_send_email` / `escrow_write_external` enqueue. The outbox is written only on a verified commit. The host re-verifies, then sends | `evidence/m7-outbox.md` |
| M8 | Exact-match + canary tier, plus tier-2 fuzzy canary fingerprints; 5 canary unit scenarios + FERPA R1/R2/R3; 6 live leak scenarios blocked; a forged outbox record rejected by the host | `evidence/m8-canary.md` |

### Session-level verification phase (2026-10-25)

| Step | What | Proof |
|---|---|---|
| 0a | Dashboard forward rebound to `127.0.0.1` (was `0.0.0.0`); WSL browser still reaches it | `evidence/housekeeping.md`, `scripts/dashboard-loopback.sh` |
| 0b | `scripts/up.sh` re-applies the egress policy every run. **rebuild preserves** the live policy (source); **onboard resets** it to the tier default (confirmed live). | `evidence/housekeeping.md` |
| 0c | Proxy stop status configurable, now **defaults to 429 + Retry-After** (avoids OpenClaw's 10 min–24 h billing lockout that 402 triggers); `scripts/backoff.py` shows/clears the SQLite backoff | `evidence/housekeeping.md` |
| 1 | Baseline (per-call) vs escrow (session) arms, toggleable per scenario | `lib/escrow/modes.ts`, step 5 table |
| 2 | Fingerprint tier **R4**: identity + value facts matched across the whole session | `evidence/step5-scenarios.md` (0 FP on 2.59M-char corpus) |
| 3 | Super judge **R5**: deterministic tiers first, then Nemotron Super; fail closed | `evidence/step4-killer.md`; Super limits 262144 ctx / 200k TPM, ~$0.0027 per 9k-tok call measured |
| 4 | Killer scenario: agent spreads a score across 3 messages, and the "extra exam time" paraphrase — baseline leaks both, escrow blocks at commit | `evidence/step4-killer.md` |
| 5 | 10 scenarios × both arms: **escrow correct on all 10**, baseline leaks 4 | `evidence/step5-scenarios.md` |

`npm test`: **79 passing**. `npm run typecheck` is clean, with the plugin checked against the real `openclaw@2026.9.2` types.

### Phase 2 (2026-10-26): live agent end to end, contract, skills, event stream

| Step | What | Proof |
|---|---|---|
| 6 | **Event stream + runner API.** `harness/server.ts`: WS `/events` (tool call, shadow write, per-tier verdict with ms, judge call, commit/abort, outbox send, every model call with model/role/latency/tokens/cost) and `POST /api/runs {scenario, arm}` → live run, or cached replay flagged `cached: true` (explicit, or auto-fallback when the proxy/sandbox is unavailable). Proven live (K1 blocked, S1 released) and cached (both modes) | `evidence/p6-events-api.md` |
| 5 | **Minimal skills.** Course-policy memory (`MEMORY.md`) + `regrade` + `extension` skills, seeded into the workspace; the hook protects memory, skills, records, roster from agent writes (live check: all 3 rewrites blocked). S1/S2 run end to end in both arms: skill → roster/record → gradebook/note (shadow) → email the student only → all tiers pass → delivered | `evidence/p5-skills.md` |
| 4 | **Ultra task contract.** Ultra drafts (recipients, targets, actions, data scope); the run waits for approve/reject via the control API (`harness/server.ts`); the hook enforces it and a breach poisons the commit (`C1-contract`). C1: injected "also email the newsletter" passes every verification tier, **delivered without a contract, blocked with one**; a rejected contract never starts the agent | `evidence/p4-contract.md` |
| 3 | **Judge reliability.** Live Super judge, 5× each on 4 paraphrase leaks (incl. the live agent's own K1/K2 texts) + 3 clean controls: **0/20 misses, 0/15 false positives** (also 0/20 at temperature 0.6). Self-consistency not needed; built and measured (2 votes = 2× cost, +~0.1–0.2 s p90) | `evidence/p3-judge-reliability.md` |
| 2 | **Real OpenClaw agent end to end, both arms.** 10 scripted scenarios: agent made exactly the scripted calls 20/20, and **all 20 outcomes match the pipeline-only table** (same verdict, same tier). Killer, agent-composed (agent reads records, writes the leak itself): baseline leaks both, escrow blocks both via R5 (judge now runs **inside the sandbox** via inference.local). 24 transcripts saved as the cached-run fallback | `evidence/p2-live-agent.md`, `evidence/runs/` |
| 1 | **Live sandbox restored.** Root cause of the 10-25 outage was a poisoned NemoClaw state volume (`openclaw.json` owned by uid 1000, mode 600), not memory. destroy → onboard --fresh → onboard --resume → `up.sh`. Egress re-verified: example.com, DNS, direct Token Factory, raw TCP/UDP all fail; inference.local works | `evidence/p1-restore.md` |

**Never run `nemoclaw rebuild` before the deadline.** Recovery recipe if the sandbox wedges: `evidence/p1-restore.md`.

## Guarantees (honest)

* **Deterministic:** egress lockdown (OpenShell, outside the agent); spend cap (host proxy, outside the sandbox); tier-1 exact and canary match including base64/hex; all-or-nothing commit; host-side re-verification of every outbox record.
* **Deterministic algorithm, best-effort coverage:** tier-2 fuzzy canary (edit distance ≤ 25%). Measured false-positive margin: nearest benign text is at distance 7–8 against a budget of 3–4.
* **Best-effort (now built):** paraphrase + cross-message leaks via the Nemotron Super judge (R5). Caught the "extra exam time" paraphrase and the split-score scenario; observed occasional misses on pure paraphrase (~1/5 before prompt tuning) — the deterministic tiers remain the guarantee, and judge failure/timeout blocks (fail closed).
* **Still not caught:** short generic values (grade letters alone); a canary deliberately **split with filler between the halves** (session-join reconstructs only contiguous fragments) — documented in `lib/escrow/escrow.test.ts` and `evidence/step5-scenarios.md`.

## Things found along the way (also in `feedback.md`)

* LLM-garbled base64 slipped past exact match (live S3). That drove tier 2.
* OpenClaw re-runs a plugin's `register()` on every agent run, so plugin state must be a process singleton.
* The gradebook false positive led to `trustedTargets` (R2), with typed recipients so there's no prefix-trust bypass.
* `inference.local` L7 path rules don't restrict recognized inference paths. The proxy is the real path allowlist.
* Every 402 sends OpenClaw into a 10 min → 24 h billing backoff, so cached mode pauses the agent past the stop itself.

## Needs your attention (manual)

1. **Nebius account-level spend limit or alert.** The proxy can't see usage of the key from anywhere else (console playground, other machines). If Token Factory offers one, set it at or below your promo credit amount.
2. **Host port `0.0.0.0:18789`.** That's NemoClaw's OpenClaw dashboard forward, token-protected. It's inbound, not a sandbox exit, but you may want it loopback-only on the demo machine.
3. **Git identity:** I set a repo-local `user.name=swetha`, `user.email=smv5809@psu.edu` so commits would work. Change it if you prefer something else.
4. **Third-party notice:** accepted on your instruction for the NemoClaw install.

## Operational notes

* Restart the proxy: `proxy/run.sh`. Health: `curl localhost:8000/healthz`.
* Control API + event stream: `node harness/server.ts` (127.0.0.1:8790). Record the stream: `node harness/ws-record.ts out.jsonl`.
* Live scenario batch: `node harness/run-live.ts [ids] [--arms baseline,escrow] [--no-contract]`, then `node harness/report-live.ts`.
* Exec into the sandbox **without** NemoClaw's global lock: `openshell sandbox exec -n escrow --no-tty -- <cmd> < /dev/null`.
* Reinstall the plugin: `scripts/install-plugin.sh`. `gateway restart` often reports a readiness timeout on this machine even when the gateway is fine. Check `scripts/sbx.sh 'openclaw gateway status | grep Connectivity'`.
* Reseed data and policy: `node scripts/seed-sandbox.ts`. Agent turn: `scripts/ag.sh <session> <tag> "<message>"`. Drain: `node sender/main.ts --once`.
* **Re-apply the egress policy after any `nemoclaw onboard` or `rebuild`:** `openshell policy set escrow --policy policies/escrow-sandbox.yaml --wait`. NemoClaw may restore its base policy. This hasn't been tested yet.

## Next

1. **UI** (React Flow + particles + Framer Motion) on `ws://127.0.0.1:8790/events` and the runner API. The cached runs in `evidence/runs/` cover all 15 scenarios × both arms (C1 escrow only + baseline + no-contract control).
2. Let the user **edit** an Ultra contract draft before approving (today it's approve/reject).
3. **Ultra-generated attack scenarios** as a regression suite; re-measure the judge on them (step 3 is 0/20 on our own set, 95% upper bound ~15%).
4. **Nano read labeling** (tag `read` results that touch records). Must be host-side: `inference.local` pins in-sandbox calls to Super.
5. Known gaps (unchanged): canary split with filler between the halves; short generic values; `apply_patch` envelope into the shadow FS.
