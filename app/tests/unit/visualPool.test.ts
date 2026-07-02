import { describe, it, expect } from 'vitest';
import { visualPool, flashFramePool, MIN_PRIMARY_VIDEOS } from '../../src/dream/visualPool';
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

// Enough videos to clear the MIN_PRIMARY_VIDEOS threshold, interleaved with other media.
const mixed = [
  asset('p1', 'procedural'),
  asset('img1', 'image'),
  asset('vid1', 'video'),
  asset('tc1', 'titlecard'),
  asset('vid2', 'video'),
  asset('vid3', 'video'),
  asset('p2', 'procedural'),
  asset('vid4', 'video'),
  asset('img2', 'image'),
];

describe('visualPool — video-first primary pool, procedural fallback-only', () => {
  it('holds only videos as primary and demotes static/card visuals when archive is on and video exists', () => {
    const pool = visualPool(mixed, true);
    expect(pool.map((a) => a.id)).toEqual(['vid1', 'vid2', 'vid3', 'vid4']);
    expect(pool.some((a) => a.type === 'image')).toBe(false);
    expect(pool.some((a) => a.type === 'titlecard')).toBe(false);
    expect(pool.some((a) => a.type === 'procedural')).toBe(false);
  });

  it('keeps images primary when the corpus has NO video (a video-less corpus must still play)', () => {
    const noVideo = [asset('img1', 'image'), asset('img2', 'image'), asset('tc1', 'titlecard')];
    const pool = visualPool(noVideo, true);
    expect(pool.map((a) => a.id)).toEqual(['img1', 'img2', 'tc1']);
  });

  it('keeps all media primary when the corpus is video-STARVED (too few clips for a video-only walk)', () => {
    const starved = [
      asset('img1', 'image'),
      asset('vid1', 'video'),
      asset('img2', 'image'),
      asset('tc1', 'titlecard'),
    ];
    expect(starved.filter((a) => a.type === 'video').length).toBeLessThan(MIN_PRIMARY_VIDEOS);
    const pool = visualPool(starved, true);
    expect(pool.map((a) => a.id)).toEqual(['img1', 'vid1', 'img2', 'tc1']);
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
    expect(pool).toEqual([mixed[2], mixed[4], mixed[5], mixed[7]]);
  });
});

describe('flashFramePool — the demoted stills, in lock-step with visualPool', () => {
  it('returns exactly the images that visualPool demoted (archive on AND enough video)', () => {
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

  it('is empty when the corpus is video-starved (images stay primary, nothing to flash)', () => {
    const starved = [asset('img1', 'image'), asset('vid1', 'video'), asset('tc1', 'titlecard')];
    expect(flashFramePool(starved, true)).toEqual([]);
    // Lock-step: those images are still in the primary pool instead.
    const primary = new Set(visualPool(starved, true).map((a) => a.id));
    expect(primary.has('img1')).toBe(true);
  });

  it('is empty when archive is off (images are excluded entirely, not flashed)', () => {
    expect(flashFramePool(mixed, false)).toEqual([]);
  });

  it('is empty when the corpus has no images at all', () => {
    const noImages = [
      asset('vid1', 'video'),
      asset('vid2', 'video'),
      asset('vid3', 'video'),
      asset('vid4', 'video'),
      asset('tc1', 'titlecard'),
    ];
    expect(flashFramePool(noImages, true)).toEqual([]);
  });
});
