import { describe, it, expect } from 'vitest';
import {
  POSTER_W,
  POSTER_H,
  POSTER_LAYOUT,
  fitRect,
  wrapLines,
  trackedLayout,
  fitFontPx,
  posterFilename,
  shareUrlFor,
  composePoster,
} from '../../src/ui/poster';

// The drawing path needs a real 2D canvas (jsdom/node have none), so these tests cover the pure
// layout math the poster is composed from, plus composePoster's graceful no-canvas fallback.

describe('poster layout constants', () => {
  it('is a 1080×1620 sheet with every block inside it, stacked top to bottom', () => {
    expect(POSTER_W).toBe(1080);
    expect(POSTER_H).toBe(1620);
    const fb = POSTER_LAYOUT.frameBounds;
    expect(fb.x).toBeGreaterThan(0);
    expect(fb.y).toBeGreaterThan(0);
    expect(fb.x + fb.w).toBeLessThanOrEqual(POSTER_W);
    expect(fb.y + fb.h).toBeLessThanOrEqual(POSTER_H);
    // Text blocks sit below the frame and above the sheet's bottom edge, in order.
    const whisperBottom =
      POSTER_LAYOUT.whisper.topY +
      (POSTER_LAYOUT.whisper.maxLines - 1) * POSTER_LAYOUT.whisper.lineHeightPx;
    expect(POSTER_LAYOUT.whisper.topY).toBeGreaterThan(fb.y + fb.h);
    expect(POSTER_LAYOUT.seed.baselineY).toBeGreaterThan(whisperBottom);
    expect(POSTER_LAYOUT.wordmark.baselineY).toBeGreaterThan(POSTER_LAYOUT.seed.baselineY);
    expect(POSTER_LAYOUT.url.baselineY).toBeGreaterThan(POSTER_LAYOUT.wordmark.baselineY);
    expect(POSTER_LAYOUT.url.baselineY).toBeLessThan(POSTER_H);
  });

  it('slots the dream name as a subtitle between the seed and the wordmark', () => {
    const n = POSTER_LAYOUT.name;
    expect(n.baselineY).toBeGreaterThan(POSTER_LAYOUT.seed.baselineY);
    expect(n.baselineY).toBeLessThan(POSTER_LAYOUT.wordmark.baselineY);
    expect(n.maxWidth).toBeLessThanOrEqual(POSTER_W);
    expect(n.minFontPx).toBeGreaterThan(0);
    expect(n.minFontPx).toBeLessThanOrEqual(n.fontPx);
  });
});

describe('fitRect', () => {
  const bounds = { x: 90, y: 110, w: 900, h: 880 };

  it('fits a landscape source to the bounds width, vertically centered', () => {
    const r = fitRect(1920, 1080, bounds);
    expect(r.w).toBeCloseTo(900);
    expect(r.h).toBeCloseTo(900 * (1080 / 1920));
    expect(r.x).toBeCloseTo(bounds.x);
    expect(r.y).toBeCloseTo(bounds.y + (bounds.h - r.h) / 2);
  });

  it('fits a portrait source to the bounds height, horizontally centered', () => {
    const r = fitRect(1080, 1920, bounds);
    expect(r.h).toBeCloseTo(880);
    expect(r.w).toBeCloseTo(880 * (1080 / 1920));
    expect(r.y).toBeCloseTo(bounds.y);
    expect(r.x).toBeCloseTo(bounds.x + (bounds.w - r.w) / 2);
  });

  it('never overflows the bounds', () => {
    for (const [sw, sh] of [
      [4096, 16],
      [16, 4096],
      [900, 880],
      [1, 1],
    ]) {
      const r = fitRect(sw, sh, bounds);
      expect(r.x).toBeGreaterThanOrEqual(bounds.x - 1e-6);
      expect(r.y).toBeGreaterThanOrEqual(bounds.y - 1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(bounds.x + bounds.w + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(bounds.y + bounds.h + 1e-6);
    }
  });

  it('falls back to the full bounds for degenerate sources', () => {
    expect(fitRect(0, 1080, bounds)).toEqual(bounds);
    expect(fitRect(1920, 0, bounds)).toEqual(bounds);
    expect(fitRect(NaN, NaN, bounds)).toEqual(bounds);
  });
});

describe('wrapLines', () => {
  // A fake measure: 10px per character (spaces included), no canvas required.
  const measure = (s: string) => s.length * 10;

  it('wraps greedily at the max width', () => {
    // 10px/char, 100px max -> 10 chars per line.
    expect(wrapLines('the moon is a projector lamp', 100, measure)).toEqual([
      'the moon',
      'is a',
      'projector',
      'lamp',
    ]);
  });

  it('keeps a single short line intact', () => {
    expect(wrapLines('hello world', 1000, measure)).toEqual(['hello world']);
  });

  it('gives an over-long word its own line rather than dropping it', () => {
    expect(wrapLines('a extraordinarily b', 100, measure)).toEqual(['a', 'extraordinarily', 'b']);
  });

  it('collapses whitespace and handles empty text', () => {
    expect(wrapLines('   ', 100, measure)).toEqual([]);
    expect(wrapLines('one\n  two', 1000, measure)).toEqual(['one two']);
  });
});

describe('trackedLayout', () => {
  it('spaces glyphs by width + tracking, with no trailing tracking', () => {
    const { offsets, width } = trackedLayout([10, 20, 30], 5);
    expect(offsets).toEqual([0, 15, 40]);
    expect(width).toBe(70); // 10+5+20+5+30
  });

  it('handles a single glyph and zero tracking', () => {
    expect(trackedLayout([12], 100)).toEqual({ offsets: [0], width: 12 });
    expect(trackedLayout([10, 10], 0)).toEqual({ offsets: [0, 10], width: 20 });
    expect(trackedLayout([], 5)).toEqual({ offsets: [], width: 0 });
  });
});

describe('fitFontPx', () => {
  it('keeps the max size when the text already fits', () => {
    expect(fitFontPx(800, 118, 900, 36)).toBe(118);
  });

  it('scales down linearly when too wide', () => {
    // Width 1800 at 118px must halve to fit 900.
    expect(fitFontPx(1800, 118, 900, 36)).toBe(59);
  });

  it('never goes below the minimum', () => {
    expect(fitFontPx(90000, 118, 900, 36)).toBe(36);
  });

  it('tolerates a degenerate zero-width measurement', () => {
    expect(fitFontPx(0, 118, 900, 36)).toBe(118);
  });
});

describe('posterFilename', () => {
  it('names the file after the seed', () => {
    expect(posterFilename('k3j9zx1ab')).toBe('dreamreel-k3j9zx1ab.png');
  });

  it('sanitizes unsafe characters and never yields an empty name', () => {
    expect(posterFilename('a b/c\\d?e')).toBe('dreamreel-a-b-c-d-e.png');
    expect(posterFilename('///')).toBe('dreamreel-dream.png');
    expect(posterFilename('')).toBe('dreamreel-dream.png');
  });
});

describe('shareUrlFor', () => {
  it('carries only ?seed= — the single shareable dream param', () => {
    expect(shareUrlFor('abc123', 'https://dreamreel.example', '/')).toBe(
      'https://dreamreel.example/?seed=abc123',
    );
  });

  it('URL-encodes odd seeds', () => {
    expect(shareUrlFor('a b&c', 'https://x.test', '/reel')).toBe(
      'https://x.test/reel?seed=a%20b%26c',
    );
  });
});

describe('composePoster', () => {
  it('resolves null (never throws) when no DOM/canvas backend exists', async () => {
    // The node test environment has no document at all — the earliest graceful exit.
    const blob = await composePoster({ frame: 'data:image/png;base64,', seed: 'x' });
    expect(blob).toBeNull();
  });
});
