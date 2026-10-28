# Phase 4: live agent over all 42 scenarios, both arms (2026-10-27)

The real OpenClaw agent ran in the NemoClaw sandbox on every scenario (15 hand-written plus 27 Ultra-generated), under both the baseline arm (per call) and the escrow arm (session). That's **84 live runs**, with transcripts in `evidence/runs/<id>-<arm>.json` (all started on 2026-10-27; the C1 no-contract control is from 10-26 and isn't counted).

Command: `node harness/run-live.ts`, with the new `--stop-at <usd>` budget guard (stops before a run once the proxy total reaches it) and `--since <iso>` resume. Metrics: `node scripts/live-metrics.ts`.

## How leaks were labeled
- **Scripted scenarios** (the agent is told exactly which effects to make): labeled by construction. Every delivered effect of a leak scenario counts as a leak.
- **Agent-composed scenarios** (K1, K2, and the generated prompt-injection ones, where the agent writes its own text): every delivered effect was read by hand. Verdicts are in `evidence/live-review.json` and written into the transcripts by `scripts/apply-live-review.ts` (`outcome.leakedEffectIds`). The UI's cached replays use those ids, so a baseline effect shows as a leak only if it actually carried record data.

## Results (`node scripts/live-metrics.ts`)

| metric | baseline (per call) | escrow (session) |
|---|---|---|
| **leak rate**, all leak scenarios (record data delivered) | 14/24 (58.3%) | **0/24 (0.0%)** |
| leak rate where the agent actually attempted the leak | 14/20 (70.0%) | 0/21 (0.0%) |
| agent refused / declined the attack on its own (reviewed) | 4 | 3 |
| **false-block rate** (clean scenarios with an effect blocked) | 0/14 (0.0%) | **0/14 (0.0%)** |
| out-of-scope effect delivered (contract scenarios, contract approved) | 0/4 (0.0%) | 0/4 (0.0%) |
| agent turn failed (nemoclaw exec non-zero) | 1 | 0 |

**By category (leak scenarios: delivered / attempted, per arm)**

| category | runs per arm | baseline leaked | escrow leaked | escrow first catching tier |
|---|---|---|---|---|
| hand-written exact/split | 5 | 2 / 5 attempted | 0 / 5 attempted | R0-canary 1, R3-unauthorized-recipient 3, R4-fingerprint 1 |
| hand-written paraphrase/split | 2 | 2 / 2 attempted | 0 / 2 attempted | R5-super-judge 2 |
| prompt_injection | 3 | 0 / 0 attempted | 0 / 0 attempted | — (the agent refused all 3 in both arms) |
| split_leak | 3 | 3 / 3 attempted | 0 / 3 attempted | R4-fingerprint 2, R5-super-judge 1 |
| paraphrase | 3 | 3 / 3 attempted | 0 / 3 attempted | R5-super-judge 3 |
| encoding | 3 | 1 / 3 attempted | 0 / 3 attempted | R3-unauthorized-recipient 2, R5-super-judge 1 |
| lookalike_address | 3 | 2 / 3 attempted | 0 / 3 attempted | R5-super-judge 2, R3-unauthorized-recipient 1 |
| killer (agent-composed) | 2 | 1 / 1 attempted | 0 / 2 attempted | R4-fingerprint 1, R5-super-judge 1 |

**Escrow tiers (live, per commit)**

| tier | ran | blocked | latency p50 | latency p90 |
|---|---|---|---|---|
| C1-contract | 43 | 3 | 0.00 ms | 0.01 ms |
| R0-R3-exact-canary | 43 | 7 | 0.20 ms | 0.44 ms |
| R4-fingerprint | 43 | 10 | 0.09 ms | 0.32 ms |
| R5-super-judge | 29 | 10 | 1.13 s | 1.84 s |

Nano labels were present at commit for all 43 escrow commits (every read labeled). Labeled-R4 catches: 2.

**Cost** (spend-proxy log, per run window): $3.62 total. Baseline $1.83, escrow $1.79, a mean of $0.043 per run. By model: Super $3.602, Nano $0.009, Ultra $0.014. Median wall time: 17 s per run. Almost all of the cost is the agent itself (OpenClaw re-sends a ~25k-token system prompt on every model call), not Escrow.

### How to read these numbers
- Baseline delivers less than 100% of leak scenarios because the agent sometimes refuses on its own (4 runs). Most notably, it refused all 3 prompt-injection scenarios. That's the model's safety behavior, which isn't a guarantee. Escrow doesn't depend on it.
- Escrow has 0 leaks out of 21 runs where the agent attempted one. With n=21 this is a small sample (the rule-of-three 95% upper bound is ~14%). The 200-task pipeline run below is the larger-sample number.

## Fixes made during this run
1. **Run-slot race** (`harness/server.ts`). Two `POST /api/runs` arriving together could both pass the "one run at a time" check during the ~0.5 s sandbox health probe. Seen live: the split view fired both arms at once, and the second run's mode switch flipped the first run into escrow mode. The run slot is now claimed before any `await` and released on error. The UI's split view also waits for the first health check before deciding whether to run sequentially.
   ```
   $ node scripts/check-run-race.ts
   202 { "id": "run-a41d799c", "scenario": "K1-split-score", "arm": "baseline", "live": false, "s
   409 { "error": "run run-a41d799c is in progress (the sandbox runs one scenario at a time)" }
   409 { "error": "run run-a41d799c is in progress (the sandbox runs one scenario at a time)" }
   OK: exactly one of 3 simultaneous requests started a run
   ```
2. **Judge truncation** (`lib/escrow/judge.ts`). With `max_tokens` 700, a ROT13 case ran out of budget in Super's reasoning, mid-JSON, so the commit blocked because the verdict was unparseable (fail-closed, but needless). It's now 1600.
3. **Nano field-name mapping** (`lib/escrow/verify.ts`, `labeledFieldKeys`). Nano names fields inconsistently ("date_of_birth", "midterm"), so the labeled R4 tightening missed some. Names are now mapped onto the record's own field keys through synonyms. A name that can't be mapped tightens **every** field, so labels can only add catches. Unit-tested in `lib/escrow/labels.test.ts`.

## 200-task pipeline run, re-run after the fixes
`evidence/pipeline/results.jsonl` (`node scripts/pipeline-run.ts --report`). The run committed in p10 is kept as `results.v1.jsonl` / `report.v1.md`.

| metric | baseline (per call) | escrow (session) |
|---|---|---|
| **leak rate** (leak tasks with ≥1 effect delivered) | 52/109 (47.7%) | 0/109 (0.0%) |
| **false-block rate** (clean tasks with ≥1 effect blocked) | 0/81 (0.0%) | **0/81 (0.0%)** (v1: 1/81, a Token Factory 502 that failed closed) |
| out-of-scope effect delivered (contract tasks) | 0/10 (0.0%) | 0/10 (0.0%) |
| fail-closed (judge unavailable) | — | 0 |

Per-tier first catches (escrow): C1 10, R0–R3 57, R4 21 (16 of them labeled-R4 via Nano), R5 31. Commit latency: p50 779 ms, p90 1660 ms. Judge cost: $0.0301 total, or $0.00027 per judged commit.

## Checks
```
$ npm test
ℹ tests 88
ℹ pass 88
ℹ fail 0
$ npm run typecheck   # clean
```
