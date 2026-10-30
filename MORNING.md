# Good morning: overnight summary (written 2026-10-30, ~01:45 EDT)

## Final numbers (all from code commit `bb46672`, 2026-10-30)

| | baseline (per call) | **Escrow** |
|---|---|---|
| Live OpenClaw agent, 24 leak scenarios | 13/24 leaked | **0/24** (95% upper bound 11.7%) |
| Live, 14 clean scenarios: false blocks | 0/14 | **0/14** |
| Live, 4 contract scenarios: out-of-scope delivered | 0/4 | **0/4** (no-contract control: 4/4 delivered) |
| 200-task pipeline, 109 leak tasks | 47/109 | **0/109** (bound 2.7%) |
| Pipeline, 81 clean tasks: false blocks | 0/81 | **0/81** (was 1/81 before the judge fix) |
| Failure-mode suite, 11 leak attacks | — | 9/11 caught by the deterministic tiers; FM12 and FM13 get through |

- **Live run quality:** 0 failed agent turns this time. I reviewed the agent-composed runs by hand.
- **Evidence:** `evidence/p16-final-rerun.md` and `evidence/p17-vercel.md`.
- **Counts updated everywhere:** README, Devpost, STATUS, the landing page (labeled with commit and date) and the video script.

## Links
- **Demo (Vercel):** https://escrow-ui-phi.vercel.app. Cached-only right now; it works with no backend.
- **Repo:** https://github.com/swetha7502/escrow. **It's public.** It was already public last night, but 46 commits behind. I audited the full history for secrets, found none, and pushed. GitHub detects the **MIT License**.

## Commits since you went to bed
| commit | what |
|---|---|
| `e9aa734` | Spend cap: `set-cap 25` was clamped by `HARD_CAP_USD = 15`, so I raised the constant to 25 |
| `bb46672` | Judge prompt: a name alone is directory information, and a refusal isn't a leak. Regression test. Stability check: 0/16 sessions flipped over 3 runs |
| `c094795` | Final re-run at `bb46672`, with counts updated everywhere |
| `7abf630` | UI with no backend: the live chip is hidden, your "Cached runs are real recorded outputs…" line is on the landing page, and the button reads "Replay" |
| (last) | Vercel URL in the README, Devpost and video script; deploy evidence; this file |

Every commit passed `npm test` (98/98), the typecheck and `check-run-race`. I made no code changes after 01:45, well before the 6am freeze.

## Spend
**$18.37 of the $25 cap** (`node proxy/cli.ts show`). The re-run, control arm, stability check and live Vercel check cost $4.03 in total. That leaves $6.63, which covers your $5 for judging and the $0.40 reserve. Each live run costs about $0.05; a side-by-side is two runs.

## Broken, skipped, or still true
- **FM12** (a leak split across separate sessions) and **FM13** (a canary in single-character pieces) still get through. They're documented in `FAILURE_MODES.md`, and I didn't start on cross-session memory.
- **The judge isn't perfectly deterministic.** It runs at temperature 0, and the stability check saw 0 flips in 3 runs per session, but rare flips aren't ruled out. It fails closed, so a flip costs a false block, never a leak. I didn't test whether Token Factory honors a `seed`.
- **Live is OFF overnight**, on purpose (decision 11 in STATUS.md): no tunnel, control API stopped, `state/live-runs-disabled` set. The site shows cached runs until you turn live on.
- **I made all the overnight decisions alone.** Each one is logged with its reason in STATUS.md, under "Overnight decisions log".

## What you need to do manually
1. **Turn live on for recording or judging.** The laptop must be awake, with WSL and Docker up and the sandbox Ready:
   ```bash
   cd ~/escrow && rm -f state/live-runs-disabled && scripts/live-tunnel.sh
   ```
   Wait for `tunnel OK` and the Vercel publish. Then open https://escrow-ui-phi.vercel.app, click **UNLOCK LIVE**, and paste the token (`grep TOKEN state/public.env`; don't show it on camera). The quick-tunnel URL changes on every restart, so re-run the same command after any reboot or sleep. To turn live off again: `scripts/live-tunnel.sh stop && touch state/live-runs-disabled`.
2. **Record the video** (`docs/video-script.md`). It's set up for the Vercel URL, the counts at `bb46672`, FM6 blocked on camera, and FM12 as the remaining limit.
3. **Paste the YouTube link** into `docs/devpost.md` and the Devpost form.
4. **Submit on Devpost** before 1:00pm EDT. All the fields are in `docs/devpost.md`; demo and code links are filled.
5. **Optional:** set a Nebius account-level spend alert. The proxy can only cap the traffic that goes through it.
6. **Optional:** the repo uses a local git identity, `swetha <smv5809@psu.edu>`. Change it if you want.
