import { describe, it, expect } from 'vitest';
import { cosine, l2norm, dot, projectMood, blankMood } from '../../src/dream/mood';
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

  it('returns all six axes squashed into [0, 1]', () => {
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
    expect(Object.keys(mood)).toHaveLength(6);
    for (const v of Object.values(mood)) expect(v).toBe(0.5);
  });
});
