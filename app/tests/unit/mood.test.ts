import { describe, it, expect } from 'vitest';
import {
  cosine,
  l2norm,
  dot,
  projectMood,
  blankMood,
  dominantAxes,
  blendMoods,
  moodAffinity,
} from '../../src/dream/mood';
import { MOOD_AXES, type MoodAxis } from '../../src/manifest/types';

describe('dot', () => {
  it('computes the inner product over the shared length', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
  it('only multiplies the overlapping prefix when lengths differ', () => {
    expect(dot([1, 2, 3], [4, 5])).toBe(14);
  });
});

describe('cosine', () => {
  it('is 1 for parallel vectors', () => {
    expect(cosine([1, 0, 0], [3, 0, 0])).toBeCloseTo(1, 10);
  });
  it('is 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 5])).toBeCloseTo(0, 10);
  });
  it('is -1 for anti-parallel vectors', () => {
    expect(cosine([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });
  it('is invariant to magnitude scaling', () => {
    const a = [0.3, -0.7, 0.2];
    const b = [0.9, 0.1, -0.4];
    expect(cosine(a, b)).toBeCloseTo(cosine(a, b.map((x) => x * 100)), 10);
  });
  it('does not divide by zero on a zero vector', () => {
    const v = cosine([0, 0, 0], [1, 2, 3]);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(0);
  });
});

describe('l2norm', () => {
  it('returns a unit-length vector', () => {
    const u = l2norm([3, 4]);
    expect(Math.hypot(...u)).toBeCloseTo(1, 10);
    expect(u).toEqual([0.6, 0.8]);
  });
  it('preserves direction', () => {
    const v = [2, -1, 0.5];
    expect(cosine(v, l2norm(v))).toBeCloseTo(1, 10);
  });
  it('handles a zero vector without producing NaN', () => {
    const u = l2norm([0, 0, 0]);
    expect(u.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe('projectMood', () => {
  // Build axis vectors so each axis reads a distinct embedding component.
  const dim = MOOD_AXES.length;
  const axes = {} as Record<MoodAxis, number[]>;
  MOOD_AXES.forEach((axis, i) => {
    const v = new Array(dim).fill(0);
    v[i] = 1;
    axes[axis] = v;
  });

  it('returns all axes squashed into [0, 1]', () => {
    const embedding = MOOD_AXES.map((_, i) => (i % 2 === 0 ? 1 : -1));
    const mood = projectMood(embedding, axes);
    expect(Object.keys(mood).sort()).toEqual([...MOOD_AXES].sort());
    for (const v of Object.values(mood)) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('maps a zero projection to exactly 0.5 (sigmoid midpoint)', () => {
    const mood = projectMood(new Array(dim).fill(0), axes);
    for (const v of Object.values(mood)) expect(v).toBeCloseTo(0.5, 10);
  });

  it('a positive projection on an axis reads above 0.5, negative below', () => {
    const embedding = new Array(dim).fill(0);
    embedding[1] = 1; // uncanny axis high
    embedding[3] = -1; // ominous axis low
    const mood = projectMood(embedding, axes);
    expect(mood.uncanny).toBeGreaterThan(0.5);
    expect(mood.ominous).toBeLessThan(0.5);
  });
});

describe('blankMood', () => {
  it('is 0.5 on every axis', () => {
    const mood = blankMood();
    expect(Object.keys(mood).sort()).toEqual([...MOOD_AXES].sort());
    expect(Object.keys(mood)).toHaveLength(MOOD_AXES.length);
    for (const v of Object.values(mood)) expect(v).toBe(0.5);
  });
});

describe('emotion taxonomy', () => {
  it('carries all twelve emotional axes including the new ones', () => {
    for (const axis of ['love', 'loss', 'joy', 'fear', 'absurdity', 'strange'] as const) {
      expect(MOOD_AXES).toContain(axis);
    }
    expect(MOOD_AXES).toHaveLength(12);
  });
});

describe('dominantAxes', () => {
  const mood = blankMood();
  mood.loss = 0.9;
  mood.tender = 0.8;
  mood.joy = 0.1;

  it('returns the top-k axes by strength, descending', () => {
    const top = dominantAxes(mood, 2);
    expect(top.map((t) => t.axis)).toEqual(['loss', 'tender']);
    expect(top[0].value).toBe(0.9);
  });

  it('does not collapse the blend — k can span the whole vector', () => {
    expect(dominantAxes(mood, MOOD_AXES.length)).toHaveLength(MOOD_AXES.length);
    expect(dominantAxes(mood, 0)).toHaveLength(0);
    // k is clamped, never over-returns.
    expect(dominantAxes(mood, 99)).toHaveLength(MOOD_AXES.length);
  });

  it('breaks ties by MOOD_AXES order (deterministic)', () => {
    const flat = blankMood(); // all equal
    const top = dominantAxes(flat, 3).map((t) => t.axis);
    expect(top).toEqual(MOOD_AXES.slice(0, 3));
  });
});

describe('moodAffinity', () => {
  it('is zero when both moods are neutral', () => {
    expect(moodAffinity(blankMood(), blankMood())).toBeCloseTo(0, 10);
  });

  it('is positive when aligned axes rise together', () => {
    const a = blankMood();
    a.joy = 0.9;
    const b = blankMood();
    b.joy = 0.9;
    expect(moodAffinity(a, b)).toBeGreaterThan(0);
  });

  it('is negative when one mood peaks where the other dips', () => {
    const a = blankMood();
    a.joy = 0.9;
    const b = blankMood();
    b.joy = 0.1;
    expect(moodAffinity(a, b)).toBeLessThan(0);
  });
});

describe('blendMoods', () => {
  it('weighted-averages per axis (tender+loss = a bittersweet blend)', () => {
    const a = blankMood();
    a.tender = 1;
    a.loss = 0;
    const b = blankMood();
    b.tender = 0;
    b.loss = 1;
    const mix = blendMoods([a, b], [1, 1]);
    expect(mix.tender).toBeCloseTo(0.5, 10);
    expect(mix.loss).toBeCloseTo(0.5, 10);
    // unweighted axes stay where both agreed
    expect(mix.joy).toBeCloseTo(0.5, 10);
  });

  it('honors weights', () => {
    const a = blankMood();
    a.joy = 1;
    const b = blankMood();
    b.joy = 0;
    const mix = blendMoods([a, b], [3, 1]);
    expect(mix.joy).toBeCloseTo(0.75, 10);
  });

  it('stays in 0..1 and covers every axis', () => {
    const mix = blendMoods([blankMood(), blankMood()]);
    expect(Object.keys(mix).sort()).toEqual([...MOOD_AXES].sort());
    for (const v of Object.values(mix)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('falls back to a neutral mood on empty input or non-positive weight', () => {
    expect(blendMoods([])).toEqual(blankMood());
    expect(blendMoods([blankMood()], [0])).toEqual(blankMood());
  });
});
