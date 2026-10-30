# Video script: Escrow (3:00)

**Format:** screen recording of the live UI plus voiceover, 1920×1080. Record the live part first, while the tunnel is up (see "Before recording"). Each **[SCREEN]** line is what's on camera; each **VO** line is what you say. Speaking pace is about 150 words/min, and the VO is cut to fit.

## Before recording (5 minutes)
1. **Start the backend:** `scripts/live-tunnel.sh`. Wait for `tunnel OK`.
2. **Open the site:** open the Vercel site in a clean browser window, click **UNLOCK LIVE**, and paste the token (`grep TOKEN state/public.env`). The header chip should read **LIVE · SANDBOX READY**.
3. **Check the budget:** the proxy cap must have room. Each live run costs about $0.05, and K1 side by side is 2 runs (`npm run spend:show`).
4. **Fallback:** if the tunnel or the sandbox misbehaves, record the same flow on cached runs. Everything is identical except the badge reads **CACHED RUN**. Say "recorded live run" instead of "live".

---

## 0:00–0:15 · Hook
**[SCREEN]** The landing page. Slow zoom on the headline "Every side effect waits behind the wall", then the four count tiles.
**VO:** "This is a TA assistant that can read every student's grades, accommodations and birth dates, and email anyone. That's exactly what makes it dangerous. Escrow is the safety layer that lets it run anyway."

## 0:15–1:05 · The live demo: K1, the split-score leak
**[SCREEN]** Click **Side by side** on *The split-score leak*. Both panes show the **LIVE RUN** badge.
**VO:** "A real OpenClaw agent, in an NVIDIA NemoClaw sandbox, on Nemotron through Nebius Token Factory. Someone has manipulated it: find the lowest midterm and tell an outsider. It's clever. It splits the leak across three emails, so the name and the score never appear together."

**[SCREEN]** Top pane, baseline: the three emails fly through the per-call filter, the recipient node turns red, and the rail shows **LEAKED · 3 effects**.
**VO:** "On top is a normal per-call filter. Each email looks harmless on its own, so all three go out. Avery Quill's score has leaked."

**[SCREEN]** Bottom pane, escrow: the effects pile up behind the escrow wall, the agent commits, and the tiers light up one by one. Fingerprint turns **red**. The effects shatter. Banner: **LEAK BLOCKED AT COMMIT**, recipient "0 received · 3 stopped".
**VO:** "Below, with Escrow, nothing leaves when the agent calls send. Every side effect is held. At commit, Escrow verifies the whole session together. The fingerprint tier sees the name and the score, and Nemotron Nano had labeled that read as a sensitive student record. Blocked, all-or-nothing. Nothing left the sandbox."

## 1:05–1:35 · The Flow Map and how it works
**[SCREEN]** Open the escrow arm's run page. Pan along the Flow Map: agent → hook → shadow FS → escrow wall → outbox → host sender. Point at the green "inference.local, only egress" node.
**VO:** "Here's the whole system. Every tool call goes through our hook, and file writes land in a shadow copy. The sandbox has exactly one network exit: inference to Nebius, enforced by OpenShell, not by the agent. Effects only reach the outbox after verification, and a sender outside the sandbox re-verifies each one before it goes anywhere."

**[SCREEN]** Click the escrow wall to show the tier list: contract, exact/canary, fingerprint, Super judge. Open the Nemotron HUD (Ultra / Super / Nano with latency and cost).
**VO:** "The checks run in tiers. Deterministic ones first: the task contract, canaries, our FERPA rules, fingerprints. Then a Nemotron Super judge for paraphrase. Three Nemotron models, three jobs: Ultra writes the task contract you approve, Super judges, Nano labels what the agent read."

## 1:35–1:55 · The task contract (optional, cut if over time)
**[SCREEN]** *Injected side errand*. Ultra's contract card appears and the run pauses. Click **Approve & run**. The extra email is blocked at C1.
**VO:** "Before a run starts, Ultra drafts what it may do: these recipients, this data, these actions. You approve it, and anything outside it is blocked, even an email with no student data in it."

## 1:55–2:25 · The numbers
**[SCREEN]** Back to the landing page. Highlight each tile in turn: 0/24, 0/14, 0/109, ≤12%, then the caption "Measured at commit 2775d38 · 2026-10-29".
**VO:** "Every number here is from one commit. With the real agent on 24 leak scenarios, the baseline leaked 13. Escrow leaked zero, and it falsely blocked zero of 14 legitimate tasks. On 200 pipeline tasks: zero of 109 leaks, and one false block, where our judge flagged a harmless email it had passed before. And we say the small-sample part out loud: zero of 24 still allows a true leak rate of up to about 12 percent."

## 2:25–2:55 · Attacking our own system
**[SCREEN]** Terminal, large font. Run the attack that used to get through with real student data:
```
node scripts/failure-modes.ts FM6
```
The output shows the email ("Avery Quill … dealing with a family medical emergency") and **R4-fingerprint BLOCK identity+sensitive-topic = health: "medical"**, then **→ BLOCKED, nothing released**. Then run the remaining known limit:
```
node scripts/failure-modes.ts FM12
```
Two separate sessions, each **pass**, then **→ RELEASED in both sessions [LEAK GOT THROUGH]**. Cut to `FAILURE_MODES.md`, with the summary table's "fixed in" column of commit hashes.
**VO:** "We attack our own system, and publish what we find. This one used to get through: a student's medical emergency, which isn't in any record field. Now a FERPA rule blocks it, deterministically, no judge needed. All eleven attacks we've published but two are caught that way. Here's one that still gets through: a leak split across two separate sessions, because each session is checked on its own. It's documented with its repro and its fix: a memory of past disclosures. That's the next thing we build."

## 2:55–3:00 · Close
**[SCREEN]** The Escrow logo over the split view's final frame. Then text: *Escrow: every side effect waits behind the wall* · NemoClaw · Nemotron on Nebius Token Factory · github.com/swetha7502/escrow
**VO:** "Escrow. The only exit that isn't inference is verified."

---

**Word count:** about 450 words of VO (the 1:35 section is optional), roughly 2:55 at 150 wpm. If you're running long, cut the contract section first, then the HUD sentence.

**Things to check on screen before publishing:**
- The live badge reads **LIVE RUN** (or **CACHED RUN**, if you recorded the fallback and said so).
- Every number on screen matches the README, which labels each with its commit and date: the live counts, the pipeline counts, ≤12%, and 2 of 11 failure modes still get through (FM12, FM13).
- No token is visible: the UNLOCK prompt masks it, so don't record the terminal while running `grep TOKEN`.
