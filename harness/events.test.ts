import { test } from "node:test";
import assert from "node:assert/strict";
import { fromAudit, fromProxy, fromSender, EventBus, costOf } from "./events.ts";

test("fromAudit: a shadowed write becomes tool_call + shadow_write, keyed by the plain lowercase session id", () => {
  const evs = fromAudit({ ts: "t", hook: "before_tool_call", tool: "write", class: "shadow", decision: "allowed", sessionId: "p2-X", sessionKey: "agent:main:explicit:p2-x",
    params: { path: "notes/a.md" }, rewritten: { path: "/sandbox/.escrow/shadow/s/notes/a.md" }, note: "write held in shadow until escrow_commit" });
  assert.deepEqual(evs.map((e) => e.type), ["tool_call", "shadow_write"]);
  assert.equal(evs[0].sessionId, "p2-x");
  assert.equal(evs[1].shadowPath, "/sandbox/.escrow/shadow/s/notes/a.md");
});

test("fromAudit: plugin events map to queue / tier verdict / judge call / commit", () => {
  const s = "agent:main:explicit:p2-y";
  assert.equal(fromAudit({ event: "enqueue", session: s, id: "eff-1", kind: "send_email", to: ["a@b.c"] })[0].type, "effect_queued");
  const tier = fromAudit({ event: "verify_tier", session: s, tier: "R4-fingerprint", ok: false, ms: 0.4, violations: [{ rule: "R4-fingerprint" }] })[0];
  assert.equal(tier.type, "tier_verdict"); assert.equal(tier.ok, false); assert.equal(tier.sessionId, "p2-y");
  const j = fromAudit({ event: "judge_call", session: s, model: "nvidia/nemotron-3-super-120b-a12b", ms: 1500, promptTokens: 1000, completionTokens: 100, leak: true, vote: 0 })[0];
  assert.equal(j.type, "judge_call"); assert.ok(Math.abs((j.usd as number) - (1000 * 0.0000003 + 100 * 0.0000009)) < 1e-12);
  assert.equal(fromAudit({ event: "commit_blocked", session: s, violations: [] })[0].ok, false);
  assert.equal(fromAudit({ event: "commit_refused", session: s, error: "judge unavailable" })[0].failClosed, true);
  assert.deepEqual(fromAudit({ event: "register" }), []);
});

test("fromProxy: model, latency, tokens, cost, and an inferred role", () => {
  const agent = fromProxy({ ts: "t", event: "call", model: "nvidia/nemotron-3-super-120b-a12b", runId: "anon-1", ms: 2000, usage: { promptTokens: 26000, completionTokens: 80 }, usd: 0.0079 })[0];
  assert.equal(agent.role, "agent"); assert.equal(agent.ms, 2000); assert.equal(agent.usd, 0.0079);
  assert.equal(fromProxy({ event: "call", model: "nvidia/nemotron-3-super-120b-a12b", usage: { promptTokens: 700 } })[0].role, "judge");
  assert.equal(fromProxy({ event: "call", model: "nvidia/Nemotron-3-Ultra-550b-a55b", usage: { promptTokens: 700 } })[0].role, "contract");
  assert.deepEqual(fromProxy({ event: "blocked" }), []);
});

test("fromSender + bus: outbox sends get a seq, and the backlog is bounded", () => {
  const e = fromSender({ ts: "t", event: "sent", id: "eff-1", sessionId: "agent:main:explicit:p2-z", kind: "send_email", payload: { to: ["a@b.c"], subject: "s" } })[0];
  assert.equal(e.type, "outbox_send"); assert.equal(e.sessionId, "p2-z"); assert.equal(e.status, "sent");
  const bus = new EventBus(3);
  for (let i = 0; i < 5; i++) bus.publish({ type: "run_phase", phase: String(i) });
  assert.deepEqual(bus.backlog.map((x) => x.seq), [3, 4, 5]);
  assert.equal(costOf("unknown-model", 10, 10), undefined);
});

test("deriveTierVerdicts: rebuilds per-tier verdicts from an old commit record, marked derived", async () => {
  const { deriveTierVerdicts } = await import("./events.ts");
  const blockedByR4 = deriveTierVerdicts([{ event: "commit_blocked", session: "s", judged: false, violations: [{ rule: "R4-fingerprint" }] }]);
  assert.deepEqual(blockedByR4.map((t) => [t.tier, t.ok, t.skipped ?? ""]), [
    ["C1-contract", true, ""], ["R0-R3-exact-canary", true, ""], ["R4-fingerprint", false, ""], ["R5-super-judge", true, "a deterministic tier already blocked"]]);
  assert.ok(blockedByR4.every((t) => t.derived === true && t.ms === null));
  const blockedByJudge = deriveTierVerdicts([{ event: "commit_blocked", judged: true, violations: [{ rule: "R5-super-judge" }] }]);
  assert.deepEqual(blockedByJudge.map((t) => t.ok), [true, true, true, false]);
  assert.deepEqual(deriveTierVerdicts([{ event: "verify_tier" }, { event: "commit" }]), []); // new transcripts carry real verdicts
});
