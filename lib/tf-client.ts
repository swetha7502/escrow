// All Escrow model calls (Ultra, Super, Nano) go through the host-side spend proxy, never to Token Factory directly.
import { loadEnv } from "./env.ts";

export const MODELS = {
  super: "nvidia/nemotron-3-super-120b-a12b",
  nano: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  ultra: "nvidia/Nemotron-3-Ultra-550b-a55b",
} as const;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export class CachedModeError extends Error {
  reasonCode: string;
  constructor(reasonCode: string, msg: string) { super(msg); this.reasonCode = reasonCode; }
}

export interface ChatResult { content: string; usage?: { prompt_tokens: number; completion_tokens: number } }

export async function chat(opts: {
  model: keyof typeof MODELS | string;
  messages: ChatMessage[];
  maxTokens?: number;
  runId?: string;
  temperature?: number;
}): Promise<ChatResult> {
  const env = loadEnv();
  const base = (env.PROXY_URL ?? "http://127.0.0.1:8000/v1").replace(/\/+$/, "");
  const token = env.PROXY_TOKEN;
  if (!token) throw new Error("PROXY_TOKEN not set");
  const model = opts.model in MODELS ? MODELS[opts.model as keyof typeof MODELS] : opts.model;
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(opts.runId ? { "x-escrow-run": opts.runId } : {}) },
    body: JSON.stringify({ model, messages: opts.messages, max_tokens: opts.maxTokens ?? 2048, temperature: opts.temperature ?? 0 }),
  });
  if (r.status === 402) {
    const j = (await r.json().catch(() => ({}))) as { error?: { reason_code?: string; message?: string } };
    throw new CachedModeError(j.error?.reason_code ?? "unknown", j.error?.message ?? "spend guard stopped");
  }
  if (!r.ok) throw new Error(`proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { choices: { message: { content: string | null } }[]; usage?: ChatResult["usage"] };
  return { content: j.choices[0]?.message?.content ?? "", usage: j.usage };
}
