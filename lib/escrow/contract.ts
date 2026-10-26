// Task contract (C1). Before a run, Nemotron Ultra turns the user's request into a contract: who may be
// contacted, which external targets may be written, which actions are allowed, and which students' records
// are in scope. The user approves or rejects it; the run starts only after approval, and the hook enforces it
// on every tool call. Anything outside the contract is blocked even if verification would pass.
import type { Policy } from "./verify.ts";

export const CONTRACT_ACTIONS = ["read_records", "write_file", "send_email", "write_external"] as const;
export type ContractAction = (typeof CONTRACT_ACTIONS)[number];

export interface TaskContract {
  id: string;
  /** The OpenClaw session the contract governs */
  sessionId: string;
  request: string;
  allowedRecipients: string[];
  /** External-write target prefixes */
  allowedTargets: string[];
  allowedActions: ContractAction[];
  /** Student ids whose records the task may read */
  dataScope: string[];
  rationale: string;
  status: "pending" | "approved" | "rejected";
  draftedBy: string;
  createdAt: string;
  decidedAt?: string;
}

export const CONTRACT_SYSTEM =
  "You write task contracts for a university TA assistant that runs under a FERPA-aligned safety layer. " +
  "Given the TA's request and the course roster, output the NARROWEST contract that still lets the task succeed. " +
  "allowedRecipients: only email addresses the request needs (a student receiving their own result, or course staff). " +
  "allowedTargets: only institution systems the request needs (e.g. lms://cmpsc465/gradebook/<id>), else []. " +
  `allowedActions: a subset of ${JSON.stringify(CONTRACT_ACTIONS)}. ` +
  "dataScope: student ids whose records the task must read, else []. " +
  'Respond with ONLY compact JSON on the final line: {"allowedRecipients":[],"allowedTargets":[],"allowedActions":[],"dataScope":[],"rationale":""}. No markdown.';

export function contractPrompt(request: string, policy: Policy): string {
  const roster = policy.records.map((r) => `- ${r.name} (${r.studentId}) <${r.email}>`).join("\n");
  return `COURSE ROSTER:\n${roster}\nCOURSE STAFF: ${policy.officials.join(", ")}\nINSTITUTION SYSTEMS: ${(policy.trustedTargets ?? []).join(", ")}\n\nTA REQUEST:\n${request}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Parse and validate Ultra's draft. Anything malformed throws: no contract, no run (fail closed). */
export function parseContractDraft(raw: string, policy: Policy): Pick<TaskContract, "allowedRecipients" | "allowedTargets" | "allowedActions" | "dataScope" | "rationale"> {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`contract draft has no JSON: ${raw.slice(0, 200)}`);
  const j = JSON.parse(m[0]) as Record<string, unknown>;
  const strs = (k: string): string[] => {
    const v = j[k] ?? [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`contract field ${k} must be a string array`);
    return [...new Set(v.map((x) => x.trim()).filter(Boolean))];
  };
  const allowedRecipients = [...new Set(strs("allowedRecipients").map((e) => e.toLowerCase()))];
  for (const e of allowedRecipients) if (!EMAIL_RE.test(e)) throw new Error(`not an email: ${e}`);
  const allowedTargets = strs("allowedTargets");
  const allowedActions = strs("allowedActions") as ContractAction[];
  for (const a of allowedActions) if (!CONTRACT_ACTIONS.includes(a)) throw new Error(`unknown action: ${a}`);
  const known = new Set(policy.records.map((r) => r.studentId));
  const dataScope = strs("dataScope");
  for (const id of dataScope) if (!known.has(id)) throw new Error(`unknown student id in scope: ${id}`);
  return { allowedRecipients, allowedTargets, allowedActions, dataScope, rationale: typeof j.rationale === "string" ? j.rationale : "" };
}

/** What a tool call is about to do, in contract terms. */
export type ContractAct =
  | { kind: "read_records"; studentId: string }
  | { kind: "write_file"; path: string }
  | { kind: "send_email"; to: string[] }
  | { kind: "write_external"; target: string };

/** Returns why the act is outside the contract, or null if allowed. */
export function contractViolation(c: TaskContract, act: ContractAct): string | null {
  if (c.status !== "approved") return `task contract ${c.id} is ${c.status}`;
  if (!c.allowedActions.includes(act.kind)) return `action ${act.kind} is not in the task contract`;
  switch (act.kind) {
    case "read_records":
      return c.dataScope.includes(act.studentId) ? null : `record ${act.studentId} is outside the contract's data scope`;
    case "send_email": {
      const bad = act.to.filter((t) => !c.allowedRecipients.includes(t.trim().toLowerCase()));
      return bad.length ? `recipient(s) ${bad.join(", ")} not in the task contract` : null;
    }
    case "write_external":
      return c.allowedTargets.some((t) => act.target.startsWith(t)) ? null : `target ${act.target} is not in the task contract`;
    case "write_file":
      return null;
  }
}

/** Records live at /sandbox/course/records/<id>.json; any other path isn't a record read. */
export function recordIdOf(absPath: string): string | null {
  const m = /^\/sandbox\/course\/records\/([A-Za-z0-9-]+)\.json$/.exec(absPath);
  return m ? m[1] : null;
}
