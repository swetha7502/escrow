// Default-deny tool policy for the Escrow hook. Pure functions, so it's unit-testable on the host.
import { resolve, isAbsolute, sep } from "node:path";

export const WORKSPACE_ROOT = "/sandbox";
export const ESCROW_STATE = "/sandbox/.escrow";

/** Tools that read and cause no side effect. A read of a shadowed path is redirected. */
const READ_TOOLS = new Set(["read"]);
/** Tools whose writes are redirected into the per-session shadow FS. */
const SHADOW_TOOLS = new Set(["write", "edit"]);
/** Side-effect-free tools that pass unchanged. */
const PASS_TOOLS = new Set([
  "memory_get", "memory_search", "session_status", "sessions_list", "sessions_history",
  "sessions_search", "get_goal", "ask_user", "progress_card",
]);
/** Escrow's own tools (registered by this plugin). */
export const ESCROW_TOOLS = new Set(["escrow_send_email", "escrow_write_external", "escrow_commit", "escrow_abort", "escrow_status"]);

/** Tool paths may not resolve here, so the agent can't edit the hook, its config, or forge outbox records. */
const PROTECTED: { prefix: string; except?: string[] }[] = [
  { prefix: ESCROW_STATE },
  { prefix: "/sandbox/.nemoclaw" },
  { prefix: "/sandbox/.openclaw", except: ["/sandbox/.openclaw/workspace"] },
];

export type ToolClass = "read" | "shadow" | "pass" | "escrow" | "block";

export function classify(toolName: string, toolKind?: string): ToolClass {
  const n = toolName.toLowerCase();
  if (toolKind === "code_mode_exec") return "block";
  if (READ_TOOLS.has(n)) return "read";
  if (SHADOW_TOOLS.has(n)) return "shadow";
  if (PASS_TOOLS.has(n)) return "pass";
  if (ESCROW_TOOLS.has(n)) return "escrow";
  return "block"; // exec, process, message, web_fetch, browser, apply_patch, file_write, secrets, and anything new
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/** Resolve a tool path to an absolute path, or null if it isn't a string. */
export function absPath(raw: unknown, base: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
}

export function isProtected(abs: string): boolean {
  return PROTECTED.some(({ prefix, except }) => under(abs, prefix) && !(except ?? []).some((e) => under(abs, e)));
}

export function inWorkspace(abs: string): boolean {
  return under(abs, WORKSPACE_ROOT) && abs !== WORKSPACE_ROOT;
}

/** Name of the path param a file tool uses. OpenClaw's write/edit/read use `path`. Some tools use `file_path`. */
export function pathKey(params: Record<string, unknown>): "path" | "file_path" | null {
  if (typeof params.path === "string") return "path";
  if (typeof params.file_path === "string") return "file_path";
  return null;
}
