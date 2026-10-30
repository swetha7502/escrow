// Connection to the Escrow control API + event stream. Every call is failure-safe: if the backend is missing,
// slow, or errors, callers get a clear status and the UI falls back to bundled cached runs.
import { apiBase, loadRuntimeConfig, wsUrl } from "./config";
import type { UiEvent } from "./types";

export interface Health {
  proxy: { mode: string; totalUsd: number; capUsd: number } | null;
  sandbox: { name: string; phase: string };
  activeRun: string | null;
  liveRuns?: "on" | "off";
  authRequired?: boolean;
}
export interface BackendState {
  checked: boolean;
  online: boolean;
  /** live runs possible right now (proxy live + sandbox Ready) */
  liveReady: boolean;
  health: Health | null;
  ws: "off" | "connecting" | "open";
  reason?: string;
  /** the backend wants an access token we don't have (or ours is wrong) */
  locked: boolean;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let state: BackendState = { checked: false, online: false, liveReady: false, health: null, ws: "off", locked: false };

// Shared access token for a hosted backend: typed in once by the presenter, kept in this browser only.
// Never part of the build.
const TOKEN_KEY = "escrow.accessToken";
export const getToken = (): string | null => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export function setToken(t: string | null) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t.trim()); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
  ws?.close();
  void checkHealth();
}
const set = (s: Partial<BackendState>) => { state = { ...state, ...s }; listeners.forEach((l) => l()); };
export const backend = {
  get: () => state,
  subscribe: (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; },
};

export async function api<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init?.timeoutMs ?? 8000);
  try {
    const tok = getToken();
    const res = await fetch(`${apiBase()}${path}`, { ...init, signal: ctl.signal, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(init?.headers ?? {}) } });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error(`backend returned non-JSON (${res.status})`); }
    if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `HTTP ${res.status}`), { status: res.status, body });
    return body as T;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("backend timed out");
    throw e;
  } finally { clearTimeout(timer); }
}

// ---- global event hub: live WS events and local replays both land here --------------------------------

type EvListener = (e: UiEvent) => void;
const evListeners = new Set<EvListener>();
const recent: UiEvent[] = [];
export const hub = {
  emit(e: UiEvent) {
    recent.push(e);
    if (recent.length > 5000) recent.splice(0, recent.length - 5000);
    evListeners.forEach((l) => { try { l(e); } catch (err) { console.error(err); } });
  },
  /** Subscribe; `replay` first delivers buffered events (a run's first events can arrive before its POST returns) */
  on(l: EvListener, replay?: (e: UiEvent) => boolean) {
    if (replay) recent.filter(replay).forEach(l);
    evListeners.add(l);
    return () => { evListeners.delete(l); };
  },
};

// ---- health polling + WebSocket -----------------------------------------------------------------------

let ws: WebSocket | null = null;
let maxSeq = 0;
let wsRetry = 0;

function connectWs() {
  const url = wsUrl();
  if (ws || !url) return;
  set({ ws: "connecting" });
  const tok = getToken();
  try { ws = new WebSocket(url, tok ? ["escrow", `escrow-token.${tok}`] : ["escrow"]); } catch { ws = null; set({ ws: "off" }); return; }
  ws.onopen = () => { wsRetry = 0; set({ ws: "open" }); };
  ws.onmessage = (m) => {
    let msg: UiEvent & { backlog?: UiEvent[] };
    try { msg = JSON.parse(String(m.data)); } catch { return; }
    if (msg.type === "hello") {
      const backlog = msg.backlog ?? [];
      // A restarted server starts its sequence again: then everything in the backlog is new to us
      if (backlog.length && (backlog[backlog.length - 1].seq ?? 0) < maxSeq) maxSeq = 0;
      for (const e of backlog) if ((e.seq ?? 0) > maxSeq) { maxSeq = e.seq ?? maxSeq; hub.emit(e); }
      return;
    }
    if (msg.seq && msg.seq <= maxSeq) return; // seen (reconnect overlap)
    if (msg.seq) maxSeq = msg.seq;
    hub.emit(msg);
  };
  ws.onclose = () => {
    ws = null;
    set({ ws: "off" });
    if (state.online) setTimeout(connectWs, Math.min(1000 * 2 ** wsRetry++, 10000));
  };
  ws.onerror = () => { /* onclose follows */ };
}

export async function checkHealth() {
  try {
    const h = await api<Health>("/api/health", { timeoutMs: 20000 });
    if (!h || typeof h !== "object" || !("sandbox" in h)) throw new Error("not an Escrow backend");
    const off = h.liveRuns === "off";
    const liveReady = !off && !!h.proxy && h.proxy.mode === "live" && h.sandbox.phase === "Ready";
    set({ checked: true, online: true, locked: false, health: h, liveReady, reason: liveReady ? undefined : off ? "live runs off" : !h.proxy ? "spend proxy down" : h.proxy.mode !== "live" ? `proxy in ${h.proxy.mode} mode` : `sandbox ${h.sandbox.phase}` });
    connectWs();
  } catch (e) {
    // 401: a hosted backend that needs the access token. Everything still works as cached replays.
    if ((e as { status?: number }).status === 401) { set({ checked: true, online: false, locked: true, liveReady: false, health: null, reason: getToken() ? "access token rejected" : "access token required" }); ws?.close(); return; }
    set({ checked: true, online: false, locked: false, liveReady: false, health: null, reason: (e as Error).message });
    ws?.close();
  }
}

let started = false;
let firstCheck: Promise<void> | null = null;
/** Resolves once the first health check has finished (either way) */
export const backendReady = () => firstCheck ?? Promise.resolve();
export function startBackend() {
  if (started) return;
  started = true;
  firstCheck = loadRuntimeConfig().then(checkHealth); // live.json first: it says where the backend is
  setInterval(() => { void checkHealth(); }, 15000);
}
