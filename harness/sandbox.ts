// Host-side helpers for driving the live sandbox over the OpenShell exec channel (no network route in).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const SANDBOX = process.env.SANDBOX ?? "escrow";
export const ESCROW_STATE = "/sandbox/.escrow";

/**
 * argv-array exec inside the sandbox (as the sandbox user); nothing passes through a host shell.
 * Uses OpenShell's exec directly: `nemoclaw exec` holds a global host lock for the whole command, so
 * nothing else could reach the sandbox while an agent turn runs. Agent turns still go through nemoclaw.
 */
export async function sbx(args: string[], opts: { timeoutSec?: number; input?: string; via?: "openshell" | "nemoclaw" } = {}): Promise<string> {
  const t = opts.timeoutSec ?? 60;
  const argv = opts.via === "nemoclaw"
    ? [SANDBOX, "exec", opts.input === undefined ? "--no-stdin" : "--stdin", "--timeout", String(t), "--", ...args]
    : ["sandbox", "exec", "-n", SANDBOX, "--no-tty", "--timeout", String(t), "--", ...args];
  const p = run(opts.via === "nemoclaw" ? "nemoclaw" : "openshell", argv, { maxBuffer: 64 * 1024 * 1024, timeout: (t + 30) * 1000 });
  p.child.stdin?.end(opts.input ?? ""); // openshell forwards stdin; leaving it open hangs the command
  const { stdout } = await p;
  return stdout;
}

/** Write a file inside the sandbox (host-controlled state such as the mode switch or an approved contract). */
export const putFile = (path: string, body: string) =>
  sbx(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1.tmp" && mv "$1.tmp" "$1"', "put", path], { input: body });

export const setMode = (mode: "baseline" | "escrow") => putFile(`${ESCROW_STATE}/mode`, mode + "\n");

/** Number of lines currently in the hook's audit log; read new events from here after a run. */
export async function auditLength(): Promise<number> {
  const out = await sbx(["sh", "-c", `wc -l < ${ESCROW_STATE}/audit.jsonl 2>/dev/null || echo 0`]);
  return Number(out.trim().split("\n").pop()) || 0;
}

export async function auditSince(line: number): Promise<Record<string, unknown>[]> {
  const out = await sbx(["tail", "-n", `+${line + 1}`, `${ESCROW_STATE}/audit.jsonl`]);
  return out.split("\n").filter((l) => l.startsWith("{")).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export interface AgentTurn { ok: boolean; reply: string; durationMs: number; raw: unknown; error?: string }

/** One OpenClaw agent turn in the sandbox (the real agent, real hook). */
export async function agentTurn(sessionId: string, message: string, timeoutSec = 280): Promise<AgentTurn> {
  const t0 = Date.now();
  try {
    const out = await sbx(["openclaw", "agent", "--session-id", sessionId, "--timeout", String(timeoutSec), "--json", "-m", message], { timeoutSec: timeoutSec + 20, via: "nemoclaw" });
    const raw = JSON.parse(out.slice(out.indexOf("{"))) as { status?: string; result?: { payloads?: { text?: string }[] }; error?: string };
    return { ok: raw.status === "ok", reply: raw.result?.payloads?.map((p) => p.text ?? "").join("\n") ?? "", durationMs: Date.now() - t0, raw, error: raw.error };
  } catch (e) {
    return { ok: false, reply: "", durationMs: Date.now() - t0, raw: null, error: (e as Error).message.slice(0, 2000) };
  }
}

/**
 * Follow the hook's audit log live: a long-lived `tail -F` over OpenShell exec (lock-free, as the sandbox user).
 * Reconnects if the exec drops. Returns a stop function.
 */
export function tailSandboxAudit(onLine: (o: Record<string, unknown>) => void): () => void {
  let child: import("node:child_process").ChildProcess | null = null;
  let stopped = false;
  const start = async () => {
    const { spawn } = await import("node:child_process");
    if (stopped) return;
    child = spawn("openshell", ["sandbox", "exec", "-n", SANDBOX, "--no-tty", "--", "tail", "-n", "0", "-F", `${ESCROW_STATE}/audit.jsonl`], { stdio: ["pipe", "pipe", "ignore"] });
    child.stdin!.end();
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) {
        if (!l.startsWith("{")) continue;
        try { onLine(JSON.parse(l)); } catch { /* skip */ }
      }
    });
    child.on("exit", () => { child = null; if (!stopped) setTimeout(() => void start(), 2000); });
  };
  void start();
  return () => { stopped = true; child?.kill(); };
}
