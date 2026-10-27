// Start runs and decide contracts. A run is live through the control API when the backend can do it; anything
// else (backend unreachable, busy, failing) becomes a local replay of the bundled cached run, flagged cached.
import { api, backend, backendReady, hub } from "./backend";
import { cachedRun, specOf } from "./data";
import { REPLAY_MAX_GAP_MS } from "./config";
import type { Arm, Contract, UiEvent } from "./types";

export interface RunInfo { id: string; scenario: string; arm: Arm; local: boolean }
const runs = new Map<string, RunInfo>();
export const runInfo = (id: string) => runs.get(id);

let localN = 0;
const cancels = new Map<string, () => void>();
export const cancelRun = (id: string) => { cancels.get(id)?.(); cancels.delete(id); };

export async function startRun(scenario: string, arm: Arm, opts: { mode?: "auto" | "cached"; variant?: string } = {}): Promise<RunInfo> {
  if (opts.mode !== "cached") await backendReady();
  const b = backend.get();
  let reason: string;
  if (opts.mode === "cached") {
    let why: string | null = null;
    try { why = sessionStorage.getItem("escrow.fallback"); sessionStorage.removeItem("escrow.fallback"); } catch { /* storage unavailable */ }
    reason = why ? `fell back from live: ${why}` : "cached run requested";
  }
  else if (!b.online) reason = `backend unreachable${b.reason ? ` (${b.reason})` : ""}`;
  else {
    try {
      const rec = await api<{ id: string }>("/api/runs", { method: "POST", body: JSON.stringify({ scenario, arm, mode: "auto" }), timeoutMs: 30000 });
      const info = { id: rec.id, scenario, arm, local: false };
      runs.set(info.id, info);
      return info;
    } catch (e) {
      reason = `backend: ${(e as Error).message}`;
    }
  }
  return startLocal(scenario, arm, reason, opts.variant);
}

// ---- local replay -------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startLocal(scenario: string, arm: Arm, reason: string, variant = "default"): RunInfo {
  const id = `local-${++localN}-${Date.now().toString(36)}`;
  const info = { id, scenario, arm, local: true };
  runs.set(id, info);
  const rec = cachedRun(scenario, arm, variant);
  const spec = specOf(scenario);
  let cancelled = false;
  cancels.set(id, () => { cancelled = true; });
  const tag = { runId: id, cached: true };
  const emit = (e: UiEvent) => hub.emit({ ...e, ...tag, ts: new Date().toISOString(), originalTs: e.ts });

  void (async () => {
    await sleep(0); // let the caller subscribe first
    emit({ type: "run_started", scenario, arm, live: false, cachedReason: reason, desc: spec?.desc, leaks: spec?.leaks, recordedAt: rec?.recordedAt, source: rec?.file });
    if (!rec) { emit({ type: "run_failed", error: `no cached run for ${scenario}/${arm}` }); return; }
    let prevT = 0;
    let contractId: string | null = null;
    for (const e of rec.events) {
      if (cancelled) return;
      await sleep(Math.min(Math.max((e.t ?? 0) - prevT, 0), REPLAY_MAX_GAP_MS));
      prevT = e.t ?? prevT;
      if (cancelled) return;
      if (e.type === "contract_drafted") {
        const c = { ...(e.contract as Contract), id: `${(e.contract as Contract).id}-${id.split("-")[1]}`, status: "pending" as const };
        contractId = c.id;
        emit({ ...e, contract: c });
        const decision = await waitLocalDecision(c);
        if (cancelled) return;
        const decided = { ...c, status: decision, decidedAt: new Date().toISOString() };
        emit({ type: "contract_decided", contract: decided });
        if (decision === "rejected") {
          emit({ type: "run_finished", scenario, arm, live: false, outcome: { result: "REJECTED (contract)", tier: "-", delivered: 0, leaked: false, effectsAttempted: 0 }, delivered: [], durationMs: 0, modelUsd: 0, note: "task contract rejected by the user; the agent was not started" });
          return;
        }
        prevT = (rec.events.find((x) => x.type === "contract_decided")?.t ?? prevT); // skip the recorded wait for approval
        continue;
      }
      if (e.type === "contract_decided" && contractId) continue; // replaced by the user's own decision above
      emit(e);
    }
    const usd = rec.events.filter((e) => e.type === "model_call").reduce((a, e) => a + Number(e.usd ?? 0), 0);
    emit({ type: "run_finished", scenario, arm, live: false, outcome: rec.outcome, delivered: rec.delivered, durationMs: rec.durationMs, modelUsd: usd, reply: rec.reply });
    cancels.delete(id);
  })();
  return info;
}

// ---- contract decisions -------------------------------------------------------------------------------
// Local (cached) runs wait on an in-browser decision; a BroadcastChannel lets the approval page in another tab
// (or the phone-layout page in this browser) decide it. Live runs decide through the API.

type Decision = "approved" | "rejected";
const localWaiters = new Map<string, { contract: Contract; resolve: (d: Decision) => void }>();
const chan: BroadcastChannel | null = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("escrow-contracts") : null;
const pendingListeners = new Set<() => void>();
/** Contracts drafted for local runs in other tabs, as announced on the channel */
const remotePending = new Map<string, Contract>();
let pendingSnapshot: Contract[] = [];
const notifyPending = () => {
  pendingSnapshot = [...[...localWaiters.values()].map((w) => w.contract), ...[...remotePending.values()].filter((c) => !localWaiters.has(c.id))];
  pendingListeners.forEach((l) => l());
};


chan?.addEventListener("message", (m) => {
  const msg = m.data as { kind: string; contract?: Contract; contractId?: string; decision?: Decision };
  if (msg.kind === "decide" && msg.contractId) { const w = localWaiters.get(msg.contractId); if (w) { localWaiters.delete(msg.contractId); w.resolve(msg.decision!); } remotePending.delete(msg.contractId); notifyPending(); }
  if (msg.kind === "pending" && msg.contract) { remotePending.set(msg.contract.id, msg.contract); notifyPending(); }
  if (msg.kind === "resolved" && msg.contractId) { remotePending.delete(msg.contractId); notifyPending(); }
  if (msg.kind === "list") for (const w of localWaiters.values()) chan.postMessage({ kind: "pending", contract: w.contract });
});
chan?.postMessage({ kind: "list" });

function waitLocalDecision(c: Contract): Promise<Decision> {
  return new Promise((resolve) => {
    localWaiters.set(c.id, { contract: c, resolve: (d) => { chan?.postMessage({ kind: "resolved", contractId: c.id }); notifyPending(); resolve(d); } });
    chan?.postMessage({ kind: "pending", contract: c });
    notifyPending();
  });
}

export const localPending = {
  /** Stable snapshot (useSyncExternalStore needs the same array until something changes) */
  list: (): Contract[] => pendingSnapshot,
  subscribe: (l: () => void) => { pendingListeners.add(l); return () => { pendingListeners.delete(l); }; },
};
export const isLocalContract = (id: string) => localWaiters.has(id) || remotePending.has(id);

export async function decideContract(contractId: string, decision: Decision): Promise<void> {
  const w = localWaiters.get(contractId);
  if (w) { localWaiters.delete(contractId); w.resolve(decision); return; }
  if (remotePending.has(contractId)) { chan?.postMessage({ kind: "decide", contractId, decision }); remotePending.delete(contractId); notifyPending(); return; }
  await api(`/api/contracts/${encodeURIComponent(contractId)}/${decision === "approved" ? "approve" : "reject"}`, { method: "POST", body: "{}" });
}
