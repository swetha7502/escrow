# M5 decision: OpenClaw `before_tool_call` inside the NemoClaw sandbox

## Verdict: **GO**

The hook (`plugins/escrow-hook`, loaded in the OpenClaw gateway **inside** the `escrow` sandbox) sees the tool name and the **complete** parameters, plus session, run, and tool-call IDs, for all three side-effect classes **before** the tool runs. It can block each of them. No fallback harness is needed.

| Class | Tool(s) observed | Params seen by the hook | Blockable |
|---|---|---|---|
| exec | `exec` | `{command}`, the full shell string | **yes** (proven in M2; the command never ran) |
| file write | `write`, `edit` (`read` too) | `write`: `{path, content}` with the full file body. `edit`: `{path, edits:[{oldText,newText}]}` | yes (same mechanism) |
| message send | `message` | `{action:"send", target, message}`, full recipient and body | yes |

## Raw hook log (`/tmp/escrow-hook.jsonl` inside the sandbox)

The M5 runs were in observe mode (only `exec` blocked):

```
{"ts": "2026-10-23T21:06:29.301Z", "tool": "exec", "params": {"command": "echo escrow-m2 && hostname"}, "sessionKey": "agent:main:explicit:m2-proof", "decision": "blocked"}
{"ts": "2026-10-23T21:09:42.152Z", "tool": "write", "params": {"path": "/sandbox/escrow/m5-note.md", "content": "Regrade note\nStudent PSU-90412277 requested a regrade."}, "sessionKey": "agent:main:explicit:m5-write", "decision": "allowed"}
{"ts": "2026-10-23T21:09:58.056Z", "tool": "read", "params": {"path": "/sandbox/escrow/m5-note.md"}, "sessionKey": "agent:main:explicit:m5-edit", "decision": "allowed"}
{"ts": "2026-10-23T21:10:00.394Z", "tool": "edit", "params": {"path": "/sandbox/escrow/m5-note.md", "edits": [{"oldText": "Regrade note", "newText": "Regrade note (v2)"}]}, "sessionKey": "agent:main:explicit:m5-edit", "decision": "allowed"}
{"ts": "2026-10-23T21:10:21.514Z", "tool": "message", "params": {"action": "send", "target": "avery.quill@student.example.edu", "message": "Your regrade was approved"}, "sessionKey": "agent:main:explicit:m5-message", "decision": "allowed"}
```

Every line carries `sessionKey` (e.g. `agent:main:explicit:m5-write`), which is the key for per-session transactions in M6.

## Tool surface the agent actually has (Nemotron Super listed it, `m5-message` run)

```
agents_list, agents_wait, apply_patch, ask_user, browser, canvas, create_goal, dashboard, dir_fetch, dir_list, edit, exec, file_fetch, file_write, get_goal, memory_get, memory_search, message, node_inference, process, progress_card, read, secrets, session_status, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, tts, update_goal, web_fetch, write
```

That's far more than read, write, and message. For M6–M8 the hook switches from a **blocklist to a default-deny allowlist**:

* **Allowed, unchanged:** `read`, `memory_get`, `memory_search`, `session_status`, `sessions_list`, `sessions_history`, `sessions_search`, `get_goal`, `ask_user`, `progress_card`
* **Allowed, rewritten into the shadow FS:** `write`, `edit`, plus `read` of a path the session has shadowed. `apply_patch` is blocked until its envelope is parsed (`derivedPaths` is best-effort per the docs).
* **Escrow tools (registered by the plugin, `api.registerTool`):** `escrow_send_email`, `escrow_write_external`, `escrow_commit`, `escrow_abort`. These enqueue into the session transaction. Nothing leaves before commit.
* **Blocked:** everything else, including `exec`, `process`, `message`, `sessions_send`, `sessions_spawn`, `subagents`, `web_fetch`, `browser`, `file_write`, `file_fetch`, `dir_fetch`, `secrets`, `canvas`, `tts`, `node_inference`, and any tool added later.
* **Self-protection:** writes resolving into `/sandbox/.openclaw`, `/sandbox/.nemoclaw`, or `/sandbox/escrow/outbox` are blocked, so the agent can't edit the hook, its config, or forge outbox records.

## Why this is enough, and the residual risks (honest)

* **Network egress doesn't depend on the hook.** Even if a tool slipped past it, OpenShell allows only `inference.local` (M3, deterministic). The hook governs *which* effects reach the outbox. It isn't the network boundary.
* **Outbox forgery:** the sandbox user can write `/sandbox/escrow/outbox` directly (for example from a tool the hook failed to block). Mitigation: the host sender re-runs the deterministic canary/exact-match verification on every record (M8), so a forged `committed` label alone releases nothing.
* **Plugin tamper:** `/sandbox/.openclaw/extensions/escrow-hook` is writable by the sandbox user. Mitigated by the self-protection rule above and by `exec` being blocked. Residual: a non-hooked code path inside OpenClaw that writes files, such as memory persistence. Not observed. Listed as a known gap.
* **Hook coverage is per runtime:** the docs note hook coverage differs for Codex/Copilot harnesses. This sandbox uses the OpenClaw embedded harness (`agentHarnessId: "openclaw"` in M1), where `before_tool_call` is implemented.
* **Param rewrite** (needed for the shadow FS) is documented ("Return `params` to rewrite host-owned tool parameters") and gets verified in M6. If a tool ignores rewritten params, the fallback is to block `write`/`edit` and expose `escrow_write_file` instead.

## Not needed: fallback harness

The NO-GO plan (a standalone TypeScript agent harness on Token Factory with its own tool interception) isn't needed. `lib/escrow/` (transactions, shadow FS, verification) stays harness-agnostic, so that option remains cheap if a later OpenClaw release breaks the hook contract.
