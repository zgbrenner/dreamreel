// app/src/ui/poster.ts
// The dream poster: a shareable 1080×1620 PNG composed off-screen from the current dream frame,
// the drifting whisper, and the seed. Chrome-free by design — it is triggered by a hidden key
// ("p"), not a visible control, so the single-verb UX stays intact. All layout math lives in
// pure exported helpers so it can be unit-tested without a real 2D canvas (jsdom has none).
//
// Palette (CLAUDE.md aesthetic tokens): ink #0E0B08, tungsten amber #C8A35E, lamp glow #E8C887,
// silver-bone #D8D2C4, sepia #6B5640. Type: Bodoni Moda (seed, caps + wide tracking),
// EB Garamond italic (whisper), Courier Prime (wordmark + share URL) — the @fontsource families
// the app already ships, with serif/monospace fallbacks if they are not loaded.

export const POSTER_W = 1080;
export const POSTER_H = 1620;

const INK = '#0E0B08';
const AMBER = '#C8A35E';
const LAMP = '#E8C887';
const BONE = '#D8D2C4';
const SEPIA = '#6B5640';

const FONT_TITLE = '"Bodoni Moda", serif';
const FONT_DRIFT = '"EB Garamond", serif';
const FONT_MONO = '"Courier Prime", monospace';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fixed poster layout: every block's geometry, in poster pixels. Pure data, testable. */
export const POSTER_LAYOUT = {
  /** The dream frame is aspect-fit and centered inside these bounds. */
  frameBounds: { x: 90, y: 110, w: 900, h: 880 } as Rect,
  /** Thin silver-bone film-frame border width. */
  frameBorderPx: 3,
  /** EB Garamond italic whisper block, centered, wrapped. */
  whisper: { topY: 1088, lineHeightPx: 54, fontPx: 38, maxWidth: 840, maxLines: 3 },
  /** The seed, LARGE — Bodoni Moda caps with wide tracking, tungsten amber. */
  seed: { baselineY: 1368, maxWidth: 900, maxFontPx: 118, minFontPx: 36, trackingEm: 0.28 },
  /** Small DREAMREEL wordmark, Courier Prime. */
  wordmark: { baselineY: 1486, fontPx: 24, trackingEm: 0.6 },
  /** The share URL, Courier Prime, sepia. */
  url: { baselineY: 1534, fontPx: 20, maxWidth: 940 },
} as const;

/** Aspect-fit a source of srcW×srcH into bounds, centered. Degenerate sources fill the bounds. */
export function fitRect(srcW: number, srcH: number, bounds: Rect): Rect {
  if (!(srcW > 0) || !(srcH > 0)) return { ...bounds };
  const scale = Math.min(bounds.w / srcW, bounds.h / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: bounds.x + (bounds.w - w) / 2, y: bounds.y + (bounds.h - h) / 2, w, h };
}

/**
 * Greedy word-wrap using an injected measure function (so tests need no canvas). Words longer
 * than maxWidth get a line of their own rather than being split mid-word.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && measure(candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Per-character x-offsets for letter-spaced (tracked) text, given each glyph's width and the
 * tracking gap in px. Returns offsets relative to the text's left edge plus the total width
 * (no trailing tracking after the final glyph).
 */
export function trackedLayout(
  charWidths: number[],
  trackingPx: number,
): { offsets: number[]; width: number } {
  const offsets: number[] = [];
  let x = 0;
  for (let i = 0; i < charWidths.length; i++) {
    offsets.push(x);
    x += charWidths[i];
    if (i < charWidths.length - 1) x += trackingPx;
  }
  return { offsets, width: x };
}

/**
 * Largest font size (px) that fits maxWidth, given the text's measured width at maxPx.
 * Canvas text width scales linearly with font size, so one measurement suffices.
 */
export function fitFontPx(
  widthAtMaxPx: number,
  maxPx: number,
  maxWidth: number,
  minPx: number,
): number {
  if (!(widthAtMaxPx > 0) || widthAtMaxPx <= maxWidth) return maxPx;
  return Math.max(minPx, Math.floor((maxPx * maxWidth) / widthAtMaxPx));
}

/** Download filename for a poster: `dreamreel-<seed>.png`, seed sanitized for filesystems. */
export function posterFilename(seed: string): string {
  const safe = seed.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'dream';
  return `dreamreel-${safe}.png`;
}

/** The share URL printed on the poster — ?seed= is the ONLY shareable dream param. */
export function shareUrlFor(seed: string, origin: string, pathname: string): string {
  return `${origin}${pathname}?seed=${encodeURIComponent(seed)}`;
}

export interface PosterOpts {
  /** The captured dream frame: a CanvasImageSource, or a (data) URL to load. */
  frame: CanvasImageSource | string;
  seed: string;
  /** The current drifting whisper line, if any. */
  whisper?: string;
  /** The share URL text printed at the foot of the poster. */
  shareUrl?: string;
}

/**
 * Compose the poster onto an off-screen canvas and return it as a PNG blob.
 * Best-effort: resolves null (never throws) when a 2D canvas is unavailable.
 */
export async function composePoster(opts: PosterOpts): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = POSTER_W;
  canvas.height = POSTER_H;
  const ctx = getContext2d(canvas);
  if (!ctx) return null;

  await loadPosterFonts();
  const image = typeof opts.frame === 'string' ? await loadImage(opts.frame) : opts.frame;

  // Ink background.
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, POSTER_W, POSTER_H);

  // The dream frame, aspect-fit inside the film-frame bounds, with a thin silver-bone border.
  const bounds = POSTER_LAYOUT.frameBounds;
  const size = image ? sourceSize(image) : null;
  const frameRect = size ? fitRect(size.w, size.h, bounds) : { ...bounds };
  if (image) {
    try {
      ctx.drawImage(image, frameRect.x, frameRect.y, frameRect.w, frameRect.h);
    } catch {
      /* tainted/broken source — leave the frame dark */
    }
  }
  const b = POSTER_LAYOUT.frameBorderPx;
  ctx.strokeStyle = BONE;
  ctx.lineWidth = b;
  ctx.strokeRect(frameRect.x - b / 2, frameRect.y - b / 2, frameRect.w + b, frameRect.h + b);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Whisper — EB Garamond italic, centered, wrapped.
  if (opts.whisper && opts.whisper.trim()) {
    const wl = POSTER_LAYOUT.whisper;
    ctx.font = `italic ${wl.fontPx}px ${FONT_DRIFT}`;
    ctx.fillStyle = BONE;
    const lines = wrapLines(opts.whisper.trim(), wl.maxWidth, (s) => ctx.measureText(s).width);
    lines.slice(0, wl.maxLines).forEach((line, i) => {
      const w = ctx.measureText(line).width;
      ctx.fillText(line, (POSTER_W - w) / 2, wl.topY + i * wl.lineHeightPx);
    });
  }

  // Seed — Bodoni Moda caps, wide tracking, tungsten amber, sized to fit.
  const sl = POSTER_LAYOUT.seed;
  const seedText = opts.seed.toUpperCase();
  drawTracked(ctx, seedText, {
    fontOf: (px) => `700 ${px}px ${FONT_TITLE}`,
    color: AMBER,
    baselineY: sl.baselineY,
    maxWidth: sl.maxWidth,
    maxFontPx: sl.maxFontPx,
    minFontPx: sl.minFontPx,
    trackingEm: sl.trackingEm,
  });

  // DREAMREEL wordmark — Courier Prime, small, lamp glow.
  const wm = POSTER_LAYOUT.wordmark;
  drawTracked(ctx, 'DREAMREEL', {
    fontOf: (px) => `${px}px ${FONT_MONO}`,
    color: LAMP,
    baselineY: wm.baselineY,
    maxWidth: sl.maxWidth,
    maxFontPx: wm.fontPx,
    minFontPx: wm.fontPx,
    trackingEm: wm.trackingEm,
  });

  // Share URL — Courier Prime, sepia, centered.
  if (opts.shareUrl) {
    const ul = POSTER_LAYOUT.url;
    ctx.font = `${ul.fontPx}px ${FONT_MONO}`;
    ctx.fillStyle = SEPIA;
    const w = ctx.measureText(opts.shareUrl).width;
    const x = Math.max((POSTER_W - ul.maxWidth) / 2, (POSTER_W - w) / 2);
    ctx.fillText(opts.shareUrl, x, ul.baselineY);
  }

  return await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** Trigger a browser download of a composed poster blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a delay so the download has started reading the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// Internals

interface TrackedStyle {
  fontOf: (px: number) => string;
  color: string;
  baselineY: number;
  maxWidth: number;
  maxFontPx: number;
  minFontPx: number;
  trackingEm: number;
}

/** Draw centered letter-spaced text, shrinking the font until it fits maxWidth. */
function drawTracked(ctx: CanvasRenderingContext2D, text: string, s: TrackedStyle): void {
  const chars = [...text];
  if (chars.length === 0) return;
  const measureAt = (px: number): { widths: number[]; total: number } => {
    ctx.font = s.fontOf(px);
    const widths = chars.map((c) => ctx.measureText(c).width);
    return { widths, total: trackedLayout(widths, px * s.trackingEm).width };
  };
  const atMax = measureAt(s.maxFontPx);
  const px = fitFontPx(atMax.total, s.maxFontPx, s.maxWidth, s.minFontPx);
  const { widths } = px === s.maxFontPx ? atMax : measureAt(px);
  const { offsets, width } = trackedLayout(widths, px * s.trackingEm);
  const startX = (POSTER_W - width) / 2;
  ctx.fillStyle = s.color;
  chars.forEach((c, i) => ctx.fillText(c, startX + offsets[i], s.baselineY));
}

function getContext2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null; // jsdom / headless environments without a 2D backend
  }
}

function sourceSize(src: CanvasImageSource): { w: number; h: number } {
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    return { w: src.naturalWidth, h: src.naturalHeight };
  }
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) {
    return { w: src.videoWidth, h: src.videoHeight };
  }
  const maybe = src as { width?: unknown; height?: unknown };
  const w = typeof maybe.width === 'number' ? maybe.width : 0;
  const h = typeof maybe.height === 'number' ? maybe.height : 0;
  return { w, h };
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

/** Best-effort: wait for the poster's fonts so canvas text uses them if available. */
async function loadPosterFonts(): Promise<void> {
  try {
    if (!('fonts' in document)) return;
    await Promise.allSettled([
      document.fonts.load(`700 ${POSTER_LAYOUT.seed.maxFontPx}px ${FONT_TITLE}`),
      document.fonts.load(`italic ${POSTER_LAYOUT.whisper.fontPx}px ${FONT_DRIFT}`),
      document.fonts.load(`${POSTER_LAYOUT.wordmark.fontPx}px ${FONT_MONO}`),
    ]);
  } catch {
    /* fonts API unavailable — canvas falls back to serif/monospace */
  }
}
