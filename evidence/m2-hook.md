# M2: `before_tool_call` hook loads inside the sandbox, logs tool calls, blocks `exec`

**Claim:** `plugins/escrow-hook` is a native OpenClaw plugin running in the OpenClaw gateway process **inside** the `escrow` OpenShell sandbox. Its `before_tool_call` hook sees every tool call's name and full params, logs them as JSON lines, and blocks `exec` (and `process`, plus `code_mode_exec`) before execution.

## SDK shape (from installed source, not memory)

* `openclaw@2026.9.2` (the version in the sandbox), file `docs/plugins/hooks.md` → "Tool call policy": `api.on("before_tool_call", (event, ctx) => ...)`. The event carries `toolName`, `params`, `toolKind`, `derivedPaths`, `runId`, and `toolCallId`. ctx carries `agentId`, `sessionKey`, `sessionId`, and `runId`. The handler returns `{ block, blockReason }`, `{ params }`, or `{ requireApproval }`.
* `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry` (`dist/plugin-entry-*.js`) returns `{id,name,description,configSchema,register}`.
* `plugins/escrow-hook/index.ts` typechecks against the real `openclaw@2026.9.2` `.d.ts` files (`npm run typecheck`).

## Install (inside the sandbox)

`scripts/install-plugin.sh` builds `dist/`, uploads it to `/sandbox/escrow-hook`, then runs `openclaw plugins install <path> --force --accept-capabilities`, `openclaw plugins enable escrow-hook`, and `nemoclaw escrow gateway restart`.

```
$ nemoclaw escrow exec -- openclaw plugins inspect escrow-hook --runtime --json   # excerpt
{
  "id": "escrow-hook",
  "enabled": true,
  "status": "loaded",
  "activated": true,
  "source": "/sandbox/.openclaw/extensions/escrow-hook/dist/index.js",
  "typedHooks": [
    {
      "name": "before_tool_call",
      "priority": 1000
    }
  ],
  "install.installPath": "/sandbox/.openclaw/extensions/escrow-hook"
}
```

The gateway log inside the sandbox (`/tmp/openclaw/openclaw-2026-10-23.log`) shows `escrow-hook` among the 15 loaded plugins, and the plugin's own startup line `escrow-hook: loaded, logging tool calls to /tmp/escrow-hook.jsonl`.

## Proof: exec blocked

```
$ nemoclaw escrow exec --no-stdin -- openclaw agent --session-id m2-proof --json \
    -m "Use the exec tool to run this exact shell command and show me its output: echo escrow-m2 && hostname"
```

The model (Nemotron Super) called `exec`. The hook's log line, read from `/tmp/escrow-hook.jsonl` **inside the sandbox**:

```
{
  "ts": "2026-10-23T21:06:29.301Z",
  "hook": "before_tool_call",
  "tool": "exec",
  "params": {
    "command": "echo escrow-m2 && hostname"
  },
  "runId": "f6070ca2-36dc-470c-b100-556e21ab0f78",
  "toolCallId": "chatcmpl-tool-9d572d4467fe0d9e",
  "sessionKey": "agent:main:explicit:m2-proof",
  "sessionId": "3e4e92e4-0dd5-49a6-a032-56124a621ff5",
  "agentId": "main",
  "decision": "blocked",
  "reason": "Escrow: tool \"exec\" is blocked in this sandbox. Side effects must go through the Escrow outbox."
}
```

Agent's reply (the command never ran; there's no `escrow-m2` output):

> I’m unable to run the `exec` tool in this sandbox—it’s blocked for security reasons, and any side‑effects must go through the Escrow outbox instead. If you’d like the same information, I can try an alternative approach (for example, spawning a sub‑agent session) or you can run the command yourself in a terminal. Let me know how you’d like to proceed.

## Caveats found along the way

* **402 → OpenClaw billing backoff.** After the spend-cap test, OpenClaw marked the inline provider key "temporarily disabled after a provider auth/billing failure". Its billing backoff starts at 10 min and doubles up to 24 h (`billingBackoffMs: 6e5`, `billingMaxMs: 864e5` in `openclaw/dist/usage-*.js`). That's fail-safe, but in cached mode the agent can stay paused after the cap is raised. This run waited about 12 minutes.
* **Plugin self-protection:** OpenClaw's plugin dir (`/sandbox/.openclaw/extensions/escrow-hook`) is writable by the sandbox user, so an agent with a file-write tool could try to edit the hook. M6 adds a hook rule that blocks writes into `/sandbox/.openclaw` and `/sandbox/.nemoclaw`.
