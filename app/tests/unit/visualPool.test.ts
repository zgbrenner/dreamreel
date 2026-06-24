import { describe, it, expect } from 'vitest';
import { visualPool } from '../../src/dream/visualPool';
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

describe('visualPool — procedural is fallback-only', () => {
  const mixed = [
    asset('p1', 'procedural'),
    asset('img1', 'image'),
    asset('vid1', 'video'),
    asset('tc1', 'titlecard'),
    asset('p2', 'procedural'),
  ];

  it('walks real media + title cards and excludes procedural when archive is on', () => {
    const pool = visualPool(mixed, true);
    expect(pool.map((a) => a.id)).toEqual(['img1', 'vid1', 'tc1']);
    expect(pool.some((a) => a.type === 'procedural')).toBe(false);
  });

  it('keeps title cards as primary visuals (they are media, not procedural)', () => {
    expect(visualPool(mixed, true).some((a) => a.type === 'titlecard')).toBe(true);
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
    expect(pool).toEqual([mixed[1], mixed[2], mixed[3]]);
  });
});
