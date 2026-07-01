import { describe, it, expect } from 'vitest';
import { visualPool, flashFramePool } from '../../src/dream/visualPool';
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

describe('visualPool — video-first primary pool, procedural fallback-only', () => {
  const mixed = [
    asset('p1', 'procedural'),
    asset('img1', 'image'),
    asset('vid1', 'video'),
    asset('tc1', 'titlecard'),
    asset('p2', 'procedural'),
  ];

  it('holds only videos as primary and demotes static/card visuals when archive is on and video exists', () => {
    const pool = visualPool(mixed, true);
    expect(pool.map((a) => a.id)).toEqual(['vid1']);
    expect(pool.some((a) => a.type === 'image')).toBe(false);
    expect(pool.some((a) => a.type === 'titlecard')).toBe(false);
    expect(pool.some((a) => a.type === 'procedural')).toBe(false);
  });

  it('keeps images primary when the corpus has NO video (a video-less corpus must still play)', () => {
    const noVideo = [asset('img1', 'image'), asset('img2', 'image'), asset('tc1', 'titlecard')];
    const pool = visualPool(noVideo, true);
    expect(pool.map((a) => a.id)).toEqual(['img1', 'img2', 'tc1']);
  });

  it('falls back to the procedural pool only when there is genuinely no media', () => {
    const onlyProcedural = [asset('p1', 'procedural'), asset('p2', 'procedural')];
    const pool = visualPool(onlyProcedural, true);
    expect(pool.map((a) => a.id)).toEqual(['p1', 'p2']);
  });

  it('archive-off uses the procedural+titlecard pool (legacy procedural-only mode)', () => {
    const pool = visualPool(mixed, false);
    expect(pool.map((a) => a.id)).toEqual(['p1', 'tc1', 'p2']);
    expect(pool.some((a) => a.type === 'image' || a.type === 'video')).toBe(false);
  });

  it('preserves manifest order within the chosen pool (deterministic walk input)', () => {
    const pool = visualPool(mixed, true);
    expect(pool).toEqual([mixed[2]]);
  });
});

describe('flashFramePool — the demoted stills, in lock-step with visualPool', () => {
  const mixed = [
    asset('p1', 'procedural'),
    asset('img1', 'image'),
    asset('vid1', 'video'),
    asset('tc1', 'titlecard'),
    asset('img2', 'image'),
  ];

  it('returns exactly the images that visualPool demoted (archive on AND video present)', () => {
    const flashes = flashFramePool(mixed, true);
    expect(flashes.map((a) => a.id)).toEqual(['img1', 'img2']);
    // No still is simultaneously a primary beat and a flash-frame.
    const primary = new Set(visualPool(mixed, true).map((a) => a.id));
    expect(flashes.every((a) => !primary.has(a.id))).toBe(true);
  });

  it('is empty when there is no video (images stay primary, nothing to flash)', () => {
    const noVideo = [asset('img1', 'image'), asset('tc1', 'titlecard')];
    expect(flashFramePool(noVideo, true)).toEqual([]);
  });

  it('is empty when archive is off (images are excluded entirely, not flashed)', () => {
    expect(flashFramePool(mixed, false)).toEqual([]);
  });

  it('is empty when the corpus has no images at all', () => {
    const noImages = [asset('vid1', 'video'), asset('tc1', 'titlecard')];
    expect(flashFramePool(noImages, true)).toEqual([]);
  });
});
