import { useEffect, useState, useSyncExternalStore } from "react";
import { api, backend } from "../lib/backend";
import { localPending } from "../lib/runner";
import { useBackend } from "../lib/hooks";
import { ContractPanel } from "../components/ContractPanel";
import type { Contract } from "../lib/types";

/** Phone-friendly approvals: pending contracts from the API (live runs) and from cached runs in this browser. */
export function ApprovePage({ id }: { id?: string }) {
  const b = useBackend();
  const local = useSyncExternalStore(localPending.subscribe, localPending.list);
  const [remote, setRemote] = useState<Contract[]>([]);
  const [decided, setDecided] = useState<Record<string, Contract>>({});
  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (!backend.get().online) { setRemote([]); return; }
      try { const cs = await api<Contract[]>("/api/contracts", { timeoutMs: 6000 }); if (!stop) setRemote(Array.isArray(cs) ? cs : []); } catch { /* keep the last list */ }
    };
    void load();
    const t = setInterval(load, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [b.online]);
  // Decided contracts stay on screen with their verdict (a cached run's contract leaves the pending list once decided)
  const live = [...local, ...remote.filter((r) => !local.some((l) => l.id === r.id))].filter((c) => !decided[c.id]);
  const all = [...Object.values(decided), ...live];
  const shown = id ? all.filter((c) => c.id === id) : [...Object.values(decided), ...live.filter((c) => c.status === "pending")];
  return (
    <div className="approve-page">
      <div>
        <div className="kicker">Approvals</div>
        <h1>{id ? "Task contract" : "Pending task contracts"}</h1>
        <p className="muted" style={{ margin: "8px 0 0", lineHeight: 1.5 }}>Each run that needs a contract waits here until you decide. The agent does not start before you approve.</p>
      </div>
      {shown.map((c) => <ContractPanel key={c.id} c={c} onDecided={(d) => setDecided((x) => ({ ...x, [c.id]: { ...c, status: d } }))} />)}
      {!shown.length && (
        <div className="empty">
          {id ? <>No contract <span className="mono">{id}</span> here{b.online ? "" : " — the backend is unreachable"}.</> : <>Nothing is waiting for approval.<br />Start the <a href="#/run/C1-contract-out-of-scope/escrow">injected side errand</a> scenario to see one.</>}
        </div>
      )}
    </div>
  );
}
