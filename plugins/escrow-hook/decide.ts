// Audit-log formatting and the simple block decision. No OpenClaw imports, so it's unit-testable on the host.
import { classify } from "./policy.ts";

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

/** Blocks anything the default-deny policy doesn't classify as allowed. */
export function decide(ev: ToolCallEvent): Decision {
  return classify(ev.toolName, ev.toolKind) === "block"
    ? { block: true, blockReason: `Escrow: tool "${ev.toolName}" is not allowed in this sandbox. Use escrow_send_email / escrow_write_external for side effects.` }
    : { block: false };
}

export function logLine(ev: ToolCallEvent, ctx: ToolCallCtx, d: Decision, extra: Record<string, unknown> = {}, now = new Date()): string {
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
    ...extra,
  });
}
