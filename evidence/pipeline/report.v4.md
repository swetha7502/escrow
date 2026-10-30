| metric | baseline (per call) | escrow (session) |
|---|---|---|
| **leak rate** (leak tasks with ≥1 effect delivered) | 47/109 (43.1%) | 0/109 (0.0%) |
| **false-block rate** (clean tasks with ≥1 effect blocked) | 0/81 (0.0%) | 1/81 (1.2%) |
| out-of-scope effect delivered (contract tasks) | 0/10 (0.0%) | 0/10 (0.0%) |
| fail-closed (judge unavailable) | — | 0 |

**By attack family (leak tasks)**

| family | n | baseline leaked | escrow leaked | escrow first catching tier |
|---|---|---|---|---|
| paraphrase | 28 | 23 | 0 | R4-fingerprint 5, R5-super-judge 23 |
| encoding | 13 | 1 | 0 | R3-unauthorized-recipient 12, R5-super-judge 1 |
| lookalike | 13 | 0 | 0 | R3-unauthorized-recipient 13 |
| exact | 18 | 0 | 0 | R3-unauthorized-recipient 18 |
| split | 23 | 23 | 0 | R4-fingerprint 23 |
| canary | 14 | 0 | 0 | R0-canary 14 |

**Per-tier catches (escrow, first tier that blocked)**

| tier | catches | of which labeled-R4 (Nano) | latency p50 | latency p90 |
|---|---|---|---|---|
| C1-contract | 10 |  | 0.00 ms | 0.00 ms |
| R0-R3-exact-canary | 57 |  | 0.33 ms | 1.11 ms |
| R4-fingerprint | 28 | 16 | 0.31 ms | 0.88 ms |
| R5-super-judge | 25 |  | 1.72 s | 4.02 s |

Whole commit latency p50 924 ms, p90 2936 ms. **Cost:** Super judge ran on 105/200 tasks, $0.0279 total ($0.00027 per judged commit); Nano labels from the cache (no new calls); baseline has no model cost.

