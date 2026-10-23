// Pure policy for the before_tool_call hook. No OpenClaw imports, so it's unit-testable on the host.

/** Tools blocked outright. A side effect has to go through Escrow's outbox instead. */
export const BLOCKED_TOOLS = new Set(["exec", "process"]);

export interface ToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  toolKind?: string;
  toolInputKind?: string;
  derivedPaths?: string[];
  runId?: string;
  toolCallId?: string;
}

export interface ToolCallCtx {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}

export interface Decision {
  block: boolean;
  blockReason?: string;
}

export function decide(ev: ToolCallEvent): Decision {
  const name = ev.toolName.toLowerCase();
  if (BLOCKED_TOOLS.has(name) || ev.toolKind === "code_mode_exec") {
    return { block: true, blockReason: `Escrow: tool "${ev.toolName}" is blocked in this sandbox. Side effects must go through the Escrow outbox.` };
  }
  return { block: false };
}

export function logLine(ev: ToolCallEvent, ctx: ToolCallCtx, d: Decision, now = new Date()): string {
  return JSON.stringify({
    ts: now.toISOString(),
    hook: "before_tool_call",
    tool: ev.toolName,
    toolKind: ev.toolKind,
    params: ev.params,
    derivedPaths: ev.derivedPaths,
    runId: ev.runId ?? ctx.runId,
    toolCallId: ev.toolCallId,
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    decision: d.block ? "blocked" : "allowed",
    reason: d.blockReason,
  });
}
