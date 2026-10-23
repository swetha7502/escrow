import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sender, type OutboxTransport, type Effect, type Verifier } from "./sender.ts";

function memTransport(entries: Record<string, string>) {
  const acked: string[] = [];
  const t: OutboxTransport = {
    list: async () => Object.keys(entries).filter((k) => !acked.includes(k)),
    read: async (id) => entries[id],
    ack: async (id) => { acked.push(id); },
  };
  return { t, acked };
}

const eff = (id: string, payload: Record<string, unknown> = { to: "a@b.edu", body: "hi" }): string =>
  JSON.stringify({ id, sessionId: "s1", kind: "send_email", payload, status: "committed", committedAt: "2026-10-23T00:00:00Z" } satisfies Effect);

function setup(entries: Record<string, string>, verify: Verifier = () => ({ ok: true })) {
  const dir = mkdtempSync(join(tmpdir(), "sender-"));
  const m = memTransport(entries);
  const s = new Sender({ transport: m.t, verify, sentLog: join(dir, "sent.log"), seenPath: join(dir, "seen.json") });
  const log = () => readFileSync(join(dir, "sent.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { s, m, dir, log, cleanup: () => rmSync(dir, { recursive: true }) };
}

test("sends committed effects and logs 'sent'", async () => {
  const t = setup({ e1: eff("e1") });
  const r = await t.s.drainOnce();
  assert.deepEqual(r.sent, ["e1"]);
  assert.equal(t.log()[0].event, "sent");
  assert.deepEqual(t.m.acked, ["e1"]);
  t.cleanup();
});

test("host-side verification can veto an effect the sandbox called committed", async () => {
  const t = setup({ e1: eff("e1", { body: "CANARY-123" }) }, (e) => JSON.stringify(e.payload).includes("CANARY") ? { ok: false, reason: "canary" } : { ok: true });
  const r = await t.s.drainOnce();
  assert.equal(r.sent.length, 0);
  assert.equal(r.rejected[0].reason, "canary");
  assert.equal(t.log()[0].event, "rejected");
  t.cleanup();
});

test("malformed, uncommitted, or mismatched entries are rejected", async () => {
  const t = setup({
    bad1: "{not json",
    bad2: JSON.stringify({ ...JSON.parse(eff("bad2")), status: "pending" }),
    bad3: eff("other-id"),
    bad4: JSON.stringify({ ...JSON.parse(eff("bad4")), kind: "exec" }),
  });
  const r = await t.s.drainOnce();
  assert.equal(r.sent.length, 0);
  assert.equal(r.rejected.length, 4);
  t.cleanup();
});

test("exactly-once: a re-listed id is not re-sent", async () => {
  const entries = { e1: eff("e1") };
  const t = setup(entries);
  await t.s.drainOnce();
  t.m.acked.length = 0; // simulate ack lost, entry reappears
  const r = await t.s.drainOnce();
  assert.deepEqual(r.sent, []);
  assert.deepEqual(r.skipped, ["e1"]);
  t.cleanup();
});
