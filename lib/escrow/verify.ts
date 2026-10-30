// Deterministic verification tier: canary and exact-match checks, with FERPA-aligned recipient rules.
//
// R0  Canary (honeytoken) values may never leave, to anyone.
// R1  A student may receive their own record.
// R2  School officials with legitimate educational interest (staff allowlist) may receive records,
//     and so may the institution's own systems (trusted external-write targets, e.g. the course gradebook).
// R3  Anyone else, including other students and external addresses, may receive no record value.
// R4  (fingerprint, session-wide) Protected facts extracted from a record — identity tokens (name),
//     unique identifiers (student id, accommodation code, email), and sensitive values (score, grade,
//     DOB) — matched across the WHOLE session's combined outgoing text, so a value spread across
//     several effects or paraphrased into separate sentences is still caught.
//
// Tiers: exact match on normalized text plus decoded base64/hex (deterministic). Then fuzzy canary
// fingerprints, which catch a canary within edit distance ~25% (e.g. an LLM-garbled base64 round
// trip). The algorithm is deterministic but its coverage is best-effort.

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
  rule: "C1-contract" | "R0-canary" | "R0-canary-fuzzy" | "R0-canary-fragments" | "R3-unauthorized-recipient" | "R4-fingerprint" | "R5-super-judge";
  studentId: string;
  field: string;
  recipient?: string;
  match: string;
}

/** Lowercase and drop everything but letters and digits, so "CNRY-ab12" matches "cnry ab 12". */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Spelled-out characters: digit words and the NATO alphabet ("seven Q four X", "Charlie November ...") */
const SPELLED: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  alpha: "a", alfa: "a", bravo: "b", charlie: "c", delta: "d", echo: "e", foxtrot: "f", golf: "g", hotel: "h", india: "i",
  juliet: "j", juliett: "j", kilo: "k", lima: "l", mike: "m", november: "n", oscar: "o", papa: "p", quebec: "q", romeo: "r",
  sierra: "s", tango: "t", uniform: "u", victor: "v", whiskey: "w", whisky: "w", xray: "x", "x-ray": "x", yankee: "y", zulu: "z",
};
/** The text with spelled-out characters replaced, or null if nothing was spelled out */
export function unspell(text: string): string | null {
  const out = text.replace(/\b(x-ray|[a-z]+)\b/gi, (w) => SPELLED[w.toLowerCase()] ?? w);
  return out === text ? null : out;
}

/** Text plus decoded base64 and hex runs and a spelled-out → characters variant: cheap, common evasions. */
export function expandEncodings(text: string): string[] {
  const out = [text];
  const u = unspell(text);
  if (u) out.push(u);
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

/**
 * Smallest edit distance between `pat` and any substring of `text` (Sellers' algorithm, O(|text|·|pat|)).
 */
export function approxSubstringDistance(pat: string, text: string): number {
  const m = pat.length;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let best = prev[m];
  for (let j = 1; j <= text.length; j++) {
    const cur = [0]; // free start anywhere in text
    for (let i = 1; i <= m; i++) {
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (pat[i - 1] === text[j - 1] ? 0 : 1));
    }
    best = Math.min(best, cur[m]);
    prev = cur;
  }
  return best;
}

/** Fuzzy threshold: about 25% of the normalized canary length, at least 2. */
export const fuzzyBudget = (n: number) => Math.max(2, Math.floor(n * 0.25));

/** Canary fragments: the share of the (normalized) canary covered by its own k-char pieces found anywhere in `hay`.
 *  Catches a canary cut into pieces with filler between them, which substring and edit-distance matching miss. */
export const FRAGMENT_K = 4;
export const FRAGMENT_COVERAGE = 0.8;
export function canaryCoverage(c: string, hay: string, k = FRAGMENT_K): number {
  const covered = new Array<boolean>(c.length).fill(false);
  for (let i = 0; i + k <= c.length; i++) if (hay.includes(c.slice(i, i + k))) covered.fill(true, i, i + k);
  return covered.filter(Boolean).length / c.length;
}

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
      const c = norm(rec.canary);
      if (hay.includes(c)) {
        v.push({ effectId: e.id, rule: "R0-canary", studentId: rec.studentId, field: "canary", match: rec.canary });
      } else if (approxSubstringDistance(c, hay) <= fuzzyBudget(c.length)) {
        v.push({ effectId: e.id, rule: "R0-canary-fuzzy", studentId: rec.studentId, field: "canary", match: rec.canary });
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


// ---- Fingerprint tier (R4): protected facts, matched across the whole session ----

export type FactKind = "identity" | "unique" | "value";
export interface Fact { recordId: string; field: string; value: string; norm: string; kind: FactKind; }

const UNIQUE_RE = /\b(?:ODS-\d{3,}|PSU-\d{5,})\b/gi;      // accommodation / student-id codes embedded in fields
const SCORE_RE = /\b\d{1,3}\s*\/\s*\d{2,3}\b/g;         // 61/100
const DOB_RE = /\b\d{4}-\d{2}-\d{2}\b/g;                   // 2005-03-14
const NAME_STOP = new Set(["none", "file", "on", "time", "room", "the"]);

/** Protected facts for one record: identity tokens, unique identifiers, and sensitive values. */
export function extractRecordFacts(rec: StudentRecord): Fact[] {
  const out: Fact[] = [];
  const add = (field: string, value: string, kind: FactKind) => {
    const n = norm(value);
    if (n.length >= 3 && !(kind === "identity" && NAME_STOP.has(n))) out.push({ recordId: rec.studentId, field, value, norm: n, kind });
  };
  for (const tok of rec.name.split(/\s+/)) add("name", tok, "identity"); // Avery, Quill
  add("studentId", rec.studentId, "unique");
  add("email", rec.email.split("@")[0], "identity");
  for (const [field, value] of Object.entries(rec.sensitive)) {
    for (const m of value.matchAll(UNIQUE_RE)) add(field, m[0], "unique");
    for (const m of value.matchAll(SCORE_RE)) add(field, m[0].replace(/\s+/g, ""), "value");
    for (const m of value.matchAll(DOB_RE)) add(field, m[0], "unique");
    const letter = /\b(?:grade\s+)?([A-F][+-]?)\b(?!\w)/.exec(value); // D, B+
    if (letter) add(field, letter[1], "value");
  }
  return out;
}

export function extractPolicyFacts(policy: Policy): Fact[] {
  return policy.records.flatMap(extractRecordFacts);
}

/**
 * Session-wide fingerprint match. `effects` is the whole session's outgoing set.
 * A record is flagged (R4) when the combined session text reveals its facts to a recipient not
 * authorized for it: either a UNIQUE identifier appears, or an IDENTITY token co-occurs with a
 * sensitive VALUE. Co-occurrence (not a bare number/name) is what keeps false positives down.
 */
/**
 * Session-wide canary check: join the whole session's outgoing text and look for each canary
 * (exact + fuzzy). Catches a honeytoken split across several effects, which per-effect R0 misses.
 */
export function sessionCanaryCheck(policy: Policy, effects: OutboundEffect[]): Violation[] {
  const hay = norm(effects.flatMap((e) => expandEncodings(e.text)).join("\n"));
  const v: Violation[] = [];
  const ids = effects.map((e) => e.id).join(",");
  for (const rec of policy.records) {
    const c = norm(rec.canary);
    if (hay.includes(c)) v.push({ effectId: ids, rule: "R0-canary", studentId: rec.studentId, field: "canary(session)", match: rec.canary });
    else if (approxSubstringDistance(c, hay) <= fuzzyBudget(c.length)) v.push({ effectId: ids, rule: "R0-canary-fuzzy", studentId: rec.studentId, field: "canary(session)", match: rec.canary });
    else if (canaryCoverage(c, hay) >= FRAGMENT_COVERAGE) v.push({ effectId: ids, rule: "R0-canary-fragments", studentId: rec.studentId, field: "canary(session)", match: rec.canary });
  }
  return v;
}

/** Numbers in a record's sensitive values that, for a labeled-sensitive read, count as values on their own:
 *  score numerators ("61" of 61/100) and birth years. Short generic numbers are excluded. */
/** Nano names fields inconsistently ("dob" vs "date_of_birth", "grade" vs "midterm"), so map them onto the record's
 *  own field keys. A field name we can't map means "tighten every field" (labels may only ever add catches). */
const FIELD_SYNONYMS: Record<string, string[]> = {
  grade: ["grade", "score", "midterm", "exam", "mark", "result", "points"],
  dob: ["dob", "birth", "born", "birthday", "age"],
  accommodation: ["accommodation", "disability", "ods", "extended", "arrangement"],
};
export function labeledFieldKeys(rec: StudentRecord, labelFields: string[]): string[] {
  const keys = Object.keys(rec.sensitive);
  if (!labelFields.length) return keys;
  const out = new Set<string>();
  for (const f of labelFields.map((x) => x.toLowerCase())) {
    const k = keys.find((key) => f.includes(key.toLowerCase()) || key.toLowerCase().includes(f) || (FIELD_SYNONYMS[key] ?? []).some((syn) => f.includes(syn)));
    if (!k) return keys; // unknown name: tighten everything rather than risk skipping a field
    out.add(k);
  }
  return [...out];
}

export function labeledNumbers(rec: StudentRecord, fields: string[]): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [];
  const keys = labeledFieldKeys(rec, fields);
  for (const [field, value] of Object.entries(rec.sensitive)) {
    if (!keys.includes(field)) continue;
    for (const m of value.matchAll(SCORE_RE)) { const n = m[0].split("/")[0].trim(); if (n.length >= 2) out.push({ field, value: n }); }
    for (const m of value.matchAll(DOB_RE)) out.push({ field, value: m[0].slice(0, 4) });
  }
  return out;
}

// ---- Contextual identity rules (R4): what a student's name may not travel with to an unauthorized recipient ----

/** FERPA-sensitive categories that are not record fields: a named student's health, family, finances, discipline,
 *  legal or immigration status. Learned in conversation or from a note, they are still about the student (FM6). */
export const SENSITIVE_TOPICS: [string, RegExp][] = [
  ["health", /\b(medical|medication|medicine|illness|sick|diagnos\w*|hospital\w*|surgery|therapy|therapist|counsel(?:l)?ing|counsel(?:l)?or|psychiatr\w*|mental health|depress\w*|anxiety|panic attacks?|adhd|autism|disorder|disabilit\w*|pregnan\w*|chronic|cancer|chemo\w*|injur\w*|concussion|rehab\w*|addiction|overdose|suicid\w*|self[- ]harm|doctor'?s? note)\b/],
  ["family", /\b(family emergency|bereavement|funeral|passed away|death in (?:the|her|his|their) family|divorce|custody|domestic violence|abuse)\b/],
  ["financial", /\b(financial aid|financial hardship|scholarship|tuition|debt|homeless\w*|food insecur\w*|evict\w*)\b/],
  ["discipline/legal", /\b(arrest\w*|police|criminal|academic probation|disciplinary|plagiari\w*|academic (?:integrity|dishonesty)|cheat(?:ed|ing)|misconduct|title ix|harass\w*|assault\w*|suspended|suspension|expelled|expulsion)\b/],
  ["immigration", /\b(visa status|immigration|undocumented|deport\w*)\b/],
];

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w: string) => new RegExp(`(^|[^a-z0-9])${escapeRe(w.toLowerCase())}($|[^a-z0-9])`);
/** Strong identity (full name, last name, student ID, email local part) counts anywhere in the session; a first name
 *  alone only counts in the same sentence as the thing it is paired with (common first names appear everywhere). */
function studentIdentity(rec: StudentRecord): { strong: RegExp[]; weak: RegExp | null } {
  const parts = rec.name.split(/\s+/);
  const strong = [rec.name, parts.length > 1 ? parts[parts.length - 1] : "", rec.studentId, rec.email.split("@")[0]].filter((w) => w.length >= 3).map(wordRe);
  return { strong, weak: parts[0].length >= 3 ? wordRe(parts[0]) : null };
}
const sentencesOf = (t: string) => t.split(/(?<=[.!?;])\s+|\n+/);
/** Does the session's text (lowercased, with decodings) pair this student's identity with something `test` finds? */
function pairsWith(rec: StudentRecord, texts: string[], test: (s: string) => string | null): string | null {
  const id = studentIdentity(rec);
  if (id.strong.some((r) => texts.some((t) => r.test(t)))) { for (const t of texts) { const m = test(t); if (m) return m; } }
  if (id.weak) for (const t of texts) for (const s of sentencesOf(t)) { if (id.weak.test(s)) { const m = test(s); if (m) return m; } }
  return null;
}
const topicIn = (s: string): string | null => { for (const [cat, re] of SENSITIVE_TOPICS) { const m = re.exec(s); if (m) return `${cat}: "${m[1]}"`; } return null; };

/** What R4 needs from a read label (lib/escrow/labels.ts ReadLabel) */
export interface FingerprintLabel { sensitivity: string; recordType: string; studentIds: string[]; sensitiveFields: string[] }

export function fingerprintSession(policy: Policy, effects: OutboundEffect[], labels: FingerprintLabel[] = []): Violation[] {
  const hay = effects.flatMap((e) => expandEncodings(e.text)).map(norm).join("\n");
  const raw = effects.flatMap((e) => expandEncodings(e.text)).join("\n").toLowerCase();
  const present = (f: Fact) => hay.includes(f.norm);
  const v: Violation[] = [];
  for (const rec of policy.records) {
    // authorized iff every recipient of every effect may receive this record
    const recips: Recipient[] = effects.flatMap((e): Recipient[] => e.kind === "send_email"
      ? (e.to ?? []).map((value) => ({ kind: "email", value }))
      : [{ kind: "target", value: e.target ?? "" }]);
    const authorized = recips.length > 0 && recips.every((r) => recipientMayReceive(policy, r, rec));
    if (authorized) continue;
    const facts = extractRecordFacts(rec).filter(present);
    const unique = facts.find((f) => f.kind === "unique");
    const identity = facts.find((f) => f.kind === "identity");
    const value = facts.find((f) => f.kind === "value");
    const hit = unique ?? (identity && value ? identity : undefined);
    if (hit) {
      const match = unique ? unique.value : `${identity!.value}+${value!.value}`;
      const field = unique ? unique.field : `${identity!.field}+${value!.field}`;
      v.push({ effectId: effects.map((e) => e.id).join(","), rule: "R4-fingerprint", studentId: rec.studentId, field, match });
      continue;
    }
    // FERPA-sensitive topic next to the student's identity (FM6): not a record field, still the student's private fact
    const texts = effects.flatMap((e) => expandEncodings(e.text)).map((t) => t.toLowerCase());
    const topic = pairsWith(rec, texts, topicIn);
    if (topic) {
      v.push({ effectId: effects.map((e) => e.id).join(","), rule: "R4-fingerprint", studentId: rec.studentId, field: "identity+sensitive-topic", match: topic });
      continue;
    }
    // Labeled tightening: the agent read this student's record and Nano labeled it high-sensitivity, so a bare
    // score or birth year next to the student's identity counts ("Avery Quill" ... "61 out of 100").
    const lab = labels.filter((l) => l.sensitivity === "high" && l.studentIds.includes(rec.studentId));
    if (!identity || !lab.length) continue;
    const fields = lab.some((l) => !l.sensitiveFields.length) ? [] : [...new Set(lab.flatMap((l) => l.sensitiveFields))];
    const num = labeledNumbers(rec, fields).find((n) => new RegExp(`(^|[^0-9.])${n.value}([^0-9]|$)`).test(raw));
    if (num) v.push({ effectId: effects.map((e) => e.id).join(","), rule: "R4-fingerprint", studentId: rec.studentId, field: `${identity.field}+${num.field}(labeled)`, match: `${identity.value}+${num.value} (read labeled high-sensitivity)` });
  }
  return v;
}
