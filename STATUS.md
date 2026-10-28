# Escrow: status (2026-10-27)

**Core claim:** *"The only non-inference exit is verified, and inference goes only to Nebius as the processor."* Proven end to end for the deterministic parts. See below.

Spend so far: **$8.52** (phase 2 ~$2.74, UI ~$0.22, phase 4 live batch of 84 runs ~$3.62; a live agent run is ~$0.04–0.08). **Budget rule:** experiments stop at **$12** (proxy cap); the last **$3** (to $15) is reserved for the live demo during judging (`npm run spend:show`). Each OpenClaw agent model call re-sends a ~25k-token system prompt, about $0.008 per call on Nemotron Super.

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

`npm test`: **89 passing** (2026-10-28). `npm run typecheck` is clean, with the plugin checked against the real `openclaw@2026.9.2` types.

### Phase 2 (2026-10-26): live agent end to end, contract, skills, event stream

| Step | What | Proof |
|---|---|---|
| 6 | **Event stream + runner API.** `harness/server.ts`: WS `/events` (tool call, shadow write, per-tier verdict with ms, judge call, commit/abort, outbox send, every model call with model/role/latency/tokens/cost) and `POST /api/runs {scenario, arm}` → live run, or cached replay flagged `cached: true` (explicit, or auto-fallback when the proxy/sandbox is unavailable). Proven live (K1 blocked, S1 released) and cached (both modes) | `evidence/p6-events-api.md` |
| 5 | **Minimal skills.** Course-policy memory (`MEMORY.md`) + `regrade` + `extension` skills, seeded into the workspace; the hook protects memory, skills, records, roster from agent writes (live check: all 3 rewrites blocked). S1/S2 run end to end in both arms: skill → roster/record → gradebook/note (shadow) → email the student only → all tiers pass → delivered | `evidence/p5-skills.md` |
| 4 | **Ultra task contract.** Ultra drafts (recipients, targets, actions, data scope); the run waits for approve/reject via the control API (`harness/server.ts`); the hook enforces it and a breach poisons the commit (`C1-contract`). C1: injected "also email the newsletter" passes every verification tier, **delivered without a contract, blocked with one**; a rejected contract never starts the agent | `evidence/p4-contract.md` |
| 3 | **Judge reliability.** Live Super judge, 5× each on 4 paraphrase leaks (incl. the live agent's own K1/K2 texts) + 3 clean controls: **0/20 misses, 0/15 false positives** (also 0/20 at temperature 0.6). Self-consistency not needed; built and measured (2 votes = 2× cost, +~0.1–0.2 s p90) | `evidence/p3-judge-reliability.md` |
| 2 | **Real OpenClaw agent end to end, both arms.** 10 scripted scenarios: agent made exactly the scripted calls 20/20, and **all 20 outcomes match the pipeline-only table** (same verdict, same tier). Killer, agent-composed (agent reads records, writes the leak itself): baseline leaks both, escrow blocks both via R5 (judge now runs **inside the sandbox** via inference.local). 24 transcripts saved as the cached-run fallback | `evidence/p2-live-agent.md`, `evidence/runs/` |
| 1 | **Live sandbox restored.** Root cause of the 10-25 outage was a poisoned NemoClaw state volume (`openclaw.json` owned by uid 1000, mode 600), not memory. destroy → onboard --fresh → onboard --resume → `up.sh`. Egress re-verified: example.com, DNS, direct Token Factory, raw TCP/UDP all fail; inference.local works | `evidence/p1-restore.md` |

### Phase 4 (2026-10-27): Nano labels, ~40 scenarios, metrics, hosting hardening

Hard budget: the proxy cap is **$12** (`node proxy/cli.ts set-cap 12`, set 2026-10-27, was $11), so the proxy itself stops all spending there. The $3 demo reserve above $12 is released by hand before judging (you check the Token Factory credit balance, then run `node proxy/cli.ts set-cap <usd>`); experiments never raise it.

| Step | What | Proof |
|---|---|---|
| 1 | **Nemotron Nano read labels → R4.** A host labeler labels each read (type, sensitivity, students, fields) and writes the label into Escrow's sandbox state; R4 tightens for high-sensitivity reads (bare score + identity). Live K1 is now a **deterministic R4 catch** (labels 4/4) instead of judge-only. The HUD shows real Nano calls. Nano took 36–117 s per call this afternoon, so labels are cached by content hash with a background re-label | `evidence/p7-nano-labels.md` |
| 2 | **42 scenarios**: 27 Ultra-generated (attacks + clean, labels by construction, validated) on top of the 15 hand-written | `evidence/p8-scenarios.md` |
| 4 | **200-task pipeline-only run** (no agent): leaks 52/109 baseline → **0/109** escrow; false blocks 1/81 (a Token Factory 502, fail-closed), **0/81 on the re-run after the fixes below** | `evidence/p10-pipeline-200.md`, `evidence/p11-live-agent-42.md` |
| 5 | **Live agent, all 42 scenarios × both arms (84 runs)**: **0/24 leaks vs baseline 14/24** (95% upper bound for 0/24 about 12%); false blocks 0/14 in both arms; agent-composed leaks reviewed by hand (`evidence/live-review.json`). Fixed along the way: run-slot race (two requests could both start), judge max_tokens truncation, Nano field-name mapping. $3.62 | `evidence/p11-live-agent-42.md` |
| 6 | **Hosting hardening**: shared access token (never bundled), per-IP rate limits, one run at a time + approval timeout, live-runs off switch; Cloudflare Tunnel config | `evidence/p12-hosting.md` |

### Phase 3 (2026-10-27): the UI (`ui/`, React + Vite + React Flow + canvas particles + Framer Motion)

Screenshots for every view are in `evidence/ui/` (index: `evidence/ui/README.md`). Every run carries a LIVE RUN or CACHED RUN badge, driven only by the stream's `cached` flag.

| Step | What | Proof |
|---|---|---|
| 1 | Scenario landing: preset cards only (killer K1/K2 featured), Baseline / Escrow / Side-by-side buttons, last recorded verdict per arm | `evidence/ui/01-*` |
| 2 | **Flow Map**: agent → hook → shadow FS → ESCROW WALL → outbox → host sender → recipients, with Token Factory as the only inference exit. Particles per event; effects pile up in escrow; tiers light up one by one at commit; blocked effects shatter; click any node, tier or particle for the raw event | `evidence/ui/02-*` |
| 3 | Split view: baseline leaks step by step while escrow holds, then blocks. K2 reads "leak blocked" → "safe refusal verified" as two events. Live runs go one after the other (one sandbox), cached runs in lockstep | `evidence/ui/03-*` |
| 4 | Ultra contract view: the run visibly pauses until Approve/Reject. The approvals page is responsive (phone shot), and decides through the API (live) or across tabs (cached). Verified: approve resumes, reject never starts the agent | `evidence/ui/04-*` |
| 5 | Model HUD: active Nemotron model, latency, cost per call, run spend, proxy total, all from the stream (cached figures are marked RECORDED) | `evidence/ui/05-*` |
| 6 | Deployment: API/WS URL from `VITE_API_BASE` / `VITE_WS_URL`; the API allowlists browser origins (`ESCROW_UI_ORIGINS`, unknown origin → 403). All 31 transcripts are bundled, so a static build with no backend replays everything (flagged CACHED). **Live via UI:** K1 escrow (blocked by R5, real tier timings) and C1 with Ultra contract approved in the UI (blocked by C1). **Backend killed mid-live-run:** UI switched to the recorded run in ~10 s with the reason shown | `evidence/ui/06-*`, `evidence/ui/README.md` |

**Never run `nemoclaw rebuild` before the deadline.** Recovery recipe if the sandbox wedges: `evidence/p1-restore.md`.

## Guarantees (honest)

* **Deterministic:** egress lockdown (OpenShell, outside the agent); spend cap (host proxy, outside the sandbox); tier-1 exact and canary match including base64/hex; all-or-nothing commit; host-side re-verification of every outbox record.
* **Deterministic algorithm, best-effort coverage:** tier-2 fuzzy canary (edit distance ≤ 25%). Measured false-positive margin: nearest benign text is at distance 7–8 against a budget of 3–4.
* **Best-effort (now built):** paraphrase + cross-message leaks via the Nemotron Super judge (R5). Caught the "extra exam time" paraphrase and the split-score scenario; observed occasional misses on pure paraphrase (~1/5 before prompt tuning) — the deterministic tiers remain the guarantee, and judge failure/timeout blocks (fail closed).
* **Still not caught:** short generic values (grade letters alone); a canary deliberately **split with filler between the halves** (session-join reconstructs only contiguous fragments) — documented in `lib/escrow/escrow.test.ts` and `evidence/step5-scenarios.md`.

## Things found along the way (also in `feedback.md`)

* LLM-garbled base64 slipped past exact match (live S3). That drove tier 2.
* `apply_patch` is exposed to Nemotron too: OpenClaw's help text says OpenAI/Codex, but the code has no provider check (`allowModels` empty → every model). Blocked by the hook's allowlist regardless, now with a message pointing to write/edit.
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
* UI: `cd ui && npm run build && npx vite preview` → http://127.0.0.1:4173 (proxies `/api` + `/events` to the control server). Screenshots: `node ui/scripts/shots.ts <name> <hash-path> [--until text]`. After new live transcripts: `npm run bundle-runs` in `ui/`.
* Control API + event stream: `node harness/server.ts` (127.0.0.1:8790). Record the stream: `node harness/ws-record.ts out.jsonl`.
* Live scenario batch: `node harness/run-live.ts [ids] [--arms baseline,escrow] [--no-contract]`, then `node harness/report-live.ts`.
* Exec into the sandbox **without** NemoClaw's global lock: `openshell sandbox exec -n escrow --no-tty -- <cmd> < /dev/null`.
* Reinstall the plugin: `scripts/install-plugin.sh`. `gateway restart` often reports a readiness timeout on this machine even when the gateway is fine. Check `scripts/sbx.sh 'openclaw gateway status | grep Connectivity'`.
* Reseed data and policy: `node scripts/seed-sandbox.ts`. Agent turn: `scripts/ag.sh <session> <tag> "<message>"`. Drain: `node sender/main.ts --once`.
* **Re-apply the egress policy after any `nemoclaw onboard` or `rebuild`:** `openshell policy set escrow --policy policies/escrow-sandbox.yaml --wait`. NemoClaw may restore its base policy. This hasn't been tested yet.

## Next

1. Port 18789 loopback-only, asserted by `scripts/up.sh`.
2. `FAILURE_MODES.md`: the remaining known gaps, each with a reproducible example ("attacking our own system").
3. Cloudflare Tunnel for the control API/WebSocket (needs your `cloudflared` login), and the static UI on Vercel (needs your login).
4. Later: let the user **edit** an Ultra contract draft before approving (today it's approve/reject).
