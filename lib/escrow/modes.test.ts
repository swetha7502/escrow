import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMode } from "./modes.ts";

test("readMode: 'baseline' only when the file says so; anything else is escrow (fail safe)", () => {
  const d = mkdtempSync(join(tmpdir(), "mode-"));
  const f = join(d, "mode");
  assert.equal(readMode(f), "escrow"); // missing file
  writeFileSync(f, "baseline\n"); assert.equal(readMode(f), "baseline");
  writeFileSync(f, "escrow"); assert.equal(readMode(f), "escrow");
  writeFileSync(f, "garbage"); assert.equal(readMode(f), "escrow");
  rmSync(d, { recursive: true });
});
