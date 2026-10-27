import { useEffect, useState, useSyncExternalStore } from "react";
import { backend } from "./backend";
import { feedFor, type RunView } from "./runState";

export const useBackend = () => useSyncExternalStore(backend.subscribe, backend.get);

/** Hash route: #/, #/run/<scenario>/<arm>, #/split/<scenario>, #/approve[/<id>] */
export function useRoute(): string[] {
  const parse = () => (location.hash.replace(/^#\/?/, "").split("?")[0] || "").split("/").filter(Boolean).map(decodeURIComponent);
  const [r, setR] = useState(parse);
  useEffect(() => { const on = () => setR(parse()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  return r;
}
export const query = (k: string) => new URLSearchParams(location.hash.split("?")[1] ?? "").get(k);
export const go = (path: string) => { location.hash = path; };

export function useRunView(runId: string | null): RunView | null {
  const [v, setV] = useState<RunView | null>(() => (runId ? feedFor(runId).view : null));
  useEffect(() => {
    if (!runId) { setV(null); return; }
    const f = feedFor(runId);
    setV(f.view);
    return f.subscribe((_e, view) => setV(view));
  }, [runId]);
  return v;
}

/** Re-render every `ms` (for "active" indicators that decay) */
export function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}
