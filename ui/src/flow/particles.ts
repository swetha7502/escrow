// Canvas particle engine over the Flow Map. Particles travel along edge polylines (flow coordinates) and are
// drawn in screen space through the current viewport; bursts shatter at a point. Additive glow, short trails.
import type { Pt } from "./geometry";
import type { UiEvent } from "../lib/types";

export interface Viewport { x: number; y: number; zoom: number }
interface Travel { kind: "travel"; pts: Pt[]; len: number[]; total: number; d: number; speed: number; color: string; size: number; trail: Pt[]; event?: UiEvent; label?: string; onArrive?: () => void; ambient?: boolean }
interface Shard { kind: "shard"; x: number; y: number; vx: number; vy: number; rot: number; vr: number; life: number; max: number; color: string; size: number; screen: boolean }
interface Ring { kind: "ring"; x: number; y: number; r: number; life: number; max: number; color: string; screen: boolean }

const cumulative = (pts: Pt[]) => { const len = [0]; for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)); return len; };

export class ParticleField {
  private ctx: CanvasRenderingContext2D;
  private travels: Travel[] = [];
  private shards: Shard[] = [];
  private rings: Ring[] = [];
  private raf = 0;
  private last = performance.now();
  vp: Viewport = { x: 0, y: 0, zoom: 1 };
  private dpr = Math.min(window.devicePixelRatio || 1, 2);
  private canvas: HTMLCanvasElement;
  private ambientRoutes: Pt[][] = [];
  private ambientClock = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, r.width * this.dpr);
    this.canvas.height = Math.max(1, r.height * this.dpr);
  }
  destroy() { cancelAnimationFrame(this.raf); }
  setAmbient(routes: Pt[][]) { this.ambientRoutes = routes; }

  travel(pts: Pt[], o: { color: string; size?: number; speed?: number; event?: UiEvent; label?: string; onArrive?: () => void; ambient?: boolean; delay?: number }) {
    if (pts.length < 2) { o.onArrive?.(); return; }
    const len = cumulative(pts);
    const t: Travel = { kind: "travel", pts, len, total: len[len.length - 1], d: -(o.delay ?? 0) * (o.speed ?? 0.85), speed: o.speed ?? 0.85, color: o.color, size: o.size ?? 4, trail: [], event: o.event, label: o.label, onArrive: o.onArrive, ambient: o.ambient };
    this.travels.push(t);
  }
  /** Shatter at a flow-space point (or a screen point relative to the canvas) */
  burst(p: Pt, color: string, o: { screen?: boolean; n?: number; power?: number } = {}) {
    const n = o.n ?? 26, pw = o.power ?? 1;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = (0.08 + Math.random() * 0.28) * pw;
      this.shards.push({ kind: "shard", x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.05, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.02, life: 0, max: 700 + Math.random() * 600, color, size: 2 + Math.random() * 5, screen: !!o.screen });
    }
    this.rings.push({ kind: "ring", x: p.x, y: p.y, r: 4, life: 0, max: 650, color, screen: !!o.screen });
  }
  ring(p: Pt, color: string) { this.rings.push({ kind: "ring", x: p.x, y: p.y, r: 4, life: 0, max: 700, color, screen: false }); }

  /** Particle under a screen point (for click-to-inspect) */
  hit(sx: number, sy: number): Travel | null {
    let best: Travel | null = null, bd = 16;
    for (const t of this.travels) {
      if (!t.event || t.d < 0) continue;
      const p = this.pos(t), s = this.toScreen(p), d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  private toScreen(p: Pt): Pt { return { x: p.x * this.vp.zoom + this.vp.x, y: p.y * this.vp.zoom + this.vp.y }; }
  private pos(t: Travel): Pt {
    const d = Math.max(0, Math.min(t.d, t.total));
    let i = 1; while (i < t.len.length - 1 && t.len[i] < d) i++;
    const seg = t.len[i] - t.len[i - 1] || 1, f = (d - t.len[i - 1]) / seg;
    return { x: t.pts[i - 1].x + (t.pts[i].x - t.pts[i - 1].x) * f, y: t.pts[i - 1].y + (t.pts[i].y - t.pts[i - 1].y) * f };
  }

  private frame = (now: number) => {
    const dt = Math.min(now - this.last, 50); this.last = now;
    const { ctx } = this; const z = this.vp.zoom, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "lighter";

    // ambient drift so the map always breathes
    this.ambientClock += dt;
    if (this.ambientRoutes.length && this.ambientClock > 420) {
      this.ambientClock = 0;
      const r = this.ambientRoutes[Math.floor(Math.random() * this.ambientRoutes.length)];
      this.travel(r, { color: "rgba(160,185,220,0.35)", size: 1.6, speed: 0.22, ambient: true });
    }

    this.travels = this.travels.filter((t) => {
      t.d += t.speed * dt;
      if (t.d < 0) return true;
      const p = this.pos(t), s = this.toScreen(p);
      t.trail.push(s); if (t.trail.length > (t.ambient ? 6 : 14)) t.trail.shift();
      for (let i = 1; i < t.trail.length; i++) {
        const a = i / t.trail.length;
        ctx.strokeStyle = t.color; ctx.globalAlpha = a * (t.ambient ? 0.5 : 0.55);
        ctx.lineWidth = t.size * z * a * 1.1; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(t.trail[i - 1].x, t.trail[i - 1].y); ctx.lineTo(t.trail[i].x, t.trail[i].y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const r = Math.max(1.2, t.size * z);
      if (!t.ambient) {
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 4.5);
        g.addColorStop(0, t.color); g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.x, s.y, r * 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(s.x, s.y, r * 0.55, 0, Math.PI * 2); ctx.fill();
      } else { ctx.fillStyle = t.color; ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill(); }
      if (t.d >= t.total) { try { t.onArrive?.(); } catch (e) { console.error(e); } return false; }
      return true;
    });

    this.shards = this.shards.filter((s) => {
      s.life += dt; s.x += s.vx * dt * (s.screen ? 1 : 1); s.y += s.vy * dt; s.vy += 0.00035 * dt; s.rot += s.vr * dt;
      const p = s.screen ? { x: s.x, y: s.y } : this.toScreen(s), k = 1 - s.life / s.max, sz = s.size * (s.screen ? 1 : z);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(s.rot); ctx.globalAlpha = Math.max(0, k);
      ctx.fillStyle = s.color; ctx.beginPath(); ctx.moveTo(0, -sz); ctx.lineTo(sz * 0.7, sz * 0.6); ctx.lineTo(-sz * 0.6, sz * 0.4); ctx.closePath(); ctx.fill();
      ctx.restore();
      return s.life < s.max;
    });
    this.rings = this.rings.filter((r) => {
      r.life += dt; const k = r.life / r.max, p = r.screen ? r : this.toScreen(r);
      ctx.globalAlpha = Math.max(0, 1 - k); ctx.strokeStyle = r.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, (r.r + k * 46) * (r.screen ? 1 : z), 0, Math.PI * 2); ctx.stroke();
      return r.life < r.max;
    });
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    this.raf = requestAnimationFrame(this.frame);
  };
}
