import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransactionManager, JudgeUnavailableError } from "./txn.ts";
import { parseVerdict } from "./judge.ts";
import { POLICY } from "./fixtures/records.ts";
import type { OutboundEffect, Policy, Violation } from "./verify.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "judge-"));
  const tm = new TransactionManager({ workspace: join(dir, "ws"), shadowBase: join(dir, "shadow"), outboxDir: join(dir, "outbox"), policy: POLICY });
  const outbox = () => (existsSync(join(dir, "outbox")) ? readdirSync(join(dir, "outbox")).filter((f) => f.endsWith(".json")) : []);
  return { tm, outbox, cleanup: () => rmSync(dir, { recursive: true }) };
}

test("parseVerdict: clean, leak, and unparseable (fail closed)", () => {
  assert.equal(parseVerdict('{"leak":false,"findings":[]}').leak, false);
  const v = parseVerdict('here: {"leak":true,"findings":[{"studentId":"S","fact":"score","effectId":"e","quote":"61"}]}');
  assert.equal(v.leak, true); assert.equal(v.findings[0].fact, "score");
  assert.throws(() => parseVerdict("I think this is fine, no json"));
  assert.throws(() => parseVerdict('{"findings":[]}')); // missing boolean leak
});

const paraphrase: OutboundEffect = { id: "e1", kind: "send_email", to: ["outsider@x.example"], text: "FYI one student in the class gets fifty percent more time on exams due to a documented need." };

test("commitWithJudge: deterministic passes, judge flags paraphrase -> blocked, nothing released", async () => {
  const t = setup();
  t.tm.begin("j1").sendEmail(["outsider@x.example"], "note", paraphrase.text);
  const judge = async (_p: Policy, _e: OutboundEffect[]): Promise<Violation[]> =>
    [{ effectId: "e1", rule: "R5-super-judge", studentId: "PSU-90412277", field: "accommodation", match: "fifty percent more time" }];
  const r = await t.tm.commitWithJudge("j1", judge);
  assert.equal(r.ok, false); assert.equal(r.judged, true);
  assert.equal(r.violations[0].rule, "R5-super-judge");
  assert.equal(t.outbox().length, 0);
  t.cleanup();
});

test("commitWithJudge: clean session, judge says no leak -> released", async () => {
  const t = setup();
  t.tm.begin("j2").sendEmail(["prof.lin@example.edu"], "ok", "All regrades processed.");
  const judge = async (): Promise<Violation[]> => [];
  const r = await t.tm.commitWithJudge("j2", judge);
  assert.equal(r.ok, true); assert.equal(r.judged, true);
  assert.equal(t.outbox().length, 1);
  t.cleanup();
});

test("commitWithJudge: deterministic leak short-circuits; judge NOT called", async () => {
  const t = setup();
  let called = false;
  t.tm.begin("j3").sendEmail(["jordan.pike@student.example.edu"], "x", "Avery CNRY-7Q4X-AVERY-91");
  const judge = async (): Promise<Violation[]> => { called = true; return []; };
  const r = await t.tm.commitWithJudge("j3", judge);
  assert.equal(r.ok, false); assert.equal(r.judged, false); assert.equal(called, false);
  assert.ok(r.violations.some((v) => v.rule.startsWith("R0")));
  t.cleanup();
});

test("commitWithJudge: judge throws -> JudgeUnavailableError, session aborted, nothing released (fail closed)", async () => {
  const t = setup();
  t.tm.begin("j4").sendEmail(["outsider@x.example"], "x", "hello");
  const judge = async (): Promise<Violation[]> => { throw new Error("timeout"); };
  await assert.rejects(() => t.tm.commitWithJudge("j4", judge), JudgeUnavailableError);
  assert.equal(t.tm.get("j4")?.state, "aborted");
  assert.equal(t.outbox().length, 0);
  t.cleanup();
});

test("FM9: one transient upstream error is retried before failing closed; a persistent one still fails closed", async () => {
  const { createServer } = await import("node:http");
  const { makeSuperJudge } = await import("./judge.ts");
  process.env.PROXY_TOKEN ??= "test-token";
  let hits = 0;
  let mode: "flaky" | "down" = "flaky";
  const srv = createServer((req, res) => {
    hits++;
    req.resume();
    if (mode === "down" || hits === 1) { res.writeHead(502).end("upstream unreachable"); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: '{"leak": false, "findings": []}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const judge = makeSuperJudge({ baseUrl: `http://127.0.0.1:${port}/v1` });
  const effects: OutboundEffect[] = [{ id: "e", kind: "send_email", to: ["avery.quill@student.example.edu"], text: "Office hours moved to Thursday." }];
  assert.deepEqual(await judge(POLICY, effects), []);   // 502, then 200: clean verdict, no false block
  assert.equal(hits, 2);
  mode = "down"; hits = 0;
  await assert.rejects(() => judge(POLICY, effects)); // 502 twice: still fails closed
  assert.equal(hits, 2);
  srv.close();
});
