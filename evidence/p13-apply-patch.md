# apply_patch: blocked live, with the new message (2026-10-29)

**Why it matters.** OpenClaw exposes `apply_patch` to Nemotron. The help text says "OpenAI/Codex", but `openclaw@2026.9.2` has no provider check (`dist/agent-tools-By64BZu5.js:329`, `dist/core-coding-tools-DMh_iw8e.js:96-98`). The tool writes files directly, outside the shadow FS, so it has to be blocked. The hook's default-deny allowlist always blocked it; it now does so with a message that points the agent at `write`/`edit`, which are shadowed until `escrow_commit`.

**Plugin reinstalled** (`scripts/install-plugin.sh`). As always on this machine, `gateway restart` reported a "forward recovery failure", because our loopback forward holds 18789. The gateway is fine:
```
Installed plugin: escrow-hook
Enabled plugin "escrow-hook".
Connectivity probe: ok
openclaw plugins inspect escrow-hook → "status": "loaded"
/sandbox/.openclaw/extensions/escrow-hook/dist/plugins/escrow-hook/decide.js contains the new message
scripts/assert-loopback.sh → 18789 / 8000 / 8790 all on 127.0.0.1
```

**Live attempt** (`scripts/ag.sh p13-applypatch run "Use the apply_patch tool (not write or edit) to create … notes/patch-test.md …"`, $0.025). The agent's reply:
```
Escrow: tool "apply_patch" is not allowed in this sandbox. Use write or edit to change files instead (they are held in the shadow FS until escrow_commit).
```
The hook's audit log inside the sandbox (`/sandbox/.escrow/audit.jsonl`):
```json
{
 "ts": "2026-10-30T00:52:44.934Z",
 "tool": "apply_patch",
 "params": { "input": "*** Begin Patch\n*** Add File: notes/patch-test.md\nhello\n*** End Patch" },
 "derivedPaths": [ "/sandbox/.openclaw/workspace/notes/patch-test.md" ],
 "sessionKey": "agent:main:explicit:p13-applypatch",
 "decision": "blocked",
 "reason": "Escrow: tool \"apply_patch\" is not allowed in this sandbox. Use write or edit to change files instead (they are held in the shadow FS until escrow_commit).",
 "class": "block"
}
```
```
$ ls /sandbox/.openclaw/workspace/notes/patch-test.md
ls: cannot access '/sandbox/.openclaw/workspace/notes/patch-test.md': No such file or directory
```
Unit test: `plugins/escrow-hook/decide.test.ts`, "apply_patch is blocked with a message pointing the agent at write/edit".
