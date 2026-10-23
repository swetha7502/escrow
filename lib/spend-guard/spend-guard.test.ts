import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SpendGuard, initState, setCap, readState, loadPricesFromMarkdown, parseExpiry,
  HARD_CAP_USD, MAX_RUNS_PER_UTC_DAY, type Prices,
} from "./index.ts";

const prices: Prices = {
  "m/super": { prompt: 0.0000003, completion: 0.0000009 },
  "m/ultra": { prompt: 0.000001, completion: 0.000003 },
};

function setup(opts: { cap?: number; expiry?: string; now?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  const statePath = join(dir, "spend.json");
  initState(statePath, opts.cap ?? 15);
  let now = new Date(opts.now ?? "2026-10-23T12:00:00Z");
  const guard = new SpendGuard({ statePath, prices, creditExpiry: opts.expiry ?? "2026-12-15", now: () => now });
  return { dir, statePath, guard, setNow: (d: string) => { now = new Date(d); }, cleanup: () => rmSync(dir, { recursive: true }) };
}

const small = { promptTokens: 1000, completionTokens: 1000 };

test("allows a call under the cap and records cost per model", () => {
  const t = setup();
  const d = t.guard.check({ model: "m/super", maxUsage: small, runId: "r1" });
  assert.ok(d.ok);
  const res = t.guard.commit(d.reservation, { promptTokens: 100, completionTokens: 50 });
  assert.equal(res.usd, 100 * 0.0000003 + 50 * 0.0000009);
  const s = readState(t.statePath);
  assert.equal(s.byModel["m/super"].calls, 1);
  assert.equal(s.byModel["m/super"].promptTokens, 100);
  assert.equal(s.totalUsd, res.usd);
  t.cleanup();
});

test("cached mode when the worst case would cross the cap", () => {
  const t = setup({ cap: 0.001 });
  // ultra: 1000*1e-6 + 1000*3e-6 = 0.004 > 0.001
  const d = t.guard.check({ model: "m/ultra", maxUsage: small });
  assert.equal(d.ok, false);
  if (!d.ok) { assert.equal(d.mode, "cached"); assert.equal(d.code, "cap_reached"); }
  t.cleanup();
});

test("in-flight reservations count toward the cap", () => {
  const t = setup({ cap: 0.005 });
  const a = t.guard.check({ model: "m/ultra", maxUsage: small, runId: "r" }); // 0.004 reserved
  assert.ok(a.ok);
  const b = t.guard.check({ model: "m/ultra", maxUsage: small, runId: "r" });
  assert.equal(b.ok, false);
  t.cleanup();
});

test("usage unknown → charges full reservation", () => {
  const t = setup();
  const d = t.guard.check({ model: "m/ultra", maxUsage: small, runId: "r" });
  assert.ok(d.ok);
  const r = t.guard.commit(d.reservation, null);
  assert.equal(r.usd, 0.004);
  t.cleanup();
});

test("spend.json cap cannot exceed the hard cap", () => {
  const t = setup();
  const s = setCap(t.statePath, 1000);
  assert.equal(s.capUsd, HARD_CAP_USD);
  // hand-edit above the ceiling: effective cap is still 15
  const raw = JSON.parse(readFileSync(t.statePath, "utf8"));
  raw.capUsd = 1e6; raw.byModel = { "m/ultra": { calls: 1, promptTokens: 0, completionTokens: 0, usd: 14.999 } }; raw.totalUsd = 14.999;
  writeFileSync(t.statePath, JSON.stringify(raw));
  const d = t.guard.check({ model: "m/ultra", maxUsage: small });
  assert.equal(d.ok, false);
  t.cleanup();
});

test("fail closed: missing spend.json", () => {
  const t = setup();
  rmSync(t.statePath);
  const d = t.guard.check({ model: "m/super", maxUsage: small });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "state_missing");
  t.cleanup();
});

test("fail closed: corrupt spend.json (bad JSON, wrong shape, tampered total)", () => {
  const t = setup();
  for (const body of ["{not json", "[]", JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, capUsd: 15, totalUsd: 0, byModel: { x: { calls: 1, promptTokens: 1, completionTokens: 1, usd: 5 } }, runs: {}, updatedAt: "x" })]) {
    writeFileSync(t.statePath, body);
    const d = t.guard.check({ model: "m/super", maxUsage: small });
    assert.equal(d.ok, false, body);
    if (!d.ok) assert.equal(d.code, "state_corrupt", body);
  }
  t.cleanup();
});

test("stops at and after CREDIT_EXPIRY (00:00 UTC on that date)", () => {
  const t = setup({ expiry: "2026-12-15" });
  t.setNow("2026-12-14T23:59:59Z");
  assert.ok(t.guard.check({ model: "m/super", maxUsage: small, runId: "a" }).ok);
  t.setNow("2026-12-15T00:00:00Z");
  const d = t.guard.check({ model: "m/super", maxUsage: small, runId: "a" });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "credit_expired");
  t.cleanup();
});

test("fail closed: missing or invalid CREDIT_EXPIRY", () => {
  for (const expiry of [undefined, "", "soon"]) {
    const dir = mkdtempSync(join(tmpdir(), "spend-"));
    const statePath = join(dir, "spend.json");
    initState(statePath);
    const g = new SpendGuard({ statePath, prices, creditExpiry: expiry });
    const d = g.check({ model: "m/super", maxUsage: small });
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.code, "expiry_invalid");
    rmSync(dir, { recursive: true });
  }
});

test("unknown model is refused", () => {
  const t = setup();
  const d = t.guard.check({ model: "someone/else", maxUsage: small });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "unknown_model");
  t.cleanup();
});

test("daily run limit: 20 per UTC day, resets the next day, same run id is free", () => {
  const t = setup();
  for (let i = 0; i < MAX_RUNS_PER_UTC_DAY; i++) {
    const d = t.guard.check({ model: "m/super", maxUsage: small, runId: `run-${i}` });
    assert.ok(d.ok, `run ${i}`);
    t.guard.release(d.reservation);
  }
  const over = t.guard.check({ model: "m/super", maxUsage: small, runId: "run-20" });
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.code, "daily_run_limit");
  // an existing run can keep calling
  assert.ok(t.guard.check({ model: "m/super", maxUsage: small, runId: "run-3" }).ok);
  t.setNow("2026-10-24T00:00:01Z");
  assert.ok(t.guard.check({ model: "m/super", maxUsage: small, runId: "run-20" }).ok);
  t.cleanup();
});

test("anonymous calls group into one run by idle gap", () => {
  const t = setup();
  const a = t.guard.check({ model: "m/super", maxUsage: small });
  t.setNow("2026-10-23T12:05:00Z");
  const b = t.guard.check({ model: "m/super", maxUsage: small });
  t.setNow("2026-10-23T12:30:00Z");
  const c = t.guard.check({ model: "m/super", maxUsage: small });
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(a.reservation.runId, b.reservation.runId);
  assert.notEqual(b.reservation.runId, c.reservation.runId);
  assert.equal(readState(t.statePath).runs["2026-10-23"].length, 2);
  t.cleanup();
});

test("commit failure latches the guard closed", () => {
  const t = setup();
  const d = t.guard.check({ model: "m/super", maxUsage: small, runId: "r" });
  assert.ok(d.ok);
  writeFileSync(t.statePath, "garbage");
  assert.throws(() => t.guard.commit(d.reservation, small));
  initStateOver(t.statePath);
  const after = t.guard.check({ model: "m/super", maxUsage: small, runId: "r" });
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.code, "state_write_failed");
  t.cleanup();
});

function initStateOver(p: string) { rmSync(p); initState(p); }

test("initState refuses to overwrite", () => {
  const t = setup();
  assert.throws(() => initState(t.statePath));
  t.cleanup();
});

test("parseExpiry and price table parsing", () => {
  assert.equal(parseExpiry("2026-12-15")?.toISOString(), "2026-12-15T00:00:00.000Z");
  assert.equal(parseExpiry("nope"), null);
  const md = readFileSync(new URL("../../docs/models.md", import.meta.url), "utf8");
  const p = loadPricesFromMarkdown(md);
  assert.deepEqual(p["nvidia/nemotron-3-super-120b-a12b"], { prompt: 0.0000003, completion: 0.0000009 });
  assert.equal(Object.keys(p).length, 3);
});
