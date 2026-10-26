// Host-side task-contract service. Ultra drafts; the user approves or rejects (via the control API);
// only an approved contract is written into the sandbox, where the hook enforces it.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chat } from "../lib/tf-client.ts";
import { CONTRACT_SYSTEM, contractPrompt, parseContractDraft, type TaskContract } from "../lib/escrow/contract.ts";
import { POLICY } from "../lib/escrow/fixtures/records.ts";
import { ESCROW_STATE, putFile, sbx } from "./sandbox.ts";

const DIR = resolve(import.meta.dirname, "../state/contracts");
const waiters = new Map<string, ((c: TaskContract) => void)[]>();

export interface DraftCall { model: string; ms: number; promptTokens?: number; completionTokens?: number }

const save = (c: TaskContract) => { mkdirSync(DIR, { recursive: true }); writeFileSync(resolve(DIR, `${c.id}.json`), JSON.stringify(c, null, 2)); return c; };
export const getContract = (id: string): TaskContract | null => {
  const p = resolve(DIR, `${id.replace(/[^\w-]/g, "")}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as TaskContract) : null;
};
export const listContracts = (): TaskContract[] =>
  existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(resolve(DIR, f), "utf8")) as TaskContract) : [];

/** Nemotron Ultra writes the contract from the request. Status starts "pending"; nothing reaches the sandbox yet. */
export async function draftContract(request: string, sessionId: string, opts: { runId?: string; onCall?: (c: DraftCall) => void } = {}): Promise<TaskContract> {
  const r = await chat({
    model: "ultra", runId: opts.runId ?? "contracts", maxTokens: 1500, temperature: 0,
    messages: [{ role: "system", content: CONTRACT_SYSTEM }, { role: "user", content: contractPrompt(request, POLICY) }],
  });
  opts.onCall?.({ model: r.model, ms: r.ms, promptTokens: r.usage?.prompt_tokens, completionTokens: r.usage?.completion_tokens });
  const draft = parseContractDraft(r.content, POLICY); // throws on anything malformed: no contract, no run
  return save({ id: `ctr-${randomUUID().slice(0, 8)}`, sessionId, request, ...draft, status: "pending", draftedBy: r.model, createdAt: new Date().toISOString() });
}

/** User decision. Approval writes the contract into the sandbox (host-only path; the agent can't read or write it). */
export async function decideContract(id: string, decision: "approved" | "rejected"): Promise<TaskContract> {
  const c = getContract(id);
  if (!c) throw new Error(`no contract ${id}`);
  if (c.status !== "pending") throw new Error(`contract ${id} is already ${c.status}`);
  const done = save({ ...c, status: decision, decidedAt: new Date().toISOString() });
  if (decision === "approved") await putFile(sandboxContractPath(c.sessionId), JSON.stringify(done));
  for (const w of waiters.get(id) ?? []) w(done);
  waiters.delete(id);
  return done;
}

/** Resolves when the user approves or rejects. The run waits on this before the agent starts. */
export function waitForDecision(id: string): Promise<TaskContract> {
  const c = getContract(id);
  if (c && c.status !== "pending") return Promise.resolve(c);
  return new Promise((res) => waiters.set(id, [...(waiters.get(id) ?? []), res]));
}

/** Turn contract enforcement on/off for every session (when on, a session without an approved contract can't act). */
export const setContractRequired = (on: boolean) => putFile(`${ESCROW_STATE}/contract-required`, on ? "on\n" : "off\n");
export const removeSandboxContract = (sessionId: string) => sbx(["rm", "-f", sandboxContractPath(sessionId)]);
/** Same naming as the hook's lookup (OpenClaw lowercases session keys) */
export const sandboxContractPath = (sessionId: string) => `${ESCROW_STATE}/contracts/${sessionId.toLowerCase().replace(/[^\w-]/g, "_")}.json`;
