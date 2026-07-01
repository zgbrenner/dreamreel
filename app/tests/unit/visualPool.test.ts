import { describe, it, expect } from 'vitest';
import { visualPool, flashFramePool, MIN_VIDEO_FOR_VIDEO_FIRST } from '../../src/dream/visualPool';
import type { Asset, AssetType, MoodAxis } from '../../src/manifest/types';

const MOOD = {} as Record<MoodAxis, number>;

function asset(id: string, type: AssetType): Asset {
  return {
    id,
    type,
    embedding: [0, 0, 0],
    mood: MOOD,
    tags: [],
    dwellBase: 4,
    source: 'test',
    license: 'CC0',
  };
}

/** N video assets vid0..vid(N-1). */
function videos(n: number): Asset[] {
  return Array.from({ length: n }, (_, i) => asset(`vid${i}`, 'video'));
}

describe('visualPool — video-first primary pool, procedural fallback-only', () => {
  // A genuinely video-rich corpus (>= the floor) so the video-first demotion engages.
  const rich = [
    asset('p1', 'procedural'),
    asset('img1', 'image'),
    ...videos(MIN_VIDEO_FOR_VIDEO_FIRST),
    asset('tc1', 'titlecard'),
    asset('p2', 'procedural'),
  ];

  it('holds video + title cards as primary and demotes images when the corpus is video-rich', () => {
    const pool = visualPool(rich, true);
    expect(pool.some((a) => a.type === 'image')).toBe(false);
    expect(pool.some((a) => a.type === 'procedural')).toBe(false);
    expect(pool.some((a) => a.type === 'video')).toBe(true);
    expect(pool.some((a) => a.type === 'titlecard')).toBe(true);
  });

  it('keeps title cards as primary visuals (they are media, not procedural)', () => {
    expect(visualPool(rich, true).some((a) => a.type === 'titlecard')).toBe(true);
  });

  it('keeps images primary when the corpus has NO video (a video-less corpus must still play)', () => {
    const noVideo = [asset('img1', 'image'), asset('img2', 'image'), asset('tc1', 'titlecard')];
    const pool = visualPool(noVideo, true);
    expect(pool.map((a) => a.id)).toEqual(['img1', 'img2', 'tc1']);
  });

  it('keeps images primary when the corpus is video-POOR (a thin video pool cannot carry the reel)', () => {
    // One video + several images: below the floor, so images stay primary instead of the reel
    // collapsing to procedural whenever the lone clip is between beats or fails to load.
    const thin = [asset('vid1', 'video'), asset('img1', 'image'), asset('img2', 'image')];
    expect(MIN_VIDEO_FOR_VIDEO_FIRST).toBeGreaterThan(1);
    const pool = visualPool(thin, true);
    expect(pool.map((a) => a.id)).toEqual(['vid1', 'img1', 'img2']);
    // The scarce video is still in the primary pool (the walk up-weights it) — it is not discarded.
    expect(pool.some((a) => a.type === 'video')).toBe(true);
  });

  it('demotes images exactly at the video-rich floor, but not one below it', () => {
    const belowImgs = [asset('img1', 'image'), asset('img2', 'image')];
    const below = [...videos(MIN_VIDEO_FOR_VIDEO_FIRST - 1), ...belowImgs];
    expect(visualPool(below, true).some((a) => a.type === 'image')).toBe(true);

    const at = [...videos(MIN_VIDEO_FOR_VIDEO_FIRST), ...belowImgs];
    expect(visualPool(at, true).some((a) => a.type === 'image')).toBe(false);
  });

  it('falls back to the procedural pool only when there is genuinely no media', () => {
    const onlyProcedural = [asset('p1', 'procedural'), asset('p2', 'procedural')];
    const pool = visualPool(onlyProcedural, true);
    expect(pool.map((a) => a.id)).toEqual(['p1', 'p2']);
  });

  it('archive-off uses the procedural+titlecard pool (legacy procedural-only mode)', () => {
    const pool = visualPool(rich, false);
    expect(pool.map((a) => a.id)).toEqual(['p1', 'tc1', 'p2']);
    expect(pool.some((a) => a.type === 'image' || a.type === 'video')).toBe(false);
  });

  it('preserves manifest order within the chosen pool (deterministic walk input)', () => {
    const pool = visualPool(rich, true);
    const expected = rich.filter((a) => a.type === 'video' || a.type === 'titlecard');
    expect(pool).toEqual(expected);
  });
});

describe('flashFramePool — the demoted stills, in lock-step with visualPool', () => {
  const rich = [
    asset('p1', 'procedural'),
    asset('img1', 'image'),
    ...videos(MIN_VIDEO_FOR_VIDEO_FIRST),
    asset('tc1', 'titlecard'),
    asset('img2', 'image'),
  ];

  it('returns exactly the images that visualPool demoted (archive on AND a video-rich corpus)', () => {
    const flashes = flashFramePool(rich, true);
    expect(flashes.map((a) => a.id)).toEqual(['img1', 'img2']);
    // No still is simultaneously a primary beat and a flash-frame.
    const primary = new Set(visualPool(rich, true).map((a) => a.id));
    expect(flashes.every((a) => !primary.has(a.id))).toBe(true);
  });

  it('is empty when there is no video (images stay primary, nothing to flash)', () => {
    const noVideo = [asset('img1', 'image'), asset('tc1', 'titlecard')];
    expect(flashFramePool(noVideo, true)).toEqual([]);
  });

  it('is empty when the corpus is video-poor (images stay primary, nothing to flash)', () => {
    const thin = [asset('vid1', 'video'), asset('img1', 'image'), asset('img2', 'image')];
    expect(flashFramePool(thin, true)).toEqual([]);
  });

  it('is empty when archive is off (images are excluded entirely, not flashed)', () => {
    expect(flashFramePool(rich, false)).toEqual([]);
  });

  it('is empty when the corpus has no images at all', () => {
    const noImages = [...videos(MIN_VIDEO_FOR_VIDEO_FIRST), asset('tc1', 'titlecard')];
    expect(flashFramePool(noImages, true)).toEqual([]);
  });
});
