# Escrow: status (2026-10-24, ~00:15 UTC)

**Core claim:** *"The only non-inference exit is verified, and inference goes only to Nebius as the processor."* Proven end to end for the deterministic parts. See below.

Spend so far: **$1.17 of the $15 cap** (`npm run spend:show`). Each OpenClaw agent model call re-sends a ~25k-token system prompt, about $0.008 per call on Nemotron Super.

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

`npm test`: 55 passing. `npm run typecheck` is clean, with the plugin checked against the real `openclaw@2026.9.2` types.

## Guarantees (honest)

* **Deterministic:** egress lockdown (OpenShell, outside the agent); spend cap (host proxy, outside the sandbox); tier-1 exact and canary match including base64/hex; all-or-nothing commit; host-side re-verification of every outbox record.
* **Deterministic algorithm, best-effort coverage:** tier-2 fuzzy canary (edit distance ≤ 25%). Measured false-positive margin: nearest benign text is at distance 7–8 against a budget of 3–4.
* **Not built / best-effort by nature:** paraphrase leaks ("Avery gets extra exam time"). Short generic values (grade letters) aren't matched. Values split across effects aren't caught.

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
