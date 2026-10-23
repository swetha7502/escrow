import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { SpendGuard, initState, readState, setCap } from "../lib/spend-guard/index.ts";
import { createProxy, assertTokenFactoryUrl, MAX_TOKENS_CEILING } from "./proxy.ts";

const prices = { "m/super": { prompt: 0.0000003, completion: 0.0000009 } };
const TOKEN = "t".repeat(40);

type Seen = { url: string; auth: string | null; body: Record<string, unknown> };

async function setup(upstream: (seen: Seen) => Response) {
  const dir = mkdtempSync(join(tmpdir(), "proxy-"));
  const statePath = join(dir, "spend.json");
  initState(statePath);
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const s = { url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body!.toString()) };
    seen.push(s);
    return upstream(s);
  }) as unknown as typeof fetch;
  const guard = new SpendGuard({ statePath, prices, creditExpiry: "2099-01-01" });
  const server = createProxy({ upstreamBase: "https://api.tokenfactory.nebius.com/v1", upstreamKey: "REAL-KEY", proxyToken: TOKEN, guard, prices, fetchImpl });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (body: unknown, token = TOKEN) => fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return { dir, statePath, seen, base, call, close: () => { server.close(); rmSync(dir, { recursive: true }); } };
}

const ok = () => Response.json({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const msg = { model: "m/super", messages: [{ role: "user", content: "hi" }] };

test("forwards with the real key, meters usage, clamps max_tokens", async () => {
  const t = await setup(ok);
  const r = await t.call({ ...msg, max_tokens: 10 ** 9 });
  assert.equal(r.status, 200);
  assert.equal(t.seen[0].url, "https://api.tokenfactory.nebius.com/v1/chat/completions");
  assert.equal(t.seen[0].auth, "Bearer REAL-KEY");
  assert.equal(t.seen[0].body.max_tokens, MAX_TOKENS_CEILING);
  const s = readState(t.statePath);
  assert.equal(s.byModel["m/super"].promptTokens, 10);
  assert.equal(s.totalUsd, 10 * 0.0000003 + 5 * 0.0000009);
  t.close();
});

test("rejects wrong or missing proxy token (and never forwards it)", async () => {
  const t = await setup(ok);
  assert.equal((await t.call(msg, "REAL-KEY")).status, 401);
  assert.equal(t.seen.length, 0);
  t.close();
});

test("402 cached mode at cap, upstream never called", async () => {
  const t = await setup(ok);
  setCap(t.statePath, 0.000001);
  const r = await t.call(msg);
  assert.equal(r.status, 402);
  assert.equal(r.headers.get("x-escrow-mode"), "cached");
  const j = await r.json() as { error: { code: string; reason_code: string } };
  assert.equal(j.error.code, "cached_mode");
  assert.equal(j.error.reason_code, "cap_reached");
  assert.equal(t.seen.length, 0);
  t.close();
});

test("402 fail-closed when spend.json missing or corrupt", async () => {
  const t = await setup(ok);
  rmSync(t.statePath);
  assert.equal((await t.call(msg)).status, 402);
  writeFileSync(t.statePath, "{oops");
  assert.equal((await t.call(msg)).status, 402);
  assert.equal(t.seen.length, 0);
  t.close();
});

test("unknown model refused with 402", async () => {
  const t = await setup(ok);
  assert.equal((await t.call({ ...msg, model: "other/model" })).status, 402);
  assert.equal(t.seen.length, 0);
  t.close();
});

test("streaming: forces include_usage and meters the final usage chunk", async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "h" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const t = await setup(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  const r = await t.call({ ...msg, stream: true });
  assert.ok((await r.text()).includes("[DONE]"));
  assert.deepEqual(t.seen[0].body.stream_options, { include_usage: true });
  assert.equal(readState(t.statePath).byModel["m/super"].completionTokens, 3);
  t.close();
});

test("2xx without usage is charged the worst case", async () => {
  const t = await setup(() => Response.json({ choices: [] }));
  await t.call({ ...msg, max_tokens: 100 });
  const s = readState(t.statePath);
  assert.ok(s.totalUsd >= 100 * 0.0000009, `charged ${s.totalUsd}`);
  t.close();
});

test("only chat/completions and models are exposed", async () => {
  const t = await setup(ok);
  const r = await fetch(`${t.base}/v1/embeddings`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" });
  assert.equal(r.status, 404);
  t.close();
});

test("upstream URL must be Token Factory over https", () => {
  assert.equal(assertTokenFactoryUrl("https://api.tokenfactory.nebius.com/v1/"), "https://api.tokenfactory.nebius.com/v1");
  for (const u of ["http://api.tokenfactory.nebius.com/v1", "https://evil.example/v1", "https://api.tokenfactory.nebius.com.evil.io/v1", "https://api.tokenfactory.nebius.com:8443/v1"]) {
    assert.throws(() => assertTokenFactoryUrl(u), u);
  }
});
