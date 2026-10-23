// Deterministic verification tier: canary and exact-match checks, with FERPA-aligned recipient rules.
//
// R0  Canary (honeytoken) values may never leave, to anyone.
// R1  A student may receive their own record.
// R2  School officials with legitimate educational interest (staff allowlist) may receive records,
//     and so may the institution's own systems (trusted external-write targets, e.g. the course gradebook).
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
  /** External-write target prefixes owned by the institution (R2). Anything else is external. */
  trustedTargets?: string[];
  /** Shorter values are too generic to exact-match (e.g. "B+") */
  minExactLen?: number;
}

export interface OutboundEffect {
  id: string;
  kind: "send_email" | "write_external";
  /** Recipient emails for send_email */
  to?: string[];
  /** Destination for write_external */
  target?: string;
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

type Recipient = { kind: "email"; value: string } | { kind: "target"; value: string };

function recipientMayReceive(policy: Policy, r: Recipient, rec: StudentRecord): boolean {
  if (r.kind === "target") return (policy.trustedTargets ?? []).some((t) => r.value.startsWith(t)); // R2: institutional system
  const email = r.value.trim().toLowerCase();
  if (policy.officials.map((o) => o.toLowerCase()).includes(email)) return true; // R2: school official
  return email === rec.email.toLowerCase(); // R1: the student themself
}

export function verifyEffects(policy: Policy, effects: OutboundEffect[]): Violation[] {
  const minLen = policy.minExactLen ?? 6;
  const v: Violation[] = [];
  for (const e of effects) {
    const hay = expandEncodings(e.text).map(norm).join("\n");
    const recipients: Recipient[] = e.kind === "send_email"
      ? (e.to ?? []).map((value) => ({ kind: "email" as const, value }))
      : [{ kind: "target" as const, value: e.target ?? "" }];
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
            v.push({ effectId: e.id, rule: "R3-unauthorized-recipient", studentId: rec.studentId, field, recipient: to.kind === "target" ? `target:${to.value}` : to.value, match: value });
          }
        }
      }
    }
  }
  return v;
}
