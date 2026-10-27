// Fixed layout of the Flow Map, in flow coordinates. Edges and particles share these paths exactly.
export interface Box { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export const BOX: Record<string, Box> = {
  contract: { x: 230, y: 0, w: 240, h: 100 },
  tf: { x: 560, y: 0, w: 340, h: 100 },
  agent: { x: 0, y: 220, w: 220, h: 150 },
  hook: { x: 280, y: 220, w: 220, h: 150 },
  records: { x: 280, y: 450, w: 220, h: 104 },
  shadow: { x: 560, y: 220, w: 220, h: 150 },
  wall: { x: 840, y: 150, w: 360, h: 290 },
  outbox: { x: 1270, y: 220, w: 190, h: 150 },
  sender: { x: 1520, y: 220, w: 200, h: 150 },
};
export const RCPT = { x: 1790, w: 280, h: 84, gap: 14 };
export const WALL_IN: Pt = { x: BOX.wall.x, y: BOX.wall.y + BOX.wall.h / 2 };
export const WALL_OUT: Pt = { x: BOX.wall.x + BOX.wall.w, y: BOX.wall.y + BOX.wall.h / 2 };
export const BARRIER_X = BOX.wall.x + 196 + 13; // the glowing bar, for bursts

export function rcptBox(i: number, n: number): Box {
  const total = n * RCPT.h + (n - 1) * RCPT.gap;
  const cy = BOX.sender.y + BOX.sender.h / 2;
  return { x: RCPT.x, y: cy - total / 2 + i * (RCPT.h + RCPT.gap), w: RCPT.w, h: RCPT.h };
}

const right = (b: Box): Pt => ({ x: b.x + b.w, y: b.y + b.h / 2 });
const left = (b: Box): Pt => ({ x: b.x, y: b.y + b.h / 2 });
const top = (b: Box, f = 0.5): Pt => ({ x: b.x + b.w * f, y: b.y });
const bottom = (b: Box, f = 0.5): Pt => ({ x: b.x + b.w * f, y: b.y + b.h });

export interface EdgeGeo { id: string; a: Pt; b: Pt; dir: "h" | "v"; kind: "main" | "inference" | "control" }
export function edges(nRcpt: number): EdgeGeo[] {
  const e: EdgeGeo[] = [
    { id: "agent-hook", a: right(BOX.agent), b: left(BOX.hook), dir: "h", kind: "main" },
    { id: "hook-shadow", a: right(BOX.hook), b: left(BOX.shadow), dir: "h", kind: "main" },
    { id: "hook-records", a: bottom(BOX.hook), b: top(BOX.records), dir: "v", kind: "main" },
    { id: "shadow-wall", a: right(BOX.shadow), b: WALL_IN, dir: "h", kind: "main" },
    { id: "wall-outbox", a: WALL_OUT, b: left(BOX.outbox), dir: "h", kind: "main" },
    { id: "outbox-sender", a: right(BOX.outbox), b: left(BOX.sender), dir: "h", kind: "main" },
    { id: "tf-agent", a: bottom(BOX.tf, 0.12), b: top(BOX.agent, 0.6), dir: "v", kind: "inference" },
    { id: "tf-wall", a: bottom(BOX.tf, 0.85), b: top(BOX.wall, 0.75), dir: "v", kind: "inference" },
    { id: "tf-contract", a: left(BOX.tf), b: right(BOX.contract), dir: "h", kind: "inference" },
    { id: "contract-hook", a: bottom(BOX.contract, 0.4), b: top(BOX.hook, 0.6), dir: "v", kind: "control" },
  ];
  for (let i = 0; i < nRcpt; i++) e.push({ id: `sender-r${i}`, a: right(BOX.sender), b: left(rcptBox(i, nRcpt)), dir: "h", kind: "main" });
  return e;
}

/** Cubic bezier control points: horizontal or vertical tangents */
function ctrl(g: EdgeGeo): [Pt, Pt, Pt, Pt] {
  const { a, b } = g;
  if (g.dir === "h") { const d = (b.x - a.x) / 2; return [a, { x: a.x + d, y: a.y }, { x: b.x - d, y: b.y }, b]; }
  const d = (b.y - a.y) / 2;
  return [a, { x: a.x, y: a.y + d }, { x: b.x, y: b.y - d }, b];
}
export function pathD(g: EdgeGeo) {
  const [p0, p1, p2, p3] = ctrl(g);
  return `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;
}
export function samplePath(g: EdgeGeo, reverse = false, n = 48): Pt[] {
  const [p0, p1, p2, p3] = ctrl(g);
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push({ x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y });
  }
  return reverse ? pts.reverse() : pts;
}
