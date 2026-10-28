import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, logLine } from "./decide.ts";
import { classify, isProtected, inWorkspace, absPath } from "./policy.ts";

test("default deny: exec, process, message, web_fetch, apply_patch, unknown tools are blocked", () => {
  for (const t of ["exec", "EXEC", "process", "message", "sessions_send", "web_fetch", "browser", "apply_patch", "file_write", "secrets", "brand_new_tool"]) {
    assert.equal(decide({ toolName: t, params: {} }).block, true, t);
  }
  assert.equal(decide({ toolName: "x", params: {}, toolKind: "code_mode_exec" }).block, true);
});

test("apply_patch is blocked with a message pointing the agent at write/edit (the shadowed file tools)", () => {
  const envelope = "*** Begin Patch\n*** Update File: /sandbox/course/regrades.md\n@@\n-old\n+new\n*** End Patch";
  for (const t of ["apply_patch", "APPLY_PATCH"]) {
    const d = decide({ toolName: t, params: { input: envelope }, derivedPaths: ["/sandbox/course/regrades.md"] });
    assert.equal(d.block, true, t);
    assert.match(d.blockReason!, /Use write or edit to change files instead/);
    assert.match(d.blockReason!, /shadow FS until escrow_commit/);
  }
  // other blocked tools keep the side-effect message
  assert.match(decide({ toolName: "exec", params: {} }).blockReason!, /escrow_send_email/);
});

test("allowed classes: read, shadowed writes, pass-through, escrow tools", () => {
  assert.equal(classify("read"), "read");
  assert.equal(classify("write"), "shadow");
  assert.equal(classify("edit"), "shadow");
  assert.equal(classify("memory_search"), "pass");
  assert.equal(classify("escrow_send_email"), "escrow");
  assert.equal(classify("escrow_commit"), "escrow");
});

test("self-protection: escrow state, nemoclaw, openclaw config/extensions are protected; openclaw workspace is not", () => {
  for (const p of ["/sandbox/.escrow/outbox/x.json", "/sandbox/.escrow", "/sandbox/.nemoclaw/config.json", "/sandbox/.openclaw/extensions/escrow-hook/dist/index.js", "/sandbox/.openclaw/openclaw.json"]) {
    assert.equal(isProtected(p), true, p);
  }
  assert.equal(isProtected("/sandbox/.openclaw/workspace/notes.md"), false);
  assert.equal(isProtected("/sandbox/course/regrades.md"), false);
  assert.equal(isProtected("/sandbox/.escrowx/y"), false); // prefix match is per path segment
});

test("workspace bounds and relative path resolution", () => {
  assert.equal(inWorkspace("/sandbox/course/a.md"), true);
  assert.equal(inWorkspace("/tmp/a.md"), false);
  assert.equal(inWorkspace("/sandbox"), false);
  assert.equal(absPath("notes.md", "/sandbox/.openclaw/workspace"), "/sandbox/.openclaw/workspace/notes.md");
  assert.equal(absPath("/sandbox/course/../.escrow/x", "/"), "/sandbox/.escrow/x");
  assert.equal(isProtected(absPath("/sandbox/course/../.escrow/x", "/")!), true);
});

test("log line carries tool name, full params, decision, extras", () => {
  const ev = { toolName: "exec", params: { command: "ls -la" } };
  const j = JSON.parse(logLine(ev, { sessionKey: "s1" }, decide(ev), { class: "block" }));
  assert.equal(j.tool, "exec");
  assert.deepEqual(j.params, { command: "ls -la" });
  assert.equal(j.decision, "blocked");
  assert.equal(j.class, "block");
  assert.equal(j.sessionKey, "s1");
});

test("instructor-owned memory, skills, and course records are protected; the rest of the workspace is not", async () => {
  const { isProtected } = await import("./policy.ts");
  assert.equal(isProtected("/sandbox/.openclaw/workspace/MEMORY.md"), true);
  assert.equal(isProtected("/sandbox/.openclaw/workspace/skills/regrade/SKILL.md"), true);
  assert.equal(isProtected("/sandbox/course/records/PSU-90412277.json"), true);
  assert.equal(isProtected("/sandbox/course/roster.md"), true);
  assert.equal(isProtected("/sandbox/.openclaw/workspace/notes/regrade-x.md"), false);
  assert.equal(isProtected("/sandbox/.openclaw/workspace/memory/2026-10-26.md"), false);
});
