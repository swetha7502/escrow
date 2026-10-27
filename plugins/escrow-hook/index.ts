import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { TransactionManager, buildEmailEffect, buildExternalEffect, type CommitResult } from "../../lib/escrow/txn.ts";
import { readMode, type Mode } from "../../lib/escrow/modes.ts";
import { makeSuperJudge } from "../../lib/escrow/judge.ts";
import { SANDBOX_INFERENCE_URL } from "../../lib/tf-client.ts";
import { JudgeUnavailableError } from "../../lib/escrow/txn.ts";
import type { Policy } from "../../lib/escrow/verify.ts";
import { logLine, type ToolCallEvent, type ToolCallCtx } from "./decide.ts";
import { contractViolation, recordIdOf, type ContractAct, type TaskContract } from "../../lib/escrow/contract.ts";
import { labelable, labelSessionKey, type ReadLabel } from "../../lib/escrow/labels.ts";
import { classify, absPath, isProtected, inWorkspace, pathKey, WORKSPACE_ROOT, ESCROW_STATE } from "./policy.ts";

const DEFAULT_BASE = "/sandbox/.openclaw/workspace";

function loadPolicy(path: string): Policy {
  const p = JSON.parse(readFileSync(path, "utf8")) as Policy;
  if (!Array.isArray(p.records) || !Array.isArray(p.officials)) throw new Error("policy.json malformed");
  return p;
}

function summarize(r: CommitResult): string {
  if (r.ok) return `COMMITTED. Released ${r.effectsReleased.length} effect(s) to the outbox and applied ${r.filesCommitted.length} file(s): ${r.filesCommitted.join(", ") || "none"}.`;
  const v = r.violations.map((x) => x.rule === "C1-contract" ? `${x.rule} (${x.match})` : `${x.rule} (${x.field} of ${x.studentId}${x.recipient ? ` → ${x.recipient}` : ""})`);
  return `BLOCKED. Verification failed: ${v.join("; ")}. The session was aborted, and no email, external write, or file change was released.`;
}

type Params = Record<string, unknown>;
const text = (t: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: t }], details });

export default definePluginEntry({
  id: "escrow-hook",
  name: "Escrow Hook",
  description: "Escrow safety layer: holds every side effect in escrow until the session is verified.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as { stateDir?: string; inferenceUrl?: string };
    const inferenceUrl = cfg.inferenceUrl ?? SANDBOX_INFERENCE_URL;
    const stateDir = cfg.stateDir ?? ESCROW_STATE;
    const auditPath = join(stateDir, "audit.jsonl");
    const policyPath = join(stateDir, "policy.json");
    const modePath = join(stateDir, "mode");
    const mode = (): Mode => readMode(modePath);
    const judgeEnabled = (): boolean => { try { return readFileSync(join(stateDir, "judge"), "utf8").trim() !== "off"; } catch { return true; } };
    // Task contracts (C1). The host writes contracts/<sessionId>.json only after the user approves.
    // When contract-required is "on", a session with no approved contract can't act at all.
    const contractRequired = (): boolean => { try { return readFileSync(join(stateDir, "contract-required"), "utf8").trim() === "on"; } catch { return false; } };
    const contractFor = (sessionId: string): TaskContract | null => {
      try { return JSON.parse(readFileSync(join(stateDir, "contracts", `${sessionId.toLowerCase().replace(/[^\w-]/g, "_")}.json`), "utf8")) as TaskContract; } catch { return null; }
    };
    mkdirSync(stateDir, { recursive: true });
    // One manager per process. OpenClaw may call register() more than once (hot reload, registry
    // rebuilds), and open transactions must survive that. Still in-memory, no WAL.
    const g = globalThis as { __escrowTM?: { tm: TransactionManager; instance: string; reads: Map<string, Set<string>> } };
    g.__escrowTM ??= {
      instance: Math.random().toString(36).slice(2, 8),
      reads: new Map(), // labelable files read per session: the commit waits until each has a Nano label
      tm: new TransactionManager({
        workspace: WORKSPACE_ROOT,
        shadowBase: join(stateDir, "shadow"),
        outboxDir: join(stateDir, "outbox"),
        policy: () => loadPolicy(policyPath), // re-read at every commit; missing or bad → commit refused
      }),
    };
    const { tm, instance } = g.__escrowTM;
    g.__escrowTM.reads ??= new Map();
    const reads = g.__escrowTM.reads;
    // Read labels: the host labeler (harness/labeler.ts) writes labels/<session>.jsonl after Nano labels each read.
    const loadLabels = (s: string): ReadLabel[] => {
      try { return readFileSync(join(stateDir, "labels", `${labelSessionKey(s)}.jsonl`), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as ReadLabel]; } catch { return []; } }); } catch { return []; }
    };
    const labelWaitMs = (): number => { try { return Number(readFileSync(join(stateDir, "label-wait-ms"), "utf8").trim()) || 0; } catch { return 6000; } };
    /** Wait (bounded) until every labelable read in the session has a label. Missing labels just mean plain R4. */
    const labelsFor = async (s: string) => {
      const want = reads.get(labelSessionKey(s)) ?? new Set<string>();
      const deadline = Date.now() + labelWaitMs();
      let got = loadLabels(s);
      while ([...want].some((p) => !got.some((l) => l.path === p)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        got = loadLabels(s);
      }
      return { labels: got.filter((l) => want.has(l.path)), want: want.size };
    };
    const proc = { pid: process.pid, tm: instance };
    const audit = (o: Record<string, unknown>) => appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...proc, mode: mode(), ...o }) + "\n");
    audit({ event: "register" });
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

      // What this call would do, in task-contract terms
      const p = ev.params ?? {};
      const rid = cls === "read" && abs ? recordIdOf(abs) : null;
      const act: ContractAct | null =
        rid ? { kind: "read_records", studentId: rid }
        : cls === "shadow" && abs ? { kind: "write_file", path: abs }
        : ev.toolName === "escrow_send_email" ? { kind: "send_email", to: Array.isArray(p.to) ? p.to.map(String) : [String(p.to ?? "")] }
        : ev.toolName === "escrow_write_external" ? { kind: "write_external", target: String(p.target ?? "") }
        : null;
      const plainSession = c.sessionId ?? session.split(":").pop() ?? session;
      const contract = act ? contractFor(plainSession) : null;
      const breach = act && (contract || contractRequired())
        ? (contract ? contractViolation(contract, act) : "no approved task contract for this session")
        : null;

      if (breach) {
        // Block the call AND poison the session: escrow_commit will refuse to release anything
        tm.begin(session).violations.push({ effectId: ev.toolCallId ?? "-", rule: "C1-contract", studentId: rid ?? "", field: act!.kind, match: breach });
        block(`outside the approved task contract: ${breach}.`);
        note = `contract ${contract?.id ?? "none"}`;
      } else if (cls === "block") {
        block(`tool "${ev.toolName}" is not allowed in this sandbox. Use escrow_send_email / escrow_write_external for side effects.`);
      } else if (cls === "read" && abs) {
        if (abs.startsWith(ESCROW_STATE)) block("Escrow state is not readable.");
        else {
          if (labelable(abs)) { const k = labelSessionKey(session); if (!reads.has(k)) reads.set(k, new Set()); reads.get(k)!.add(abs); note = "label requested"; }
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
        appendFileSync(auditPath, logLine(ev, c, d, { ...proc, class: cls, note, abs: cls === "read" ? abs ?? undefined : undefined, rewritten: result && "params" in result ? result.params : undefined }) + "\n");
      } catch (e) {
        api.logger.error(`escrow-hook: audit write failed (${(e as Error).message}); blocking ${ev.toolName}`);
        return { block: true, blockReason: "Escrow: audit log unavailable" };
      }
      return result;
    }, { priority: 1000 });

    // In baseline mode each effect is checked alone and released immediately (the comparison arm).
    // In escrow mode it is queued and released only by a verified escrow_commit.
    const releaseOrQueue = (s: string, kind: string, e: ReturnType<typeof buildEmailEffect>, extra: Record<string, unknown>) => {
      if (mode() === "baseline") {
        const v = tm.releaseNow(s, e);
        audit({ event: v.length ? "baseline_blocked" : "baseline_released", session: s, kind, id: e.id, violations: v, ...extra });
        return v.length
          ? text(`BASELINE BLOCKED ${e.id}: ${v.map((x) => x.rule).join(", ")}.`, { id: e.id, blocked: true })
          : text(`BASELINE SENT ${e.id} (released immediately; no session verification).`, { id: e.id });
      }
      tm.begin(s).effects.push(e);
      audit({ event: "enqueue", session: s, kind, id: e.id, ...extra });
      return text(`Queued ${kind} ${e.id} (held in escrow until escrow_commit).`, { id: e.id });
    };

    // Escrow tools: side effects are queued in the session transaction. Nothing leaves before commit.
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[],
      run: (session: string, p: Params) => ReturnType<typeof text> | Promise<ReturnType<typeof text>>) =>
      api.registerTool((tc) => ({
        name, label: name, description,
        parameters: { type: "object", properties, required, additionalProperties: false } as never,
        async execute(_id: string, p: Params) {
          const session = tc.sessionKey ?? tc.sessionId ?? "unknown";
          try { return await run(session, p); } catch (e) { return text(`Escrow error: ${(e as Error).message}`); }
        },
      }), { name });

    tool("escrow_send_email", "Queue an email. It's held in escrow and only sent after escrow_commit passes verification.",
      { to: { type: "array", items: { type: "string" }, minItems: 1 }, subject: { type: "string" }, body: { type: "string" } }, ["to", "subject", "body"],
      (s, p) => releaseOrQueue(s, "send_email", buildEmailEffect(p.to as string[], String(p.subject), String(p.body)), { to: p.to }));

    tool("escrow_write_external", "Queue a write to an external system (LMS, gradebook, file share). Held in escrow until escrow_commit.",
      { target: { type: "string" }, content: { type: "string" } }, ["target", "content"],
      (s, p) => releaseOrQueue(s, "write_external", buildExternalEffect(String(p.target), String(p.content)), { target: p.target }));

    tool("escrow_status", "Show what this session holds in escrow (pending files and effects).", {}, [],
      (s) => {
        const t = tm.get(s);
        if (!t || t.state !== "open") return text("Nothing held in escrow for this session.");
        const files = t.fs.pendingWrites().map((f) => f.path);
        return text(`Pending files: ${files.join(", ") || "none"}. Pending effects: ${t.effects.map((e) => `${e.kind}:${e.id}`).join(", ") || "none"}.`);
      });

    tool("escrow_commit", "Finish the task: verify everything held in escrow and release it (all or nothing). Call this when the task is done.", {}, [],
      async (s) => {
        const t = tm.get(s);
        if (!t || t.state !== "open") return text("Nothing to commit.");
        const useJudge = judgeEnabled();
        const lab = await labelsFor(s);
        audit({ event: "labels_used", session: s, want: lab.want, labels: lab.labels.map((l) => ({ path: l.path, recordType: l.recordType, sensitivity: l.sensitivity, studentIds: l.studentIds, sensitiveFields: l.sensitiveFields, source: l.source })) });
        let r: CommitResult & { judged?: boolean };
        try {
          r = await tm.commitWithJudge(s,
            useJudge ? makeSuperJudge({ runId: `judge-${s}`.slice(0, 120), baseUrl: inferenceUrl, onCall: (c) => audit({ event: "judge_call", session: s, ...c }) }) : undefined,
            (t) => audit({ event: "verify_tier", session: s, ...t, ...(t.tier === "R4-fingerprint" ? { labels: `${lab.labels.length}/${lab.want}` } : {}) }), lab.labels);
        } catch (e) {
          tm.abort(s);
          const why = e instanceof JudgeUnavailableError ? `judge unavailable (${e.message})` : (e as Error).message;
          audit({ event: "commit_refused", session: s, error: why });
          return text(`BLOCKED (fail closed). Verification unavailable: ${why}. The session was aborted and nothing was released.`);
        }
        audit({ event: r.ok ? "commit" : "commit_blocked", session: s, judged: r.judged, effects: r.effectsReleased, files: r.filesCommitted, violations: r.violations });
        return text(summarize(r) + (r.judged ? " [Super judge ran]" : ""), r);
      });

    tool("escrow_abort", "Discard everything held in escrow for this session.", {}, [],
      (s) => {
        tm.abort(s);
        audit({ event: "abort", session: s });
        return text("Aborted. Nothing was released.");
      });
  },
});
