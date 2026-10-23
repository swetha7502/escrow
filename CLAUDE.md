# Escrow — project context for Claude Code

## What this is
Hackathon entry for the Nebius x NVIDIA Global AI Hackathon (Personal AI track). Deadline: Oct 30, 2026, 1:00pm EDT.

A private, always-on TA assistant running in NVIDIA NemoClaw (OpenClaw inside an OpenShell sandbox), with course-policy memory and regrade/extension/grade-dispute skills. **Escrow** is its safety layer: it holds every side effect in escrow until the session is verified, so the agent can't leak student records.

## Core claim (everything must support this)
"The only non-inference exit is verified, and inference goes only to Nebius as the processor."
- Sandbox egress is allowed to Nebius Token Factory ONLY (enforced by OpenShell network policy).
- All other effects (email, file writes outside the sandbox) go through an outbox. A host-side sender, running outside the sandbox, sends only verified effects.

## Architecture
- **Hook:** OpenClaw plugin using `before_tool_call` (via `definePluginEntry` / `api.on`). Can block, rewrite params, or require approval. Fallback if this proves unworkable: MCP proxy in front of the tools.
- **Transaction manager:** in-memory per session (no WAL).
- **Shadow FS:** app-level; writes go to a shadow copy until commit.
- **Effect outbox:** queued side effects; host-side sender drains only committed ones.
- **Session-level verification**, in tiers: exact-match/canary (deterministic) → fingerprints → Nemotron Super adjudication (paraphrase, best-effort).
- **Nemotron roles (all on Token Factory):** Ultra writes the task contract (user approves before the run) and attack scenarios; Super adjudicates paraphrase leaks; Nano labels reads.

## Policy framing
"FERPA-aligned policy enforcement". Encode 2–3 concrete rules: school officials with legitimate educational interest may see records; other students may not.

## Guarantees — be honest
- Deterministic: egress lockdown, exact-match/canary tier.
- Best-effort: paraphrase tier. Document known failure modes.

## Rules for working in this repo
- Never commit secrets. Keys live in `.env` (gitignored). Read `TF_API_KEY`, `TF_BASE_URL` from env.
- Prefer small, verifiable steps. After each milestone, run a concrete check and show the output.
- Save proof of security properties (command + output) to `evidence/` as markdown. These go in the demo/README.
- Log any Nebius / NVIDIA / NemoClaw / OpenShell friction to `feedback.md` (date, what happened, workaround). It's part of the submission.
- If a step needs an interactive prompt or a manual console action, stop and tell me exactly what to do instead of guessing.
- Don't invent CLI flags or APIs. Check `--help`, the installed source, or official docs (docs.nvidia.com/nemoclaw, docs.openclaw.ai) first.

## Stack (UI, later)
React, React Flow + canvas particles, Framer Motion, WebSockets.