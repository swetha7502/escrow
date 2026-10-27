import { test } from "node:test";
import assert from "node:assert/strict";
import { accessConfig, tokenOk, RateLimiter, liveRunsDisabled, wsToken, clientIp } from "./access.ts";

const req = (h: Record<string, string>, ip = "10.0.0.1") => ({ headers: h, socket: { remoteAddress: ip } }) as never;

test("token: unset = open; set = constant-time exact match only", () => {
  assert.equal(tokenOk(accessConfig({}), null), true);
  const c = accessConfig({ ESCROW_ACCESS_TOKEN: "s3cret-demo" });
  assert.equal(tokenOk(c, "s3cret-demo"), true);
  assert.equal(tokenOk(c, "s3cret-dem"), false);
  assert.equal(tokenOk(c, null), false);
  assert.equal(wsToken(req({ "sec-websocket-protocol": "escrow, escrow-token.s3cret-demo" })), "s3cret-demo");
});

test("rate limit: fixed window per kind and IP", () => {
  const rl = new RateLimiter(accessConfig({ ESCROW_RL_RUNS_PER_HOUR: "2" }));
  assert.equal(rl.take("run", "a", 0), 0);
  assert.equal(rl.take("run", "a", 1), 0);
  assert.ok(rl.take("run", "a", 2) > 0);       // third run in the hour: refused with retry-after
  assert.equal(rl.take("run", "b", 3), 0);     // other IP unaffected
  assert.equal(rl.take("run", "a", 3_600_001), 0); // new window
});

test("client IP: CF-Connecting-IP only when the tunnel is trusted; live switch via env", () => {
  assert.equal(clientIp(accessConfig({}), req({ "cf-connecting-ip": "1.2.3.4" }, "127.0.0.1")), "127.0.0.1");
  assert.equal(clientIp(accessConfig({ ESCROW_TRUST_CF: "1" }), req({ "cf-connecting-ip": "1.2.3.4" }, "127.0.0.1")), "1.2.3.4");
  assert.match(liveRunsDisabled({ ESCROW_LIVE_RUNS: "off" })!, /disabled/);
});
