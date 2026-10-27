export type Arm = "baseline" | "escrow";

/** One event from the pipeline stream (harness/events.ts EscrowEvent), live or replayed. */
export interface UiEvent {
  seq?: number;
  ts?: string;
  /** ms since run start (bundled cached runs only) */
  t?: number;
  type: string;
  runId?: string;
  sessionId?: string;
  /** true when this event is a replay of a saved run, not live */
  cached?: boolean;
  [k: string]: unknown;
}

export interface Contract {
  id: string;
  sessionId: string;
  request: string;
  allowedRecipients: string[];
  allowedTargets: string[];
  allowedActions: string[];
  dataScope: string[];
  rationale: string;
  status: "pending" | "approved" | "rejected";
  draftedBy: string;
  createdAt: string;
  decidedAt?: string;
}

export interface ModelCallInfo { model?: string; ms?: number; promptTokens?: number; completionTokens?: number }
