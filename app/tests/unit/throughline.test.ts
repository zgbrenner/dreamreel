// Through-line machinery: entity match-cuts and leap targeting (dream-bizarreness research —
// discontinuities carry a peripheral association or emotional theme across the cut).
import { describe, it, expect } from 'vitest';
import { entityOverlap, throughlineCandidates } from '../../src/dream/dreamwalker';
import { MOOD_AXES, type Asset, type MoodAxis } from '../../src/manifest/types';

function moodWith(overrides: Partial<Record<MoodAxis, number>>): Record<MoodAxis, number> {
  const m = {} as Record<MoodAxis, number>;
  for (const a of MOOD_AXES) m[a] = 0.5;
  return { ...m, ...overrides };
}

function asset(id: string, entities?: string[], mood?: Record<MoodAxis, number>): Asset {
  return {
    id,
    type: 'video',
    embedding: [1, 0, 0],
    mood: mood ?? moodWith({}),
    tags: [],
    dwellBase: 4,
    source: 'test',
    license: 'PD',
    ...(entities ? { entities } : {}),
  };
}

describe('entityOverlap', () => {
  it('counts shared entities, capped', () => {
    expect(entityOverlap(['dog', 'street'], ['dog'])).toBe(1);
    expect(entityOverlap(['dog', 'street', 'sky'], ['dog', 'street', 'sky'])).toBe(2); // cap
  });

  it('is 0 when either side is missing or empty (legacy manifests unaffected)', () => {
    expect(entityOverlap(undefined, ['dog'])).toBe(0);
    expect(entityOverlap(['dog'], undefined)).toBe(0);
    expect(entityOverlap([], [])).toBe(0);
  });
});

describe('throughlineCandidates', () => {
  const pool = [
    asset('shared-entity', ['dog', 'field']),
    asset('mood-kin', [], moodWith({ tender: 0.95, loss: 0.9 })),
    asset('unrelated', ['train'], moodWith({ mechanical: 0.95, fear: 0.9 })),
  ];

  it('prefers candidates sharing an entity with the previous pick', () => {
    const cands = throughlineCandidates(pool, ['dog'], ['joy']);
    expect(cands.map((a) => a.id)).toEqual(['shared-entity']);
  });

  it('falls back to shared dominant mood axes when no entity matches', () => {
    const cands = throughlineCandidates(pool, ['ocean'], ['tender']);
    expect(cands.map((a) => a.id)).toEqual(['mood-kin']);
  });

  it('falls back to the whole pool when nothing connects (never empty)', () => {
    // 'joy' is nobody's dominant axis here and 'ocean' matches no entity.
    const flatPool = [asset('a', ['train']), asset('b', ['car'])];
    const cands = throughlineCandidates(flatPool, ['ocean'], undefined);
    expect(cands).toHaveLength(2);
  });

  it('handles a previous pick with no entities/axes (start of dream)', () => {
    expect(throughlineCandidates(pool, undefined, undefined)).toHaveLength(pool.length);
  });
});
