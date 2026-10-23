import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, logLine } from "./decide.ts";

test("blocks exec and process, allows others", () => {
  assert.equal(decide({ toolName: "exec", params: { command: "curl example.com" } }).block, true);
  assert.equal(decide({ toolName: "EXEC", params: {} }).block, true);
  assert.equal(decide({ toolName: "process", params: {} }).block, true);
  assert.equal(decide({ toolName: "x", params: {}, toolKind: "code_mode_exec" }).block, true);
  assert.equal(decide({ toolName: "read", params: { path: "/a" } }).block, false);
});

test("log line carries tool name, full params, decision", () => {
  const ev = { toolName: "exec", params: { command: "ls -la" } };
  const j = JSON.parse(logLine(ev, { sessionKey: "s1" }, decide(ev)));
  assert.equal(j.tool, "exec");
  assert.deepEqual(j.params, { command: "ls -la" });
  assert.equal(j.decision, "blocked");
  assert.equal(j.sessionKey, "s1");
});
