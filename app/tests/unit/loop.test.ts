import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LOOP_MIME_CANDIDATES,
  LOOP_WIDTH,
  pickMimeType,
  loopFilename,
  loopOverlayLayout,
  loopNameLayout,
  recordDreamLoop,
} from '../../src/ui/loop';

// The recording path needs MediaRecorder + canvas.captureStream (absent in node/jsdom), so these
// tests cover the pure helpers the loop is composed from, plus recordDreamLoop's graceful
// no-API fallback (it must resolve null, never throw).

describe('pickMimeType', () => {
  it('prefers vp9, then vp8, then bare webm', () => {
    expect(pickMimeType(() => true)).toBe('video/webm;codecs=vp9');
    expect(pickMimeType((t) => !t.includes('vp9'))).toBe('video/webm;codecs=vp8');
    expect(pickMimeType((t) => t === 'video/webm')).toBe('video/webm');
  });

  it('returns null when nothing is supported', () => {
    expect(pickMimeType(() => false)).toBeNull();
  });

  it('treats a throwing probe as unsupported', () => {
    expect(
      pickMimeType((t) => {
        if (t.includes('codecs')) throw new Error('nope');
        return t === 'video/webm';
      }),
    ).toBe('video/webm');
    expect(
      pickMimeType(() => {
        throw new Error('nope');
      }),
    ).toBeNull();
  });

  it('probes only the frozen webm candidate list, in order', () => {
    const probed: string[] = [];
    pickMimeType((t) => {
      probed.push(t);
      return false;
    });
    expect(probed).toEqual([...LOOP_MIME_CANDIDATES]);
  });
});

describe('loopFilename', () => {
  it('formats dreamreel-<seed>-loop.webm', () => {
    expect(loopFilename('velvet-owl')).toBe('dreamreel-velvet-owl-loop.webm');
    expect(loopFilename('Seed_42')).toBe('dreamreel-Seed_42-loop.webm');
  });

  it('sanitizes unsafe characters like the poster filename does', () => {
    expect(loopFilename('we/ird see:d!')).toBe('dreamreel-we-ird-see-d-loop.webm');
    expect(loopFilename('  ../../etc  ')).toBe('dreamreel-etc-loop.webm');
  });

  it('falls back to "dream" for an empty/fully-unsafe seed', () => {
    expect(loopFilename('')).toBe('dreamreel-dream-loop.webm');
    expect(loopFilename('///')).toBe('dreamreel-dream-loop.webm');
  });
});

describe('loopOverlayLayout', () => {
  const caption = '?seed=velvet-owl';

  it('puts the scrim fully inside the frame, bottom-right', () => {
    const w = LOOP_WIDTH;
    const h = 540;
    const l = loopOverlayLayout(w, h, caption.length);
    expect(l.scrim.x).toBeGreaterThanOrEqual(0);
    expect(l.scrim.y).toBeGreaterThanOrEqual(0);
    expect(l.scrim.x + l.scrim.w).toBeLessThanOrEqual(w);
    expect(l.scrim.y + l.scrim.h).toBeLessThanOrEqual(h);
    // Bottom-right quadrant.
    expect(l.scrim.x).toBeGreaterThan(w / 2);
    expect(l.scrim.y).toBeGreaterThan(h / 2);
  });

  it('places the caption baseline inside the scrim', () => {
    const l = loopOverlayLayout(960, 540, caption.length);
    expect(l.caption.x).toBeGreaterThan(l.scrim.x);
    expect(l.caption.x).toBeLessThan(l.scrim.x + l.scrim.w);
    expect(l.caption.y).toBeGreaterThan(l.scrim.y);
    expect(l.caption.y).toBeLessThanOrEqual(l.scrim.y + l.scrim.h);
  });

  it('scales the font with width but never below the 12px floor', () => {
    const big = loopOverlayLayout(1920, 1080, caption.length);
    const mid = loopOverlayLayout(960, 540, caption.length);
    const tiny = loopOverlayLayout(120, 68, caption.length);
    expect(big.fontPx).toBeGreaterThan(mid.fontPx);
    expect(tiny.fontPx).toBe(12);
    expect(big.borderPx).toBeGreaterThanOrEqual(1);
    expect(tiny.borderPx).toBeGreaterThanOrEqual(1);
  });

  it('widens the scrim for longer captions and clamps it to the frame', () => {
    const short = loopOverlayLayout(960, 540, 8);
    const long = loopOverlayLayout(960, 540, 40);
    expect(long.scrim.w).toBeGreaterThan(short.scrim.w);
    const absurd = loopOverlayLayout(200, 112, 500);
    expect(absurd.scrim.w).toBeLessThanOrEqual(200);
    expect(absurd.scrim.x).toBeGreaterThanOrEqual(0);
  });
});

describe('loopNameLayout', () => {
  const h = 540;
  const layout = loopOverlayLayout(LOOP_WIDTH, h, '?seed=velvet-owl'.length);

  it('sits above the seed scrim, right-aligned to it, in a smaller face', () => {
    const nl = loopNameLayout(layout, h);
    // Baseline above the scrim's top edge (so the two burn-ins stack, not overlap).
    expect(nl.y).toBeLessThan(layout.scrim.y);
    // Right-aligned to the scrim's right edge, on-frame.
    expect(nl.x).toBe(layout.scrim.x + layout.scrim.w);
    expect(nl.x).toBeLessThanOrEqual(LOOP_WIDTH);
    // Smaller than the seed caption, never below its legibility floor.
    expect(nl.fontPx).toBeLessThan(layout.fontPx);
    expect(nl.fontPx).toBeGreaterThanOrEqual(11);
  });

  it('keeps the baseline on-frame even for a shallow frame', () => {
    const shallow = loopOverlayLayout(240, 60, 10);
    const nl = loopNameLayout(shallow, 60);
    expect(nl.y).toBeGreaterThanOrEqual(nl.fontPx);
    expect(nl.y).toBeLessThanOrEqual(60);
  });
});

describe('recordDreamLoop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fakeSource = { width: 1280, height: 720 } as unknown as HTMLCanvasElement;

  it('resolves null when MediaRecorder/document are unavailable (never throws)', async () => {
    // node environment: no document, no MediaRecorder.
    await expect(recordDreamLoop({ source: fakeSource, seed: 'x' })).resolves.toBeNull();
  });

  it('resolves null when canvas.captureStream is missing, even with MediaRecorder present', async () => {
    class FakeRecorder {
      static isTypeSupported(): boolean {
        return true;
      }
    }
    const fakeCanvas: { width: number; height: number } = { width: 0, height: 0 };
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    await expect(recordDreamLoop({ source: fakeSource, seed: 'x' })).resolves.toBeNull();
  });

  it('resolves null when no webm mime type is supported', async () => {
    class FakeRecorder {
      static isTypeSupported(): boolean {
        return false;
      }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal('document', {
      createElement: () => {
        throw new Error('should not get as far as creating a canvas');
      },
    });
    await expect(recordDreamLoop({ source: fakeSource, seed: 'x' })).resolves.toBeNull();
  });
});
