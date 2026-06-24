// app/src/render/procedural.ts
// Zero-network procedural frame sources so a dream always renders: archive feed off, or
// every image failing, still yields a full reel. Each kind draws to a small offscreen
// canvas and exposes a THREE.Texture that updates over elapsed time. All output is
// deterministic in the seed, and kept cheap (small canvases, no per-pixel shaders except
// where chunky grain is the point).

import * as THREE from 'three';
import type { ProceduralKind } from '../manifest/types';
import { makeRng, type Rng } from '../dream/prng';
import { NEUTRAL_PROC_PARAMS, type ProceduralParams } from '../dream/filterDirector';

export interface ProceduralSource {
  texture: THREE.Texture;
  update(elapsedSeconds: number): void;
  /**
   * Apply emotion/intensity-derived variation (from filterDirector.proceduralParams). Optional —
   * sources default to NEUTRAL_PROC_PARAMS, which reproduces the original look bit-for-bit.
   */
  setParams(p: ProceduralParams): void;
  dispose(): void;
}

// Filmic palette (kept muted on purpose).
const INK = '#0E0B08';
const AMBER = '#C8A35E';
const LAMP = '#E8C887';
const BONE = '#D8D2C4';
const SEPIA = '#6B5640';
const VERD = '#4A6B66';

const W = 640;
const H = 360;

function makeCanvasTexture(w = W, h = H): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
} {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('procedural: no 2d context');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  // Not owned by the compositor — the procedural source manages its own lifecycle.
  tex.userData.ownedByCompositor = false;
  return { canvas, ctx, tex };
}

/** Smooth value noise sampled deterministically (no allocation per call). */
function makeNoise(rng: Rng) {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = rng.int(i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t: number) => t * t * (3 - 2 * t);
  const grad = (h: number) => (h & 1 ? -1 : 1) * (0.5 + (h & 6) / 8);
  return (x: number, y: number): number => {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[xi] + yi];
    const ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi];
    const bb = perm[perm[xi + 1] + yi + 1];
    const x1 = lerp(grad(aa) * xf, grad(ba) * (xf - 1), u);
    const x2 = lerp(grad(ab) * (yf - 0), grad(bb) * (xf - 1), u);
    return (lerp(x1, x2, v) + 1) * 0.5;
  };
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type Draw = (ctx: CanvasRenderingContext2D, t: number, rng: Rng, p: ProceduralParams) => void;

// ---- per-kind painters ------------------------------------------------------

const drawLeader: Draw = (ctx, t) => {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2;
  const r = Math.min(W, H) * 0.42;
  // crosshair
  ctx.strokeStyle = SEPIA;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(W, cy);
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, H);
  ctx.stroke();
  // outer ring
  ctx.strokeStyle = BONE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  // sweeping radial hand (one revolution per second)
  const sweep = (t % 1) * Math.PI * 2 - Math.PI / 2;
  ctx.strokeStyle = LAMP;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweep) * r, cy + Math.sin(sweep) * r);
  ctx.stroke();
  // wedge already swept
  ctx.fillStyle = 'rgba(232,200,135,0.10)';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, -Math.PI / 2, sweep);
  ctx.closePath();
  ctx.fill();
  // countdown number 3,2,1
  const n = Math.max(1, 3 - Math.floor(t));
  ctx.fillStyle = BONE;
  ctx.font = `bold ${Math.floor(H * 0.6)}px "Bodoni Moda", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), cx, cy + 6);
};

const drawFog: Draw = (ctx, t, rng, p) => {
  const noise = getCached(rng, 'fog-noise', () => makeNoise(rng.fork('fog')));
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#15110c');
  g.addColorStop(1, INK);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // density: ominous/fear thicken the fog (lower threshold + heavier fill); loss thins it.
  // At neutral density 0.5 → thr 0.45, factor 0.7 (the original look).
  const thr = 0.45 - (p.density - 0.5) * 0.3;
  const af = 0.7 * (0.7 + p.density * 0.6);
  const step = 16;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const n = noise(x * 0.012 + t * 0.15 * p.speed, y * 0.02 - t * 0.05 * p.speed);
      const a = Math.max(0, n - thr) * af;
      ctx.fillStyle = `rgba(107,86,64,${a.toFixed(3)})`;
      ctx.fillRect(x, y, step, step);
    }
  }
};

const STAR_POOL = 220;
const drawStars: Draw = (ctx, t, rng, p) => {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);
  // Generate a fixed pool ONCE; draw a mood-driven prefix of it. The first 160 entries are drawn
  // exactly as before at neutral density (0.5 → 160), so the identity look is preserved; loss
  // lowers density → a sparser field, ominous/fear raise it. (The pool's first 160 draws consume
  // the same rng sequence as the original, so their positions are unchanged.)
  const stars = getCached(rng, 'stars', () => {
    const sr = rng.fork('stars');
    return Array.from({ length: STAR_POOL }, () => ({
      x: sr.next() * W,
      y: sr.next() * H,
      r: 0.4 + sr.next() * 1.4,
      ph: sr.next() * Math.PI * 2,
      sp: 0.5 + sr.next() * 2,
    }));
  });
  const visible = Math.max(1, Math.min(STAR_POOL, Math.round(STAR_POOL * (0.227 + p.density))));
  const bright = 0.4 + p.brightness; // neutral 0.6 → 1.0 (original)
  for (let i = 0; i < visible; i++) {
    const s = stars[i];
    const tw = 0.5 + 0.5 * Math.sin(t * s.sp * p.speed + s.ph);
    ctx.fillStyle = `rgba(216,210,196,${((0.2 + tw * 0.7) * bright).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
};

const drawIris: Draw = (ctx, t, _rng, p) => {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2;
  const base = Math.min(W, H) * 0.5;
  const open = 0.5 + 0.5 * Math.sin(t * 0.6 * p.speed);
  const r = base * (0.2 + open * 0.8);
  const grd = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
  grd.addColorStop(0, 'rgba(232,200,135,0.22)');
  grd.addColorStop(0.7, 'rgba(107,86,64,0.10)');
  grd.addColorStop(1, 'rgba(14,11,8,1)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = `rgba(200,163,94,${(0.3 + open * 0.4).toFixed(3)})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
};

const drawRipple: Draw = (ctx, t, _rng, p) => {
  ctx.fillStyle = '#0c1413';
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H * 0.55;
  // joy / high intensity → faster + brighter rings (neutral speed 1, brightness 0.6 → original).
  const bright = 0.4 + p.brightness;
  for (let i = 0; i < 7; i++) {
    const phase = (t * 0.6 * p.speed + i / 7) % 1;
    const r = phase * Math.max(W, H) * 0.7;
    const a = (1 - phase) * 0.5 * bright;
    ctx.strokeStyle = `rgba(74,107,102,${a.toFixed(3)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
};

const drawStatic: Draw = (() => {
  // chunky filmic grain at reduced cadence; deterministic in (seed, frame index) only —
  // the source rng is sampled once for a stable base, never per frame.
  let img: ImageData | null = null;
  return (ctx, t, rng) => {
    const sw = 256;
    const sh = 144;
    const frame = Math.floor(t * 12);
    const base = getCached(rng, 'static-base', () => rng.int(0x7fffffff));
    const fr = makeRng((base ^ Math.imul(frame, 0x9e3779b9)) >>> 0);
    if (!img) img = ctx.createImageData(sw, sh);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 30 + fr.next() * 120;
      d[i] = v * 0.85;
      d[i + 1] = v * 0.8;
      d[i + 2] = v * 0.65;
      d[i + 3] = 255;
    }
    // paint scaled up
    const tmp = (drawStatic as unknown as { _tmp?: HTMLCanvasElement })._tmp ?? document.createElement('canvas');
    (drawStatic as unknown as { _tmp?: HTMLCanvasElement })._tmp = tmp;
    tmp.width = sw;
    tmp.height = sh;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
  };
})();

const drawHorizon: Draw = (ctx, t) => {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#1a140d');
  sky.addColorStop(0.6, '#2a2014');
  sky.addColorStop(0.62, SEPIA);
  sky.addColorStop(1, '#0c0a07');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // hazy sun
  const sx = W * (0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * 0.1)));
  const sy = H * 0.5;
  const grd = ctx.createRadialGradient(sx, sy, 4, sx, sy, 120);
  grd.addColorStop(0, 'rgba(232,200,135,0.5)');
  grd.addColorStop(1, 'rgba(232,200,135,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(216,210,196,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, H * 0.62);
  ctx.lineTo(W, H * 0.62);
  ctx.stroke();
};

const drawOrbs: Draw = (ctx, t, rng, p) => {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);
  const orbs = getCached(rng, 'orbs', () => {
    const or = rng.fork('orbs');
    return Array.from({ length: 9 }, () => ({
      x: or.next(),
      y: or.next(),
      r: 18 + or.next() * 50,
      sp: 0.05 + or.next() * 0.12,
      ph: or.next() * Math.PI * 2,
      col: or.next() > 0.5 ? LAMP : AMBER,
    }));
  });
  // drift speed + glow brightness vary (neutral speed 1, brightness 0.6 → original alpha 0.35).
  const glow = 0.35 * (0.4 + p.brightness) * 1.0;
  for (const o of orbs) {
    const x = (o.x + Math.sin(t * o.sp * p.speed + o.ph) * 0.06) * W;
    const y = (o.y + Math.cos(t * o.sp * 0.8 * p.speed + o.ph) * 0.06) * H;
    const grd = ctx.createRadialGradient(x, y, 0, x, y, o.r);
    grd.addColorStop(0, hexA(o.col, glow));
    grd.addColorStop(1, hexA(o.col, 0));
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, o.r, 0, Math.PI * 2);
    ctx.fill();
  }
};

const drawFilmrun: Draw = (ctx, t) => {
  ctx.fillStyle = '#14110c';
  ctx.fillRect(0, 0, W, H);
  // scrolling sprocket holes on both edges
  const holeH = 26;
  const gap = 44;
  const off = (t * 220) % gap;
  ctx.fillStyle = INK;
  for (const ex of [10, W - 10 - 18]) {
    for (let y = -gap + off; y < H + gap; y += gap) {
      roundRect(ctx, ex, y, 18, holeH, 4);
      ctx.fill();
    }
  }
  // frame divider lines scrolling
  ctx.strokeStyle = 'rgba(107,86,64,0.6)';
  ctx.lineWidth = 2;
  const fgap = 120;
  const foff = (t * 220) % fgap;
  for (let y = -fgap + foff; y < H + fgap; y += fgap) {
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(W - 40, y);
    ctx.stroke();
  }
  // faint center label
  ctx.fillStyle = 'rgba(216,210,196,0.18)';
  ctx.font = `${Math.floor(H * 0.16)}px "Courier Prime", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('PICTURE START', W / 2, H / 2);
};

// ---- helpers ----------------------------------------------------------------

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Per-source cache keyed on the source's own rng identity so seeded scatters are computed once.
const cacheStore = new WeakMap<Rng, Map<string, unknown>>();
function getCached<T>(rng: Rng, key: string, make: () => T): T {
  let m = cacheStore.get(rng);
  if (!m) {
    m = new Map();
    cacheStore.set(rng, m);
  }
  if (!m.has(key)) m.set(key, make());
  return m.get(key) as T;
}

const PAINTERS: Record<ProceduralKind, Draw> = {
  leader: drawLeader,
  fog: drawFog,
  stars: drawStars,
  iris: drawIris,
  ripple: drawRipple,
  static: drawStatic,
  horizon: drawHorizon,
  orbs: drawOrbs,
  filmrun: drawFilmrun,
};

// suppress unused-import lint for VERD if a painter stops using it — keep palette complete.
void VERD;

/**
 * Build a deterministic procedural source for `kind`, seeded by `seed`. Returns its
 * THREE.Texture plus an `update(elapsedSeconds)` that repaints and flags the texture dirty.
 */
export function getProceduralTexture(kind: ProceduralKind, seed: string): ProceduralSource {
  const { ctx, tex } = makeCanvasTexture();
  const rng = makeRng(`${kind}:${seed}`);
  const painter = PAINTERS[kind] ?? PAINTERS.fog;
  // Default to the neutral params so a source created before any mood is applied (and any kind that
  // ignores params) renders exactly as it did before this variation wiring existed.
  let params: ProceduralParams = NEUTRAL_PROC_PARAMS;
  let last = -1;
  let lastParams = params;
  const update = (elapsed: number) => {
    // cap repaint cadence to ~30fps to stay cheap; texture stays put between repaints — but always
    // repaint promptly if the params changed so a mood shift reads without waiting for the cadence.
    if (last >= 0 && elapsed - last < 1 / 30 && params === lastParams) return;
    last = elapsed;
    lastParams = params;
    painter(ctx, elapsed, rng, params);
    tex.needsUpdate = true;
  };
  update(0);
  return {
    texture: tex,
    update,
    setParams: (p: ProceduralParams) => {
      params = p;
    },
    dispose: () => tex.dispose(),
  };
}
