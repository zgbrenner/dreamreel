// app/src/ui/loop.ts
// The dream loop: a shareable ~4-second WebM capture of the live dream with the seed burned into
// a corner — the moving-image sibling of the dream poster (poster.ts). Chrome-free by design: it
// is triggered by a hidden key ("l"), not a visible control, so the single-verb UX stays intact.
// Capture uses only standard browser APIs (canvas.captureStream + MediaRecorder), composed onto
// an offscreen 2D canvas so the WebGL reel is never disturbed; the recorder runs its own
// requestAnimationFrame loop for its lifetime and never touches the compositor's render loop.
// All layout math lives in pure exported helpers so it can be unit-tested without a real canvas.
//
// Palette (CLAUDE.md aesthetic tokens, mirroring poster.ts): ink #0E0B08, silver-bone #D8D2C4,
// lamp glow #E8C887. Type: Courier Prime (the archival-caption face, for the seed) and EB Garamond
// italic (the drifting face, for the poetic name) — both with generic fallbacks.

const INK = '#0E0B08';
const BONE = '#D8D2C4';
const LAMP = '#E8C887';
const FONT_MONO = '"Courier Prime", monospace';
const FONT_DRIFT = '"EB Garamond", serif';

export const LOOP_DURATION_MS = 4000;
export const LOOP_WIDTH = 960;
export const LOOP_FPS = 30;
export const LOOP_BITS_PER_SECOND = 4_000_000;

/** WebM candidates in preference order; the first the browser supports wins. */
export const LOOP_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * First supported mime type from the candidate list, or null when none are supported
 * (recording is then unavailable and the caller resolves null).
 */
export function pickMimeType(supported: (t: string) => boolean): string | null {
  for (const t of LOOP_MIME_CANDIDATES) {
    try {
      if (supported(t)) return t;
    } catch {
      /* a throwing probe counts as unsupported */
    }
  }
  return null;
}

/** Download filename for a loop: `dreamreel-<seed>-loop.webm`, seed sanitized like the poster's. */
export function loopFilename(seed: string): string {
  const safe = seed.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'dream';
  return `dreamreel-${safe}-loop.webm`;
}

export interface LoopOverlayLayout {
  /** Thin silver-bone border, stroked just inside the canvas edge. */
  borderPx: number;
  /** Caption font size, px (Courier Prime). */
  fontPx: number;
  /** Subtle ink scrim behind the caption, bottom-right. */
  scrim: Rect;
  /** Caption baseline origin (left edge x, alphabetic baseline y). */
  caption: { x: number; y: number };
}

/**
 * Overlay geometry for a w×h loop frame carrying a caption of `captionChars` monospace glyphs
 * (Courier advance ≈ 0.6em). Pure math — everything scales off the width so the burn-in reads
 * the same at any capture size, and the scrim always sits fully inside the frame, bottom-right.
 */
export function loopOverlayLayout(w: number, h: number, captionChars: number): LoopOverlayLayout {
  const fontPx = Math.max(12, Math.round(w / 48));
  const padPx = Math.round(fontPx * 0.55);
  const marginPx = Math.round(fontPx * 0.75);
  const borderPx = Math.max(1, Math.round(w / 480));
  const textW = Math.ceil(captionChars * fontPx * 0.6);
  const scrimW = Math.min(w, textW + padPx * 2);
  const scrimH = fontPx + padPx * 2;
  const scrim: Rect = {
    x: Math.max(0, w - marginPx - scrimW),
    y: Math.max(0, h - marginPx - scrimH),
    w: scrimW,
    h: scrimH,
  };
  return {
    borderPx,
    fontPx,
    scrim,
    // Alphabetic baseline sits roughly 0.8em below the text's top edge in Courier.
    caption: { x: scrim.x + padPx, y: scrim.y + padPx + Math.round(fontPx * 0.8) },
  };
}

/**
 * Position for the dream's poetic name (EB Garamond italic), sitting just above the seed scrim and
 * right-aligned to it, in a slightly smaller face. Pure — derived from the seed-caption layout so
 * the two burn-ins stack cleanly at any capture size. Drawn with textAlign='right' at `x`.
 */
export function loopNameLayout(
  layout: LoopOverlayLayout,
  h: number,
): { x: number; y: number; fontPx: number } {
  const fontPx = Math.max(11, Math.round(layout.fontPx * 0.82));
  const gap = Math.round(layout.fontPx * 0.5);
  return {
    // Right edge of the seed scrim — the caption is drawn right-aligned to it.
    x: layout.scrim.x + layout.scrim.w,
    // Baseline sits above the scrim, clamped to stay on-frame.
    y: Math.min(h, Math.max(fontPx, layout.scrim.y - gap)),
    fontPx,
  };
}

export interface LoopOpts {
  /** The live WebGL compositor canvas to record. */
  source: HTMLCanvasElement;
  seed: string;
  /** The dream's poetic name (deriveDreamName), burned in above the seed caption. */
  name?: string;
  durationMs?: number;
  width?: number;
  fps?: number;
}

/**
 * Record ~durationMs of the dream from the source canvas into a WebM blob, with the `?seed=`
 * caption burned in bottom-right over an ink scrim and a thin silver-bone border. Best-effort:
 * resolves null (never throws) when MediaRecorder / captureStream / a 2D canvas is unavailable,
 * or when the recorder produces no data. Cleans up its rAF loop and stream tracks on all paths.
 */
export async function recordDreamLoop(opts: LoopOpts): Promise<Blob | null> {
  const durationMs = opts.durationMs ?? LOOP_DURATION_MS;
  const width = opts.width ?? LOOP_WIDTH;
  const fps = opts.fps ?? LOOP_FPS;

  // Feature detection — recording quietly does nothing where the APIs are missing.
  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') return null;
  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) return null;

  const srcW = opts.source.width;
  const srcH = opts.source.height;
  const w = Math.max(2, Math.round(width / 2) * 2);
  const h = Math.max(2, Math.round((srcW > 0 && srcH > 0 ? (w * srcH) / srcW : w * 0.5625) / 2) * 2);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  if (typeof canvas.captureStream !== 'function') return null;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  const ctx2d = ctx;

  const caption = `?seed=${opts.seed}`;
  const layout = loopOverlayLayout(w, h, caption.length);
  const nameText = opts.name?.trim() ? opts.name.trim() : null;
  const nameLayout = nameText ? loopNameLayout(layout, h) : null;

  const drawFrame = (): void => {
    try {
      ctx2d.drawImage(opts.source, 0, 0, w, h);
    } catch {
      /* tainted/broken source — keep the last frame (or the ink base) */
    }
    // The dream's poetic name, EB Garamond italic, lamp glow — above the seed caption, right-aligned.
    if (nameText && nameLayout) {
      ctx2d.font = `italic ${nameLayout.fontPx}px ${FONT_DRIFT}`;
      ctx2d.textAlign = 'right';
      ctx2d.textBaseline = 'alphabetic';
      ctx2d.fillStyle = LAMP;
      ctx2d.fillText(nameText, nameLayout.x, nameLayout.y);
    }
    // Subtle ink scrim + seed caption, bottom-right, Courier Prime.
    ctx2d.fillStyle = 'rgba(14, 11, 8, 0.6)'; // INK at 60%
    ctx2d.fillRect(layout.scrim.x, layout.scrim.y, layout.scrim.w, layout.scrim.h);
    ctx2d.font = `${layout.fontPx}px ${FONT_MONO}`;
    ctx2d.textAlign = 'left';
    ctx2d.textBaseline = 'alphabetic';
    ctx2d.fillStyle = BONE;
    ctx2d.fillText(caption, layout.caption.x, layout.caption.y);
    // Thin silver-bone border just inside the frame.
    ctx2d.strokeStyle = BONE;
    ctx2d.lineWidth = layout.borderPx;
    const half = layout.borderPx / 2;
    ctx2d.strokeRect(half, half, w - layout.borderPx, h - layout.borderPx);
  };

  // Ink base + first composed frame before the stream starts, so frame 0 is never blank.
  ctx2d.fillStyle = INK;
  ctx2d.fillRect(0, 0, w, h);
  drawFrame();

  let stream: MediaStream;
  try {
    stream = canvas.captureStream(fps);
  } catch {
    return null;
  }

  return await new Promise<Blob | null>((resolve) => {
    let rafId = 0;
    let done = false;
    const tick = (): void => {
      drawFrame();
      rafId = requestAnimationFrame(tick);
    };
    const finish = (blob: Blob | null): void => {
      if (done) return;
      done = true;
      cancelAnimationFrame(rafId);
      for (const track of stream.getTracks()) track.stop();
      resolve(blob);
    };

    let recorder: MediaRecorder;
    const chunks: Blob[] = [];
    try {
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: LOOP_BITS_PER_SECOND,
      });
    } catch {
      finish(null);
      return;
    }
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      finish(chunks.length > 0 ? new Blob(chunks, { type: mimeType }) : null);
    };
    recorder.onerror = () => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* already stopped */
      }
      finish(null);
    };

    try {
      recorder.start(250);
    } catch {
      finish(null);
      return;
    }
    rafId = requestAnimationFrame(tick);
    setTimeout(() => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
        else finish(null);
      } catch {
        finish(null);
      }
    }, durationMs);
  });
}
