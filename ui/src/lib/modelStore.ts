// Model calls seen on the event stream (live WS or cached replay), for the HUD. Spend comes only from
// model_call events (the spend proxy's log), so a judge call is never counted twice.
import { hub } from "./backend";
import { costOf, modelKey } from "./models";
import type { UiEvent } from "./types";

export interface ModelRec { runId?: string; key: "ultra" | "super" | "nano"; role: string; ms?: number; usd?: number; tokens?: number; at: number; cached: boolean; totalUsd?: number }
let recs: ModelRec[] = [];
let focus: string[] = [];
let lastTotal: { usd: number; cached: boolean } | null = null;
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; listeners.forEach((l) => l()); };

hub.on((e: UiEvent) => {
  if (e.type !== "model_call") return;
  const key = modelKey(e.model);
  if (!key) return;
  const p = Number(e.promptTokens ?? 0), c = Number(e.completionTokens ?? 0);
  const usd = typeof e.usd === "number" ? e.usd : costOf(e.model, p, c);
  recs = [...recs.slice(-400), { runId: e.runId, key, role: String(e.role ?? ""), ms: e.ms as number | undefined, usd, tokens: p + c, at: Date.now(), cached: !!e.cached, totalUsd: e.totalUsd as number | undefined }];
  if (typeof e.totalUsd === "number") lastTotal = { usd: e.totalUsd, cached: !!e.cached };
  bump();
});

export const modelStore = {
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  version: () => version,
  /** Calls for the runs on screen (all calls this session when no run is focused) */
  calls: () => (focus.length ? recs.filter((r) => r.runId && focus.includes(r.runId)) : recs),
  lastTotal: () => lastTotal,
  setFocus: (ids: (string | null)[]) => { focus = ids.filter((x): x is string => !!x); bump(); },
};
