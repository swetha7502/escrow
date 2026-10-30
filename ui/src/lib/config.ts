// Backend location. Resolved at RUNTIME from ./live.json (deployed next to index.html; scripts/live-tunnel.sh
// rewrites it whenever the quick tunnel's URL changes, no rebuild), else the build-time env (ui/.env.example),
// else same origin (dev/preview proxy). live.json {"apiBase": null} or missing → no backend → cached replays.
const env = import.meta.env;
const BUILD_BASE = String(env.VITE_API_BASE ?? "").replace(/\/$/, "");
const BUILD_WS = String(env.VITE_WS_URL || "");
let runtimeBase: string | null = null;
/** live.json says {"apiBase": null}: the hosted site is deliberately cached-only (not a backend that went down) */
let cachedOnly = false;

/** Only an https origin (or a loopback http one, for local checks) is accepted from live.json */
export function parseLiveConfig(raw: unknown): string | null {
  const b = (raw as { apiBase?: unknown } | null)?.apiBase;
  if (typeof b !== "string") return null;
  try {
    const u = new URL(b);
    const loopback = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
    return (u.protocol === "https:" || loopback) && u.pathname === "/" && !u.search ? u.origin : null;
  } catch { return null; }
}

export async function loadRuntimeConfig(): Promise<void> {
  if (typeof fetch === "undefined") return;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch("./live.json", { cache: "no-store", signal: ctl.signal });
    if (r.ok) { const raw = await r.json(); runtimeBase = parseLiveConfig(raw); cachedOnly = (raw as { apiBase?: unknown } | null)?.apiBase === null; }
  } catch { /* no live.json: build-time settings */ } finally { clearTimeout(t); }
}

export const apiBase = (): string => runtimeBase ?? BUILD_BASE;
export const isCachedOnly = (): boolean => cachedOnly;
export const wsUrl = (): string => {
  if (runtimeBase) return runtimeBase.replace(/^http/, "ws") + "/events";
  if (BUILD_WS) return BUILD_WS;
  if (BUILD_BASE) return BUILD_BASE.replace(/^http/, "ws") + "/events";
  if (typeof location === "undefined") return "";
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events`;
};
/** Replay pacing: gaps between recorded events are capped (same as the server's replay) */
export const REPLAY_MAX_GAP_MS = 1500;
