import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransactionManager } from "./txn.ts";
import { ShadowFS, PathEscapeError } from "./shadow-fs.ts";
import { verifyEffects, norm } from "./verify.ts";
import { POLICY, RECORDS } from "./fixtures/records.ts";

const [avery, jordan] = RECORDS;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "escrow-"));
  const tm = new TransactionManager({ workspace: join(dir, "ws"), shadowBase: join(dir, "shadow"), outboxDir: join(dir, "outbox"), policy: POLICY });
  const outbox = () => (existsSync(join(dir, "outbox")) ? readdirSync(join(dir, "outbox")).filter((f) => f.endsWith(".json")) : []);
  return { dir, tm, outbox, cleanup: () => rmSync(dir, { recursive: true }) };
}

// ---- M6: transactions + shadow FS ----

test("shadow writes are invisible on disk until commit, visible to the session", () => {
  const t = setup();
  const tx = t.tm.begin("s1");
  tx.writeFile("notes/regrade.md", "draft");
  assert.equal(existsSync(join(t.dir, "ws/notes/regrade.md")), false);
  assert.equal(tx.fs.read("notes/regrade.md").toString(), "draft");
  const r = t.tm.commit("s1");
  assert.ok(r.ok);
  assert.equal(readFileSync(join(t.dir, "ws/notes/regrade.md"), "utf8"), "draft");
  t.cleanup();
});

test("abort discards shadow writes and pending effects", () => {
  const t = setup();
  const tx = t.tm.begin("s1");
  tx.writeFile("a.txt", "x");
  tx.sendEmail(["prof.lin@example.edu"], "hi", "hello");
  t.tm.abort("s1");
  assert.equal(existsSync(join(t.dir, "ws/a.txt")), false);
  assert.deepEqual(t.outbox(), []);
  assert.throws(() => tx.writeFile("b.txt", "y"));
  t.cleanup();
});

test("shadow FS rejects paths escaping the workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfs-"));
  const fs = new ShadowFS(join(dir, "ws"), join(dir, "sh"));
  for (const p of ["../x", "/etc/passwd", "a/../../x", "."]) assert.throws(() => fs.write(p, "z"), PathEscapeError, p);
  rmSync(dir, { recursive: true });
});

test("sessions are isolated", () => {
  const t = setup();
  t.tm.begin("s1").writeFile("f.txt", "one");
  t.tm.begin("s2").writeFile("f.txt", "two");
  t.tm.abort("s1");
  t.tm.commit("s2");
  assert.equal(readFileSync(join(t.dir, "ws/f.txt"), "utf8"), "two");
  t.cleanup();
});

// ---- M7: outbox ----

test("effects reach the outbox only after a clean commit", () => {
  const t = setup();
  const tx = t.tm.begin("s1");
  const id = tx.sendEmail(["prof.lin@example.edu"], "Regrade queue", "3 requests pending.");
  tx.writeExternal("lms://gradebook/notes", "queue reviewed");
  assert.deepEqual(t.outbox(), []);
  const r = t.tm.commit("s1");
  assert.ok(r.ok);
  assert.equal(t.outbox().length, 2);
  const rec = JSON.parse(readFileSync(join(t.dir, "outbox", `${id}.json`), "utf8"));
  assert.equal(rec.status, "committed");
  assert.equal(rec.sessionId, "s1");
  t.cleanup();
});

// ---- M8: canary scenarios ----

test("canary 1: canary in an email to another student blocks commit", () => {
  const t = setup();
  const tx = t.tm.begin("s1");
  tx.sendEmail([jordan.email], "FYI", `Avery's file says ${avery.canary}`);
  const r = t.tm.commit("s1");
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.rule === "R0-canary" && v.studentId === avery.studentId));
  assert.deepEqual(t.outbox(), []);
  t.cleanup();
});

test("canary 2: obfuscated canary (case, separators, base64, hex) is still caught", () => {
  const variants = [
    avery.canary.toLowerCase(),
    avery.canary.replace(/-/g, " "),
    avery.canary.split("").join("."),
    Buffer.from(`ref ${avery.canary}`).toString("base64"),
    Buffer.from(avery.canary).toString("hex"),
  ];
  for (const text of variants) {
    const v = verifyEffects(POLICY, [{ id: "e", kind: "send_email", to: ["prof.lin@example.edu"], text }]);
    assert.ok(v.some((x) => x.rule === "R0-canary"), text);
  }
});

test("canary 3: canary never leaves, even to an authorized official (R0 beats R2)", () => {
  const t = setup();
  t.tm.begin("s1").sendEmail(["prof.lin@example.edu"], "Case", `Internal note ${avery.canary}`);
  const r = t.tm.commit("s1");
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, "R0-canary");
  t.cleanup();
});

test("canary 4: canary in an external file write blocks commit, and the shadow write is discarded", () => {
  const t = setup();
  const tx = t.tm.begin("s1");
  tx.writeFile("local/summary.md", "fine");
  tx.writeExternal("https://pastebin.example/new", `dump: ${jordan.canary}`);
  const r = t.tm.commit("s1");
  assert.equal(r.ok, false);
  assert.equal(existsSync(join(t.dir, "ws/local/summary.md")), false);
  assert.deepEqual(t.outbox(), []);
  t.cleanup();
});

test("canary 5: one leaking effect among clean ones aborts the whole session (all-or-nothing)", () => {
  const t = setup();
  const tx = t.tm.begin("s1");
  tx.sendEmail(["ta.rivera@example.edu"], "Status", "All regrades processed.");
  tx.sendEmail([avery.email], "Your regrade", "Your regrade was approved.");
  tx.sendEmail(["someone@gmail.example"], "lol", `${jordan.canary}`);
  const r = t.tm.commit("s1");
  assert.equal(r.ok, false);
  assert.equal(r.effectsReleased.length, 0);
  assert.deepEqual(t.outbox(), []);
  t.cleanup();
});

// ---- FERPA exact-match rules ----

test("R1: a student may receive their own record", () => {
  const v = verifyEffects(POLICY, [{ id: "e", kind: "send_email", to: [avery.email], text: `ID ${avery.studentId}, ${avery.sensitive.grade}` }]);
  assert.deepEqual(v, []);
});

test("R2: an official with legitimate interest may receive records", () => {
  const v = verifyEffects(POLICY, [{ id: "e", kind: "send_email", to: ["ta.rivera@example.edu"], text: `${jordan.studentId} ${jordan.sensitive.accommodation}` }]);
  assert.deepEqual(v, []);
});

test("R3: another student may not receive a record value (exact match, normalized)", () => {
  const v = verifyEffects(POLICY, [{ id: "e", kind: "send_email", to: [jordan.email], text: `avery's accommodation: extended time 1.5x (ods-4471)` }]);
  assert.ok(v.some((x) => x.rule === "R3-unauthorized-recipient" && x.field === "accommodation" && x.studentId === avery.studentId));
});

test("R3: mixed recipients, so one unauthorized recipient blocks", () => {
  const v = verifyEffects(POLICY, [{ id: "e", kind: "send_email", to: ["prof.lin@example.edu", jordan.email], text: avery.studentId }]);
  assert.equal(v.length, 1);
  assert.equal(v[0].recipient, jordan.email);
});

test("R3: external write of a record value is blocked", () => {
  const v = verifyEffects(POLICY, [{ id: "e", kind: "write_external", text: `dob ${avery.sensitive.dob}` }]);
  assert.equal(v[0].rule, "R3-unauthorized-recipient");
});

test("short generic values don't trigger exact match (no false positives on 'B+')", () => {
  assert.ok(norm("B+").length < 6);
  const v = verifyEffects(POLICY, [{ id: "e", kind: "send_email", to: [jordan.email], text: "Avg grade was a C, top was B+." }]);
  assert.deepEqual(v, []);
});
