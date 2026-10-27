// Nemotron models on Token Factory: display names and prices (USD per token, from docs/models.md).
export const MODELS = [
  { key: "ultra", id: "nvidia/Nemotron-3-Ultra-550b-a55b", name: "ULTRA", role: "task contract", prompt: 0.000001, completion: 0.000003 },
  { key: "super", id: "nvidia/nemotron-3-super-120b-a12b", name: "SUPER", role: "agent · judge", prompt: 0.0000003, completion: 0.0000009 },
  { key: "nano", id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", name: "NANO", role: "labels reads", prompt: 0.00000006, completion: 0.00000024 },
] as const;
export const modelKey = (id: unknown) => { const s = String(id ?? "").toLowerCase(); return s.includes("ultra") ? "ultra" : s.includes("nano") ? "nano" : s.includes("super") ? "super" : null; };
export function costOf(id: unknown, p = 0, c = 0): number | undefined {
  const m = MODELS.find((x) => x.key === modelKey(id));
  return m ? p * m.prompt + c * m.completion : undefined;
}
export const usd = (n: number | undefined) => (n === undefined ? "—" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
