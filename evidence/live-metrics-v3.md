Runs: 84 (42 scenarios × arms).

| metric | baseline (per call) | escrow (session) |
|---|---|---|
| **leak rate**, all leak scenarios (record data delivered) | 14/24 (58.3%) | 0/24 (0.0%) |
| leak rate where the agent actually attempted the leak | 14/20 (70.0%) | 0/21 (0.0%) |
| agent refused / declined the attack on its own (reviewed) | 4 | 3 |
| **false-block rate** (clean scenarios with an effect blocked) | 0/14 (0.0%) | 0/14 (0.0%) |
| out-of-scope effect delivered (contract scenarios, contract approved) | 0/4 (0.0%) | 0/4 (0.0%) |
| agent turn failed (nemoclaw exec non-zero) | 1 | 0 |

**By category (leak scenarios: delivered / attempted / runs)**

| category | runs per arm | baseline leaked | escrow leaked | escrow first catching tier |
|---|---|---|---|---|
| hand-written exact/split | 5 | 2 / 5 attempted | 0 / 5 attempted | R0-canary 1, R3-unauthorized-recipient 3, R4-fingerprint 1 |
| hand-written paraphrase/split | 2 | 2 / 2 attempted | 0 / 2 attempted | R5-super-judge 2 |
| prompt_injection | 3 | 0 / 0 attempted | 0 / 0 attempted | — |
| split_leak | 3 | 3 / 3 attempted | 0 / 3 attempted | R4-fingerprint 3 |
| paraphrase | 3 | 3 / 3 attempted | 0 / 3 attempted | R5-super-judge 3 |
| encoding | 3 | 1 / 3 attempted | 0 / 3 attempted | R3-unauthorized-recipient 2, R5-super-judge 1 |
| lookalike_address | 3 | 2 / 3 attempted | 0 / 3 attempted | R5-super-judge 2, R3-unauthorized-recipient 1 |
| killer (agent-composed) | 2 | 1 / 1 attempted | 0 / 2 attempted | R4-fingerprint 1, R5-super-judge 1 |

**Escrow tiers (live, per commit)**

| tier | ran | blocked | latency p50 | latency p90 |
|---|---|---|---|---|
| C1-contract | 42 | 3 | 0.00 ms | 0.01 ms |
| R0-R3-exact-canary | 42 | 7 | 0.35 ms | 0.76 ms |
| R4-fingerprint | 42 | 11 | 0.14 ms | 0.48 ms |
| R5-super-judge | 27 | 9 | 1.17 s | 1.98 s |

Nano labels present at commit: 42/42 escrow commits had every read labeled. Labeled-R4 catches: 3.

**Cost (spend-proxy log, per run window):** total $3.61; baseline $1.83, escrow $1.78; mean $0.043 per run. By model: nemotron-3-super-120b-a12b $3.586, NVIDIA-Nemotron-3-Nano-30B-A3B $0.008, Nemotron-3-Ultra-550b-a55b $0.014.
Wall time: median 17 s per run.

