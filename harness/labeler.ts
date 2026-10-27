// Host-side read labeler: Nemotron Nano labels every course/workspace file the agent reads, and the label is
// written into Escrow's state in the sandbox (labels/<session>.jsonl) for the fingerprint tier to use at commit.
// It runs on the host because inference.local pins every in-sandbox model call to Super. The agent can't read or
// write Escrow's state, so it can't forge labels.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chat } from "../lib/tf-client.ts";
import { LABEL_SYSTEM, labelPrompt, parseLabel, pathLabel, labelable, labelSessionKey, type ReadLabel } from "../lib/escrow/labels.ts";
import { POLICY } from "../lib/escrow/fixtures/records.ts";
import { ESCROW_STATE, sbx } from "./sandbox.ts";

export const LABEL_RUN_ID = "nano-labels"; // one spend-proxy run id for all labeling

/** Label one file's content with Nano; on any failure, fall back to the path (never blocks the pipeline). */
export async function labelContent(path: string, content: string): Promise<ReadLabel> {
  const t0 = Date.now();
  try {
    const r = await chat({ model: "nano", runId: LABEL_RUN_ID, maxTokens: 800, temperature: 0, messages: [{ role: "system", content: LABEL_SYSTEM }, { role: "user", content: labelPrompt(path, content) }] });
    return { ...parseLabel(r.content, path, POLICY), source: "nano", model: r.model, ms: r.ms, ts: new Date().toISOString() };
  } catch (e) {
    return { ...pathLabel(path, POLICY), ms: Date.now() - t0, ts: new Date().toISOString(), error: (e as Error).message.slice(0, 200) };
  }
}

export const labelsPath = (session: string) => `${ESCROW_STATE}/labels/${labelSessionKey(session)}.jsonl`;

// Token Factory's Nano answered in 44–117 s per call when this was built (feedback.md, 2026-10-27), far longer than
// an agent turn. So Nano labels are cached by file content (sha256): a read of a known file gets its Nano label at
// once, and a fresh Nano call re-labels it in the background (stale-while-revalidate). New content waits for Nano.
const CACHE = resolve(import.meta.dirname, "../state/label-cache.json");
type Cache = Record<string, ReadLabel>;
const loadCache = (): Cache => { try { return JSON.parse(readFileSync(CACHE, "utf8")) as Cache; } catch { return {}; } };
const saveCache = (c: Cache) => { mkdirSync(resolve(CACHE, ".."), { recursive: true }); writeFileSync(CACHE, JSON.stringify(c, null, 1)); };
export const contentHash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Nano label for this content: from the cache if known (and re-validated in the background), else a Nano call. */
export async function labelCached(path: string, content: string, opts: { revalidate?: boolean; onFresh?: (l: ReadLabel) => void } = {}): Promise<ReadLabel & { cache: "hit" | "miss" }> {
  const h = contentHash(content);
  const hit = loadCache()[h];
  const fresh = async () => {
    const l = await labelContent(path, content);
    if (l.source === "nano") { const c = loadCache(); c[h] = l; saveCache(c); }
    opts.onFresh?.(l);
    return l;
  };
  if (hit) {
    if (opts.revalidate !== false) void fresh().catch(() => {});
    return { ...hit, path, ts: new Date().toISOString(), cache: "hit" };
  }
  return { ...(await fresh()), cache: "miss" };
}

/** Label the course files once, so the first live read of each is instant. Real Nano calls. */
export async function prewarm(paths = ["/sandbox/course/roster.md", "/sandbox/course/policy.md", ...POLICY.records.map((r) => `/sandbox/course/records/${r.studentId}.json`)]) {
  return Promise.all(paths.map(async (p) => {
    try { const c = await sbx(["head", "-c", "20000", p], { timeoutSec: 20 }); return await labelCached(p, c, { revalidate: false }); } catch (e) { return { path: p, error: (e as Error).message }; }
  }));
}
export const cacheSize = () => (existsSync(CACHE) ? Object.keys(loadCache()).length : 0);

/** Feed audit lines in; every allowed, labelable read gets labeled and written back into the sandbox. */
export function createLabeler(opts: { onLabel?: (session: string, l: ReadLabel & { cache?: string }) => void } = {}) {
  const chains = new Map<string, Promise<void>>(); // one writer per session file
  const onAuditLine = (o: Record<string, unknown>) => {
    if (o.hook !== "before_tool_call" || o.tool !== "read" || o.decision !== "allowed") return;
    const abs = typeof o.abs === "string" ? o.abs : null;
    const session = String(o.sessionKey ?? o.sessionId ?? "");
    if (!abs || !session || !labelable(abs)) return;
    const prev = chains.get(session) ?? Promise.resolve();
    const next = prev.then(async () => {
      let content = "";
      try { content = await sbx(["head", "-c", "20000", abs], { timeoutSec: 20 }); } catch { /* unreadable: label from the path */ }
      const label = content ? await labelCached(abs, content) : { ...pathLabel(abs, POLICY), ts: new Date().toISOString() };
      await sbx(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat >> "$1"', "label", labelsPath(session)], { input: JSON.stringify(label) + "\n" });
      opts.onLabel?.(labelSessionKey(session), label);
    }).catch((e) => console.error(`labeler: ${(e as Error).message}`));
    chains.set(session, next);
  };
  return { onAuditLine };
}

/** All labels written for a session (for transcripts) */
export async function readLabels(session: string): Promise<ReadLabel[]> {
  try {
    const out = await sbx(["sh", "-c", 'cat "$1" 2>/dev/null || true', "labels", labelsPath(session)]);
    return out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as ReadLabel);
  } catch { return []; }
}
