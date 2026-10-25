# Escrow: status (2026-10-25)

**Core claim:** *"The only non-inference exit is verified, and inference goes only to Nebius as the processor."* Proven end to end for the deterministic parts. See below.

Spend so far: **~$1.20 of the $15 cap** (`npm run spend:show`). Each OpenClaw agent model call re-sends a ~25k-token system prompt, about $0.008 per call on Nemotron Super.

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

`npm test`: **68 passing**. `npm run typecheck` is clean, with the plugin checked against the real `openclaw@2026.9.2` types.

### ⚠️ Live sandbox is DOWN (needs your attention)

Testing 0b (does rebuild reset egress?) required a `nemoclaw escrow rebuild`. On this WSL2 + Docker Desktop box (7.6 GiB; NemoClaw wants ≥ 8), the rebuild's backup phase failed and left the sandbox in **Error** phase. No non-destructive recovery worked (`recover`, `doctor --fix`, stop/start, gateway-service restart, container restart). A fresh `onboard --fresh --recreate-sandbox` (with `NEMOCLAW_RECREATE_WITHOUT_BACKUP=1`) rebuilt the image and reached **Ready**, but the OpenClaw gateway main-process **crashes on start** (exit 1) and NemoClaw's managed startup "does not settle" — the same symptom M1 hit, made permanent here. Root causes are all environmental: Docker Desktop's `docker info` takes ~1.4–2.5 s and trips NemoClaw's 5 s preflight timeout; the box is under-provisioned.

**What this means:** steps 4–5 were proven against the **real verification pipeline with the live Super judge** (the new logic), but the OpenClaw **agent layer was not re-exercised** this phase. That layer was proven live in M2/M5/M6/M7/M8 (agent calls tools → hook intercepts → commit blocks), all committed with evidence.

**To restore the live agent:** raise Docker Desktop to ≥ 4 CPU / ≥ 8 GiB (Settings → Resources), then:
```
scripts/up.sh                       # proxy, policy, dashboard, backoff reset
# if the sandbox won't leave Error: onboard fresh (destroys workspace; re-seeded by scripts)
for p in $(pgrep -f "forward service escrow"); do kill $p; done   # free 18789 first
NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 COMPATIBLE_API_KEY=$(grep PROXY_TOKEN .env|cut -d= -f2-|tr -d "\r ") \
  NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 NEMOCLAW_PROVIDER=custom \
  NEMOCLAW_ENDPOINT_URL=http://localhost:8000/v1 NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b \
  NEMOCLAW_POLICY_TIER=restricted nemoclaw onboard --fresh --recreate-sandbox --non-interactive --name escrow
scripts/up.sh                       # re-lock egress, install plugin, seed data
```
If the gateway still won't settle, the box needs more resources or a clean `nemoclaw uninstall` + reinstall.

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
* Reinstall the plugin: `scripts/install-plugin.sh`. `gateway restart` often reports a readiness timeout on this machine even when the gateway is fine. Check `scripts/sbx.sh 'openclaw gateway status | grep Connectivity'`.
* Reseed data and policy: `node scripts/seed-sandbox.ts`. Agent turn: `scripts/ag.sh <session> <tag> "<message>"`. Drain: `node sender/main.ts --once`.
* **Re-apply the egress policy after any `nemoclaw onboard` or `rebuild`:** `openshell policy set escrow --policy policies/escrow-sandbox.yaml --wait`. NemoClaw may restore its base policy. This hasn't been tested yet.

## Next

1. **Tier 3: paraphrase adjudication** with Nemotron Super through `lib/tf-client.ts`. Label it best-effort and log its known misses.
2. **Nemotron Ultra task contract:** written before the run, approved by the user, and enforced at commit (allowed recipients and targets per task). Plus Ultra-generated attack scenarios as a regression suite.
3. **Nemotron Nano read labeling:** tag `read` results that touch records, so commit knows which sessions handled which students.
4. Cross-effect check (concatenated session text), `apply_patch` envelope parsing into the shadow FS, a cached-mode demo path (replayed responses when the proxy returns 402).
5. Regrade, extension, and grade-dispute skills + course-policy memory for the TA agent.
6. UI (React Flow + particles + WebSockets) fed from `/sandbox/.escrow/audit.jsonl` and `state/sent.log`.
