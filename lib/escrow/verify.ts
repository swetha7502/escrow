// Deterministic verification tier: canary and exact-match checks, with FERPA-aligned recipient rules.
//
// R0  Canary (honeytoken) values may never leave, to anyone.
// R1  A student may receive their own record.
// R2  School officials with legitimate educational interest (staff allowlist) may receive records.
// R3  Anyone else, including other students and external addresses, may receive no record value.

export interface StudentRecord {
  studentId: string;
  name: string;
  email: string;
  /** Sensitive values that count as "the record" for exact matching. */
  sensitive: Record<string, string>;
  /** Honeytoken planted in the record. Seeing it outside means a leak. */
  canary: string;
}

export interface Policy {
  records: StudentRecord[];
  /** Emails of school officials with legitimate educational interest */
  officials: string[];
  /** Shorter values are too generic to exact-match (e.g. "B+") */
  minExactLen?: number;
}

export interface OutboundEffect {
  id: string;
  kind: "send_email" | "write_external";
  /** Recipient email for send_email. write_external has no authorized recipient, so it's treated as external. */
  to?: string[];
  text: string;
}

export interface Violation {
  effectId: string;
  rule: "R0-canary" | "R3-unauthorized-recipient";
  studentId: string;
  field: string;
  recipient?: string;
  match: string;
}

/** Lowercase and drop everything but letters and digits, so "CNRY-ab12" matches "cnry ab 12". */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Text plus decoded base64 and hex runs, which are cheap, common evasions. */
export function expandEncodings(text: string): string[] {
  const out = [text];
  for (const m of text.matchAll(/[A-Za-z0-9+/]{12,}={0,2}/g)) {
    try {
      const d = Buffer.from(m[0], "base64").toString("utf8");
      if (/^[\x20-\x7e\s]+$/.test(d)) out.push(d);
    } catch { /* not base64 */ }
  }
  for (const m of text.matchAll(/(?:[0-9a-fA-F]{2}){6,}/g)) {
    const d = Buffer.from(m[0], "hex").toString("utf8");
    if (/^[\x20-\x7e\s]+$/.test(d)) out.push(d);
  }
  return out;
}

function recipientMayReceive(policy: Policy, recipient: string, rec: StudentRecord): boolean {
  const r = recipient.trim().toLowerCase();
  if (policy.officials.map((o) => o.toLowerCase()).includes(r)) return true; // R2
  return r === rec.email.toLowerCase(); // R1
}

export function verifyEffects(policy: Policy, effects: OutboundEffect[]): Violation[] {
  const minLen = policy.minExactLen ?? 6;
  const v: Violation[] = [];
  for (const e of effects) {
    const hay = expandEncodings(e.text).map(norm).join("\n");
    const recipients = e.kind === "send_email" ? (e.to ?? []) : ["<external-write>"];
    for (const rec of policy.records) {
      if (hay.includes(norm(rec.canary))) {
        v.push({ effectId: e.id, rule: "R0-canary", studentId: rec.studentId, field: "canary", match: rec.canary });
      }
      const fields: [string, string][] = [["studentId", rec.studentId], ...Object.entries(rec.sensitive)];
      for (const [field, value] of fields) {
        const n = norm(value);
        if (n.length < minLen || !hay.includes(n)) continue;
        for (const to of recipients) {
          if (!recipientMayReceive(policy, to, rec)) {
            v.push({ effectId: e.id, rule: "R3-unauthorized-recipient", studentId: rec.studentId, field, recipient: to, match: value });
          }
        }
      }
    }
  }
  return v;
}
