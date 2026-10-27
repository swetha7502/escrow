import { useState } from "react";
import { motion } from "framer-motion";
import type { Contract } from "../lib/types";
import { studentName } from "../lib/data";
import { decideContract } from "../lib/runner";
import { costOf, usd } from "../lib/models";

const ACTIONS: { id: string; label: string }[] = [
  { id: "read_records", label: "Read student records" },
  { id: "write_file", label: "Write workspace files" },
  { id: "send_email", label: "Send email" },
  { id: "write_external", label: "Write to external systems" },
];

/** The Ultra-drafted task contract, readable, with Approve / Reject. Responsive down to phone width. */
export function ContractPanel({ c, call, onDecided }: { c: Contract; call?: Record<string, unknown>; onDecided?: (d: "approved" | "rejected") => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (d: "approved" | "rejected") => {
    setBusy(true); setErr(null);
    try { await decideContract(c.id, d); onDecided?.(d); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const cost = call ? costOf(call.model, Number(call.promptTokens ?? 0), Number(call.completionTokens ?? 0)) : undefined;
  const link = `${location.origin}${location.pathname}#/approve/${encodeURIComponent(c.id)}`;
  return (
    <motion.div className="contract" initial={{ opacity: 0, y: 20, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}>
      <div className="ch">
        <div className="kicker">Task contract · drafted by Nemotron Ultra</div>
        <h3>{c.status === "pending" ? "Approve what this run may do" : c.status === "approved" ? "Contract approved" : "Contract rejected"}</h3>
        <div className="req">“{c.request}”</div>
      </div>
      <div className="cb">
        <div>
          <div className="lbl">Allowed recipients</div>
          <div className="pills">
            {c.allowedRecipients.length ? c.allowedRecipients.map((r) => <span key={r} className="pill ok">✉ {r}</span>) : <span className="pill none">nobody</span>}
            {c.allowedTargets.map((t) => <span key={t} className="pill ok">⇪ {t}</span>)}
          </div>
        </div>
        <div>
          <div className="lbl">Data scope</div>
          <div className="pills">
            {c.dataScope.length ? c.dataScope.map((s) => <span key={s} className="pill ok">◎ {studentName(s) ?? s} <span className="mono muted" style={{ fontSize: 11 }}>{s}</span></span>) : <span className="pill none">no student records</span>}
          </div>
        </div>
        <div>
          <div className="lbl">Actions</div>
          <div className="pills">
            {ACTIONS.map((a) => { const ok = c.allowedActions.includes(a.id); return <span key={a.id} className={`pill ${ok ? "ok" : "no"}`}>{ok ? "✓" : "✕"} {a.label}</span>; })}
          </div>
        </div>
        {c.rationale && <div><div className="lbl">Ultra's rationale</div><div className="why">{c.rationale}</div></div>}
      </div>
      <div className="cf">
        <div className="meta">
          {String(c.draftedBy).replace("nvidia/", "")}{call ? ` · ${call.ms} ms · ${usd(cost)}` : ""}<br />
          Anything outside this contract is blocked by the hook.
          {c.status === "pending" && <><br /><a href={link} style={{ color: "var(--muted)" }}>Approve from another device ↗</a></>}
        </div>
        {c.status === "pending" ? (
          <>
            <button className="btn big reject" disabled={busy} onClick={() => decide("rejected")}>Reject</button>
            <button className="btn big approve" disabled={busy} onClick={() => decide("approved")}>Approve &amp; run</button>
          </>
        ) : <span className={`decided ${c.status === "approved" ? "ok" : "no"}`}>{c.status === "approved" ? "✓ APPROVED" : "✕ REJECTED"}</span>}
        {err && <div style={{ color: "var(--blocked)", width: "100%", fontSize: 13 }}>Could not record the decision: {err}</div>}
      </div>
    </motion.div>
  );
}
