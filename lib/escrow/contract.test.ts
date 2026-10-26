import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContractDraft, contractViolation, recordIdOf, type TaskContract } from "./contract.ts";
import { TransactionManager } from "./txn.ts";
import { POLICY, RECORDS } from "./fixtures/records.ts";

const [avery, jordan] = RECORDS;
const contract = (over: Partial<TaskContract> = {}): TaskContract => ({
  id: "c1", sessionId: "s", request: "regrade", status: "approved", draftedBy: "ultra", createdAt: "",
  allowedRecipients: [avery.email], allowedTargets: ["lms://cmpsc465/gradebook/"], allowedActions: ["read_records", "send_email", "write_file"],
  dataScope: [avery.studentId], rationale: "", ...over,
});

test("parseContractDraft: valid JSON after reasoning, normalized and deduped", () => {
  const d = parseContractDraft(`thinking... {"allowedRecipients":["Avery.Quill@student.example.edu","avery.quill@student.example.edu"],"allowedTargets":[],"allowedActions":["read_records","send_email"],"dataScope":["${avery.studentId}"],"rationale":"own result"}`, POLICY);
  assert.deepEqual(d.allowedRecipients, [avery.email]);
  assert.deepEqual(d.dataScope, [avery.studentId]);
});

test("parseContractDraft: fails closed on bad shapes, unknown actions, non-emails, unknown students", () => {
  assert.throws(() => parseContractDraft("no json here", POLICY));
  assert.throws(() => parseContractDraft('{"allowedRecipients":"x@y.z"}', POLICY));
  assert.throws(() => parseContractDraft('{"allowedActions":["exec"]}', POLICY));
  assert.throws(() => parseContractDraft('{"allowedRecipients":["not-an-email"]}', POLICY));
  assert.throws(() => parseContractDraft('{"dataScope":["PSU-00000000"]}', POLICY));
});

test("contractViolation: recipients, targets, actions, data scope, and unapproved contracts", () => {
  const c = contract();
  assert.equal(contractViolation(c, { kind: "send_email", to: ["AVERY.QUILL@student.example.edu"] }), null);
  assert.match(contractViolation(c, { kind: "send_email", to: [avery.email, "newsletter@outside.example"] })!, /newsletter@outside\.example/);
  assert.equal(contractViolation(c, { kind: "read_records", studentId: avery.studentId }), null);
  assert.match(contractViolation(c, { kind: "read_records", studentId: jordan.studentId })!, /data scope/);
  assert.match(contractViolation(c, { kind: "write_external", target: "lms://cmpsc465/gradebook/x" })!, /not in the task contract/); // action not allowed
  assert.equal(contractViolation(contract({ allowedActions: ["write_external"] }), { kind: "write_external", target: "lms://cmpsc465/gradebook/x" }), null);
  assert.match(contractViolation(contract({ allowedActions: ["write_external"] }), { kind: "write_external", target: "https://pastebin.example" })!, /target/);
  assert.match(contractViolation(contract({ status: "pending" }), { kind: "send_email", to: [avery.email] })!, /pending/);
  assert.match(contractViolation(contract({ status: "rejected" }), { kind: "write_file", path: "/sandbox/x" })!, /rejected/);
});

test("recordIdOf: only exact record paths", () => {
  assert.equal(recordIdOf(`/sandbox/course/records/${avery.studentId}.json`), avery.studentId);
  assert.equal(recordIdOf("/sandbox/course/policy.md"), null);
  assert.equal(recordIdOf("/sandbox/course/records/../policy.md"), null);
});

test("a recorded contract violation blocks the commit even when every effect is clean (all-or-nothing)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "c1-"));
  const tm = new TransactionManager({ workspace: join(dir, "ws"), shadowBase: join(dir, "sh"), outboxDir: join(dir, "out"), policy: POLICY });
  const t = tm.begin("s");
  t.sendEmail([avery.email], "Your regrade", "Your regrade is complete."); // clean and in-contract
  t.violations.push({ effectId: "call-2", rule: "C1-contract", studentId: "", field: "send_email", match: "recipient(s) newsletter@outside.example not in the task contract" });
  const r = await tm.commitWithJudge("s", async () => { throw new Error("judge must not run"); });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, "C1-contract");
  assert.equal(existsSync(join(dir, "out")) ? readdirSync(join(dir, "out")).length : 0, 0);
  rmSync(dir, { recursive: true });
});
