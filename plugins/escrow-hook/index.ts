import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { TransactionManager, type CommitResult } from "../../lib/escrow/txn.ts";
import type { Policy } from "../../lib/escrow/verify.ts";
import { logLine, type ToolCallEvent, type ToolCallCtx } from "./decide.ts";
import { classify, absPath, isProtected, inWorkspace, pathKey, WORKSPACE_ROOT, ESCROW_STATE } from "./policy.ts";

const DEFAULT_BASE = "/sandbox/.openclaw/workspace";

function loadPolicy(path: string): Policy {
  const p = JSON.parse(readFileSync(path, "utf8")) as Policy;
  if (!Array.isArray(p.records) || !Array.isArray(p.officials)) throw new Error("policy.json malformed");
  return p;
}

function summarize(r: CommitResult): string {
  if (r.ok) return `COMMITTED. Released ${r.effectsReleased.length} effect(s) to the outbox and applied ${r.filesCommitted.length} file(s): ${r.filesCommitted.join(", ") || "none"}.`;
  const v = r.violations.map((x) => `${x.rule} (${x.field} of ${x.studentId}${x.recipient ? ` → ${x.recipient}` : ""})`);
  return `BLOCKED. Verification failed: ${v.join("; ")}. The session was aborted, and no email, external write, or file change was released.`;
}

type Params = Record<string, unknown>;
const text = (t: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: t }], details });

export default definePluginEntry({
  id: "escrow-hook",
  name: "Escrow Hook",
  description: "Escrow safety layer: holds every side effect in escrow until the session is verified.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as { stateDir?: string };
    const stateDir = cfg.stateDir ?? ESCROW_STATE;
    const auditPath = join(stateDir, "audit.jsonl");
    const policyPath = join(stateDir, "policy.json");
    mkdirSync(stateDir, { recursive: true });
    const tm = new TransactionManager({
      workspace: WORKSPACE_ROOT,
      shadowBase: join(stateDir, "shadow"),
      outboxDir: join(stateDir, "outbox"),
      policy: () => loadPolicy(policyPath), // re-read at every commit; missing or bad → commit refused
    });
    const audit = (o: Record<string, unknown>) => appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
    // Resolve the way the file tools do: relative to params.workdir, else the agent workspace
    const resolveTool = (raw: unknown, params: Params) =>
      absPath(raw, typeof params.workdir === "string" && params.workdir.startsWith("/") ? params.workdir : DEFAULT_BASE);
    api.logger.info(`escrow-hook: loaded; state ${stateDir}`);

    api.on("before_tool_call", (event, ctx) => {
      const ev = event as unknown as ToolCallEvent;
      const c = (ctx ?? {}) as ToolCallCtx;
      const session = c.sessionKey ?? c.sessionId ?? ev.runId ?? "unknown";
      const cls = classify(ev.toolName, ev.toolKind);
      let result: { block: true; blockReason: string } | { params: Params } | undefined;
      let note: string | undefined;

      const block = (why: string) => { result = { block: true, blockReason: `Escrow: ${why}` }; };
      const key = pathKey(ev.params ?? {});
      const abs = key ? resolveTool(ev.params[key], ev.params) : null;

      if (cls === "block") {
        block(`tool "${ev.toolName}" is not allowed in this sandbox. Use escrow_send_email / escrow_write_external for side effects.`);
      } else if (cls === "read" && abs) {
        if (abs.startsWith(ESCROW_STATE)) block("Escrow state is not readable.");
        else {
          const s = tm.get(session)?.state === "open" ? tm.get(session)!.fs.shadowed(abs) : null;
          if (s) { result = { params: { ...ev.params, [key!]: s } }; note = `read redirected to shadow`; }
        }
      } else if (cls === "shadow") {
        if (!abs) block("file tools need a path.");
        else if (!inWorkspace(abs)) block(`writes outside ${WORKSPACE_ROOT} are not allowed.`);
        else if (isProtected(abs)) block(`${abs} is protected.`);
        else {
          try {
            const s = tm.begin(session).fs.redirect(abs, { copyOnWrite: ev.toolName.toLowerCase() === "edit" });
            result = { params: { ...ev.params, [key!]: s } };
            note = `write held in shadow until escrow_commit`;
          } catch (e) {
            block(`shadow FS refused: ${(e as Error).message}`);
          }
        }
      }

      const d = result && "block" in result ? { block: true, blockReason: result.blockReason } : { block: false };
      try {
        appendFileSync(auditPath, logLine(ev, c, d, { class: cls, note, rewritten: result && "params" in result ? result.params : undefined }) + "\n");
      } catch (e) {
        api.logger.error(`escrow-hook: audit write failed (${(e as Error).message}); blocking ${ev.toolName}`);
        return { block: true, blockReason: "Escrow: audit log unavailable" };
      }
      return result;
    }, { priority: 1000 });

    // Escrow tools: side effects are queued in the session transaction. Nothing leaves before commit.
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[],
      run: (session: string, p: Params) => ReturnType<typeof text>) =>
      api.registerTool((tc) => ({
        name, label: name, description,
        parameters: { type: "object", properties, required, additionalProperties: false } as never,
        async execute(_id: string, p: Params) {
          const session = tc.sessionKey ?? tc.sessionId ?? "unknown";
          try { return run(session, p); } catch (e) { return text(`Escrow error: ${(e as Error).message}`); }
        },
      }), { name });

    tool("escrow_send_email", "Queue an email. It's held in escrow and only sent after escrow_commit passes verification.",
      { to: { type: "array", items: { type: "string" }, minItems: 1 }, subject: { type: "string" }, body: { type: "string" } }, ["to", "subject", "body"],
      (s, p) => {
        const id = tm.begin(s).sendEmail(p.to as string[], String(p.subject), String(p.body));
        audit({ event: "enqueue", session: s, kind: "send_email", id, to: p.to });
        return text(`Queued email ${id} (held in escrow until escrow_commit).`, { id });
      });

    tool("escrow_write_external", "Queue a write to an external system (LMS, gradebook, file share). Held in escrow until escrow_commit.",
      { target: { type: "string" }, content: { type: "string" } }, ["target", "content"],
      (s, p) => {
        const id = tm.begin(s).writeExternal(String(p.target), String(p.content));
        audit({ event: "enqueue", session: s, kind: "write_external", id, target: p.target });
        return text(`Queued external write ${id} (held in escrow until escrow_commit).`, { id });
      });

    tool("escrow_status", "Show what this session holds in escrow (pending files and effects).", {}, [],
      (s) => {
        const t = tm.get(s);
        if (!t || t.state !== "open") return text("Nothing held in escrow for this session.");
        const files = t.fs.pendingWrites().map((f) => f.path);
        return text(`Pending files: ${files.join(", ") || "none"}. Pending effects: ${t.effects.map((e) => `${e.kind}:${e.id}`).join(", ") || "none"}.`);
      });

    tool("escrow_commit", "Finish the task: verify everything held in escrow and release it (all or nothing). Call this when the task is done.", {}, [],
      (s) => {
        const t = tm.get(s);
        if (!t || t.state !== "open") return text("Nothing to commit.");
        let r: CommitResult;
        try {
          r = tm.commit(s);
        } catch (e) {
          tm.abort(s);
          audit({ event: "commit_refused", session: s, error: (e as Error).message });
          return text(`BLOCKED. Verification unavailable (${(e as Error).message}). The session was aborted and nothing was released.`);
        }
        audit({ event: r.ok ? "commit" : "commit_blocked", session: s, effects: r.effectsReleased, files: r.filesCommitted, violations: r.violations });
        return text(summarize(r), r);
      });

    tool("escrow_abort", "Discard everything held in escrow for this session.", {}, [],
      (s) => {
        tm.abort(s);
        audit({ event: "abort", session: s });
        return text("Aborted. Nothing was released.");
      });
  },
});
